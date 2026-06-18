// bv-films — Films & TV browser for the Digital Library.
// Searches the Internet Archive (public-domain / openly-licensed moving images)
// and plays titles through the sandboxed archive.org embed player. Fully client
// side: search hits archive.org/advancedsearch.php (CORS-open JSON), posters come
// from archive.org/services/img, playback streams from archive.org. Nothing routes
// through our server, so it adds no bandwidth and nothing to take down.
//
// CSP this needs (see nginx blindvault.conf): add https://archive.org to
//   img-src, connect-src, frame-src.
// For a future direct-<video> player (offline download of PD titles) also add
//   media-src https://archive.org https://*.us.archive.org  and the same to connect-src.

const SEARCH = "https://archive.org/advancedsearch.php";
const IMG = "https://archive.org/services/img/";
const EMBED = "https://archive.org/embed/";
const DETAILS = "https://archive.org/details/";
const META = "https://archive.org/metadata/";
const DL = "https://archive.org/download/";
const ROWS = 24;

// Curated, safe-to-stream collections. Empty id = all moving images, sorted by reach.
const CATEGORIES = [
  { id: "", label: "All" },
  { id: "feature_films", label: "Feature films" },
  { id: "film_noir", label: "Film noir" },
  { id: "silent_films", label: "Silent" },
  { id: "classic_tv", label: "Classic TV" },
  { id: "prelinger", label: "Educational" },
  { id: "animationandcartoons", label: "Cartoons" },
];

const QKEY = "bv.films.q";
const CKEY = "bv.films.cat";

