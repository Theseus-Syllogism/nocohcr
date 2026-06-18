#!/usr/bin/env python3
"""
bv-route-proxy — thin wrapper turning the directions UI's `/api/route`
request into a Valhalla `/route` call and normalizing the reply into the
RouteResult shape the frontend (web/src/directions.ts) consumes.

  GET /api/route?from=<lat,lon>&to=<lat,lon>&mode=foot|driving|bicycle
    -> { mode, distance_m, duration_s, geometry:[[lon,lat],...],
         steps:[{instruction,distance_m,duration_s,street?,modifier?,type?}],
         from:{lat,lon}, to:{lat,lon} }

  503 while Valhalla is still building/unreachable (UI: RoutingUnavailable)
  404 when Valhalla can't find a route                (UI: NoRoute)
"""

from __future__ import annotations

import json
import os
import re
import urllib.parse
import urllib.request
import urllib.error
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

HOST = os.environ.get("BV_ROUTE_HOST", "127.0.0.1")
PORT = int(os.environ.get("BV_ROUTE_PORT", "8084"))
VALHALLA_URL = os.environ.get("BV_VALHALLA_URL", "http://127.0.0.1:8002").rstrip("/")
NOMINATIM_URL = os.environ.get("BV_NOMINATIM_URL", "http://127.0.0.1:8085").rstrip("/")
TIMEOUT = int(os.environ.get("BV_ROUTE_TIMEOUT", "8"))
# Blindvault / south Larimer County viewbox (left,top,right,bottom =
# min_lon,max_lat,max_lon,min_lat) — biases address search to the service area.
VIEWBOX = os.environ.get("BV_GEOCODE_VIEWBOX", "-105.25,40.55,-104.85,40.28")
UA = "bv-route-proxy/1.0"

_COSTING = {"foot": "pedestrian", "driving": "auto", "bicycle": "bicycle"}
_LATLON = re.compile(r"^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$")


def _decode_polyline(encoded: str, precision: int = 6) -> list[list[float]]:
    """Decode a Valhalla-encoded polyline into [[lon, lat], ...]."""
    coords: list[list[float]] = []
    index = lat = lng = 0
    factor = float(10 ** precision)
    length = len(encoded)
    while index < length:
        for is_lat in (True, False):
            shift = result = 0
            while True:
                b = ord(encoded[index]) - 63
                index += 1
                result |= (b & 0x1F) << shift
                shift += 5
                if b < 0x20:
                    break
            delta = ~(result >> 1) if (result & 1) else (result >> 1)
            if is_lat:
                lat += delta
            else:
                lng += delta
        coords.append([lng / factor, lat / factor])
    return coords


def _parse_pt(s: str) -> tuple[float, float] | None:
    m = _LATLON.match(s or "")
    if not m:
        return None
    lat, lon = float(m.group(1)), float(m.group(2))
    if not (-90 <= lat <= 90 and -180 <= lon <= 180):
        return None
    return lat, lon


class RouteError(Exception):
    def __init__(self, status: int, msg: str):
        super().__init__(msg)
        self.status = status


