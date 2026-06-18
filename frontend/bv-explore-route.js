,Pu("explore", async (u) => {
  // Explore — Neocities-style directory of published sites. Signed-in browse only.
  // Reads the public-after-auth GET /api/sites/index (whitelisted card fields).
  const bvH = (tag, props, ...kids) => {
    let el = document.createElement(tag);
    if (props) for (let k in props) {
      if (k === "class") el.className = props[k];
      else if (k === "style") el.setAttribute("style", props[k]);
      else if (k.slice(0, 2) === "on" && typeof props[k] === "function") el.addEventListener(k.slice(2), props[k]);
      else if (props[k] != null) el.setAttribute(k, props[k]);
    }
    for (let c of kids) { if (c == null) continue; el.appendChild(typeof c === "string" ? document.createTextNode(c) : c); }
    return el;
  };
  const api = async (method, path) => {
    let id = Mu(), token = id ? await ce(id) : null, headers = {};
    if (token) headers.authorization = "Bearer " + token;
    let r; try { r = await fetch(path, { method, headers }); } catch (e) { return { ok: false, status: 0, data: { error: "network" } }; }
    let data = {}; try { data = await r.json(); } catch (e) {}
    return { ok: r.ok, status: r.status, data };
  };
  if (!document.getElementById("bv-exp-css")) {
    let st = document.createElement("style"); st.id = "bv-exp-css";
    st.textContent = ".bv-exp{max-width:60rem;margin:1.5rem auto;padding:0 1rem;font-family:system-ui,sans-serif;color:#0f172a}.bv-exp-title{font-size:1.6rem;margin:.2rem 0}.bv-exp-sub{color:#64748b;margin:.1rem 0 1rem}.bv-exp-controls{display:flex;gap:.6rem;flex-wrap:wrap;margin-bottom:.7rem}.bv-exp-search{flex:1 1 16rem;min-width:12rem;padding:.6rem .8rem;border:1px solid #cbd5e1;border-radius:.5rem;font:inherit;min-height:44px;box-sizing:border-box}.bv-exp-sort{padding:.6rem;border:1px solid #cbd5e1;border-radius:.5rem;font:inherit;min-height:44px}.bv-exp-tagbar{margin-bottom:.5rem}.bv-exp-filterchip{display:inline-flex;align-items:center;gap:.4rem;background:#eef2ff;color:#3730a3;border:1px solid #c7d2fe;border-radius:1rem;padding:.25rem .7rem;font-size:.82rem;cursor:pointer;font:inherit}.bv-exp-status{color:#64748b;font-size:.85rem;margin:.2rem 0 .6rem}.bv-exp-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(15rem,1fr));gap:1rem}.bv-exp-card{display:flex;flex-direction:column;border:1px solid #e5e7eb;border-radius:.8rem;padding:1rem;text-decoration:none;color:inherit;box-shadow:0 1px 4px rgba(0,0,0,.05);cursor:pointer;transition:box-shadow .15s,transform .15s}.bv-exp-card:hover,.bv-exp-card:focus-within{box-shadow:0 4px 14px rgba(0,0,0,.1);transform:translateY(-2px)}.bv-exp-shotwrap{margin:-1rem -1rem .75rem;aspect-ratio:4/3;overflow:hidden;border-radius:.8rem .8rem 0 0;background:#e2e8f0}.bv-exp-shot{width:100%;height:100%;object-fit:cover;object-position:top center;display:block}.bv-exp-cardtop{display:flex;align-items:center;gap:.55rem;margin-bottom:.5rem}.bv-exp-fav{width:2rem;height:2rem;border-radius:.4rem;object-fit:cover;background:#fff;flex:none}.bv-exp-badge{width:2rem;height:2rem;border-radius:.4rem;color:#fff;display:flex;align-items:center;justify-content:center;font-weight:700;flex:none}.bv-exp-cardttl{font-weight:700;font-size:1.02rem;line-height:1.25;color:inherit;text-decoration:none;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}.bv-exp-desc{color:#475569;font-size:.86rem;line-height:1.4;margin:.1rem 0 .5rem;overflow:hidden;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical}.bv-exp-host{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:.78rem;color:#64748b;margin-top:auto}.bv-exp-tags{display:flex;flex-wrap:wrap;gap:.3rem;margin-top:.5rem}.bv-exp-tag{background:#f1f5f9;border:1px solid #e2e8f0;border-radius:.8rem;padding:.12rem .55rem;font-size:.74rem;color:#475569;cursor:pointer;font:inherit;line-height:1.4}.bv-exp-tag:hover{background:#e2e8f0}.bv-exp-more{padding:.6rem 1.4rem;border:1px solid #2563eb;background:#fff;color:#2563eb;border-radius:.5rem;font:inherit;font-weight:600;cursor:pointer;min-height:44px}.bv-exp-spin{width:30px;height:30px;border:3px solid #dbeafe;border-top-color:#2563eb;border-radius:50%;animation:bvspin 1s linear infinite;margin:2rem auto}.bv-exp-empty{text-align:center;color:#64748b;padding:2.5rem 1rem}.bv-exp-btn{display:inline-block;padding:.6rem 1.1rem;border-radius:.5rem;font-weight:600;cursor:pointer;border:1px solid #2563eb;background:#2563eb;color:#fff;text-decoration:none;font:inherit;min-height:44px;box-sizing:border-box}@keyframes bvspin{to{transform:rotate(360deg)}}@media (prefers-reduced-motion:reduce){.bv-exp-spin{animation:none}.bv-exp-card:hover{transform:none}}";
    document.head.appendChild(st);
  }
  u.replaceChildren();
  if (!Mu()) {
    let w = bvH("div", { class: "bv-exp" },
      bvH("h1", { class: "bv-exp-title" }, "Explore sites"),
      bvH("p", { class: "bv-exp-sub" }, "Sign in to browse and search sites built by the community."),
      bvH("a", { class: "bv-exp-btn", href: "#/login" }, "Sign in"));
    u.appendChild(w); return;
  }

  const LIMIT = 24;
  let state = { q: "", sort: "new", tag: "", page: 1, total: 0, loading: false };
  const hueOf = (s) => { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0; return h % 360; };
  const safeColor = (c) => (/^#([0-9a-fA-F]{3,8})$/.test(c || "")) ? c : null;

  const wrap = bvH("div", { class: "bv-exp" });
  wrap.appendChild(bvH("h1", { class: "bv-exp-title" }, "Explore"));
  wrap.appendChild(bvH("p", { class: "bv-exp-sub" }, "Discover sites built by the community."));
  const controls = bvH("div", { class: "bv-exp-controls" });
  const search = bvH("input", { class: "bv-exp-search", type: "search", placeholder: "Search sites…", "aria-label": "Search sites" });
  const sortSel = bvH("select", { class: "bv-exp-sort", "aria-label": "Sort sites" });
  for (const [v, l] of [["new", "Newest"], ["alpha", "A–Z"], ["random", "Surprise me"]]) sortSel.appendChild(bvH("option", { value: v }, l));
  controls.appendChild(search); controls.appendChild(sortSel);
  wrap.appendChild(controls);
  const tagBar = bvH("div", { class: "bv-exp-tagbar" });
  const status = bvH("div", { class: "bv-exp-status" });
  const grid = bvH("div", { class: "bv-exp-grid" });
  const moreWrap = bvH("div", { style: "text-align:center;margin:1.3rem 0" });
  const moreBtn = bvH("button", { class: "bv-exp-more", type: "button" }, "Load more");
  moreBtn.addEventListener("click", () => { state.page += 1; load(false); });
  moreWrap.appendChild(moreBtn); moreWrap.style.display = "none";
  wrap.appendChild(tagBar); wrap.appendChild(status); wrap.appendChild(grid); wrap.appendChild(moreWrap);
  u.appendChild(wrap);

  function setTag(t) { state.tag = t; renderTagBar(); load(true); }
  function renderTagBar() {
    tagBar.replaceChildren();
    if (state.tag) {
      let chip = bvH("button", { class: "bv-exp-filterchip", type: "button", title: "Clear tag filter", onclick: () => setTag("") },
        "Tag: #" + state.tag, bvH("span", { "aria-hidden": "true" }, "✕"));
      tagBar.appendChild(chip);
    }
  }
  function card(s) {
    const accent = safeColor(s.theme_color) || ("hsl(" + hueOf(s.handle) + ",55%,55%)");
    const bg = "hsl(" + hueOf(s.handle) + ",60%,97%)";
    const a = bvH("a", { class: "bv-exp-card", href: s.url, target: "_blank", rel: "noopener noreferrer", style: "background:" + bg + ";border-top:4px solid " + accent });
    if (s.thumb) {
      const shotWrap = bvH("div", { class: "bv-exp-shotwrap", style: "background:" + accent });
      const shot = bvH("img", { class: "bv-exp-shot", src: s.thumb, alt: "", loading: "lazy" });
      shot.addEventListener("error", () => { shotWrap.style.display = "none"; });   // fall back to the favicon/title header below
      shotWrap.appendChild(shot); a.appendChild(shotWrap);
    }
    const top = bvH("div", { class: "bv-exp-cardtop" });
    const f = s.favicon || "";
    let fav = null;
    if (f && !/^[a-z][a-z0-9+.\-]*:/i.test(f)) {
      const src = s.url.replace(/\/$/, "") + (f[0] === "/" ? "" : "/") + f;
      fav = bvH("img", { class: "bv-exp-fav", src: src, alt: "", loading: "lazy" });
      fav.addEventListener("error", () => { fav.style.display = "none"; badge.style.display = ""; });
    }
    const badge = bvH("span", { class: "bv-exp-badge", style: "background:" + accent + (fav ? ";display:none" : "") }, (String(s.title || s.handle || "?").trim().charAt(0) || "?").toUpperCase());
    if (fav) top.appendChild(fav);
    top.appendChild(badge);
    top.appendChild(bvH("span", { class: "bv-exp-cardttl" }, s.title || s.handle));
    a.appendChild(top);
    if (s.description) a.appendChild(bvH("p", { class: "bv-exp-desc" }, s.description));
    a.appendChild(bvH("div", { class: "bv-exp-host" }, s.handle + ".yourdomain.com"));
    if (Array.isArray(s.tags) && s.tags.length) {
      const tg = bvH("div", { class: "bv-exp-tags" });
      s.tags.slice(0, 5).forEach((t) => tg.appendChild(bvH("button", { class: "bv-exp-tag", type: "button", onclick: (e) => { e.preventDefault(); e.stopPropagation(); setTag(t); } }, "#" + t)));
      a.appendChild(tg);
    }
    return a;
  }
  async function load(reset) {
    if (state.loading) return;
    state.loading = true; moreBtn.disabled = true;
    if (reset) { state.page = 1; grid.replaceChildren(); status.replaceChildren(bvH("div", { class: "bv-exp-spin" })); moreWrap.style.display = "none"; }
    const qs = new URLSearchParams({ sort: state.sort, page: String(state.page), limit: String(LIMIT) });
    if (state.q) qs.set("q", state.q);
    if (state.tag) qs.set("tag", state.tag);
    const r = await api("GET", "/api/sites/index?" + qs.toString());
    state.loading = false; moreBtn.disabled = false;
    if (!r.ok) { status.replaceChildren(); grid.replaceChildren(bvH("p", { class: "bv-exp-empty" }, r.status === 0 ? "Can't reach the server. Try again." : "Couldn't load the directory (status " + r.status + ").")); return; }
    state.total = r.data.total || 0;
    const sites = r.data.sites || [];
    if (reset && !sites.length) {
      status.replaceChildren();
      grid.replaceChildren(bvH("div", { class: "bv-exp-empty" },
        bvH("p", null, state.q || state.tag ? "No sites match your search." : "No sites published yet — be the first!"),
        bvH("a", { class: "bv-exp-btn", href: "#/site", style: "margin-top:.6rem" }, "Build your site")));
      return;
    }
    status.textContent = state.total + (state.total === 1 ? " site" : " sites") + (state.q || state.tag ? " found" : "");
    for (const s of sites) grid.appendChild(card(s));
    moreWrap.style.display = (state.page * LIMIT < state.total) ? "" : "none";
  }
  let deb = null;
  search.addEventListener("input", () => { clearTimeout(deb); deb = setTimeout(() => { state.q = search.value.trim(); load(true); }, 300); });
  sortSel.addEventListener("change", () => { state.sort = sortSel.value; load(true); });
  load(true);
})
