// Loveland HCR — in-memory vault session + refresh-safe persistence.
// The session (incl. the non-extractable masterKey CryptoKey) lives in `e`.
// To survive a page refresh without weakening the zero-knowledge model we
// persist it to a dedicated IndexedDB, gated by a sessionStorage marker:
//   refresh (same tab)  -> marker present -> session restored
//   tab / browser close -> marker cleared -> record purged, login required
// The 15-min idle auto-lock still applies (freshness check + interval below).
var e = null,
    r = 15 * 60 * 1e3,
    n = Date.now();
var Bn = "bv-session",
    Sn = "s",
    Kn = "current",
    Mn = "bv.session.live";

function Pn(o, f) {
    return new Promise((res, rej) => {
        let q;
        try { q = indexedDB.open(Bn, 1) } catch (x) { rej(x); return }
        q.onupgradeneeded = () => {
            let db = q.result;
            if (!db.objectStoreNames.contains(Sn)) db.createObjectStore(Sn)
        };
        q.onerror = () => rej(q.error);
        q.onsuccess = () => {
            let db = q.result, out;
            try {
                let tx = db.transaction(Sn, o),
                    st = tx.objectStore(Sn);
                out = f(st);
                tx.oncomplete = () => { db.close(); res(out ? out.result : void 0) };
                tx.onerror = () => { db.close(); rej(tx.error) };
                tx.onabort = () => { db.close(); rej(tx.error) }
            } catch (x) { try { db.close() } catch {} rej(x) }
        }
    })
}

function pn() {
    if (!e) return;
    try { sessionStorage.setItem(Mn, "1") } catch {}
    Pn("readwrite", st => st.put({ session: e, lastActivity: n, savedAt: Date.now() }, Kn)).catch(() => {})
}

function gn() {
    try { sessionStorage.removeItem(Mn) } catch {}
    return Pn("readwrite", st => st.delete(Kn)).catch(() => {})
}

function l(t) { e = t; n = Date.now(); pn() }

function d() { return e }

function i() { e = null; gn() }

function u() { return e !== null }

function s() { n = Date.now() }

async function fn() {
    let m = null;
    try { m = sessionStorage.getItem(Mn) } catch {}
    if (m !== "1") { await gn(); return !1 }
    let rec = null;
    try { rec = await Pn("readonly", st => st.get(Kn)) } catch { rec = null }
    if (!rec || !rec.session) { await gn(); return !1 }
    if (Date.now() - (rec.lastActivity || 0) > r) { await gn(); return !1 }
    e = rec.session; n = Date.now();
    return !0
}

function a(t) {
    for (let o of ["pointerdown", "keydown", "touchstart"]) window.addEventListener(o, s, { passive: !0 });
    setInterval(() => {
        e && (Date.now() - n > r ? (i(), t()) : pn())
    }, 3e4)
}
export { l as a, d as b, i as c, u as d, a as e, fn as f };