def _valhalla_route(frm: tuple[float, float], to: tuple[float, float], mode: str) -> dict:
    costing = _COSTING.get(mode, "pedestrian")
    body = json.dumps({
        "locations": [
            {"lat": frm[0], "lon": frm[1]},
            {"lat": to[0], "lon": to[1]},
        ],
        "costing": costing,
        "directions_options": {"units": "kilometers"},
    }).encode()
    req = urllib.request.Request(
        f"{VALHALLA_URL}/route",
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        # Valhalla returns 400 with an error code when it can't route.
        try:
            payload = json.loads(e.read())
        except Exception:
            payload = {}
        code = payload.get("error_code")
        # 442 "No path could be found", 154 "Path distance exceeds maximum", etc.
        if e.code in (400, 404) or code in (442, 443, 444, 445):
            raise RouteError(404, payload.get("error", "no route"))
        raise RouteError(502, f"valhalla {e.code}")
    except (urllib.error.URLError, ConnectionError, TimeoutError) as e:
        # Valhalla still building tiles / not up yet.
        raise RouteError(503, f"valhalla unavailable: {e}")


def _normalize(vh: dict, frm: tuple[float, float], to: tuple[float, float], mode: str) -> dict:
    trip = vh.get("trip") or {}
    if trip.get("status", 0) != 0:
        raise RouteError(404, trip.get("status_message", "no route"))
    legs = trip.get("legs") or []
    geometry: list[list[float]] = []
    steps: list[dict] = []
    for leg in legs:
        shape = leg.get("shape")
        if shape:
            geometry.extend(_decode_polyline(shape))
        for mv in leg.get("maneuvers") or []:
            names = mv.get("street_names") or mv.get("begin_street_names") or []
            steps.append({
                "instruction": mv.get("instruction", ""),
                "distance_m": round(float(mv.get("length", 0)) * 1000.0),
                "duration_s": round(float(mv.get("time", 0))),
                "street": names[0] if names else None,
                "type": str(mv.get("type", "")),
            })
    summary = trip.get("summary") or {}
    return {
        "mode": mode,
        "distance_m": round(float(summary.get("length", 0)) * 1000.0),
        "duration_s": round(float(summary.get("time", 0))),
        "geometry": geometry,
        "steps": steps,
        "from": {"lat": frm[0], "lon": frm[1]},
        "to": {"lat": to[0], "lon": to[1]},
    }


def _geocode(q: str, limit: int, bounded: bool) -> list[dict]:
    """Forward-geocode via Nominatim /search, biased to the Blindvault viewbox."""
    params = {
        "q": q,
        "format": "jsonv2",
        "limit": str(max(1, min(limit, 10))),
        "addressdetails": "0",
        "viewbox": VIEWBOX,
        "bounded": "1" if bounded else "0",
        "countrycodes": "us",
    }
    url = f"{NOMINATIM_URL}/search?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
            hits = json.loads(r.read())
    except (urllib.error.URLError, ConnectionError, TimeoutError) as e:
        raise RouteError(503, f"geocode unavailable: {e}")
    except urllib.error.HTTPError as e:
        raise RouteError(503 if e.code in (502, 503, 504) else 502, f"nominatim {e.code}")
    results: list[dict] = []
    for h in hits if isinstance(hits, list) else []:
        try:
            results.append({
                "display_name": h.get("display_name", ""),
                "lat": float(h["lat"]),
                "lon": float(h["lon"]),
                "kind": h.get("type") or h.get("category") or "place",
                "importance": float(h.get("importance", 0) or 0),
            })
        except (KeyError, ValueError, TypeError):
            continue
    return results


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a: Any) -> None:
        pass

    def _json(self, code: int, obj: Any) -> None:
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _handle_geocode(self, parsed) -> None:
        qs = urllib.parse.parse_qs(parsed.query)
        q = (qs.get("q") or [""])[0].strip()
        if len(q) < 2:
            self._json(200, {"results": []})
            return
        try:
            limit = int((qs.get("limit") or ["6"])[0])
        except ValueError:
            limit = 6
        bounded = (qs.get("bounded") or ["1"])[0] != "0"
        try:
            results = _geocode(q, limit, bounded)
            self._json(200, {"results": results})
        except RouteError as e:
            self._json(e.status, {"error": str(e)})
        except Exception as e:  # noqa: BLE001
            self._json(502, {"error": f"geocode failed: {e}"})

    def do_GET(self) -> None:
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/api/geocode":
            self._handle_geocode(parsed)
            return
        if parsed.path != "/api/route":
            self._json(404, {"error": "not found"})
            return
        qs = urllib.parse.parse_qs(parsed.query)
        frm = _parse_pt((qs.get("from") or [""])[0])
        to = _parse_pt((qs.get("to") or [""])[0])
        mode = (qs.get("mode") or ["foot"])[0]
        if not frm or not to:
            self._json(400, {"error": "from and to are required as 'lat,lon'"})
            return
        if mode not in _COSTING:
            mode = "foot"
        try:
            vh = _valhalla_route(frm, to, mode)
            self._json(200, _normalize(vh, frm, to, mode))
        except RouteError as e:
            self._json(e.status, {"error": str(e)})
        except Exception as e:  # noqa: BLE001
            self._json(502, {"error": f"route failed: {e}"})


def main() -> None:
    print(f"bv-route-proxy listening on {HOST}:{PORT} -> Valhalla {VALHALLA_URL}", flush=True)
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()


if __name__ == "__main__":
    main()
