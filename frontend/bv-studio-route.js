,Pu("studio", async (u) => {
  const api = async (method, path, body) => {
    let id = Mu(), token = id ? await ce(id) : null, hh = {};
    if (token) hh.authorization = "Bearer " + token;
    let o = { method, headers: hh };
    if (body !== undefined) { hh["content-type"] = "application/json"; o.body = JSON.stringify(body); }
    let r; try { r = await fetch(path, o); } catch (e) { return { ok: false, status: 0, data: { error: "network" } }; }
    let d = {}; try { d = await r.json(); } catch (e) {}
    return { ok: r.ok, status: r.status, data: d };
  };
  u.replaceChildren();
  if (!Mu()) {
    let p = document.createElement("p"); p.setAttribute("style", "padding:1rem");
    let a = document.createElement("a"); a.setAttribute("href", "#/login"); a.textContent = "sign in";
    p.appendChild(document.createTextNode("Please ")); p.appendChild(a); p.appendChild(document.createTextNode(" to use the builder."));
    u.appendChild(p); return;
  }
  let loading = document.createElement("p"); loading.setAttribute("style", "padding:1rem;color:#666"); loading.textContent = "Loading builder…"; u.appendChild(loading);
  let mod;
  try { mod = await import("./chunks/__BUILDER_HASH__"); }
  catch (e) {
    // A stale service worker / cache can 404 a freshly-hashed chunk -> offer reload.
    u.replaceChildren();
    let box = document.createElement("div"); box.setAttribute("style", "padding:1rem");
    box.appendChild(document.createTextNode("The builder couldn't load (it may have just updated). "));
    let b = document.createElement("button"); b.type = "button"; b.setAttribute("style", "padding:.4rem .8rem;cursor:pointer"); b.textContent = "Reload"; b.addEventListener("click", () => location.reload());
    box.appendChild(b); u.appendChild(box); return;
  }
  let me = await api("GET", "/api/sites/me");
  u.replaceChildren();
  try { await mod.renderBuilder(u, { api, me: (me && me.data) || {} }); }
  catch (e) {
    let p = document.createElement("p"); p.setAttribute("style", "padding:1rem;color:#b00"); p.textContent = "Builder error: " + (e && e.message || e);
    u.appendChild(p);
  }
})
