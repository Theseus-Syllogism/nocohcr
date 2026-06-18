/*! bv-widgets — curated runtime for yourdomain.com user sites.
 * The ONLY script allowed to run on a published <handle>.yourdomain.com page
 * (injected at the edge by nginx sub_filter; CSP script-src 'self'). Users
 * never write JS — they configure widgets that emit static, data-bv-* markup
 * which this audited, dependency-free script progressively enhances.
 *
 * No eval, no Function(), no storage, no cookies, no external network. The
 * only network call is a same-origin fetch from the contact-form widget.
 * Every widget is meaningful + usable with JS OFF; this only upgrades it.
 *
 * CANONICAL data-bv-* CONTRACT (the serializer MUST emit exactly this):
 *   nav      : <nav data-bv-nav> <button data-bv-nav-toggle aria-controls="ID" aria-expanded="false"> + <ul id="ID" data-bv-nav-menu>
 *              dropdown item: <li class="bv-has-sub"><button data-bv-sub-toggle aria-controls="SID" aria-expanded="false">…▾</button>
 *              <ul id="SID" data-bv-sub-menu>…</ul></li>  (submenus visible w/o JS; html.bv-js collapses them)
 *   tabs     : <div data-bv-tabs> <div role="tablist"><button role="tab" aria-controls="P" id="T" aria-selected>…</button>…</div>
 *              <div role="tabpanel" id="P" aria-labelledby="T">…</div>…   (panels NOT [hidden] in source → visible w/o JS)
 *   accordion: <div data-bv-accordion [data-bv-single]> <details><summary>…</summary>…</details>… (native; single-open optional)
 *   carousel : <div data-bv-carousel> <div data-bv-track><div class="bv-slide">…</div>…</div>
 *              <button data-bv-prev><button data-bv-next>  (CSS scroll-snap base works w/o JS)
 *   gallery  : <div data-bv-gallery> <a data-bv-item href="/media/full.jpg"><img src="/media/thumb.jpg" alt="…"></a>…
 *   form     : <div data-bv-form role="form" aria-label="…"> <label>…<input name="x"></label>…
 *              <input data-bv-hp name="_hp" tabindex="-1" autocomplete="off" aria-hidden="true">
 *              <button data-bv-submit>Send</button> <p data-bv-status role="status" aria-live="polite"></p>
 *   smooth   : automatic for same-page <a href="#id"> (no marker)
 */
