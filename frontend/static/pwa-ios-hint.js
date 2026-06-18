/* Blindvault — iOS "Add to Home Screen" tip.
 * iOS Safari never fires beforeinstallprompt, so the app's in-page Install button
 * cannot appear there. This shows iOS Safari users (who haven't installed yet) a
 * one-time, dismissible hint on how to install. Built with DOM APIs only (no
 * innerHTML) so it complies with the page's Trusted Types policy. */
(function () {
  'use strict';
  try {
    var nav = window.navigator, ua = nav.userAgent || '';
    var isIOS = /iP(hone|od|ad)/.test(ua) || (nav.platform === 'MacIntel' && nav.maxTouchPoints > 1); // iPadOS reports as Mac
    var isSafari = /Safari/.test(ua) && !/(CriOS|FxiOS|EdgiOS|Chrome|Android)/.test(ua);
    var installed = (('standalone' in nav) && nav.standalone) || (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches);
    if (!isIOS || !isSafari || installed) return;
    try { if (localStorage.getItem('bv.ios.a2hs') === 'dismissed') return; } catch (e) {}

    var make = function (tag, css, text) { var el = document.createElement(tag); if (css) el.style.cssText = css; if (text != null) el.textContent = text; return el; };
    var show = function () {
      if (document.getElementById('bv-ios-a2hs') || !document.body) return;
      var bar = make('div', 'position:fixed;left:.6rem;right:.6rem;bottom:calc(.6rem + env(safe-area-inset-bottom));z-index:2147483000;background:#15110d;color:#fff;border-radius:.75rem;padding:.75rem .8rem;box-shadow:0 8px 28px rgba(0,0,0,.35);font-family:system-ui,-apple-system,sans-serif;font-size:.9rem;line-height:1.4;display:flex;align-items:flex-start;gap:.6rem');
      bar.id = 'bv-ios-a2hs'; bar.setAttribute('role', 'dialog'); bar.setAttribute('aria-label', 'Install this app');
      bar.appendChild(make('div', 'font-size:1.4rem;flex:none;line-height:1', '📲')); // mobile-with-arrow
      var msg = make('div', 'flex:1');
      msg.appendChild(make('div', 'font-weight:700;margin-bottom:.15rem', 'Install Blindvault'));
      msg.appendChild(make('div', 'opacity:.92', 'Tap the Share icon at the bottom of Safari, then choose “Add to Home Screen.”'));
      bar.appendChild(msg);
      var close = make('button', 'flex:none;background:none;border:0;color:#fff;font-size:1.1rem;cursor:pointer;padding:.1rem .35rem;opacity:.85;line-height:1', '✕');
      close.type = 'button'; close.setAttribute('aria-label', 'Dismiss');
      close.addEventListener('click', function () { try { localStorage.setItem('bv.ios.a2hs', 'dismissed'); } catch (e) {} bar.remove(); });
      bar.appendChild(close);
      document.body.appendChild(bar);
    };
    var start = function () { setTimeout(show, 2500); };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true }); else start();
  } catch (e) {}
})();
