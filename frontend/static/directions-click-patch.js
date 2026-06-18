(function () {

  // ── Google / Apple Maps export for #/directions ────────────────────────────
  var _dirRoute = null; // {origin, destination, mode, geometry}

  var GMAPS_MODE = { foot: 'walking', bicycle: 'bicycling', driving: 'driving' };
  var AMAPS_MODE = { foot: 'w',       bicycle: 'w',         driving: 'd'       };

  // Intercept fetch to capture /api/route GET responses
  (function () {
    var orig = window.fetch;
    window.fetch = function (url, opts) {
      var promise = orig.apply(this, arguments);
      if (typeof url === 'string' && /\/api\/route(\?|$)/.test(url)) {
        promise = promise.then(function (resp) {
          resp.clone().json().then(function (data) {
            try {
              var p = new URL(url, window.location.origin).searchParams;
              var from = p.get('from').split(',');
              var to   = p.get('to').split(',');
              _dirRoute = {
                origin:      { lat: parseFloat(from[0]), lon: parseFloat(from[1]) },
                destination: { lat: parseFloat(to[0]),   lon: parseFloat(to[1])   },
                mode:        p.get('mode') || 'foot',
                geometry:    data.geometry || [],
              };
            } catch (e) {}
          }).catch(function () {});
          return resp;
        });
      }
      return promise;
    };
  })();

  // Sample n evenly-spaced interior waypoints (excl. start/end)
  function sampleWaypoints(coords, n) {
    if (!coords || coords.length <= 2) return [];
    var inner = coords.slice(1, -1);
    if (inner.length <= n) return inner;
    var result = [], step = inner.length / n;
    for (var i = 0; i < n; i++) result.push(inner[Math.round(i * step)]);
    return result;
  }

  function openDirInMaps(provider) {
    if (!_dirRoute) return;
    var org = _dirRoute.origin, dst = _dirRoute.destination, mode = _dirRoute.mode;
    if (provider === 'google') {
      var wpts = sampleWaypoints(_dirRoute.geometry, 8)
        .map(function (c) { return c[1].toFixed(6) + ',' + c[0].toFixed(6); });
      var u = new URL('https://www.google.com/maps/dir/');
      u.searchParams.set('api', '1');
      u.searchParams.set('origin',      org.lat + ',' + org.lon);
      u.searchParams.set('destination', dst.lat + ',' + dst.lon);
      u.searchParams.set('travelmode',  GMAPS_MODE[mode] || 'walking');
      if (wpts.length) u.searchParams.set('waypoints', wpts.join('|'));
      window.open(u.toString(), '_blank', 'noopener');
    } else {
      window.open(
        'https://maps.apple.com/?saddr=' + org.lat + ',' + org.lon +
        '&daddr=' + dst.lat + ',' + dst.lon +
        '&dirflg=' + (AMAPS_MODE[mode] || 'w'),
        '_blank', 'noopener'
      );
    }
  }

  function injectMapsButtons(exportDiv) {
    if (exportDiv.querySelector('.bv-dir-ext-maps')) return;
    var gmaps = document.createElement('button');
    gmaps.type = 'button';
    gmaps.className = 'bv-button-secondary bv-dir-ext-maps';
    gmaps.textContent = 'Open in Google Maps';
    gmaps.addEventListener('click', function () { openDirInMaps('google'); });

    var amaps = document.createElement('button');
    amaps.type = 'button';
    amaps.className = 'bv-button-secondary bv-dir-ext-maps';
    amaps.textContent = 'Open in Apple Maps';
    amaps.addEventListener('click', function () { openDirInMaps('apple'); });

    var note = document.createElement('p');
    note.className = 'bv-text-tertiary bv-text-small';
    note.textContent = 'Google Maps follows the route via waypoints; Apple Maps routes start→end only.';

    exportDiv.appendChild(gmaps);
    exportDiv.appendChild(amaps);
    exportDiv.appendChild(note);
  }

  // ── End maps export ────────────────────────────────────────────────────────

  var DRAG_THRESHOLD = 6;
  var IGNORE = '.bv-map-controls,.bv-map-pin,.bv-map-popup,.bv-map-attribution';

  function addHint(map) {
    if (map.querySelector('.bv-click-hint')) return;
    var hint = document.createElement('div');
    hint.className = 'bv-click-hint';
    hint.setAttribute('aria-hidden', 'true');
    hint.textContent = 'Left-click or right-click to place a pin and start directions';
    hint.style.cssText = [
      'position:absolute',
      'bottom:3rem',
      'left:50%',
      'transform:translateX(-50%)',
      'background:rgba(0,0,0,0.72)',
      'color:#fff',
      'font-size:0.78rem',
      'font-weight:500',
      'padding:0.35rem 0.9rem',
      'border-radius:999px',
      'pointer-events:none',
      'white-space:nowrap',
      'transition:opacity 0.7s',
      'z-index:20',
    ].join(';');

    // Ensure the map can contain an absolutely-positioned child
    if (getComputedStyle(map).position === 'static') {
      map.style.position = 'relative';
    }
    map.appendChild(hint);

    // Dismiss after the first pin is placed
    map.addEventListener('contextmenu', function dismiss() {
      setTimeout(function () { hint.style.opacity = '0'; }, 1500);
      setTimeout(function () { hint.remove(); }, 2300);
      map.removeEventListener('contextmenu', dismiss);
    });
  }

  function patchMap(map) {
    if (map._bvClickPatched) return;
    map._bvClickPatched = true;

    // Track pointer-down position per map so we can distinguish click from drag
    map.addEventListener('pointerdown', function (e) {
      map._bvPtrStart = { x: e.clientX, y: e.clientY };
    });

    map.addEventListener('click', function (e) {
      if (e.target.closest(IGNORE)) return;
      var start = map._bvPtrStart;
      if (!start) return;
      if (Math.hypot(e.clientX - start.x, e.clientY - start.y) > DRAG_THRESHOLD) return;
      // Fire a synthetic contextmenu at the same coordinates so the app's
      // existing pin-placement handler (which listens for contextmenu) picks it up
      map.dispatchEvent(new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        clientX: e.clientX,
        clientY: e.clientY,
        button: 2,
      }));
    });

    addHint(map);
  }

  // ── Directions step arrow rewriter ──────────────────────────────────────
  // Maps keywords in the instruction text to a directional arrow emoji.
  var ARROW_RULES = [
    [/\bu-turn\b/i,               '↩'],
    [/\bsharp\s+left\b/i,         '↰'],
    [/\bsharp\s+right\b/i,        '↱'],
    [/\bslight\s+left\b/i,        '↖'],
    [/\bslight\s+right\b/i,       '↗'],
    [/\bturn\s+left\b/i,          '←'],
    [/\bturn\s+right\b/i,         '→'],
    [/\bbear\s+left\b/i,          '↖'],
    [/\bbear\s+right\b/i,         '↗'],
    [/\bmerge\b/i,                '⤵'],
    [/\benter\s+roundabout\b/i,   '⟳'],
    [/\bleave\s+roundabout\b/i,   '↗'],
    [/\btake\s+exit\b/i,          '↗'],
    [/\bhead\s+north\b/i,         '↑'],
    [/\bhead\s+south\b/i,         '↓'],
    [/\bhead\s+east\b/i,          '→'],
    [/\bhead\s+west\b/i,          '←'],
    [/\bcontinue\b|\bgo\s+straight\b|\bstraight\b/i, '↑'],
    [/\barrive\b|\bdestination\b|\byou\s+have\s+arrived\b/i, '⚑'],
  ];

  function arrowFor(instruction, isFirst, isLast) {
    if (isFirst)  return '◉';   // start
    if (isLast)   return '⚑';   // arrive
    for (var i = 0; i < ARROW_RULES.length; i++) {
      if (ARROW_RULES[i][0].test(instruction)) return ARROW_RULES[i][1];
    }
    return '↑';   // default: straight
  }

  function rewriteSteps(ol) {
    var items = ol.querySelectorAll('li');
    items.forEach(function (li, idx) {
      if (li._bvArrowDone) return;
      li._bvArrowDone = true;

      // Original contents: <span>instruction</span> + optional <span class="bv-step-dist">
      var spans = li.querySelectorAll('span');
      var instrText = spans[0] ? spans[0].textContent : '';
      var distEl   = li.querySelector('.bv-step-dist');
      var distText = distEl ? distEl.textContent : '';

      var isFirst = idx === 0;
      var isLast  = idx === items.length - 1;
      var arrow   = arrowFor(instrText, isFirst, isLast);

      li.innerHTML =
        '<span class="bv-step-arrow" aria-hidden="true">' + arrow + '</span>' +
        '<span class="bv-step-instruction">' + escHtml(instrText) + '</span>' +
        (distText ? '<span class="bv-step-dist">' + escHtml(distText) + '</span>' : '');
    });
  }

  function escHtml(s) {
    return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  function observeStepList(ol) {
    if (ol._bvStepsObserved) return;
    ol._bvStepsObserved = true;
    rewriteSteps(ol);
    new MutationObserver(function () { rewriteSteps(ol); })
      .observe(ol, { childList: true });
  }

  function scan() {
    document.querySelectorAll('.bv-map').forEach(patchMap);
    var ol = document.getElementById('bv-dirtool-steps');
    if (ol) observeStepList(ol);
    var exportDiv = document.getElementById('bv-dirtool-export');
    if (exportDiv) injectMapsButtons(exportDiv);
  }

  // Observe for maps and step lists added by the SPA router
  new MutationObserver(scan).observe(document.body, { childList: true, subtree: true });
  scan();
})();