(function () {
  'use strict';
  if (window.__bvWidgets) return;            // idempotent
  window.__bvWidgets = true;
  var D = document, root = D.documentElement;
  var reduce = false;
  try { reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) {}
  var $ = function (sel, ctx) { return Array.prototype.slice.call((ctx || D).querySelectorAll(sel)); };
  var uid = (function () { var n = 0; return function () { return 'bv' + (++n); }; })();

  function ready(fn) {
    if (D.readyState === 'loading') D.addEventListener('DOMContentLoaded', fn, { once: true });
    else fn();
  }

  // --- smooth scroll (automatic) -----------------------------------------
  function initSmoothScroll() {
    D.addEventListener('click', function (e) {
      var a = e.target.closest && e.target.closest('a[href^="#"]');
      if (!a) return;
      var id = a.getAttribute('href').slice(1);
      if (!id) return;
      var t = D.getElementById(id) || D.querySelector('[name="' + CSS.escape(id) + '"]');
      if (!t) return;
      e.preventDefault();
      t.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
      if (!t.hasAttribute('tabindex')) t.setAttribute('tabindex', '-1');
      t.focus({ preventScroll: true });
    });
  }

  // --- nav: mobile toggle + dropdown submenus -----------------------------
  function initNav() {
    // top-level mobile menu toggle
    $('[data-bv-nav-toggle]').forEach(function (btn) {
      var menu = D.getElementById(btn.getAttribute('aria-controls'));
      if (!menu) return;
      btn.setAttribute('aria-expanded', 'false');
      btn.addEventListener('click', function () {
        var open = btn.getAttribute('aria-expanded') === 'true';
        btn.setAttribute('aria-expanded', String(!open));
        menu.classList.toggle('bv-open', !open);
        if (open) closeSubs(null); // collapsing the menu also resets any open dropdown
      });
      D.addEventListener('keydown', function (e) {
        if (e.key === 'Escape' && btn.getAttribute('aria-expanded') === 'true') {
          btn.setAttribute('aria-expanded', 'false'); menu.classList.remove('bv-open'); btn.focus();
        }
      });
    });
    // dropdown submenus (click to toggle; one open at a time; Esc / outside-click close)
    var subToggles = $('[data-bv-sub-toggle]');
    function closeSubs(except) {
      subToggles.forEach(function (b) {
        if (b === except || b.getAttribute('aria-expanded') !== 'true') return;
        b.setAttribute('aria-expanded', 'false');
        var m = D.getElementById(b.getAttribute('aria-controls'));
        if (m) m.classList.remove('bv-open');
      });
    }
    subToggles.forEach(function (btn) {
      var menu = D.getElementById(btn.getAttribute('aria-controls'));
      if (!menu) return;
      btn.setAttribute('aria-expanded', 'false');
      btn.addEventListener('click', function (e) {
        e.preventDefault();
        var open = btn.getAttribute('aria-expanded') === 'true';
        closeSubs(open ? null : btn);
        btn.setAttribute('aria-expanded', String(!open));
        menu.classList.toggle('bv-open', !open);
      });
    });
    if (subToggles.length) {
      D.addEventListener('click', function (e) {
        if (!(e.target.closest && e.target.closest('.bv-has-sub'))) closeSubs(null);
      });
      D.addEventListener('keydown', function (e) {
        if (e.key === 'Escape') {
          var open = D.querySelector('[data-bv-sub-toggle][aria-expanded="true"]');
          if (open) { closeSubs(null); open.focus(); }
        }
      });
    }
  }

  // --- tabs (panels visible w/o JS; JS hides inactive) --------------------
  function initTabs() {
    $('[data-bv-tabs]').forEach(function (w) {
      var tabs = $('[role="tab"]', w);
      if (!tabs.length) return;
      var panels = tabs.map(function (t) { return D.getElementById(t.getAttribute('aria-controls')); });
      function select(i, focus) {
        tabs.forEach(function (t, j) {
          var on = i === j;
          t.setAttribute('aria-selected', String(on));
          t.tabIndex = on ? 0 : -1;
          if (panels[j]) panels[j].hidden = !on;
          if (on && focus) t.focus();
        });
      }
      var start = tabs.findIndex(function (t) { return t.getAttribute('aria-selected') === 'true'; });
      select(start < 0 ? 0 : start, false);
      tabs.forEach(function (t, i) {
        t.addEventListener('click', function () { select(i, false); });
        t.addEventListener('keydown', function (e) {
          var n = tabs.length, k = e.key, j = -1;
          if (k === 'ArrowRight' || k === 'ArrowDown') j = (i + 1) % n;
          else if (k === 'ArrowLeft' || k === 'ArrowUp') j = (i - 1 + n) % n;
          else if (k === 'Home') j = 0; else if (k === 'End') j = n - 1;
          if (j >= 0) { e.preventDefault(); select(j, true); }
        });
      });
    });
  }

  // --- accordion (native <details>; optional single-open) ----------------
  function initAccordion() {
    $('[data-bv-accordion][data-bv-single]').forEach(function (w) {
      var items = $('details', w);
      items.forEach(function (d) {
        d.addEventListener('toggle', function () {
          if (d.open) items.forEach(function (o) { if (o !== d) o.open = false; });
        });
      });
    });
  }

  // --- carousel (CSS scroll-snap base; JS adds controls) -----------------
  function initCarousel() {
    $('[data-bv-carousel]').forEach(function (w) {
      var track = w.querySelector('[data-bv-track]'); if (!track) return;
      var slides = $('.bv-slide', track);
      var prev = w.querySelector('[data-bv-prev]'), next = w.querySelector('[data-bv-next]');
      function go(dir) {
        var x = track.scrollLeft, w0 = slides.length ? slides[0].offsetWidth + 16 : track.clientWidth;
        track.scrollTo({ left: x + dir * w0, behavior: reduce ? 'auto' : 'smooth' });
      }
      if (prev) prev.addEventListener('click', function () { go(-1); });
      if (next) next.addEventListener('click', function () { go(1); });
      w.setAttribute('tabindex', '0');
      w.addEventListener('keydown', function (e) {
        if (e.key === 'ArrowRight') { e.preventDefault(); go(1); }
        else if (e.key === 'ArrowLeft') { e.preventDefault(); go(-1); }
      });
    });
  }

  // --- gallery lightbox (no-JS: link opens full image) -------------------
  var lb = null;
  function lightbox() {
    if (lb) return lb;
    var ov = D.createElement('div');
    ov.className = 'bv-lightbox'; ov.setAttribute('role', 'dialog'); ov.setAttribute('aria-modal', 'true'); ov.hidden = true;
    var img = D.createElement('img'); img.className = 'bv-lightbox-img'; img.alt = '';
    var close = D.createElement('button'); close.type = 'button'; close.className = 'bv-lightbox-close'; close.setAttribute('aria-label', 'Close'); close.textContent = '×';
    var p = D.createElement('button'); p.type = 'button'; p.className = 'bv-lightbox-prev'; p.setAttribute('aria-label', 'Previous'); p.textContent = '‹';
    var n = D.createElement('button'); n.type = 'button'; n.className = 'bv-lightbox-next'; n.setAttribute('aria-label', 'Next'); n.textContent = '›';
    ov.appendChild(img); ov.appendChild(close); ov.appendChild(p); ov.appendChild(n);
    D.body.appendChild(ov);
    var group = [], idx = 0, lastFocus = null;
    function show(i) { idx = (i + group.length) % group.length; var a = group[idx]; img.src = a.getAttribute('href'); img.alt = (a.querySelector('img') || {}).alt || ''; }
    function open(g, i, trigger) { group = g; lastFocus = trigger; ov.hidden = false; D.body.style.overflow = 'hidden'; show(i); close.focus(); }
    function shut() { ov.hidden = true; D.body.style.overflow = ''; img.src = ''; if (lastFocus) lastFocus.focus(); }
    close.addEventListener('click', shut);
    p.addEventListener('click', function () { show(idx - 1); });
    n.addEventListener('click', function () { show(idx + 1); });
    ov.addEventListener('click', function (e) { if (e.target === ov) shut(); });
    D.addEventListener('keydown', function (e) {
      if (ov.hidden) return;
      if (e.key === 'Escape') shut();
      else if (e.key === 'ArrowRight') show(idx + 1);
      else if (e.key === 'ArrowLeft') show(idx - 1);
      else if (e.key === 'Tab') { e.preventDefault(); close.focus(); } // simple focus trap
    });
    lb = { open: open };
    return lb;
  }
  function initGallery() {
    $('[data-bv-gallery]').forEach(function (g) {
      var items = $('a[data-bv-item][href]', g);
      items.forEach(function (a, i) {
        a.addEventListener('click', function (e) {
          if (e.metaKey || e.ctrlKey || e.shiftKey || e.button) return; // let user open in new tab
          e.preventDefault();
          lightbox().open(items, i, a);
        });
      });
    });
  }

  // --- contact form (same-origin POST; honeypot + min-fill-time) ---------
  function initForms() {
    $('[data-bv-form]').forEach(function (w) {
      var btn = w.querySelector('[data-bv-submit]');
      var status = w.querySelector('[data-bv-status]');
      if (!btn) return;
      var loadedAt = Date.now();
      function setStatus(msg, kind) { if (status) { status.textContent = msg; status.dataset.kind = kind || ''; } }
      btn.addEventListener('click', function () {
        var hp = w.querySelector('[data-bv-hp]');
        if (hp && hp.value) { setStatus('Thanks!', 'ok'); return; }          // bot trap: pretend success
        if (Date.now() - loadedAt < 3000) { setStatus('Please take a moment, then send.', 'err'); return; }
        var fields = {}, ok = true;
        $('input[name], textarea[name], select[name]', w).forEach(function (el) {
          if (el.getAttribute('data-bv-hp') !== null || el.name === '_hp') return;
          if (el.required && !String(el.value).trim()) ok = false;
          fields[el.name] = String(el.value).slice(0, 5000);
        });
        if (!ok) { setStatus('Please fill in the required fields.', 'err'); return; }
        btn.disabled = true; setStatus('Sending…', '');
        fetch('/api/sites/form', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ fields: fields, _hp: hp ? hp.value : '', _elapsed: Date.now() - loadedAt })
        }).then(function (r) { return r.ok ? r.json().catch(function () { return {}; }) : Promise.reject(r); })
          .then(function () { setStatus(w.getAttribute('data-bv-success') || 'Thanks! Your message was sent.', 'ok'); btn.disabled = false; w.querySelectorAll('input,textarea,select').forEach(function (el) { if (el.type !== 'hidden' && el.getAttribute('data-bv-hp') === null) el.value = ''; }); })
          .catch(function () { setStatus('Sorry, that didn’t send. Please try again later.', 'err'); btn.disabled = false; });
      });
    });
  }

  ready(function () {
    root.classList.add('bv-js');
    try { initSmoothScroll(); } catch (e) {}
    try { initNav(); } catch (e) {}
    try { initTabs(); } catch (e) {}
    try { initAccordion(); } catch (e) {}
    try { initCarousel(); } catch (e) {}
    try { initGallery(); } catch (e) {}
    try { initForms(); } catch (e) {}
  });
})();
