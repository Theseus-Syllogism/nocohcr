/* Blindvault — Trusted Types "default" policy (XSS hardening).
 *
 * Registered before the app bundle runs. When the CSP enforces
 * `require-trusted-types-for 'script'`, the browser routes every string passed
 * to an injection sink (innerHTML, etc.) through this policy's createHTML — so
 * all ~224 innerHTML sinks in the bundle get DOMPurify-sanitized with no bundle
 * edits. createScript / createScriptURL pass through: the app's libraries use
 * `Function`, dynamic script src and workers internally (not from user input),
 * and blocking those would break the app; HTML sanitization is the real XSS
 * defense here. Offline-tested against the app's Shoelace/SVG/data-attr markup
 * (preserved) and a battery of XSS vectors (neutralized).
 *
 * Until the CSP enforces TT this policy is dormant (the browser only invokes a
 * default policy under enforcement). The matching CSP directive is:
 *   require-trusted-types-for 'script'; trusted-types default bv-email dompurify 'allow-duplicates'
 */
(function () {
  var TT = window.trustedTypes;
  if (!TT || typeof TT.createPolicy !== "function") return; // older browsers: no TT, no-op

  var DP = window.DOMPurify;

  // Allow Shoelace custom-element attributes that aren't in DOMPurify's default
  // allowlist, plus SVG presentation attributes used by the icon sprite.
  var NONSTD_ATTR = ["variant", "size", "pill", "outline", "circle", "summary", "effect",
    "panel", "fieldset", "open", "checked", "indeterminate", "loading", "disabled", "label",
    "value", "placeholder", "slot", "name", "for", "target", "rel", "href", "xlink:href",
    "tabindex", "hidden", "datetime", "autocomplete", "autocapitalize", "spellcheck", "type",
    "allow", "allowfullscreen", "title", "controls", "playsinline", "focusable", "part", "exportparts",
    "media", "crossorigin", "viewBox", "d", "points", "transform", "clip-rule", "fill-rule"];

  var CFG = {
    CUSTOM_ELEMENT_HANDLING: {
      tagNameCheck: /^sl-[a-z-]+$/,                 // Shoelace components
      attributeNameCheck: /^(?!on)[a-zA-Z][a-zA-Z0-9-]*$/i, // any attr EXCEPT on* handlers
      allowCustomizedBuiltInElements: false
    },
    ADD_TAGS: ["use"],                              // SVG sprite <use href="#i-...">
    ADD_ATTR: NONSTD_ATTR
  };

  if (DP && typeof DP.addHook === "function") {
    // Defense-in-depth beyond DOMPurify's defaults, covering custom elements too.
    DP.addHook("uponSanitizeAttribute", function (node, data) {
      var name = (data.attrName || "").toLowerCase();
      var raw = data.attrValue || "";
      if (/^on/.test(name)) { data.keepAttr = false; return; }            // event handlers
      if (name === "formaction" || name === "form" || name === "formmethod" ||
          name === "formtarget" || name === "formenctype") { data.keepAttr = false; return; }
      var v = raw.replace(/\s+/g, "").toLowerCase();
      if (v.indexOf("javascript:") === 0 || v.indexOf("vbscript:") === 0 ||
          v.indexOf("data:text/html") === 0) { data.keepAttr = false; return; }
      var tag = node && node.nodeName ? node.nodeName.toLowerCase() : "";
      if ((name === "href" || name === "xlink:href") && tag === "use" &&
          raw.trim().charAt(0) !== "#") { data.keepAttr = false; return; } // same-doc sprite refs only
      if (name === "style" && /(javascript:|expression\(|url\(\s*['"]?\s*javascript:)/i.test(raw)) {
        data.keepAttr = false; return;
      }
    });
  }

  function sanitizeHTML(s) {
    try {
      if (DP && typeof DP.sanitize === "function") return DP.sanitize(s, CFG);
    } catch (e) { /* fall through */ }
    // DOMPurify unavailable: prefer availability over hard failure for this audience.
    if (window.console) console.warn("[tt] DOMPurify unavailable; HTML passed through unsanitized");
    return s;
  }

  try {
    TT.createPolicy("default", {
      createHTML: function (s) { return sanitizeHTML(s); },
      createScript: function (s) { return s; },       // internal Function/eval/document.write
      createScriptURL: function (s) { return s; }      // internal script src / workers / dynamic import
    });
  } catch (e) {
    // A "default" policy already exists, or policy creation was blocked. Either
    // way, don't break boot.
    if (window.console) console.warn("[tt] default policy not registered:", e && e.message);
  }
})();