const esc = (s) => String(s == null ? "" : s);
// Strip Lucene/AND-OR specials from free-text so a stray quote can't break the query.
const clean = (s) => String(s || "").replace(/[\\"(){}\[\]:^~*?]+/g, " ").replace(/\b(AND|OR|NOT)\b/g, " ").trim();

function el(tag, attrs, ...kids) {
  const n = document.createElement(tag);
  if (attrs) for (const k in attrs) {
    if (k === "style" || k === "class") n.setAttribute(k === "class" ? "class" : "style", attrs[k]);
    else if (k.slice(0, 2) === "on" && typeof attrs[k] === "function") n.addEventListener(k.slice(2), attrs[k]);
    else if (attrs[k] != null) n.setAttribute(k, attrs[k]);
  }
  for (const c of kids) { if (c == null) continue; n.appendChild(typeof c === "string" ? document.createTextNode(c) : c); }
  return n;
}

function styleOnce() {
  if (document.getElementById("bv-films-style")) return;
  const css = `
  .bv-films{max-width:1040px;margin:0 auto;padding:1rem}
  .bv-films h2{margin:0 0 .25rem;font-size:1.4rem}
  .bv-films .sub{color:var(--text-secondary,#666);margin:0 0 1rem;font-size:.92rem;line-height:1.45}
  .bv-films form{display:flex;gap:.5rem;margin-bottom:.75rem}
  .bv-films input[type=search]{flex:1;padding:.55rem .7rem;border:1px solid var(--border,#ccc);border-radius:8px;background:var(--surface,#fff);color:inherit;font:inherit}
  .bv-films button.go{padding:.55rem 1rem;border:1px solid var(--border,#ccc);border-radius:8px;background:var(--surface,#fff);color:inherit;font:inherit;cursor:pointer}
  .bv-films .chips{display:flex;flex-wrap:wrap;gap:.4rem;margin-bottom:1rem}
  .bv-films .chip{padding:.3rem .7rem;border:1px solid var(--border,#ccc);border-radius:999px;background:transparent;color:inherit;font:inherit;font-size:.85rem;cursor:pointer}
  .bv-films .chip[aria-pressed=true]{background:var(--text,#111);color:var(--surface,#fff);border-color:var(--text,#111)}
  .bv-films .status{color:var(--text-secondary,#666);font-size:.9rem;min-height:1.2em;margin:.25rem 0 .75rem}
  .bv-films .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:1rem}
  .bv-films .item{display:flex;flex-direction:column;text-align:left;padding:0;border:1px solid var(--border,#ddd);border-radius:10px;overflow:hidden;background:var(--surface,#fff);color:inherit;font:inherit;cursor:pointer}
  .bv-films .item .thumb{width:100%;aspect-ratio:3/4;object-fit:cover;background:#222;display:block}
  .bv-films .item .meta{padding:.5rem .6rem}
  .bv-films .item .t{font-size:.85rem;font-weight:600;line-height:1.25;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
  .bv-films .item .y{font-size:.75rem;color:var(--text-secondary,#777);margin-top:.15rem}
  .bv-films .more{display:block;margin:1.25rem auto 0;padding:.55rem 1.2rem;border:1px solid var(--border,#ccc);border-radius:8px;background:var(--surface,#fff);color:inherit;font:inherit;cursor:pointer}
  /* Modal lives on <body> (outside .bv-films), so these rules must NOT be nested under .bv-films. */
  .bv-film-modal{position:fixed;top:0;left:0;right:0;bottom:0;width:100vw;height:100vh;box-sizing:border-box;background:rgba(0,0,0,.88);z-index:2147483000;display:flex;flex-direction:column;padding:2vh 2vw}
  .bv-film-modal .bar{display:flex;align-items:center;gap:.75rem;color:#fff;margin-bottom:.5rem;flex:0 0 auto}
  .bv-film-modal .pt{font-weight:600;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .bv-film-modal .bar a{color:#fff;font-size:.85rem;white-space:nowrap}
  .bv-film-modal .bar button{background:#fff;color:#111;border:0;border-radius:8px;padding:.4rem .9rem;font:inherit;cursor:pointer}
  .bv-film-modal iframe{flex:1 1 auto;width:100%;min-height:0;border:0;border-radius:8px;background:#000}
  .bv-film-modal .bv-fm-body{flex:1 1 auto;min-height:0;display:flex;gap:.6rem;overflow:hidden}
  .bv-film-modal .bv-fm-loading{color:#fff;margin:auto;font-size:.95rem}
  .bv-film-modal .bv-fm-video{flex:1 1 auto;min-width:0;min-height:0;width:100%;height:100%;background:#000;border-radius:8px;object-fit:contain}
  .bv-film-modal .bv-fm-list{flex:0 0 clamp(180px,26%,300px);overflow-y:auto;background:rgba(255,255,255,.06);border-radius:8px;padding:.35rem}
  .bv-film-modal .bv-fm-season{color:#bbb;font-size:.72rem;text-transform:uppercase;letter-spacing:.08em;padding:.5rem .5rem .25rem}
  .bv-film-modal .bv-fm-ep{display:flex;justify-content:space-between;align-items:center;gap:.5rem;width:100%;text-align:left;background:transparent;color:#eee;border:0;border-radius:6px;padding:.45rem .5rem;font:inherit;font-size:.84rem;cursor:pointer}
  .bv-film-modal .bv-fm-ep:hover{background:rgba(255,255,255,.12)}
  .bv-film-modal .bv-fm-ep[aria-current=true]{background:#fff;color:#111;font-weight:600}
  .bv-film-modal .bv-fm-ep .d{opacity:.6;font-variant-numeric:tabular-nums;flex:0 0 auto}
  @media (max-width:720px){.bv-film-modal .bv-fm-body{flex-direction:column}.bv-film-modal .bv-fm-list{flex:0 0 auto;max-height:34%}}
  `;
  document.head.appendChild(el("style", { id: "bv-films-style" })).textContent = css;
}

export async function renderFilms(container) {
  styleOnce();

  let q = "";
  let cat = "";
  try { q = sessionStorage.getItem(QKEY) || ""; cat = sessionStorage.getItem(CKEY) || ""; } catch {}
  let page = 1, total = 0, inflight = null;

  const root = el("div", { class: "bv-films" });
  const search = el("input", { type: "search", placeholder: "Search films and shows (try: noir, charlie chaplin, cartoons)", value: q, "aria-label": "Search films" });
  const form = el("form", { onsubmit: (e) => { e.preventDefault(); q = search.value; persist(); run(true); } },
    search, el("button", { type: "submit", class: "go" }, "Search"));
  const chips = el("div", { class: "chips" });
  const status = el("div", { class: "status", role: "status", "aria-live": "polite" });
  const grid = el("div", { class: "grid" });
  const moreBtn = el("button", { class: "more", hidden: "", onclick: () => { page++; run(false); } }, "Show more");

  CATEGORIES.forEach((c) => {
    const b = el("button", { type: "button", class: "chip", "aria-pressed": c.id === cat ? "true" : "false",
      onclick: () => { cat = c.id; persist(); syncChips(); run(true); } }, c.label);
    b._cid = c.id;
    chips.appendChild(b);
  });
  const syncChips = () => chips.querySelectorAll(".chip").forEach((b) => b.setAttribute("aria-pressed", b._cid === cat ? "true" : "false"));

  root.append(
    el("h2", null, "Films & TV"),
    el("p", { class: "sub" }, "Free, public-domain and openly-licensed movies and shows from the Internet Archive. No account, no ads. Streaming runs on archive.org."),
    form, chips, status, grid, moreBtn
  );
  container.replaceChildren(root);

  function persist() { try { sessionStorage.setItem(QKEY, q); sessionStorage.setItem(CKEY, cat); } catch {} }

  function buildQuery() {
    let parts = ["mediatype:(movies)"];
    if (cat) parts.push(`collection:(${cat})`);
    const t = clean(q);
    if (t) parts.push(`(${t})`);
    return parts.join(" AND ");
  }

  function makeUrl() {
    const u = new URL(SEARCH);
    u.searchParams.set("q", buildQuery());
    ["identifier", "title", "year"].forEach((f) => u.searchParams.append("fl[]", f));
    u.searchParams.append("sort[]", "downloads desc"); // most-downloaded (popular) first, for both browsing and searching, so obscure/random items don't lead
    u.searchParams.set("rows", String(ROWS));
    u.searchParams.set("page", String(page));
    u.searchParams.set("output", "json");
    return u.toString();
  }

  function card(doc) {
    const id = doc.identifier;
    const img = el("img", { class: "thumb", loading: "lazy", alt: "", src: IMG + encodeURIComponent(id) });
    img.addEventListener("error", () => { img.style.visibility = "hidden"; });
    const title = Array.isArray(doc.title) ? doc.title[0] : doc.title;
    const year = doc.year ? String(doc.year) : "";
    return el("button", { type: "button", class: "item", title: esc(title), onclick: () => openPlayer(id, title) },
      img,
      el("div", { class: "meta" },
        el("div", { class: "t" }, esc(title) || id),
        year ? el("div", { class: "y" }, year) : null));
  }

  async function run(reset) {
    if (reset) { page = 1; total = 0; grid.replaceChildren(); }
    if (inflight) inflight.abort();
    const ac = new AbortController(); inflight = ac;
    status.textContent = "Searching…"; moreBtn.hidden = true;
    try {
      const r = await fetch(makeUrl(), { signal: ac.signal });
      if (!r.ok) throw new Error("HTTP " + r.status);
      const d = await r.json();
      const docs = (d.response && d.response.docs) || [];
      total = (d.response && d.response.numFound) || 0;
      if (reset && docs.length === 0) { status.textContent = "No titles found. Try a different word or category."; return; }
      const frag = document.createDocumentFragment();
      docs.forEach((doc) => { if (doc.identifier) frag.appendChild(card(doc)); });
      grid.appendChild(frag);
      const shown = grid.children.length;
      status.textContent = total ? `${shown.toLocaleString()} of ${total.toLocaleString()} free titles` : "";
      moreBtn.hidden = shown >= total;
    } catch (e) {
      if (e.name === "AbortError") return;
      status.textContent = "Couldn't reach the film catalog. Check your connection and try again.";
    } finally { if (inflight === ac) inflight = null; }
  }

  let overlay = null, lastFocus = null, metaAC = null;
  // Critical layout is also set inline so the modal always covers the viewport even if the
  // scoped stylesheet fails to apply (the overlay lives on <body>, outside the .bv-films tree).
  const MODAL_STYLE = "position:fixed;top:0;left:0;right:0;bottom:0;width:100vw;height:100vh;box-sizing:border-box;z-index:2147483000;display:flex;flex-direction:column;padding:2vh 2vw;background:rgba(0,0,0,.88)";
  const VID_RANK = { mp4: 3, m4v: 3, webm: 2, ogv: 1, ogg: 1 }; // browser-playable formats, best first
  const fileExt = (n) => { const m = /\.([a-z0-9]+)$/i.exec(n || ""); return m ? m[1].toLowerCase() : ""; };
  const humanize = (n) => String(n || "").replace(/^.*\//, "").replace(/\.[a-z0-9]+$/i, "").replace(/[._]+/g, " ").trim();
  function parseSE(s) {
    s = String(s || "");
    let m = /s(?:eason)?\s*0*(\d{1,2})[ ._x-]*e(?:p(?:isode)?)?\s*0*(\d{1,3})/i.exec(s);
    if (m) return { s: +m[1], e: +m[2] };
    m = /\b(\d{1,2})x(\d{2,3})\b/.exec(s);
    if (m) return { s: +m[1], e: +m[2] };
    m = /\bep(?:isode)?\.?\s*0*(\d{1,3})\b/i.exec(s);
    if (m) return { s: null, e: +m[1] };
    return { s: null, e: null };
  }
  function parseLen(v) {
    if (v == null) return null;
    if (typeof v === "number") return v;
    v = String(v);
    if (/^\d+(\.\d+)?$/.test(v)) return Math.round(parseFloat(v));
    const p = v.split(":").map(Number);
    if (p.some((n) => isNaN(n))) return null;
    return p.reduce((a, n) => a * 60 + n, 0);
  }
  function fmtDur(sec) {
    if (!sec || sec < 1) return "";
    sec = Math.round(sec);
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    const mm = (h && m < 10 ? "0" : "") + m, ss = (s < 10 ? "0" : "") + s;
    return h ? `${h}:${mm}:${ss}` : `${m}:${ss}`;
  }
  // Turn item metadata into a sorted list of playable episodes, grouped by original-derivative lineage
  // (one episode can have an .avi original plus .mp4/.ogv derivatives; we keep the best playable one).
  function buildEpisodes(meta) {
    const files = (meta && meta.files) || [];
    const groups = new Map();
    for (const f of files) {
      if (!f || !f.name) continue;
      const key = (f.source === "derivative" && f.original) ? f.original : f.name;
      let g = groups.get(key); if (!g) { g = []; groups.set(key, g); }
      g.push(f);
    }
    const eps = [];
    for (const [key, members] of groups) {
      let best = null, bestRank = 0;
      for (const m of members) { const r = VID_RANK[fileExt(m.name)] || 0; if (r > bestRank) { bestRank = r; best = m; } }
      if (!best) continue; // no browser-playable video in this group
      const withTitle = members.find((m) => m.title) || {};
      const label = best.title || withTitle.title || humanize(key);
      const se = parseSE(key + " " + label);
      const lenSrc = best.length || (members.find((m) => m.length) || {}).length;
      const track = parseInt(best.track || (members.find((m) => m.track) || {}).track, 10);
      eps.push({ name: best.name, label, season: se.s, ep: se.e, track: isNaN(track) ? null : track, dur: parseLen(lenSrc) });
    }
    eps.sort((a, b) =>
      (a.season == null ? 999 : a.season) - (b.season == null ? 999 : b.season) ||
      (a.ep == null ? 1e9 : a.ep) - (b.ep == null ? 1e9 : b.ep) ||
      (a.track == null ? 1e9 : a.track) - (b.track == null ? 1e9 : b.track) ||
      a.label.localeCompare(b.label, undefined, { numeric: true })
    );
    return eps;
  }
  function embedIframe(id, title) {
    return el("iframe", { src: EMBED + encodeURIComponent(id), allow: "fullscreen",
      allowfullscreen: "", sandbox: "allow-scripts allow-same-origin allow-presentation allow-popups", title: esc(title) || "Player",
      style: "flex:1 1 auto;width:100%;min-height:0;border:0;border-radius:8px;background:#000" });
  }
  async function openPlayer(id, title) {
    closePlayer();
    lastFocus = document.activeElement;
    const body = el("div", { class: "bv-fm-body" }, el("p", { class: "bv-fm-loading" }, "Loading…"));
    const close = el("button", { type: "button", onclick: closePlayer }, "Close");
    overlay = el("div", { class: "bv-film-modal", role: "dialog", "aria-modal": "true", "aria-label": esc(title) || "Player",
      style: MODAL_STYLE, onclick: (e) => { if (e.target === overlay) closePlayer(); } },
      el("div", { class: "bar" },
        el("span", { class: "pt" }, esc(title) || ""),
        el("a", { href: DETAILS + encodeURIComponent(id), target: "_blank", rel: "noopener noreferrer" }, "Open on archive.org"),
        close),
      body);
    document.body.appendChild(overlay);
    document.body.style.overflow = "hidden";
    document.addEventListener("keydown", onKey, true);
    close.focus();

    // Fetch the item file manifest to find episodes. Any failure falls back to the Archive embed player.
    let eps = [];
    metaAC = new AbortController();
    try {
      const r = await fetch(META + encodeURIComponent(id), { signal: metaAC.signal });
      if (r.ok) eps = buildEpisodes(await r.json());
    } catch (e) { /* network/abort -> fall back below */ }
    if (!overlay) return; // closed while loading
    if (eps.length === 0) { body.replaceChildren(embedIframe(id, title)); return; }
    mountPlaylist(body, id, eps);
  }
  function mountPlaylist(body, id, eps) {
    const video = el("video", { class: "bv-fm-video", controls: "", playsinline: "", preload: "metadata",
      style: "flex:1 1 auto;min-width:0;min-height:0;width:100%;height:100%;background:#000;border-radius:8px;object-fit:contain" });
    body.replaceChildren(video);
    let list = null;
    const select = (i) => {
      const ep = eps[i]; if (!ep) return;
      // Encode each path segment so sub-foldered file names survive without breaking the URL path.
      video.src = DL + encodeURIComponent(id) + "/" + ep.name.split("/").map(encodeURIComponent).join("/");
      video.play().catch(() => {});
      if (list) list.querySelectorAll(".bv-fm-ep").forEach((b, j) => b.setAttribute("aria-current", j === i ? "true" : "false"));
    };
    if (eps.length > 1) {
      list = el("div", { class: "bv-fm-list", role: "listbox", "aria-label": "Episodes" });
      let curSeason;
      eps.forEach((ep, i) => {
        if (ep.season != null && ep.season !== curSeason) { curSeason = ep.season; list.appendChild(el("div", { class: "bv-fm-season" }, "Season " + ep.season)); }
        const text = (ep.ep != null ? "E" + ep.ep + (ep.label ? " · " + ep.label : "") : ep.label) || ("Part " + (i + 1));
        list.appendChild(el("button", { type: "button", class: "bv-fm-ep", role: "option", "aria-current": "false", onclick: () => select(i) },
          el("span", null, text), ep.dur ? el("span", { class: "d" }, fmtDur(ep.dur)) : null));
      });
      body.appendChild(list);
    }
    select(0);
  }
  function onKey(e) { if (e.key === "Escape") { e.stopPropagation(); closePlayer(); } }
  function closePlayer() {
    if (metaAC) { try { metaAC.abort(); } catch (e) {} metaAC = null; }
    if (!overlay) return;
    const v = overlay.querySelector("video"); if (v) { try { v.pause(); v.removeAttribute("src"); v.load(); } catch (e) {} }
    document.removeEventListener("keydown", onKey, true);
    overlay.remove(); overlay = null;
    document.body.style.overflow = "";
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }

  syncChips();
  run(true);
}
