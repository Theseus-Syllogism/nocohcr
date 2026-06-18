// bv-films-mount — adds a "Films & TV" section to the Digital Library page (#/library).
// Shipped as a comma-chained expression injected after Pu("emergency",...), so it must stay a
// single EXPRESSION (no statements/declarations). It defines a global that the patched library
// handler calls AFTER LC(u) has rendered the page. No new route and no nav entry: this is an
// extra section inside the existing Library page, beside the other media tools.
,(self.bvFilmsMount = function (host) {
  try {
    if (!host || !host.querySelector) return;
    // Anchor to the existing media tools. If neither is present the library did not render
    // (e.g. LC redirected an anonymous visitor to #/login), so mount nothing.
    var anchor = host.querySelector("#bv-dr-downloader") || host.querySelector(".bv-library");
    if (!anchor) {
      // LC builds synchronously, but retry once on the next frame as a safety net.
      if (!host.__bvFilmsRetried) {
        host.__bvFilmsRetried = 1;
        requestAnimationFrame(function () { self.bvFilmsMount(host); });
      }
      return;
    }
    if (host.querySelector("#bv-dr-films")) return; // already mounted for this render

    var sec = document.createElement("section");
    sec.id = "bv-dr-films";
    sec.className = "bv-library bv-card";
    sec.style.marginTop = "1.25rem";
    var mount = document.createElement("div");
    sec.appendChild(mount);

    // Place it right after the downloader's card when we can find it, else after the library card.
    var card = anchor.closest ? (anchor.closest("section") || anchor) : anchor;
    if (card && card.parentNode) card.parentNode.insertBefore(sec, card.nextSibling);
    else host.appendChild(sec);

    import("./chunks/__FILMS_HASH__")
      .then(function (m) { return m.renderFilms(mount); })
      .catch(function (e) {
        mount.textContent = "The film section couldn't load (it may have just updated).";
        console.error("bv-films chunk", e);
      });
  } catch (e) { console.error("bv-films mount", e); }
})
