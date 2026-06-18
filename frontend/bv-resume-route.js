,Pu("resume", async (u) => {
  // Resume Builder — structured editor + live preview, loaded as a content-hashed chunk.
  const api = async (method, path, body) => {
    let id = Mu(), token = id ? await ce(id) : null, hh = {};
    if (token) hh.authorization = "Bearer " + token;
    let o = { method, headers: hh };
    if (body !== undefined) { hh["content-type"] = "application/json"; o.body = JSON.stringify(body); }
    let r; try { r = await fetch(path, o); } catch (e) { return { ok: false, status: 0, data: { error: "network" } }; }
    let d = {}; try { d = await r.json(); } catch (e) {}
    return { ok: r.ok, status: r.status, data: d };
  };
  const bearer = async () => { let id = Mu(); return id ? ("Bearer " + await ce(id)) : null; };
  u.replaceChildren();
  let loading = document.createElement("p"); loading.setAttribute("style", "padding:1rem;color:#666"); loading.textContent = "Loading the résumé builder…"; u.appendChild(loading);
  let mod;
  try { mod = await import("./chunks/__RESUME_HASH__"); }
  catch (e) {
    u.replaceChildren();
    let box = document.createElement("div"); box.setAttribute("style", "padding:1rem");
    box.appendChild(document.createTextNode("The résumé builder couldn't load (it may have just updated). "));
    let b = document.createElement("button"); b.type = "button"; b.setAttribute("style", "padding:.4rem .8rem;cursor:pointer"); b.textContent = "Reload"; b.addEventListener("click", () => location.reload());
    box.appendChild(b); u.appendChild(box); return;
  }
  u.replaceChildren();
  try { await mod.renderResume(u, { api, bearer }); }
  catch (e) {
    let p = document.createElement("p"); p.setAttribute("style", "padding:1rem;color:#b00"); p.textContent = "Résumé builder error: " + (e && e.message || e);
    u.appendChild(p);
  }
})
