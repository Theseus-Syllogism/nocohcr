(function () {
  function show() {
    var onDirections = /^\/directions\/?$/.test(window.location.pathname) ||
                       /^#\/directions(\/|$)/.test(window.location.hash);
    var existing = document.getElementById('bv-directions-banner');
    if (existing && !onDirections) { existing.remove(); return; }
    if (!existing && onDirections) {
      var banner = document.createElement('div');
      banner.id = 'bv-directions-banner';
      banner.setAttribute('role', 'alert');
      banner.style.cssText = [
        'background:#b91c1c',
        'color:#fff',
        'text-align:center',
        'padding:0.75rem 1rem',
        'font-size:1rem',
        'font-weight:600',
        'line-height:1.4',
        'z-index:9999',
        'position:relative',
      ].join(';');
      banner.innerHTML =
        '&#x26A0;&#xFE0F; Emergency: The Flock camera safe-routing map is available at ' +
        '<a href="https://yourdomain.com/directions#/safe-routing" ' +
        'style="color:#fff;text-decoration:underline;">' +
        'yourdomain.com/directions#/safe-routing</a>';
      var header = document.querySelector('.bv-masthead');
      if (header && header.parentNode) {
        header.parentNode.insertBefore(banner, header.nextSibling);
      } else {
        document.body.insertBefore(banner, document.body.firstChild);
      }
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', show);
  } else {
    show();
  }

  // re-check on SPA navigation (hash changes)
  window.addEventListener('popstate', show);
  window.addEventListener('hashchange', show);
})();
