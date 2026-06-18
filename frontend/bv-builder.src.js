// bv-builder — WYSIWYG site builder (iteration 2b-1), versioned chunk for #/studio.
// Iter2b-1 adds: a NESTED tree model (section / columns / column containers) with a
// recursive serializer + parent/index map, tree-aware ops, and pointer-based
// DRAG-AND-DROP (reorder on canvas + drag-from-palette to insert, with live drop
// indicators; touch + mouse, keyboard via the Layout tab's Up/Down/Out buttons).
// Carries forward iter2a: advanced theming engine (WCAG presets), per-element style
// overrides, Content/Style/Layout inspector tabs, templates, undo/redo, teardown.
// Architecture unchanged: ONE serializer feeds a sandboxed same-origin srcdoc iframe
// (delegated handlers + surgical patch + live <style>) AND the published files.
// (Dropdown nav widget + richer templates land in 2b-2.)
export async function renderBuilder(container, ctx) {
  const { api, me } = ctx || {};
  const handle = me && me.handle;

  // ---------- generic helpers ----------
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const safeHref = (v) => { const s = String(v || '').trim(); if (/^\/\//.test(s)) return '#'; return /^(https?:|mailto:|tel:|#|\/)/i.test(s) ? s : '#'; };
  const cssColor = (c) => (/^#[0-9a-fA-F]{6}$/.test(String(c || '')) ? String(c).toLowerCase() : null);
  const cssColorOr = (c, d) => cssColor(c) || d;
  const uid = () => 'e' + Math.random().toString(36).slice(2, 9);
  const oneOf = (v, set, d) => (set.indexOf(v) >= 0 ? v : d);
  const h = (tag, props, ...kids) => {
    const el = document.createElement(tag);
    if (props) for (const k in props) {
      if (k === 'style') el.setAttribute('style', props[k]);
      else if (k === 'class') el.className = props[k];
      else if (k.slice(0, 2) === 'on' && typeof props[k] === 'function') el.addEventListener(k.slice(2), props[k]);
      else if (props[k] != null) el.setAttribute(k, props[k]);
    }
    for (const c of kids) { if (c == null) continue; el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); }
    return el;
  };
  const CE = (() => { try { const d = document.createElement('div'); d.setAttribute('contenteditable', 'plaintext-only'); return d.contentEditable === 'plaintext-only' ? 'plaintext-only' : 'true'; } catch (e) { return 'true'; } })();
  const isMobile = () => { try { return window.matchMedia('(max-width:48rem)').matches; } catch (e) { return false; } };

  // ---------- WCAG contrast ----------
  const hx = (n) => Math.max(0, Math.min(255, n)).toString(16).padStart(2, '0');
  const _chan = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
  function relLum(hex) { const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex || ''); if (!m) return 0; return 0.2126 * _chan(parseInt(m[1], 16)) + 0.7152 * _chan(parseInt(m[2], 16)) + 0.0722 * _chan(parseInt(m[3], 16)); }
  function contrastRatio(a, b) { const la = relLum(a), lb = relLum(b); return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05); }
  const AA = (ratio, large) => ratio >= (large ? 3 : 4.5);
  const bestOn = (bg) => (contrastRatio('#ffffff', bg) >= contrastRatio('#111111', bg) ? '#ffffff' : '#111111');
  function fixContrast(fg, bg, large) {
    if (AA(contrastRatio(fg, bg), large)) return fg;
    const up = contrastRatio('#ffffff', bg) >= contrastRatio('#000000', bg);
    const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(fg) || [, '80', '80', '80'];
    let r = parseInt(m[1], 16), g = parseInt(m[2], 16), b = parseInt(m[3], 16);
    for (let i = 0; i < 24 && !AA(contrastRatio('#' + hx(r) + hx(g) + hx(b), bg), large); i++) { const d = up ? 14 : -14; r += d; g += d; b += d; }
    return '#' + hx(r) + hx(g) + hx(b);
  }

  // ---------- theme constants ----------
  const STK = { system: 'system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif', serif: 'Georgia,"Times New Roman",Cambria,serif', mono: 'ui-monospace,"JetBrains Mono",Menlo,Consolas,monospace' };
  const PAIRINGS = {
    system: { name: 'System (clean)', hh: STK.system, b: STK.system },
    serifBody: { name: 'System + Serif body', hh: STK.system, b: STK.serif },
    classic: { name: 'Serif (classic)', hh: STK.serif, b: STK.serif },
    mono: { name: 'Mono accent', hh: STK.mono, b: STK.system },
  };
  const SCALE = { sm: 1.18, md: 1.22, lg: 1.27 };
  const SCALE_BASE = { sm: '1rem', md: '1.0625rem', lg: '1.15rem' };
  const LH = { tight: 1.45, normal: 1.6, relaxed: 1.8 };
  const MEASURE = { narrow: '34rem', normal: '46rem', wide: '60rem' };
  const RADII = { none: '0', sm: '.25rem', md: '.5rem', lg: '1rem', pill: '999px' };
  const DENSITY = { compact: { sec: '2rem', gap: '.6rem' }, comfortable: { sec: '3.5rem', gap: '1rem' }, roomy: { sec: '5rem', gap: '1.5rem' } };
  const SECPAD = { none: '0', sm: '1.5rem', md: '3rem', lg: '5rem' };
  const COLGAP = { sm: '.75rem', md: '1.5rem', lg: '2.5rem' };
  const PRESETS = [
    { id: 'clean', name: 'Clean Light', pairing: 'system', colors: { pageBg: '#ffffff', surface: '#f4f5f7', text: '#1f2328', heading: '#0d1117', muted: '#57606a', border: '#d8dee4', accent: '#2563eb', link: '#1d4ed8', linkHover: '#1e3a8a' } },
    { id: 'aurora', name: 'Aurora', pairing: 'system', colors: { pageBg: '#ffffff', surface: '#eef6f4', text: '#15201d', heading: '#0b3d2e', muted: '#4b5d57', border: '#cfe3dc', accent: '#0d9488', link: '#0f766e', linkHover: '#115e59' } },
    { id: 'ink', name: 'Ink on Paper', pairing: 'classic', colors: { pageBg: '#faf7f0', surface: '#f0ead9', text: '#23201a', heading: '#1a1712', muted: '#5e564a', border: '#ddd3bf', accent: '#8a5a1e', link: '#8a5a1e', linkHover: '#5e3c12' } },
    { id: 'rose', name: 'Warm Rose', pairing: 'system', colors: { pageBg: '#fffafa', surface: '#fdeef0', text: '#27191c', heading: '#160d10', muted: '#6b5359', border: '#f0d6db', accent: '#be123c', link: '#be123c', linkHover: '#881337' } },
    { id: 'ocean', name: 'Deep Ocean', pairing: 'system', colors: { pageBg: '#0b1620', surface: '#13212e', text: '#dfe9f0', heading: '#ffffff', muted: '#9fb2c0', border: '#26384a', accent: '#38bdf8', link: '#7dd3fc', linkHover: '#bae6fd' } },
    { id: 'midnight', name: 'Midnight', pairing: 'system', colors: { pageBg: '#0d0d12', surface: '#17171f', text: '#e7e7ee', heading: '#ffffff', muted: '#a1a1b0', border: '#2a2a36', accent: '#a78bfa', link: '#c4b5fd', linkHover: '#ddd6fe' } },
    { id: 'forest', name: 'Forest', pairing: 'system', colors: { pageBg: '#f6faf6', surface: '#e7f1e7', text: '#15211a', heading: '#0c2a1a', muted: '#4d5e53', border: '#cfe0cf', accent: '#15803d', link: '#15803d', linkHover: '#14532d' } },
    { id: 'sunset', name: 'Sunset', pairing: 'system', colors: { pageBg: '#fff8f3', surface: '#ffeede', text: '#26190f', heading: '#1c1109', muted: '#6e5847', border: '#f3dcc4', accent: '#c2410c', link: '#c2410c', linkHover: '#9a3412' } },
    { id: 'slate', name: 'Slate Pro', pairing: 'system', colors: { pageBg: '#ffffff', surface: '#f1f5f9', text: '#1e293b', heading: '#0f172a', muted: '#475569', border: '#cbd5e1', accent: '#475569', link: '#0f766e', linkHover: '#134e4a' } },
    { id: 'highcontrast', name: 'High Contrast', pairing: 'system', colors: { pageBg: '#ffffff', surface: '#f0f0f0', text: '#000000', heading: '#000000', muted: '#3a3a3a', border: '#000000', accent: '#0033cc', link: '#0033cc', linkHover: '#001a80' } },
  ];
  const presetById = (id) => PRESETS.find((p) => p.id === id) || PRESETS[0];
  const ROLE_KEYS = ['pageBg', 'surface', 'text', 'heading', 'muted', 'border', 'accent', 'link', 'linkHover'];

  // ---------- starter templates (model JSON; normalize() assigns ids/defaults) ----------
  const _hd = (level, text) => ({ type: 'heading', level, text });
  const _tx = (text) => ({ type: 'text', text });
  const _btn = (label, href, variant) => ({ type: 'button', label, href, variant: variant || 'solid' });
  const _img = (alt) => ({ type: 'image', asset: '', alt: alt || '' });
  const _li = (label, href) => ({ label, href });
  const _drop = (label, children) => ({ label, href: '#', children });
  const _nav = (brand, items) => ({ type: 'nav', brand, items });
  const _sec = (pad, align, bg, children) => ({ type: 'section', pad, align, bg: bg || '', children });
  const _cols = (n, children) => ({ type: 'columns', cols: n, gap: 'md', stack: true, children });
  const _col = (children) => ({ type: 'column', children });
  const _gallery = () => ({ type: 'gallery', cols: 3, items: [] });
  const _form = () => ({ type: 'form', title: 'Contact', submitLabel: 'Send', success: 'Thanks! Your message was sent.', fields: [{ type: 'text', label: 'Name', required: true }, { type: 'email', label: 'Email', required: true }, { type: 'textarea', label: 'Message', required: true }] });
  const _faq = (items) => ({ type: 'accordion', single: true, children: items.map(([q, a]) => ({ type: 'accitem', label: q, children: [{ type: 'text', text: a }] })) });
  const _tabs = (items) => ({ type: 'tabs', children: items.map(([label, text]) => ({ type: 'tabpanel', label, children: [{ type: 'text', text }] })) });
  const TEMPLATES = [
    { id: 'bio', name: 'Link in bio', preset: 'aurora', align: 'center', els: () => [
      { type: 'heading', level: 1, text: handle }, { type: 'text', text: 'A short line about you.' },
      { type: 'button', label: 'My main link', href: 'https://example.com', variant: 'solid' },
      { type: 'button', label: 'Another link', href: 'https://example.com', variant: 'outline' },
      { type: 'button', label: 'Email me', href: 'mailto:you@example.com', variant: 'outline' } ] },
    { id: 'landing', name: 'Simple landing', preset: 'clean', align: 'left', els: () => [
      { type: 'heading', level: 1, text: 'Your headline here' }, { type: 'text', text: 'One or two sentences describing what you offer and who it helps.' },
      { type: 'button', label: 'Get started', href: '#', variant: 'solid' }, { type: 'divider' },
      { type: 'heading', level: 2, text: 'What you get' }, { type: 'list', items: ['First benefit', 'Second benefit', 'Third benefit'] } ] },
    { id: 'resume', name: 'Résumé', preset: 'slate', align: 'left', els: () => [
      _sec('sm', 'left', '', [
        _hd(1, 'Your Name'),
        _tx('Job Title — a short tagline about what you do best.'),
        _tx('City · you@example.com · ' + handle + '.yourdomain.com')]),
      _cols(2, [
        _col([
          _hd(2, 'Experience'),
          _hd(3, 'Job Title — Company'), _tx('2023 – Present · City'),
          { type: 'list', items: ['Led a project and the result it produced (use a number if you can).', 'A second responsibility or achievement.'] },
          _hd(3, 'Previous Role — Company'), _tx('2020 – 2023 · City'),
          { type: 'list', items: ['What you owned and the impact you had.', 'Another highlight worth showing.'] },
          _hd(2, 'Education'),
          _hd(3, 'Degree or Program — School'), _tx('Graduation year')]),
        _col([
          _hd(2, 'Skills'),
          { type: 'list', items: ['Skill one', 'Skill two', 'Skill three', 'Skill four', 'Skill five'] },
          _hd(2, 'Contact'),
          _tx('you@example.com'), _tx('City, Country'),
          _hd(2, 'Links'),
          _btn('LinkedIn', 'https://linkedin.com/in/you', 'outline'),
          _btn('Portfolio', 'https://example.com', 'outline')])])] },
    { id: 'soon', name: 'Coming soon', preset: 'midnight', align: 'center', els: () => [
      { type: 'heading', level: 1, text: 'Coming soon' }, { type: 'text', text: 'Something new is on the way. Check back shortly.' },
      { type: 'button', label: 'Contact', href: 'mailto:you@example.com', variant: 'outline' } ] },
    { id: 'business', name: 'Business', preset: 'slate', align: 'left', els: () => [
      _nav('Acme Co', [_li('Home', '#'), _li('Services', '#services'), _drop('More', [_li('About', '#about'), _li('Contact', '#contact')])]),
      _sec('lg', 'center', '', [_hd(1, 'Grow your business with Acme'), _tx('We help small teams do big things — clear, simple, effective.'), _btn('Get started', '#contact', 'solid')]),
      _sec('md', 'left', '', [_hd(2, 'What we do'), _cols(3, [
        _col([_hd(3, 'Strategy'), _tx('Plans that fit your goals and budget.')]),
        _col([_hd(3, 'Design'), _tx('Clean, accessible, mobile-first design.')]),
        _col([_hd(3, 'Support'), _tx('We are here when you need us.')])])]),
      _sec('lg', 'center', '', [_hd(2, 'Ready to talk?'), _btn('Email us', 'mailto:hello@example.com', 'solid')])] },
    { id: 'portfolio', name: 'Portfolio', preset: 'midnight', align: 'left', els: () => [
      _nav(handle, [_li('Work', '#work'), _li('About', '#about'), _li('Contact', 'mailto:you@example.com')]),
      _sec('lg', 'left', '', [_hd(1, handle), _tx('Designer & maker. A short line about what you do and who you help.')]),
      _sec('md', 'left', '', [_hd(2, 'Selected work'), _cols(2, [
        _col([_img('Project one screenshot'), _hd(3, 'Project one'), _tx('What it is and your role.')]),
        _col([_img('Project two screenshot'), _hd(3, 'Project two'), _tx('What it is and your role.')])])]),
      _sec('md', 'left', '', [_hd(2, 'About'), _tx('A paragraph about your background, skills, and what you are looking for.'), _btn('Get in touch', 'mailto:you@example.com', 'outline')])] },
    { id: 'event', name: 'Event', preset: 'rose', align: 'center', els: () => [
      _nav('The Event', [_li('Details', '#details'), _li('Schedule', '#schedule'), _li('RSVP', '#rsvp')]),
      _sec('lg', 'center', '', [_hd(1, 'You are invited'), _tx('Saturday, the 14th · 6:00 PM · Community Hall'), _btn('RSVP now', '#rsvp', 'solid')]),
      _sec('md', 'center', '', [_hd(2, 'What to expect'), _cols(3, [
        _col([_hd(3, 'Welcome'), _tx('Doors open at 6, drinks and music.')]),
        _col([_hd(3, 'Program'), _tx('Talks and a shared meal at 7.')]),
        _col([_hd(3, 'After'), _tx('Stay for the social until late.')])])]),
      _sec('lg', 'center', '', [_hd(2, 'RSVP'), _tx('Let us know you are coming.'), _btn('Email to RSVP', 'mailto:rsvp@example.com', 'solid')])] },
    { id: 'nonprofit', name: 'Community / Nonprofit', preset: 'aurora', align: 'left', els: () => [
      _nav('Helping Hands', [_li('Home', '#'), _drop('Get help', [_li('Find support', '#support'), _li('Resources', '#resources')]), _li('Donate', '#donate'), _li('Contact', '#contact')]),
      _sec('lg', 'center', '', [_hd(1, 'You are not alone'), _tx('Confidential support and resources, whenever you need them.'), _btn('Find support', '#support', 'solid')]),
      _sec('md', 'left', '', [_hd(2, 'How we can help'), _cols(3, [
        _col([_hd(3, 'Talk to someone'), _tx('Trained advocates, ready to listen.')]),
        _col([_hd(3, 'Stay private'), _tx('Nothing is stored on your device.')]),
        _col([_hd(3, 'Make a plan'), _tx('Step-by-step safety resources.')])])]),
      _sec('md', 'left', '', [_hd(2, 'Reach us'), _tx('We reply as soon as we can.'), _btn('Email us', 'mailto:help@example.com', 'outline')])] },
    { id: 'services', name: 'Services & FAQ', preset: 'clean', align: 'left', els: () => [
      _nav(handle, [_li('Services', '#services'), _li('FAQ', '#faq'), _li('Contact', '#contact')]),
      _sec('lg', 'center', '', [_hd(1, 'Services that fit your needs'), _tx('A short line about what you offer and who it helps.'), _btn('Get in touch', '#contact', 'solid')]),
      _sec('md', 'left', '', [_hd(2, 'What we offer'), _tabs([['Consulting', 'Describe your consulting service here.'], ['Design', 'Describe your design service here.'], ['Support', 'Describe your support plans here.']])]),
      _sec('md', 'left', '', [_hd(2, 'Frequently asked questions'), _faq([['How do we start?', 'Reach out and we will set up a first call.'], ['What does it cost?', 'Pricing depends on scope — ask for a quote.'], ['How long does it take?', 'Most projects take two to six weeks.']])]),
      _sec('lg', 'left', '', [_hd(2, 'Contact'), _tx('Send a message and we will reply soon.'), _form()])] },
    { id: 'photo', name: 'Photography', preset: 'midnight', align: 'center', els: () => [
      _nav(handle, [_li('Gallery', '#gallery'), _li('About', '#about'), _li('Contact', '#contact')]),
      _sec('lg', 'center', '', [_hd(1, handle), _tx('Photographer. A short line about your style and the work you make.')]),
      _sec('md', 'center', '', [_hd(2, 'Gallery'), _gallery(), _tx('Add your photos from the gallery panel on the right.')]),
      _sec('md', 'left', '', [_hd(2, 'About'), _tx('A paragraph about you, your approach, and how to book.')]),
      _sec('lg', 'center', '', [_hd(2, 'Get in touch'), _form()])] },
  ];

  container.replaceChildren();
  if (!handle) {
    const p = h('div', { style: 'padding:1.5rem;max-width:40rem;margin:0 auto' }, h('h1', null, 'Website Builder'));
    const line = h('p', null, "You don't have a site yet. "); line.appendChild(h('a', { href: '#/site' }, 'Create one in My Website')); line.appendChild(document.createTextNode(' first.'));
    p.appendChild(line); container.appendChild(p); return;
  }

  // ---------- builder chrome CSS (injected once) ----------
  if (!document.getElementById('bv-builder-css')) {
    const st = document.createElement('style'); st.id = 'bv-builder-css';
    st.textContent = `
.bvb{--bvb-acc:var(--accent,#2563eb);--bvb-acc-d:color-mix(in srgb,var(--accent,#2563eb) 82%,#000);--bvb-bg:#eef2f7;--bvb-surf:#fff;--bvb-line:#e2e8f0;--bvb-text:#1f2937;--bvb-muted:#64748b;--bvb-r:.55rem;--bvb-sh:0 1px 3px rgba(15,23,42,.09);display:grid;grid-template-columns:12rem 1fr 20rem;grid-template-rows:auto 1fr;height:calc(100vh - 3.5rem);font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:var(--bvb-text);background:var(--bvb-bg)}
.bvb-bar{grid-column:1/-1;display:flex;gap:.5rem;align-items:center;padding:.5rem .8rem;background:var(--bvb-surf);border-bottom:1px solid var(--bvb-line);box-shadow:0 1px 2px rgba(15,23,42,.04);flex-wrap:wrap;z-index:5}
.bvb-bar strong{font-size:1rem;letter-spacing:-.01em}
.bvb-host{color:var(--bvb-muted);font-size:.78rem;background:#f1f5f9;padding:.18rem .55rem;border-radius:1rem}
.bvb-palette{background:var(--bvb-surf);border-right:1px solid var(--bvb-line);padding:.7rem .6rem;overflow:auto;display:flex;flex-direction:column;gap:.3rem}
.bvb-grouphdr{font-size:.67rem;text-transform:uppercase;letter-spacing:.06em;color:var(--bvb-muted);font-weight:700;margin:.65rem .1rem .15rem}
.bvb-grouphdr:first-of-type{margin-top:0}
.bvb-palbtn{display:flex;align-items:center;gap:.55rem;min-height:44px;min-width:0;padding:.4rem .55rem;cursor:grab;border:1px solid var(--bvb-line);border-radius:var(--bvb-r);background:var(--bvb-surf);text-align:left;font:inherit;font-size:.86rem;color:var(--bvb-text);touch-action:none;transition:border-color .12s,background .12s}
.bvb-palbtn:hover,.bvb-palbtn:focus-visible{border-color:var(--bvb-acc);background:var(--accent-soft,#f5f8ff);outline:none}
.bvb-palicon{flex:0 0 auto;width:1.85rem;height:1.85rem;display:flex;align-items:center;justify-content:center;background:var(--accent-soft,#eef2ff);color:var(--bvb-acc);border-radius:.45rem}
.bvb-palicon svg{width:20px;height:20px;display:block}
.bvb-pallabel{flex:1 1 auto;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;line-height:1.2}
.bvb-canvas{overflow:auto;padding:1.25rem;min-width:0;position:relative;background:radial-gradient(circle at 1px 1px,rgba(15,23,42,.06) 1px,transparent 0) 0 0/22px 22px,var(--bvb-bg)}
.bvb-inspector{background:var(--bvb-surf);border-left:1px solid var(--bvb-line);padding:.8rem;overflow:auto}
.bvb-panelh{font-weight:700;font-size:.95rem;margin:.1rem 0 .5rem}
.bvb-frame{width:100%;height:100%;min-height:24rem;border:1px solid var(--bvb-line);background:#fff;border-radius:.7rem;box-shadow:0 4px 16px rgba(15,23,42,.1)}
.bvb-bottombar,.bvb-drawerclose{display:none}
.bvb-act{min-height:38px;padding:.4rem .7rem;cursor:pointer;border:1px solid var(--bvb-line);border-radius:.45rem;background:var(--bvb-surf);font:inherit;color:var(--bvb-text);font-weight:500;transition:background .12s,border-color .12s}
.bvb-act:hover:not(:disabled){background:#f1f5f9;border-color:#cbd5e1}
.bvb-act:disabled{opacity:.4;cursor:default}
.bvb-field{display:flex;flex-direction:column;gap:.25rem;font-size:.8rem;color:var(--bvb-muted);margin-bottom:.65rem;font-weight:500}
.bvb-field input,.bvb-field select,.bvb-field textarea{min-height:40px;padding:.45rem .55rem;border:1px solid #cbd5e1;border-radius:.45rem;font:inherit;color:var(--bvb-text);background:var(--bvb-surf)}
.bvb-field input:focus,.bvb-field select:focus,.bvb-field textarea:focus{outline:2px solid var(--bvb-acc);outline-offset:-1px;border-color:var(--bvb-acc)}
.bvb-pub{padding:.5rem 1.1rem;font-weight:700;cursor:pointer;border-radius:.5rem;background:var(--bvb-acc);color:#fff;border:0;min-height:44px;box-shadow:var(--bvb-sh)}
.bvb-pub:hover{background:var(--bvb-acc-d)}
.bvb-tabs{display:flex;gap:.2rem;margin:.5rem 0;background:#f1f5f9;padding:.2rem;border-radius:.55rem}
.bvb-tab{flex:1;min-height:36px;border:0;background:transparent;border-radius:.4rem;cursor:pointer;font:inherit;font-weight:600;color:var(--bvb-muted)}
.bvb-tab[aria-selected=true]{background:var(--bvb-surf);color:var(--bvb-acc);box-shadow:var(--bvb-sh)}
.bvb-crumb{font-size:.74rem;color:var(--bvb-muted);margin-bottom:.4rem;display:flex;flex-wrap:wrap;gap:.15rem;align-items:center}
.bvb-crumb button{background:none;border:0;color:var(--bvb-acc);cursor:pointer;font:inherit;font-size:.74rem;padding:.05rem .15rem;text-decoration:underline}
.bvb-presets{display:grid;grid-template-columns:1fr 1fr;gap:.45rem}
.bvb-preset{display:flex;align-items:center;gap:.45rem;min-height:44px;padding:.35rem .45rem;border:1px solid var(--bvb-line);border-radius:.5rem;background:var(--bvb-surf);cursor:pointer;font:inherit;text-align:left;transition:border-color .12s}
.bvb-preset:hover{border-color:var(--bvb-acc)}
.bvb-sw{width:.95rem;height:.95rem;border-radius:50%;border:1px solid rgba(0,0,0,.15)}
.bvb-badge{font-size:.68rem;padding:.05rem .35rem;border-radius:.3rem;white-space:nowrap;font-weight:600}
.bvb-onboard{border:1px dashed #cbd5e1;border-radius:.7rem;padding:1rem;background:#f8fafc;text-align:center}
.bvb-onboard p{color:var(--bvb-muted);margin:.2rem 0 .7rem;font-size:.9rem}
.bvb-onboard .bvb-act{display:block;width:100%;margin:.35rem 0;font-weight:600}
.bvb-modal{position:fixed;inset:0;background:rgba(15,23,42,.5);z-index:60;display:flex;align-items:center;justify-content:center;padding:1rem}
.bvb-modal-box{background:var(--bvb-surf);border-radius:1rem;max-width:46rem;width:100%;max-height:85vh;overflow:auto;padding:1.25rem;box-shadow:0 20px 50px rgba(15,23,42,.3)}
.bvb-tpl-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(9.5rem,1fr));gap:.7rem}
.bvb-tpl{border:1px solid var(--bvb-line);border-radius:.7rem;padding:.8rem;cursor:pointer;background:var(--bvb-surf);text-align:left;font:inherit;min-height:5rem;transition:border-color .12s,transform .12s,box-shadow .12s}
.bvb-tpl:hover{border-color:var(--bvb-acc);box-shadow:var(--bvb-sh);transform:translateY(-1px)}
.bvb-sr{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}
.bvb-etoolbar{position:fixed;z-index:56;display:none;gap:.35rem;align-items:center;pointer-events:none}
.bvb-etoolbar .bvb-ebtn,.bvb-etoolbar .bvb-handle{box-sizing:border-box;width:38px;height:38px;min-width:38px;min-height:38px;max-width:38px;max-height:38px;aspect-ratio:1/1;border-radius:50%;border:2px solid #fff;display:flex;align-items:center;justify-content:center;box-shadow:0 1px 5px rgba(0,0,0,.3);font-size:16px;line-height:1;pointer-events:auto;padding:0;background:#fff;color:var(--bvb-text);flex:0 0 38px}
.bvb-etoolbar .bvb-ebtn{cursor:pointer;transition:background .12s,color .12s}
.bvb-etoolbar .bvb-ebtn:hover,.bvb-etoolbar .bvb-ebtn:focus-visible{background:var(--accent-soft,#eef2ff);outline:none}
.bvb-etoolbar .bvb-ebtn.del{color:#dc2626}
.bvb-etoolbar .bvb-ebtn.del:hover,.bvb-etoolbar .bvb-ebtn.del:focus-visible{background:#dc2626;color:#fff}
.bvb-etoolbar .bvb-handle{background:var(--bvb-acc);color:#fff;cursor:grab;touch-action:none}
.bvb-etoolbar .bvb-handle:active{cursor:grabbing}
.bvb-dropline{position:fixed;z-index:58;height:4px;background:var(--bvb-acc);border-radius:3px;box-shadow:0 0 0 1px #fff;pointer-events:none;display:none}
.bvb-zonehi{position:fixed;z-index:54;pointer-events:none;display:none;outline:2px solid var(--bvb-acc);outline-offset:-2px;background:var(--accent-soft,rgba(37,99,235,.07));border-radius:.4rem}
.bvb-ghost{position:fixed;z-index:62;pointer-events:none;display:none;background:var(--bvb-acc-d);color:#fff;padding:.3rem .6rem;border-radius:.4rem;font:600 .8rem system-ui;box-shadow:0 8px 24px rgba(0,0,0,.3);transform:translate(8px,8px);max-width:60vw;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
@media (max-width:48rem){
  .bvb{grid-template-columns:1fr}
  .bvb-palette,.bvb-inspector{position:fixed;left:0;right:0;bottom:0;max-height:80vh;background:#fff;z-index:50;box-shadow:0 -6px 24px rgba(0,0,0,.25);transform:translateY(105%);transition:transform .2s;border:0;border-top:1px solid #e5e7eb;border-radius:1rem 1rem 0 0;padding-bottom:1.5rem}
  .bvb-palette.bvb-open,.bvb-inspector.bvb-open{transform:translateY(0)}
  .bvb-palette::before,.bvb-inspector::before{content:"";display:block;width:2.5rem;height:.3rem;background:#cbd5e1;border-radius:1rem;margin:.1rem auto .6rem}
  .bvb-canvas{padding:.5rem;padding-bottom:4.5rem}
  .bvb-bottombar{display:flex;position:fixed;left:0;right:0;bottom:0;z-index:40;background:#fff;border-top:1px solid #e5e7eb;padding:.4rem;gap:.5rem}
  .bvb-bottombar button{flex:1;min-height:44px;border:1px solid #d1d5db;border-radius:.5rem;background:#fff;font-weight:600}
  .bvb-drawerclose{display:block;width:100%;min-height:44px;margin-bottom:.5rem;border:0;background:#f1f5f9;border-radius:.5rem;cursor:pointer}
  .bvb-act,.bvb-tab,.bvb-pub{min-height:44px}
  .bvb-modal{align-items:flex-end}
  .bvb-modal-box{max-width:none;max-height:92vh;border-radius:1rem 1rem 0 0}
}
@media (prefers-reduced-motion:reduce){.bvb-palette,.bvb-inspector{transition:none}}`;
    document.head.appendChild(st);
  }

  // ---------- model (load + normalize + migrate) ----------
  const defThemeFrom = (preset, align) => { const p = presetById(preset); return { v: 2, preset: p.id, colors: { ...p.colors }, pairing: p.pairing, scale: 'md', lineHeight: 'normal', measure: 'normal', radius: 'md', density: 'comfortable', button: { shape: 'rounded', style: 'solid' }, align: align || 'left', darkMode: 'auto' }; };
  const defaultEls = () => ([{ id: uid(), type: 'heading', level: 1, text: handle, style: {} }, { id: uid(), type: 'text', text: 'Welcome to my website. Tap any text to edit it, or add a block.', style: {} }]);
  const LEAF_TYPES = new Set(['heading', 'text', 'button', 'image', 'list', 'divider', 'spacer', 'nav', 'gallery', 'form']);
  const CONTAINER_TYPES = new Set(['section', 'columns', 'column', 'tabs', 'tabpanel', 'accordion', 'accitem', 'carousel', 'slide']);
  const PANEL_TYPES = new Set(['tabpanel', 'accitem', 'slide']);
  const ZONE_PARENTS = new Set(['section', 'column', 'tabpanel', 'accitem', 'slide']);
  const isContainer = (t) => CONTAINER_TYPES.has(t);
  function normStyle(s) { s = s || {}; const o = {}; if (['left', 'center', 'right'].includes(s.align)) o.align = s.align; if (['surface', 'accent', 'page'].includes(s.bg)) o.bg = s.bg; if (['narrow', 'normal', 'wide', 'full'].includes(s.maxW)) o.maxW = s.maxW; if (['sm', 'md', 'lg'].includes(s.padY)) o.padY = s.padY; if (['none', 'sm', 'md', 'lg', 'pill'].includes(s.radius)) o.radius = s.radius; return o; }
  function normalize(m) {
    const seen = new Set();
    const nid = (id) => { id = String(id || ''); if (!/^e[a-z0-9]{1,14}$/.test(id) || seen.has(id)) id = uid(); seen.add(id); return id; };
    function normNode(e) {
      if (!e || (!LEAF_TYPES.has(e.type) && !CONTAINER_TYPES.has(e.type))) return null;
      const o = { id: nid(e.id), type: e.type, style: normStyle(e.style) };
      if (e.type === 'heading') { o.level = [1, 2, 3].includes(e.level) ? e.level : 2; o.text = String(e.text || ''); }
      else if (e.type === 'text') { o.text = String(e.text || ''); }
      else if (e.type === 'button') { o.label = String(e.label || 'Button'); o.href = String(e.href || '#'); o.variant = oneOf(e.variant, ['solid', 'outline', 'soft'], 'solid'); }
      else if (e.type === 'image') { o.asset = typeof e.asset === 'string' ? e.asset : ''; o.alt = String(e.alt || ''); }
      else if (e.type === 'list') { o.items = Array.isArray(e.items) ? e.items.map((x) => String(x)) : ['List item']; o.ordered = !!e.ordered; }
      else if (e.type === 'spacer') { o.size = oneOf(e.size, ['sm', 'md', 'lg'], 'md'); }
      else if (e.type === 'nav') { o.brand = String(e.brand || ''); o.items = (Array.isArray(e.items) ? e.items : []).slice(0, 12).map(normNavItem); if (!o.items.length) o.items = [{ id: nid(''), label: 'Home', href: '#', children: [] }]; }
      else if (e.type === 'section') { o.bg = cssColor(e.bg) || ''; o.bgImage = typeof e.bgImage === 'string' ? e.bgImage : ''; o.overlay = (typeof e.overlay === 'number' && e.overlay >= 0 && e.overlay <= 0.85) ? e.overlay : 0; o.lightText = !!e.lightText; o.pad = oneOf(e.pad, ['none', 'sm', 'md', 'lg'], 'md'); o.align = oneOf(e.align, ['left', 'center'], 'left'); o.children = normList(e.children); }
      else if (e.type === 'columns') { let kids = (Array.isArray(e.children) ? e.children : []).map(normColumn).filter(Boolean).slice(0, 4); while (kids.length < 2) kids.push({ id: nid(''), type: 'column', style: {}, children: [] }); o.cols = Math.max(2, Math.min(4, kids.length)); o.gap = oneOf(e.gap, ['sm', 'md', 'lg'], 'md'); o.stack = e.stack === false ? false : true; o.children = kids; }
      else if (e.type === 'column') { o.children = normList(e.children); }
      else if (e.type === 'gallery') { o.cols = oneOf(e.cols, [2, 3, 4], 3); o.items = (Array.isArray(e.items) ? e.items : []).map((g) => ({ asset: (g && typeof g.asset === 'string') ? g.asset : '', alt: String((g && g.alt) || '') })).slice(0, 40); }
      else if (e.type === 'form') { o.title = String(e.title || 'Contact').slice(0, 80); o.submitLabel = String(e.submitLabel || 'Send').slice(0, 40); o.success = String(e.success || 'Thanks! Your message was sent.').slice(0, 200); o.fields = normFields(e.fields); }
      else if (e.type === 'tabs') { o.children = normPanelList(e.children, 'tabpanel', 'Tab', 1); }
      else if (e.type === 'tabpanel') { o.label = String(e.label || 'Tab').slice(0, 60); o.children = normList(e.children); }
      else if (e.type === 'accordion') { o.single = !!e.single; o.children = normPanelList(e.children, 'accitem', 'Section', 1); }
      else if (e.type === 'accitem') { o.label = String(e.label || 'Section').slice(0, 80); o.open = !!e.open; o.children = normList(e.children); }
      else if (e.type === 'carousel') { o.children = normPanelList(e.children, 'slide', '', 1); }
      else if (e.type === 'slide') { o.children = normList(e.children); }
      return o;
    }
    function normNavSub(s) { return { id: nid(s && s.id), label: String((s && s.label) || 'Link'), href: String((s && s.href) || '#') }; }
    function normNavItem(it) { it = it || {}; return { id: nid(it.id), label: String(it.label || 'Link'), href: String(it.href || '#'), children: (Array.isArray(it.children) ? it.children : []).slice(0, 12).map(normNavSub) }; }
    function normColumn(c) { if (!c || c.type !== 'column') { if (c && (LEAF_TYPES.has(c.type) || CONTAINER_TYPES.has(c.type))) { const w = normNode(c); return w ? { id: nid(''), type: 'column', style: {}, children: [w] } : null; } return null; } return normNode(c); }
    function normList(arr) { const out = []; for (const c of (Array.isArray(arr) ? arr : [])) { const n = normNode(c); if (n) out.push(n); } return out; }
    function normPanelList(arr, type, defLabel, min) {
      const out = [];
      for (const c of (Array.isArray(arr) ? arr : [])) {
        if (c && c.type === type) { const n = normNode(c); if (n) out.push(n); }
        else if (c && (LEAF_TYPES.has(c.type) || CONTAINER_TYPES.has(c.type))) { const n = normNode({ type, label: defLabel, children: [c] }); if (n) out.push(n); }
      }
      while (out.length < (min || 1)) out.push(normNode({ type, label: defLabel + ' ' + (out.length + 1), children: [] }));
      return out.slice(0, 16);
    }
    function normField(f, i) { f = f || {}; const type = oneOf(f.type, ['text', 'email', 'textarea', 'tel'], 'text'); const label = String(f.label || 'Field').slice(0, 60); let name = String(f.name || '').toLowerCase().replace(/[^a-z0-9_]/g, '_').replace(/^_+|_+$/g, ''); if (!name || name === '_hp') name = (label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || ('field' + i)).slice(0, 40) || ('field' + i); return { type, label, name, required: !!f.required }; }
    function normFields(arr) { let fs = (Array.isArray(arr) ? arr : []).map(normField).slice(0, 20); if (!fs.length) fs = [normField({ type: 'text', label: 'Name', required: true }, 0), normField({ type: 'email', label: 'Email', required: true }, 1), normField({ type: 'textarea', label: 'Message', required: true }, 2)]; const seen = {}; for (const f of fs) { let n = f.name || 'field', k = n, c = 2; while (seen[k]) k = n + '_' + (c++); f.name = k; seen[k] = 1; } return fs; }
    // theme (migrate v1 {accent,font,align} -> v2)
    let th; const t = m && m.theme;
    if (t && t.v === 2 && t.colors) {
      const c = {}; for (const k of ROLE_KEYS) c[k] = cssColorOr(t.colors[k], presetById(t.preset).colors[k] || '#888888');
      th = { v: 2, preset: PRESETS.some((p) => p.id === t.preset) ? t.preset : 'clean', colors: c, pairing: PAIRINGS[t.pairing] ? t.pairing : 'system', scale: oneOf(t.scale, ['sm', 'md', 'lg'], 'md'), lineHeight: oneOf(t.lineHeight, ['tight', 'normal', 'relaxed'], 'normal'), measure: oneOf(t.measure, ['narrow', 'normal', 'wide'], 'normal'), radius: oneOf(t.radius, ['none', 'sm', 'md', 'lg', 'pill'], 'md'), density: oneOf(t.density, ['compact', 'comfortable', 'roomy'], 'comfortable'), button: { shape: oneOf(t.button && t.button.shape, ['square', 'rounded', 'pill'], 'rounded'), style: oneOf(t.button && t.button.style, ['solid', 'outline', 'soft'], 'solid') }, align: oneOf(t.align, ['left', 'center'], 'left'), darkMode: oneOf(t.darkMode, ['off', 'auto', 'force'], 'auto') };
    } else {
      th = defThemeFrom('clean', oneOf(t && t.align, ['left', 'center'], 'left'));
      if (t && cssColor(t.accent)) th.colors.accent = cssColor(t.accent);
      if (t && ['readable', 'serif', 'mono'].includes(t.font)) th.pairing = t.font === 'serif' ? 'classic' : t.font === 'mono' ? 'mono' : 'system';
    }
    const els = normList(m && m.page && m.page.elements);
    const pg = (m && m.page) || {};
    return { v: 2, theme: th, page: {
      title: String(pg.title || handle),
      description: String(pg.description || '').slice(0, 300),
      tags: (Array.isArray(pg.tags) ? pg.tags : []).map((x) => String(x).trim().toLowerCase()).filter(Boolean).slice(0, 10),
      listed: pg.listed === false ? false : true,
      elements: els.length ? els : defaultEls(),
    } };
  }
  let model;
  try { const r = await api('GET', '/api/sites/file?path=site.json'); model = (r.ok && r.data && typeof r.data.text === 'string') ? JSON.parse(r.data.text) : null; } catch (e) { model = null; }
  model = normalize(model || {});

  let selectedId = null, dirty = false, saving = false, isPublishing = false, saveTimer = null, inspectorTab = 'content', editedDuringPublish = false;
  let contactEmail = '', contactLoaded = false;
  const assetUrls = new Map(), assetPending = new Set();   // editor-only: asset name -> data URL (staging files aren't web-served)

  // ---------- tree index (parent/list/index map; rebuilt on structural change) ----------
  const NODE = new Map();
  function reindex() {
    NODE.clear();
    (function walk(list, parent) { list.forEach((node, index) => { NODE.set(node.id, { node, parent, list, index }); if (node.children) walk(node.children, node); }); })(model.page.elements, null);
  }
  reindex();
  const slotOf = (id) => NODE.get(id) || null;
  const byId = (id) => { const e = NODE.get(id); return e ? e.node : null; };
  // Fresh-walk slot lookup (accurate even mid-mutation, before reindex) — used by side-by-side commits.
  function findSlot(id) { let res = null; (function walk(list, parent) { for (let i = 0; i < list.length; i++) { const n = list[i]; if (n.id === id) { res = { node: n, parent, list, index: i }; return; } if (n.children) { walk(n.children, n); if (res) return; } } })(model.page.elements, null); return res; }
  const makeColumns = (a, b) => ({ id: uid(), type: 'columns', cols: 2, gap: 'md', stack: true, style: {}, children: [{ id: uid(), type: 'column', style: {}, children: [a] }, { id: uid(), type: 'column', style: {}, children: [b] }] });
  const containsId = (node, id) => { if (!node || !node.children) return false; for (const c of node.children) { if (c.id === id) return true; if (containsId(c, id)) return true; } return false; };
  function zoneList(zoneId) { if (zoneId === '__root__') return model.page.elements; const s = slotOf(zoneId); return (s && s.node.children) ? s.node.children : null; }
  function zoneKind(zoneId) { if (zoneId === '__root__') return 'root'; const s = slotOf(zoneId); return s ? s.node.type : '?'; }
  function canDropInto(type, zoneId) {
    const k = zoneKind(zoneId);
    if (k === '?') return false;
    if (type === 'section') return k === 'root';                 // sections only at top level
    if (type === 'columns') return k === 'root' || k === 'section' || k === 'tabpanel' || k === 'accitem' || k === 'slide'; // rows anywhere a panel holds content (enables side-by-side)
    if (type === 'tabs' || type === 'accordion' || type === 'carousel') return k === 'root' || k === 'section';
    if (type === 'column' || type === 'tabpanel' || type === 'accitem' || type === 'slide') return false; // panels never reparented directly
    return true;                                                // leaves (incl. gallery, form) drop anywhere
  }
  function moveNode(id, zoneId, index) {
    const s = slotOf(id); if (!s) return false;
    if (id === zoneId || containsId(s.node, zoneId)) return false; // not into self/descendant
    if (!canDropInto(s.node.type, zoneId)) return false;
    const dest = zoneList(zoneId); if (!dest) return false;
    s.list.splice(s.index, 1); // `index` is already in the post-removal frame (hitDrop excludes the dragged node)
    dest.splice(Math.max(0, Math.min(index, dest.length)), 0, s.node);
    return true;
  }
  function insertNode(node, zoneId, index) {
    if (!canDropInto(node.type, zoneId)) return false;
    const dest = zoneList(zoneId); if (!dest) return false;
    dest.splice(Math.max(0, Math.min(index, dest.length)), 0, node);
    return true;
  }
  const regenIds = (node) => { node.id = uid(); if (node.children) node.children.forEach(regenIds); return node; };

  // ---------- serializer ----------
  function ovClasses(el) { const s = el.style || {}, cl = []; if (s.align) cl.push('bv-al-' + s.align); if (s.maxW) cl.push('bv-w-' + s.maxW); if (s.padY) cl.push('bv-pad-' + s.padY); if (s.bg) cl.push('bv-bg-' + s.bg); if (s.radius) cl.push('bv-rad-' + s.radius); return cl.length ? ' ' + cl.join(' ') : ''; }
  function cssText(t) {
    const c = t.colors, accT = bestOn(c.accent), P = PAIRINGS[t.pairing] || PAIRINGS.system;
    const r = SCALE[t.scale] || SCALE.md, base = SCALE_BASE[t.scale] || SCALE_BASE.md, lh = LH[t.lineHeight] || 1.6, meas = MEASURE[t.measure] || MEASURE.normal;
    const rad = RADII[t.radius] || RADII.md, den = DENSITY[t.density] || DENSITY.comfortable;
    const btnRad = t.button.shape === 'pill' ? '999px' : t.button.shape === 'square' ? '0' : rad;
    const out = [];
    out.push(`:root{--bv-bg:${c.pageBg};--bv-surface:${c.surface};--bv-text:${c.text};--bv-heading:${c.heading};--bv-muted:${c.muted};--bv-border:${c.border};--bv-accent:${c.accent};--bv-accent-text:${accT};--bv-link:${c.link};--bv-link-hover:${c.linkHover};--bv-radius:${rad};--bv-gap:${den.gap}}`);
    out.push(`*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}`);
    out.push(`body{margin:0;background:var(--bv-bg);color:var(--bv-text);font-family:${P.b};font-size:${base};line-height:${lh}}`);
    out.push(`.bv-wrap{max-width:${meas};margin:0 auto;padding:${den.sec} 1.25rem;text-align:${t.align === 'center' ? 'center' : 'left'}}`);
    out.push(`h1,h2,h3{font-family:${P.hh};color:var(--bv-heading);line-height:1.2;margin:.6em 0 .35em}`);
    out.push(`h1{font-size:clamp(1.6rem,4vw + .5rem,${(r * r * r).toFixed(3)}rem)}h2{font-size:${(r * r).toFixed(3)}rem}h3{font-size:${r.toFixed(3)}rem}`);
    out.push(`p{margin:.7em 0}a{color:var(--bv-link)}a:hover{color:var(--bv-link-hover)}img{max-width:100%;height:auto;border-radius:var(--bv-radius)}`);
    out.push(`.bv-btn{display:inline-block;padding:.7rem 1.35rem;border-radius:${btnRad};font-weight:600;text-decoration:none;margin:.4em 0;background:var(--bv-accent);color:var(--bv-accent-text);border:2px solid var(--bv-accent)}`);
    out.push(`.bv-btn.bv-outline{background:transparent;color:var(--bv-accent)}.bv-btn.bv-soft{background:var(--bv-surface);color:var(--bv-accent);border-color:transparent}`);
    out.push(`.bv-hr{border:0;border-top:1px solid var(--bv-border);margin:1.5rem 0}.bv-ul,.bv-ol{margin:.7em 0;padding-left:1.4em}`);
    out.push(`a:focus-visible,.bv-btn:focus-visible{outline:3px solid var(--bv-link);outline-offset:2px}`);
    out.push(`.bv-al-left{text-align:left}.bv-al-center{text-align:center}.bv-al-right{text-align:right}`);
    out.push(`.bv-w-narrow{max-width:34rem;margin-inline:auto}.bv-w-normal{max-width:46rem;margin-inline:auto}.bv-w-wide{max-width:60rem;margin-inline:auto}.bv-w-full{max-width:none}`);
    out.push(`.bv-pad-sm{padding-block:1rem}.bv-pad-md{padding-block:2rem}.bv-pad-lg{padding-block:4rem}`);
    out.push(`.bv-bg-page{background:var(--bv-bg)}.bv-bg-surface{background:var(--bv-surface);padding:1.25rem;border-radius:var(--bv-radius)}.bv-bg-accent{background:var(--bv-accent);color:var(--bv-accent-text);padding:1.25rem;border-radius:var(--bv-radius)}`);
    out.push(Object.entries(RADII).map(([k, v]) => `.bv-rad-${k}{border-radius:${v}}`).join(''));
    // ---- containers (sections / columns) ----
    out.push(`.bv-section{margin:0 -1.25rem}.bv-section-in{padding:0 1.25rem}`);
    out.push(Object.entries(SECPAD).map(([k, v]) => `.bv-secpad-${k}{padding-block:${v}}`).join(''));
    out.push(`.bv-section.bv-al-center{text-align:center}`);
    out.push(`.bv-cols{display:grid}.bv-cols-2{grid-template-columns:1fr 1fr}.bv-cols-3{grid-template-columns:repeat(3,1fr)}.bv-cols-4{grid-template-columns:repeat(4,1fr)}`);
    out.push(Object.entries(COLGAP).map(([k, v]) => `.bv-gap-${k}{gap:${v}}`).join(''));
    out.push(`.bv-col{min-width:0}@media (max-width:40rem){.bv-cols:not(.bv-nostack){grid-template-columns:1fr}}`);
    // ---- dropdown navigation ----
    out.push(`.bv-nav{display:flex;flex-wrap:wrap;align-items:center;gap:1rem;padding:.75rem 0;border-bottom:1px solid var(--bv-border);margin-bottom:1rem}`);
    out.push(`.bv-brand{font-weight:700;text-decoration:none;color:var(--bv-heading);font-size:1.1rem;margin-right:auto}`);
    out.push(`.bv-navtoggle{display:none;background:none;border:1px solid var(--bv-border);border-radius:.4rem;color:var(--bv-text);font-size:1.2rem;line-height:1;padding:.3rem .6rem;cursor:pointer;min-height:44px}`);
    out.push(`.bv-navmenu{display:flex;flex-wrap:wrap;gap:.25rem 1rem;list-style:none;margin:0;padding:0;align-items:center}.bv-navmenu>li{position:relative}`);
    out.push(`.bv-navmenu a,.bv-sub-toggle{color:var(--bv-text);text-decoration:none;background:none;border:0;font:inherit;cursor:pointer;padding:.5rem .3rem;display:inline-block}.bv-navmenu a:hover,.bv-sub-toggle:hover{color:var(--bv-link)}`);
    out.push(`.bv-sub-menu{list-style:none;margin:0;padding:0}.bv-sub-menu a{display:block;padding:.5rem .6rem;white-space:nowrap;border-radius:.3rem}.bv-sub-menu a:hover{background:rgba(127,127,127,.12)}`);
    out.push(`html.bv-js .bv-sub-menu{display:none;position:absolute;top:100%;left:0;min-width:11rem;background:var(--bv-surface);border:1px solid var(--bv-border);border-radius:var(--bv-radius);padding:.3rem;box-shadow:0 8px 22px rgba(0,0,0,.14);z-index:20}html.bv-js .bv-sub-menu.bv-open{display:block}`);
    out.push(`@media (max-width:46rem){html.bv-js .bv-navtoggle{display:block}html.bv-js .bv-navmenu{display:none;width:100%;flex-direction:column;align-items:flex-start}html.bv-js .bv-navmenu.bv-open{display:flex}html.bv-js .bv-sub-menu{position:static;box-shadow:none;border:0;padding-left:1rem;min-width:0}}`);
    // ---- gallery + lightbox ----
    out.push(`.bv-gallery{display:grid;gap:.6rem;margin:1rem 0}.bv-gcols-2{grid-template-columns:repeat(2,1fr)}.bv-gcols-3{grid-template-columns:repeat(3,1fr)}.bv-gcols-4{grid-template-columns:repeat(4,1fr)}@media(max-width:40rem){.bv-gallery{grid-template-columns:repeat(2,1fr)}}`);
    out.push(`.bv-gitem{display:block;overflow:hidden;border-radius:var(--bv-radius);aspect-ratio:1/1}.bv-gitem img{width:100%;height:100%;object-fit:cover;display:block;border-radius:0;margin:0;transition:transform .2s}.bv-gitem:hover img{transform:scale(1.05)}`);
    out.push(`.bv-lightbox{position:fixed;inset:0;background:rgba(0,0,0,.9);display:flex;align-items:center;justify-content:center;z-index:9999}.bv-lightbox[hidden]{display:none}.bv-lightbox-img{max-width:92vw;max-height:88vh;object-fit:contain;border-radius:.3rem}`);
    out.push(`.bv-lightbox-close,.bv-lightbox-prev,.bv-lightbox-next{position:absolute;background:rgba(0,0,0,.5);color:#fff;border:0;line-height:1;width:3rem;height:3rem;border-radius:50%;cursor:pointer;display:flex;align-items:center;justify-content:center;font-size:1.8rem}.bv-lightbox-close{top:1rem;right:1rem;font-size:1.5rem}.bv-lightbox-prev{left:1rem;top:50%;transform:translateY(-50%)}.bv-lightbox-next{right:1rem;top:50%;transform:translateY(-50%)}`);
    // ---- tabs ----
    out.push(`.bv-tabs{margin:1rem 0}.bv-tablist{display:flex;flex-wrap:wrap;gap:.25rem;border-bottom:2px solid var(--bv-border);margin-bottom:1rem}.bv-tablist [role=tab]{background:none;border:0;border-bottom:2px solid transparent;margin-bottom:-2px;padding:.6rem .9rem;font:inherit;color:var(--bv-muted);cursor:pointer;min-height:44px}.bv-tablist [role=tab][aria-selected=true]{color:var(--bv-accent);border-bottom-color:var(--bv-accent);font-weight:600}.bv-tablist [role=tab]:hover{color:var(--bv-text)}.bv-tabpanel[hidden]{display:none}.bv-tabpanel:focus{outline:none}`);
    // ---- accordion ----
    out.push(`.bv-accordion{margin:1rem 0;border:1px solid var(--bv-border);border-radius:var(--bv-radius);overflow:hidden}.bv-accitem{border-bottom:1px solid var(--bv-border)}.bv-accitem:last-child{border-bottom:0}.bv-accitem>summary{padding:.85rem 2.4rem .85rem 1rem;cursor:pointer;font-weight:600;color:var(--bv-heading);list-style:none;position:relative;min-height:44px;display:flex;align-items:center}.bv-accitem>summary::-webkit-details-marker{display:none}.bv-accitem>summary::after{content:"+";position:absolute;right:1rem;font-weight:400;font-size:1.4rem}.bv-accitem[open]>summary::after{content:"–"}.bv-acc-body{padding:0 1rem 1rem}`);
    // ---- carousel ----
    out.push(`.bv-carousel{position:relative;margin:1rem 0}.bv-track{display:flex;gap:1rem;overflow-x:auto;scroll-snap-type:x mandatory;scroll-behavior:smooth;-webkit-overflow-scrolling:touch;padding-bottom:.5rem}.bv-slide{flex:0 0 100%;scroll-snap-align:start;min-width:0}@media(min-width:48rem){.bv-slide{flex-basis:calc(50% - .5rem)}}.bv-cbtn{position:absolute;top:45%;transform:translateY(-50%);background:var(--bv-surface);color:var(--bv-text);border:1px solid var(--bv-border);width:2.6rem;height:2.6rem;border-radius:50%;font-size:1.5rem;line-height:1;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.15);z-index:2}.bv-cprev{left:-.5rem}.bv-cnext{right:-.5rem}html:not(.bv-js) .bv-cbtn{display:none}`);
    // ---- contact form ----
    out.push(`.bv-form{margin:1rem 0;max-width:34rem}.bv-form-rows{display:grid;gap:.8rem}.bv-field{display:block}.bv-field>span{display:block;font-size:.85rem;margin-bottom:.25rem;color:var(--bv-text)}.bv-field input,.bv-field textarea{width:100%;box-sizing:border-box;padding:.6rem .7rem;border:1px solid var(--bv-border);border-radius:var(--bv-radius);font:inherit;background:var(--bv-surface);color:var(--bv-text);min-height:44px}.bv-field textarea{min-height:7rem;resize:vertical}.bv-req{color:#c0392b}.bv-form-submit{margin-top:1rem;cursor:pointer}.bv-form-status{margin:.6rem 0 0;font-size:.9rem;min-height:1.2em}.bv-form-status[data-kind=ok]{color:#16794a}.bv-form-status[data-kind=err]{color:#c0392b}.bv-hp{position:absolute!important;left:-9999px!important;width:1px;height:1px;opacity:0;pointer-events:none}`);
    // ---- section background image ----
    out.push(`.bv-section-bgimg>.bv-section-in{position:relative}.bv-section-light,.bv-section-light :is(h1,h2,h3,p,li,a,summary,strong,em){color:#fff}`);
    // ---- print / Save-as-PDF (great for résumés: Ctrl/Cmd+P → Save as PDF) ----
    out.push(`@media print{:root{--bv-bg:#fff;--bv-surface:#fff;--bv-text:#111;--bv-heading:#000}body{background:#fff;color:#111}.bv-wrap{max-width:none;padding:.2in .4in}.bv-nav,.bv-navtoggle,.bv-cbtn{display:none}.bv-section{margin:0;break-inside:avoid}.bv-col,.bv-accitem,.bv-tabpanel,.bv-form,li{break-inside:avoid}h1,h2,h3{break-after:avoid}.bv-cols{gap:1.5rem}.bv-btn{background:#fff;color:#111;border:1px solid #999;box-shadow:none}a{color:#111;text-decoration:underline}*{box-shadow:none !important;-webkit-print-color-adjust:exact;print-color-adjust:exact}}`);
    out.push(darkCss(t));
    return out.filter(Boolean).join('\n');
  }
  function darkCss(t) {
    if (t.darkMode === 'off') return '';
    const isDark = relLum(t.colors.pageBg) < 0.35; if (isDark && t.darkMode !== 'force') return '';
    const c = t.colors, dLink = AA(contrastRatio(c.link, '#12141a'), false) ? c.link : '#7db3ff', accT = bestOn(c.accent);
    const block = `:root{--bv-bg:#12141a;--bv-surface:#1b1e26;--bv-text:#e6e8ec;--bv-heading:#ffffff;--bv-muted:#9aa4b2;--bv-border:#2a2f3a;--bv-link:${dLink};--bv-link-hover:${dLink};--bv-accent:${c.accent};--bv-accent-text:${accT}}`;
    return t.darkMode === 'force' ? block : `@media (prefers-color-scheme:dark){${block}}`;
  }
  function elStr(el, ed) {
    const idA = ed ? ` data-bv-id="${esc(el.id)}"` : ''; const ce = ed ? ` contenteditable="${CE}"` : ''; const ov = ovClasses(el);
    const kids = (n) => (n.children || []).map((c) => elStr(c, ed)).join('\n');
    const dz = ed ? ` data-bv-zone="${esc(el.id)}"` : '';
    switch (el.type) {
      case 'heading': { const L = [1, 2, 3].includes(el.level) ? el.level : 2; return `<h${L} class="bv-el${ov}"${idA}${ce}>${esc(el.text)}</h${L}>`; }
      case 'text': return `<p class="bv-el${ov}"${idA}${ce}>${esc(el.text)}</p>`;
      case 'button': return `<a class="bv-btn ${el.variant === 'outline' ? 'bv-outline' : el.variant === 'soft' ? 'bv-soft' : ''}${ov}" href="${esc(safeHref(el.href))}"${idA}${ce}>${esc(el.label || 'Button')}</a>`;
      case 'image': {
        if (!el.asset) return ed ? `<div class="bv-el${ov}"${idA} style="background:#eef;border:1px dashed #99c;color:#669;padding:2rem;text-align:center;border-radius:.5rem">No image yet — upload one in the panel</div>` : '';
        if (!ed) return `<img class="bv-el${ov}" src="${esc('/' + el.asset)}" alt="${esc(el.alt || '')}">`;
        const u = assetUrls.get(el.asset);
        return u ? `<img class="bv-el${ov}" src="${esc(u)}" alt="${esc(el.alt || '')}"${idA}>` : `<div class="bv-el${ov}"${idA} style="background:#f1f5f9;border:1px dashed #cbd5e1;color:#94a3b8;padding:2rem;text-align:center;border-radius:.5rem">Loading image…</div>`;
      }
      case 'divider': return `<hr class="bv-hr${ov}"${idA}>`;
      case 'spacer': return `<div class="bv-el${ov}"${idA} style="height:${({ sm: '1rem', md: '2rem', lg: '4rem' }[el.size] || '2rem')}"></div>`;
      case 'list': { const items = (el.items || []).filter((x) => String(x).trim().length); const tag = el.ordered ? 'ol' : 'ul'; return `<${tag} class="${el.ordered ? 'bv-ol' : 'bv-ul'}${ov}"${idA}>${(items.length ? items : ['List item']).map((i) => `<li>${esc(i)}</li>`).join('')}</${tag}>`; }
      case 'nav': {
        const menuId = el.id + '-m';
        const items = (el.items || []).map((it, i) => {
          if (it.children && it.children.length) {
            const subId = el.id + '-s' + i;
            const subs = it.children.map((s) => `<li><a href="${esc(safeHref(s.href))}">${esc(s.label || 'Link')}</a></li>`).join('');
            return `<li class="bv-has-sub"><button type="button" class="bv-sub-toggle" data-bv-sub-toggle aria-controls="${subId}" aria-expanded="false">${esc(it.label || 'Menu')} <span aria-hidden="true">▾</span></button><ul id="${subId}" class="bv-sub-menu" data-bv-sub-menu>${subs}</ul></li>`;
          }
          return `<li><a href="${esc(safeHref(it.href))}">${esc(it.label || 'Link')}</a></li>`;
        }).join('');
        return `<nav class="bv-nav${ov}"${idA} data-bv-nav><a class="bv-brand" href="#">${esc(el.brand || handle)}</a><button type="button" class="bv-navtoggle" data-bv-nav-toggle aria-controls="${menuId}" aria-expanded="false" aria-label="Menu">☰</button><ul id="${menuId}" class="bv-navmenu" data-bv-nav-menu>${items}</ul></nav>`;
      }
      case 'section': {
        const sty = [];
        if (el.bgImage) {
          const o2 = (typeof el.overlay === 'number' ? el.overlay : 0);
          const grad = o2 > 0 ? `linear-gradient(rgba(0,0,0,${o2}),rgba(0,0,0,${o2}))` : '';
          const bgu = ed ? assetUrls.get(el.bgImage) : ('/' + el.bgImage);
          if (bgu) sty.push(`background-image:${grad ? grad + ',' : ''}url(${esc(bgu)})`, 'background-size:cover', 'background-position:center');
          else if (grad) sty.push(`background-image:${grad}`);   // editor, image still loading: show overlay
        }
        else if (cssColor(el.bg)) sty.push(`background:${cssColor(el.bg)}`);
        const styA = sty.length ? ` style="${sty.join(';')}"` : '';
        const cls = 'bv-section bv-secpad-' + (oneOf(el.pad, ['none', 'sm', 'md', 'lg'], 'md')) + (el.align === 'center' ? ' bv-al-center' : '') + (el.bgImage ? ' bv-section-bgimg' : '') + (el.lightText ? ' bv-section-light' : '');
        const inner = kids(el) || (ed ? '<div class="bv-dzph">Empty section — add or drag blocks here</div>' : '');
        return `<section class="${cls}"${idA}${styA}><div class="bv-section-in"${dz}>${inner}</div></section>`;
      }
      case 'columns': {
        const n = Math.max(2, Math.min(4, (el.children || []).length || oneOf(el.cols, [2, 3], 2)));
        const cls = 'bv-cols bv-cols-' + n + ' bv-gap-' + (oneOf(el.gap, ['sm', 'md', 'lg'], 'md')) + (el.stack === false ? ' bv-nostack' : '');
        return `<div class="${cls}"${idA}>${kids(el)}</div>`;
      }
      case 'column': {
        const inner = kids(el) || (ed ? '<div class="bv-dzph">Drop blocks here</div>' : '');
        return `<div class="bv-col"${idA}${dz}>${inner}</div>`;
      }
      case 'gallery': {
        const cols = oneOf(el.cols, [2, 3, 4], 3);
        const items = (el.items || []).filter((g) => g && g.asset);
        if (!items.length) return ed ? `<div class="bv-el${ov}"${idA} style="background:#eef;border:1px dashed #99c;color:#669;padding:2rem;text-align:center;border-radius:.5rem">Empty gallery — add images in the panel →</div>` : '';
        const cells = items.map((g) => { const a = esc(g.alt || ''); if (!ed) { const src = esc('/' + g.asset); return `<a class="bv-gitem" data-bv-item href="${src}"><img src="${src}" alt="${a}" loading="lazy"></a>`; } const u = assetUrls.get(g.asset); return u ? `<span class="bv-gitem"><img src="${esc(u)}" alt="${a}"></span>` : `<span class="bv-gitem" style="background:#e2e8f0"></span>`; }).join('');
        return `<div class="bv-gallery bv-gcols-${cols}${ov}"${idA} data-bv-gallery>${cells}</div>`;
      }
      case 'form': {
        const rows = (el.fields || []).map((f) => { const req = f.required ? ' required' : ''; const star = f.required ? ' <span class="bv-req" aria-hidden="true">*</span>' : ''; const dis = ed ? ' disabled' : ''; const ctrl = f.type === 'textarea' ? `<textarea name="${esc(f.name)}" rows="4"${req}${dis}></textarea>` : `<input type="${f.type === 'email' ? 'email' : f.type === 'tel' ? 'tel' : 'text'}" name="${esc(f.name)}"${req}${dis}>`; return `<label class="bv-field"><span>${esc(f.label)}${star}</span>${ctrl}</label>`; }).join('');
        const hp = `<input class="bv-hp" data-bv-hp name="_hp" tabindex="-1" autocomplete="off" aria-hidden="true" value="">`;
        return `<div class="bv-form${ov}"${idA} data-bv-form role="form" aria-label="${esc(el.title || 'Contact form')}" data-bv-success="${esc(el.success || 'Thanks! Your message was sent.')}"><div class="bv-form-rows">${rows}</div>${hp}<button type="button" class="bv-btn bv-form-submit" data-bv-submit${ed ? ' disabled' : ''}>${esc(el.submitLabel || 'Send')}</button><p class="bv-form-status" data-bv-status role="status" aria-live="polite"></p></div>`;
      }
      case 'tabs': {
        const panels = el.children || [];
        const tablist = panels.map((p, i) => `<button type="button" role="tab" id="${esc(p.id)}-t" aria-controls="${esc(p.id)}" aria-selected="${i === 0 ? 'true' : 'false'}"${i === 0 ? '' : ' tabindex="-1"'}>${esc(p.label || ('Tab ' + (i + 1)))}</button>`).join('');
        return `<div class="bv-tabs${ov}"${idA} data-bv-tabs><div class="bv-tablist" role="tablist">${tablist}</div>${panels.map((p) => elStr(p, ed)).join('')}</div>`;
      }
      case 'tabpanel': { const inner = kids(el) || (ed ? '<div class="bv-dzph">Empty tab — add or drag blocks here</div>' : ''); return `<div class="bv-tabpanel" role="tabpanel" id="${esc(el.id)}" aria-labelledby="${esc(el.id)}-t"${idA}${dz}>${inner}</div>`; }
      case 'accordion': { const single = el.single ? ' data-bv-single' : ''; return `<div class="bv-accordion${ov}"${idA} data-bv-accordion${single}>${(el.children || []).map((p) => elStr(p, ed)).join('')}</div>`; }
      case 'accitem': { const inner = kids(el) || (ed ? '<div class="bv-dzph">Empty — add or drag blocks here</div>' : ''); const open = (ed || el.open) ? ' open' : ''; return `<details class="bv-accitem"${idA}${open}><summary>${esc(el.label || 'Section')}</summary><div class="bv-acc-body"${dz}>${inner}</div></details>`; }
      case 'carousel': { return `<div class="bv-carousel${ov}"${idA} data-bv-carousel><div class="bv-track" data-bv-track>${(el.children || []).map((p) => elStr(p, ed)).join('')}</div><button type="button" class="bv-cbtn bv-cprev" data-bv-prev aria-label="Previous slide">‹</button><button type="button" class="bv-cbtn bv-cnext" data-bv-next aria-label="Next slide">›</button></div>`; }
      case 'slide': { const inner = kids(el) || (ed ? '<div class="bv-dzph">Empty slide — add or drag blocks here</div>' : ''); return `<div class="bv-slide"${idA}${dz}>${inner}</div>`; }
      default: return '';
    }
  }
  const bodyInner = (ed) => model.page.elements.length ? model.page.elements.map((e) => elStr(e, ed)).join('\n') : (ed ? '<div class="bv-dzph" style="margin:2rem">Empty page — add a block or a section.</div>' : '');
  const EDIT_CSS = `.bv-el,[data-bv-id]{cursor:pointer}[data-bv-id]:hover{outline:1px dashed #94a3b8;outline-offset:2px}[data-bv-sel]{outline:2px solid #2563eb !important;outline-offset:2px}[contenteditable]:focus{outline:2px solid #2563eb;outline-offset:2px}.bv-dzph{color:#94a3b8;text-align:center;padding:1.5rem;border:2px dashed #cbd5e1;border-radius:.5rem;margin:.25rem 0;font-size:.85rem}[data-bv-zone]{min-height:1.5rem}.bv-cols{min-height:2rem}.bv-track{overflow:visible !important;flex-wrap:wrap !important;gap:.5rem !important}.bv-slide{flex-basis:100% !important}.bv-tabpanel{display:block !important;border:1px dashed var(--bv-border);border-radius:.3rem;padding:.5rem;margin-bottom:.4rem}.bv-cbtn{display:none !important}.bv-form input,.bv-form textarea,.bv-gitem,.bv-tablist [role=tab]{pointer-events:none}`;
  const rootZone = (ed) => ed ? ' data-bv-zone="__root__"' : '';
  const srcdoc = () => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style id="bv-style">${cssText(model.theme)}\n${EDIT_CSS}</style></head><body><div class="bv-wrap"${rootZone(true)}>${bodyInner(true)}</div></body></html>`;
  const publishHtml = () => {
    const t = model.page.title || handle;
    const d = String(model.page.description || '').trim();
    const kw = (model.page.tags || []).join(', ');
    const tc = (model.theme && model.theme.colors && model.theme.colors.accent) || '';
    // SEO + directory meta (name-based meta survive the publish sanitizer; og:* needs
    // 'property' in the server ADD_ATTR list). The #/explore index reads these from the head.
    const seo = (d ? `<meta name="description" content="${esc(d)}">` : '')
      + (kw ? `<meta name="keywords" content="${esc(kw)}">` : '')
      + (tc ? `<meta name="theme-color" content="${esc(tc)}">` : '')
      + `<meta property="og:title" content="${esc(t)}">`
      + (d ? `<meta property="og:description" content="${esc(d)}">` : '');
    return `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(t)}</title>${seo}<link rel="stylesheet" href="/styles.css"></head>\n<body>\n<div class="bv-wrap">\n${bodyInner(false)}\n</div>\n</body>\n</html>\n`;
  };

  // ---------- history ----------
  const clone = (x) => JSON.parse(JSON.stringify(x));
  const history = (() => {
    const past = [], future = []; let lastTag = null, lastT = 0; const CAP = 60, COALESCE = 600;
    return {
      record(tag) { const now = perfNow(); if (tag && tag === lastTag && now - lastT < COALESCE) { lastT = now; return; } lastTag = tag; lastT = now; past.push(clone(model)); if (past.length > CAP) past.shift(); future.length = 0; },
      seal() { lastTag = null; },
      undo() { if (!past.length) return false; future.push(clone(model)); model = past.pop(); lastTag = null; return true; },
      redo() { if (!future.length) return false; past.push(clone(model)); model = future.pop(); lastTag = null; return true; },
      canUndo: () => past.length > 0, canRedo: () => future.length > 0,
    };
  })();
  function perfNow() { try { return performance.now(); } catch (e) { return past0(); } }
  let _t0 = 0; function past0() { return (_t0 += 16); }

  // ---------- shell ----------
  const root = h('div', { class: 'bvb' });
  const bar = h('div', { class: 'bvb-bar' });
  const saveStatus = h('span', { style: 'color:#888;font-size:.8rem;margin-left:auto', 'aria-live': 'polite' }, 'Saved');
  const publishMsg = h('span', { style: 'font-size:.82rem;color:#666', 'aria-live': 'polite' });
  const publishBtn = h('button', { type: 'button', class: 'bvb-pub' }, 'Publish');
  const undoBtn = h('button', { type: 'button', class: 'bvb-act', 'aria-label': 'Undo', title: 'Undo (Ctrl+Z)', onclick: () => doUndo() }, '↶');
  const redoBtn = h('button', { type: 'button', class: 'bvb-act', 'aria-label': 'Redo', title: 'Redo (Ctrl+Shift+Z)', onclick: () => doRedo() }, '↷');
  const tplBtn = h('button', { type: 'button', class: 'bvb-act', onclick: () => openTemplates() }, 'Templates');
  bar.appendChild(h('strong', null, 'Builder'));
  bar.appendChild(h('span', { class: 'bvb-host' }, handle + '.yourdomain.com'));
  bar.appendChild(tplBtn); bar.appendChild(undoBtn); bar.appendChild(redoBtn);
  bar.appendChild(h('a', { href: '#/sitecode', style: 'font-size:.82rem' }, 'Code'));
  bar.appendChild(saveStatus); bar.appendChild(publishMsg); bar.appendChild(publishBtn);
  root.appendChild(bar);
  const palette = h('div', { class: 'bvb-palette' });
  const canvas = h('div', { class: 'bvb-canvas' });
  const inspector = h('div', { class: 'bvb-inspector' });
  root.appendChild(palette); root.appendChild(canvas); root.appendChild(inspector);
  const bottombar = h('div', { class: 'bvb-bottombar' });
  const closePanels = () => { palette.classList.remove('bvb-open'); inspector.classList.remove('bvb-open'); };
  bottombar.appendChild(h('button', { type: 'button', onclick: () => { const o = palette.classList.contains('bvb-open'); closePanels(); if (!o) palette.classList.add('bvb-open'); } }, '+ Add'));
  bottombar.appendChild(h('button', { type: 'button', onclick: () => { const o = inspector.classList.contains('bvb-open'); closePanels(); if (!o) inspector.classList.add('bvb-open'); } }, 'Design / Edit'));
  root.appendChild(bottombar);
  // DnD overlay elements (app-realm, position:fixed)
  // Floating per-element toolbar (Wix-style): delete / duplicate / drag, shown on the selected block.
  const handleEl = h('button', { type: 'button', class: 'bvb-handle', 'aria-label': 'Drag to move', tabindex: '-1', title: 'Drag to move' }, '✥');
  const delBtn = h('button', { type: 'button', class: 'bvb-ebtn del', 'aria-label': 'Delete block', title: 'Delete', onclick: () => { if (selectedId) del(selectedId); } }, '✕');
  const dupBtn = h('button', { type: 'button', class: 'bvb-ebtn', 'aria-label': 'Duplicate block', title: 'Duplicate', onclick: () => { if (selectedId) dup(selectedId); } }, '⧉');
  const etoolbar = h('div', { class: 'bvb-etoolbar' }, delBtn, dupBtn, handleEl);
  const dropline = h('div', { class: 'bvb-dropline' });
  const zonehi = h('div', { class: 'bvb-zonehi' });
  const ghost = h('div', { class: 'bvb-ghost' });
  const liveRegion = h('div', { class: 'bvb-sr', 'aria-live': 'polite', role: 'status' });
  root.appendChild(etoolbar); root.appendChild(dropline); root.appendChild(zonehi); root.appendChild(ghost); root.appendChild(liveRegion);
  container.appendChild(root);
  function announce(msg) { if (liveRegion) { liveRegion.textContent = ''; liveRegion.textContent = String(msg == null ? '' : msg); } }

  const drawerCloser = (panel) => h('button', { type: 'button', class: 'bvb-drawerclose', onclick: () => panel.classList.remove('bvb-open') }, 'Done');
  palette.appendChild(drawerCloser(palette));
  const mkHd = (t, lv) => ({ id: uid(), type: 'heading', level: lv || 3, text: t, style: {} });
  const mkTx = (t) => ({ id: uid(), type: 'text', text: t, style: {} });
  const mkPanel = (type, label, kids) => { const o = { id: uid(), type, style: {}, children: kids || [] }; if (type !== 'slide') o.label = label; return o; };
  const BLOCKS = [
    { g: 'Basic', n: 'Heading', i: 'H', mk: () => ({ id: uid(), type: 'heading', level: 2, text: 'Heading', style: {} }) },
    { g: 'Basic', n: 'Text', i: '¶', mk: () => ({ id: uid(), type: 'text', text: 'Your text goes here.', style: {} }) },
    { g: 'Basic', n: 'Button', i: '▭', mk: () => ({ id: uid(), type: 'button', label: 'Click me', href: '#', variant: 'solid', style: {} }) },
    { g: 'Basic', n: 'Image', i: '▣', mk: () => ({ id: uid(), type: 'image', asset: '', alt: '', style: {} }) },
    { g: 'Basic', n: 'List', i: '•', mk: () => ({ id: uid(), type: 'list', items: ['First item', 'Second item'], ordered: false, style: {} }) },
    { g: 'Basic', n: 'Divider', i: '—', mk: () => ({ id: uid(), type: 'divider', style: {} }) },
    { g: 'Basic', n: 'Spacer', i: '⇳', mk: () => ({ id: uid(), type: 'spacer', size: 'md', style: {} }) },
    { g: 'Layout', n: 'Section', i: '▤', mk: () => ({ id: uid(), type: 'section', bg: '', pad: 'md', align: 'left', style: {}, children: [] }) },
    { g: 'Layout', n: '2 Columns', i: '◫', mk: () => ({ id: uid(), type: 'columns', cols: 2, gap: 'md', stack: true, style: {}, children: [{ id: uid(), type: 'column', style: {}, children: [] }, { id: uid(), type: 'column', style: {}, children: [] }] }) },
    { g: 'Layout', n: '3 Columns', i: '⫼', mk: () => ({ id: uid(), type: 'columns', cols: 3, gap: 'md', stack: true, style: {}, children: [{ id: uid(), type: 'column', style: {}, children: [] }, { id: uid(), type: 'column', style: {}, children: [] }, { id: uid(), type: 'column', style: {}, children: [] }] }) },
    { g: 'Layout', n: 'Navigation', i: '☰', mk: () => ({ id: uid(), type: 'nav', brand: handle, style: {}, items: [{ id: uid(), label: 'Home', href: '#', children: [] }, { id: uid(), label: 'About', href: '#', children: [] }, { id: uid(), label: 'More', href: '#', children: [{ id: uid(), label: 'Services', href: '#' }, { id: uid(), label: 'Contact', href: '#' }] }] }) },
    { g: 'Sections', n: 'Tabs', i: '⊟', mk: () => ({ id: uid(), type: 'tabs', style: {}, children: [mkPanel('tabpanel', 'Tab one', [mkHd('Tab one'), mkTx('Content for the first tab.')]), mkPanel('tabpanel', 'Tab two', [mkTx('Content for the second tab.')])] }) },
    { g: 'Sections', n: 'Accordion', i: '≣', mk: () => ({ id: uid(), type: 'accordion', single: false, style: {}, children: [mkPanel('accitem', 'First question', [mkTx('Answer to the first question.')]), mkPanel('accitem', 'Second question', [mkTx('Answer to the second question.')])] }) },
    { g: 'Sections', n: 'Slideshow', i: '▷', mk: () => ({ id: uid(), type: 'carousel', style: {}, children: [mkPanel('slide', null, [mkHd('Slide one'), mkTx('Add text or an image to this slide.')]), mkPanel('slide', null, [mkHd('Slide two'), mkTx('Second slide.')])] }) },
    { g: 'Media & forms', n: 'Gallery', i: '▦', mk: () => ({ id: uid(), type: 'gallery', cols: 3, items: [], style: {} }) },
    { g: 'Media & forms', n: 'Contact form', i: '✉', mk: () => ({ id: uid(), type: 'form', title: 'Contact', submitLabel: 'Send', success: 'Thanks! Your message was sent.', fields: [{ type: 'text', label: 'Name', name: 'name', required: true }, { type: 'email', label: 'Email', name: 'email', required: true }, { type: 'textarea', label: 'Message', name: 'message', required: true }], style: {} }) },
  ];
  let _lastGroup = null;
  // Uniform line-icons for the block palette (24 viewBox, 2px stroke, centered) — replaces
  // mismatched Unicode glyphs that never aligned (different blocks => different metrics).
  const PAL_ICONS = {
    'Heading': '<path d="M6 4v16M18 4v16M6 12h12"/>',
    'Text': '<path d="M4 6h16M4 12h16M4 18h11"/>',
    'Button': '<rect x="3" y="8" width="18" height="8" rx="4"/><path d="M9 12h6"/>',
    'Image': '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.6"/><path d="M21 15l-5-5L5 21"/>',
    'List': '<path d="M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01"/>',
    'Divider': '<path d="M3 12h18"/><path d="M7 7h10M7 17h10" opacity=".4"/>',
    'Spacer': '<path d="M12 3v18M8 7l4-4 4 4M8 17l4 4 4-4"/>',
    'Section': '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 9h10M7 13h6"/>',
    '2 Columns': '<rect x="3" y="4" width="7.5" height="16" rx="1"/><rect x="13.5" y="4" width="7.5" height="16" rx="1"/>',
    '3 Columns': '<rect x="3" y="4" width="5" height="16" rx="1"/><rect x="9.5" y="4" width="5" height="16" rx="1"/><rect x="16" y="4" width="5" height="16" rx="1"/>',
    'Navigation': '<rect x="2.5" y="7" width="19" height="6" rx="2"/><path d="M6.5 10h2M11 10h2M15.5 10h2"/>',
    'Tabs': '<rect x="3" y="9" width="18" height="11" rx="1.5"/><path d="M3 9V7.5A1.5 1.5 0 0 1 4.5 6H9v3"/>',
    'Accordion': '<rect x="3" y="4" width="18" height="5" rx="1.5"/><rect x="3" y="11" width="18" height="9" rx="1.5"/><path d="M15.5 6L17 7.5 18.5 6"/>',
    'Slideshow': '<rect x="7" y="5" width="10" height="14" rx="1.5"/><path d="M4 8v8M20 8v8"/>',
    'Gallery': '<rect x="3" y="3" width="7.5" height="7.5" rx="1"/><rect x="13.5" y="3" width="7.5" height="7.5" rx="1"/><rect x="3" y="13.5" width="7.5" height="7.5" rx="1"/><rect x="13.5" y="13.5" width="7.5" height="7.5" rx="1"/>',
    'Contact form': '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3.5 7L12 13l8.5-6"/>',
  };
  const palIconSvg = (name) => `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${PAL_ICONS[name] || ''}</svg>`;
  for (const blk of BLOCKS) {
    if (blk.g !== _lastGroup) { _lastGroup = blk.g; palette.appendChild(h('div', { class: 'bvb-grouphdr' }, blk.g)); }
    const btn = h('button', { type: 'button', class: 'bvb-palbtn', title: 'Add ' + blk.n, onclick: () => { if (dragJustDropped) { dragJustDropped = false; return; } addEl(blk.mk()); if (isMobile()) { palette.classList.remove('bvb-open'); inspector.classList.add('bvb-open'); } } });
    const ic = h('span', { class: 'bvb-palicon', 'aria-hidden': 'true' }); ic.innerHTML = palIconSvg(blk.n); btn.appendChild(ic);
    btn.appendChild(h('span', { class: 'bvb-pallabel' }, blk.n));
    btn.addEventListener('pointerdown', (e) => { if (e.pointerType === 'touch' || (e.button != null && e.button !== 0)) return; beginPaletteDrag(e, btn, blk.mk, blk.n); });
    palette.appendChild(btn);
  }

  const frame = h('iframe', { class: 'bvb-frame', sandbox: 'allow-same-origin', title: 'Live preview of your site' });
  canvas.appendChild(frame);
  let cdoc = null, bvStyle = null, bvRoot = null, wired = false;

  function syncNode(node) { const id = node.getAttribute && node.getAttribute('data-bv-id'); if (!id) return; const el = byId(id); if (!el) return; const val = String(node.textContent || '').replace(/[\r\n]+/g, ' '); if (el.type === 'button') { if (el.label !== val) { history.record('edit:' + id); el.label = val; changed(); } } else if (el.type === 'heading' || el.type === 'text') { if (el.text !== val) { history.record('edit:' + id); el.text = val; changed(); } } }
  function flushActiveEdit() { if (!cdoc) return; const a = cdoc.activeElement; if (a && a.getAttribute && a.getAttribute('contenteditable') != null) syncNode(a); }
  function highlight() { if (!cdoc) return; cdoc.querySelectorAll('[data-bv-sel]').forEach((n) => n.removeAttribute('data-bv-sel')); if (selectedId) { let n = null; cdoc.querySelectorAll('[data-bv-id]').forEach((x) => { if (x.getAttribute('data-bv-id') === selectedId) n = x; }); if (n) n.setAttribute('data-bv-sel', '1'); } placeHandle(); }
  function applyTheme() { flushActiveEdit(); if (bvStyle) bvStyle.textContent = cssText(model.theme) + '\n' + EDIT_CSS; }
  const nodeInDoc = (id) => { if (!bvRoot) return null; let n = null; bvRoot.querySelectorAll('[data-bv-id]').forEach((x) => { if (x.getAttribute('data-bv-id') === id) n = x; }); return n; };
  function patchEl(id) { flushActiveEdit(); if (!bvRoot) return; const node = nodeInDoc(id); const el = byId(id); if (!node || !el) { structural(); return; } const tmp = cdoc.createElement('div'); tmp.innerHTML = elStr(el, true); if (tmp.firstElementChild) node.replaceWith(tmp.firstElementChild); highlight(); }
  function structural() { flushActiveEdit(); reindex(); if (bvRoot) { bvRoot.innerHTML = bodyInner(true); highlight(); } }
  // ---------- editor asset previews ----------
  // The canvas is a srcdoc iframe, so "/media/x.jpg" would resolve to the APP origin
  // (not the user's site, and staging files aren't web-served anyway). So in the editor
  // we render images as data URLs: cached on upload, or fetched (authed) on load.
  const ASSET_MIME = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', avif: 'image/avif', bmp: 'image/bmp', ico: 'image/x-icon' };
  const assetDataUrl = (name, b64) => { const ext = (/\.([a-z0-9]+)$/i.exec(name) || [, ''])[1].toLowerCase(); return `data:${ASSET_MIME[ext] || 'application/octet-stream'};base64,${b64}`; };
  const cacheAsset = (name, b64) => { if (name && b64) assetUrls.set(name, assetDataUrl(name, b64)); };
  function eachAsset(fn) { (function walk(list) { for (const e of (list || [])) { if (e.type === 'image' && e.asset) fn(e.asset, e); else if (e.type === 'gallery') (e.items || []).forEach((g) => { if (g.asset) fn(g.asset, e); }); else if (e.type === 'section' && e.bgImage) fn(e.bgImage, e); if (e.children) walk(e.children); } })(model.page.elements); }
  function patchAssetNodes(name) { const ids = []; eachAsset((a, e) => { if (a === name && ids.indexOf(e.id) < 0) ids.push(e.id); }); for (const id of ids) patchEl(id); }
  async function ensureAsset(name) {
    if (!name || assetUrls.has(name) || assetPending.has(name)) return;
    assetPending.add(name);
    try {
      const r = await api('GET', '/api/sites/file?path=' + encodeURIComponent(name));
      let b64 = null;
      if (r && r.ok && r.data) { if (typeof r.data.data_b64 === 'string') b64 = r.data.data_b64; else if (typeof r.data.text === 'string') { try { b64 = btoa(unescape(encodeURIComponent(r.data.text))); } catch (e) {} } }
      if (b64) { assetUrls.set(name, assetDataUrl(name, b64)); patchAssetNodes(name); }
    } catch (e) {} finally { assetPending.delete(name); }
  }
  function ensureAssets() { const seen = new Set(); eachAsset((a) => { if (!seen.has(a)) { seen.add(a); ensureAsset(a); } }); }
  function remount() { wired = false; frame.srcdoc = srcdoc(); } // full rebuild (undo/template)
  function wireCanvas() {
    cdoc = frame.contentDocument; if (!cdoc) return; bvStyle = cdoc.getElementById('bv-style'); bvRoot = cdoc.querySelector('.bv-wrap');
    if (!wired) { wired = true;
      cdoc.addEventListener('click', (e) => { const n = e.target.closest && e.target.closest('[data-bv-id]'); if (n && e.altKey) { const s = slotOf(n.getAttribute('data-bv-id')); if (s && s.parent) { select(s.parent.id); return; } } select(n ? n.getAttribute('data-bv-id') : null); });
      cdoc.addEventListener('focusin', (e) => { const n = e.target.closest && e.target.closest('[data-bv-id]'); if (n) { const id = n.getAttribute('data-bv-id'); if (id && id !== selectedId) select(id); } });
      cdoc.addEventListener('focusout', (e) => { const n = e.target; if (n && n.getAttribute && n.getAttribute('contenteditable') != null) { syncNode(n); history.seal(); } });
      cdoc.addEventListener('keydown', (e) => { const n = e.target; if (e.key === 'Escape' && selectedId) { const s = slotOf(selectedId); if (s && s.parent) { e.preventDefault(); select(s.parent.id); return; } } if (e.key === 'Enter' && n && n.getAttribute && n.getAttribute('data-bv-id')) { const el = byId(n.getAttribute('data-bv-id')); if (el && (el.type === 'heading' || el.type === 'button')) { e.preventDefault(); n.blur(); } } });
      try { cdoc.addEventListener('scroll', placeHandle, true); } catch (e) {}
      attachLongPress();
    }
    highlight();
    ensureAssets();   // fetch staged images as data URLs so they show in the canvas
  }
  frame.addEventListener('load', wireCanvas);
  frame.srcdoc = srcdoc();
  try { canvas.addEventListener('scroll', () => { placeHandle(); }); } catch (e) {}
  try { window.addEventListener('resize', () => { placeHandle(); }); } catch (e) {}
  try { if (typeof ResizeObserver === 'function') { const ro = new ResizeObserver(() => placeHandle()); ro.observe(frame); } } catch (e) {}

  // ---------- drag & drop (pointer-based, app-realm; CSP-safe, zero iframe scripts) ----------
  // App-realm drags (mouse/pen via the handle or palette) use setPointerCapture, so their
  // move/up events bubble to window. Touch drags start INSIDE the iframe (long-press); touch
  // pointers get IMPLICIT capture to their iframe target, so those events stay in cdoc — we
  // listen there too. drag.fromFrame distinguishes the coordinate space (iframe-relative).
  let drag = null, asTimer = 0, lpTimer = 0, dragJustDropped = false;
  const frameRect = () => frame.getBoundingClientRect();
  function appRectOf(node) { const r = node.getBoundingClientRect(); const fr = frameRect(); return { left: r.left + fr.left, top: r.top + fr.top, right: r.right + fr.left, bottom: r.bottom + fr.top, width: r.width, height: r.height }; }
  const drawerOpen = () => palette.classList.contains('bvb-open') || inspector.classList.contains('bvb-open');
  function placeHandle() {
    if (drag || !selectedId || !cdoc || drawerOpen()) { etoolbar.style.display = 'none'; return; }
    const node = nodeInDoc(selectedId); if (!node) { etoolbar.style.display = 'none'; return; }
    const el = byId(selectedId), t = el ? el.type : '';
    if (t === 'column' || PANEL_TYPES.has(t)) { etoolbar.style.display = 'none'; return; } // parent-managed: no toolbar
    const ar = appRectOf(node), cr = canvas.getBoundingClientRect();
    if (ar.bottom < cr.top + 4 || ar.top > cr.bottom - 4) { etoolbar.style.display = 'none'; return; }
    etoolbar.style.display = 'flex';
    const tw = etoolbar.offsetWidth || 120, th = etoolbar.offsetHeight || 36;
    const left = Math.max(cr.left + 2, Math.min(ar.left, cr.right - tw - 2));
    let top = ar.top - th - 4;                          // float just above the block…
    if (top < cr.top + 2) top = ar.top + 2;             // …or overlap the top-left corner if there's no room
    top = Math.max(cr.top + 2, Math.min(top, cr.bottom - th - 2));
    etoolbar.style.left = left + 'px'; etoolbar.style.top = top + 'px';
  }
  function vp(e) { if (drag && drag.fromFrame) { const fr = frameRect(); return { x: e.clientX + fr.left, y: e.clientY + fr.top }; } return { x: e.clientX, y: e.clientY }; }
  function beginDrag(info, e, fromFrame) { drag = Object.assign({ pointerId: e.pointerId, moved: false, raf: 0, lastHit: null, fromFrame: !!fromFrame }, info); const p = vp(e); drag.sx = p.x; drag.sy = p.y; }
  function beginReorderDrag(e, id, fromFrame) { if (!fromFrame) { try { handleEl.setPointerCapture(e.pointerId); } catch (er) {} } beginDrag({ kind: 'move', id }, e, fromFrame); }
  function beginPaletteDrag(e, btn, make, label) { try { btn.setPointerCapture(e.pointerId); } catch (er) {} let nt = ''; try { nt = make().type; } catch (er) {} beginDrag({ kind: 'new', make, label: label || btn.textContent, newType: nt }, e, false); }
  function draggedType() { return !drag ? '' : (drag.kind === 'new' ? (drag.newType || '') : (byId(drag.id) ? byId(drag.id).type : '')); }
  handleEl.addEventListener('pointerdown', (e) => { if (e.button != null && e.button !== 0) return; if (!selectedId) return; e.preventDefault(); beginReorderDrag(e, selectedId, false); });
  function onMove(e) {
    if (!drag || e.pointerId !== drag.pointerId) return;
    const p = vp(e);
    if (!drag.moved) { if (Math.hypot(p.x - drag.sx, p.y - drag.sy) < 8) return; startVisuals(); }
    drag.last = e; if (!drag.raf) drag.raf = requestAnimationFrame(dragFrame);
  }
  function startVisuals() { drag.moved = true; etoolbar.style.display = 'none'; ghost.style.display = 'block'; ghost.textContent = drag.kind === 'new' ? drag.label : ('Moving ' + ((byId(drag.id) || {}).type || 'block')); try { document.body.style.touchAction = 'none'; } catch (e) {} try { if (cdoc) cdoc.documentElement.style.touchAction = 'none'; } catch (e) {} }
  function moveGhost(x, y) { ghost.style.left = x + 'px'; ghost.style.top = y + 'px'; }
  function dragFrame() {
    if (!drag) return; drag.raf = 0; const e = drag.last; if (!e) return; const p = vp(e);
    moveGhost(p.x, p.y); autoScroll(p.y);
    const fr = frameRect(); const inside = p.x >= fr.left && p.x <= fr.right && p.y >= fr.top && p.y <= fr.bottom;
    let hit = null;
    if (inside && cdoc) { hit = hitDrop(p.x - fr.left, p.y - fr.top); if (hit && hit.mode === 'v' && drag.kind === 'move' && !canDropInto(byId(drag.id) ? byId(drag.id).type : '', hit.zoneId)) hit = null; }
    drag.lastHit = hit; showDrop(hit);
  }
  const EDGE_BAND = 0.2;   // outer 20% of a block's width triggers side-by-side placement
  function hitDrop(fx, fy) {
    let el = cdoc.elementFromPoint(fx, fy); let zoneEl = null;
    while (el && el !== cdoc.documentElement) { if (el.hasAttribute && el.hasAttribute('data-bv-zone')) { zoneEl = el; break; } el = el.parentElement; }
    if (!zoneEl) return null;
    const zoneId = zoneEl.getAttribute('data-bv-zone');
    let kids = Array.prototype.filter.call(zoneEl.children, (c) => c.hasAttribute && c.hasAttribute('data-bv-id'));
    if (drag && drag.kind === 'move') kids = kids.filter((c) => c.getAttribute('data-bv-id') !== drag.id); // exclude the dragged node so the indicator matches the committed index
    // --- side-by-side: a leaf dragged near the left/right edge of a leaf target ---
    const dt = draggedType();
    if (kids.length && LEAF_TYPES.has(dt)) {
      let ti = -1;
      for (let i = 0; i < kids.length; i++) { const r = kids[i].getBoundingClientRect(); if (fy >= r.top && fy <= r.bottom) { ti = i; break; } }
      if (ti >= 0) {
        const kr = kids[ti].getBoundingClientRect(); const band = (fx - kr.left) / Math.max(1, kr.width);
        const targetId = kids[ti].getAttribute('data-bv-id'); const target = byId(targetId);
        if ((band < EDGE_BAND || band > 1 - EDGE_BAND) && target && LEAF_TYPES.has(target.type)) {
          const side = band < EDGE_BAND ? 'left' : 'right'; const k = zoneKind(zoneId);
          if (k === 'root' || k === 'section' || k === 'tabpanel' || k === 'accitem' || k === 'slide') return { mode: 'wrap', zoneId, targetId, side, rectEl: kids[ti] };
          if (k === 'column') { const cs = slotOf(zoneId); if (cs && cs.parent && cs.parent.type === 'columns' && cs.parent.children.length < 4) return { mode: 'colinsert', columnsId: cs.parent.id, colId: zoneId, side, rectEl: zoneEl }; }
        }
      }
    }
    // --- normal vertical insert (above/below) ---
    let index = kids.length;
    for (let i = 0; i < kids.length; i++) { const r = kids[i].getBoundingClientRect(); const mid = (r.top + r.bottom) / 2; if (fy < mid) { index = i; break; } }
    return { mode: 'v', zoneEl, zoneId, index, kids };
  }
  function showDrop(hit) {
    if (!hit) { dropline.style.display = 'none'; zonehi.style.display = 'none'; return; }
    const cr = canvas.getBoundingClientRect();
    if (hit.mode === 'wrap' || hit.mode === 'colinsert') {   // vertical line beside the target
      zonehi.style.display = 'none';
      const r = appRectOf(hit.rectEl); const x = hit.side === 'left' ? r.left - 3 : r.right - 1;
      const top = Math.max(cr.top, r.top), bot = Math.min(cr.bottom, r.bottom);
      Object.assign(dropline.style, { display: 'block', left: x + 'px', top: top + 'px', width: '4px', height: Math.max(8, bot - top) + 'px' });
      return;
    }
    if (hit.kids.length === 0) { const r = appRectOf(hit.zoneEl); Object.assign(zonehi.style, { display: 'block', left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: Math.max(r.height, 24) + 'px' }); dropline.style.display = 'none'; return; }
    zonehi.style.display = 'none';
    const zr = appRectOf(hit.zoneEl); let y;
    if (hit.index < hit.kids.length) y = appRectOf(hit.kids[hit.index]).top - 2; else y = appRectOf(hit.kids[hit.kids.length - 1]).bottom - 2;
    y = Math.max(cr.top, Math.min(y, cr.bottom));
    Object.assign(dropline.style, { display: 'block', left: zr.left + 'px', top: y + 'px', width: zr.width + 'px', height: '4px' });
  }
  function autoScroll(clientY) {
    const r = canvas.getBoundingClientRect(); const EDGE = 48; let dir = 0;
    if (clientY < r.top + EDGE) dir = -1; else if (clientY > r.bottom - EDGE) dir = 1;
    if (!dir) { asTimer = 0; return; } if (asTimer) return; asTimer = 1;
    (function loop() { if (!drag || !asTimer) { asTimer = 0; return; } canvas.scrollTop += dir * 12; if (drag.last) dragFrame(); requestAnimationFrame(loop); })();
  }
  function clearDragVisuals(d) { asTimer = 0; if (d && d.raf) { try { cancelAnimationFrame(d.raf); } catch (er) {} } ghost.style.display = 'none'; dropline.style.display = 'none'; zonehi.style.display = 'none'; try { document.body.style.touchAction = ''; } catch (er) {} try { if (cdoc) cdoc.documentElement.style.touchAction = ''; } catch (er) {} }
  function abortDrag() { if (!drag) return; const d = drag; drag = null; clearDragVisuals(d); placeHandle(); }
  // Side-by-side: wrap target + dragged leaf into a 2-col row (root/section/panel zones).
  function commitWrap(d, hit) {
    history.record(d.kind === 'new' ? 'drop-new' : 'drop-move'); history.seal();
    let N;
    if (d.kind === 'new') N = d.make();
    else { const ns = findSlot(d.id); if (!ns) return; if (ns.node.id === hit.targetId || containsId(ns.node, hit.targetId)) return; N = ns.node; ns.list.splice(ns.index, 1); }
    const ts = findSlot(hit.targetId); if (!ts) return;
    const T = ts.node, cols = hit.side === 'left' ? makeColumns(N, T) : makeColumns(T, N);
    ts.list.splice(ts.index, 1, cols);
    selectedId = N.id; structural(); renderInspector(); changed(); announce('Placed beside ' + T.type);
  }
  // Side-by-side: add a new column to an existing row beside the hovered column.
  function commitColInsert(d, hit) {
    history.record(d.kind === 'new' ? 'drop-new' : 'drop-move'); history.seal();
    let N;
    if (d.kind === 'new') N = d.make();
    else { const ns = findSlot(d.id); if (!ns) return; N = ns.node; ns.list.splice(ns.index, 1); }
    const cs = findSlot(hit.columnsId); if (!cs || !cs.node.children || cs.node.children.length >= 4) return;
    const ci = cs.node.children.findIndex((c) => c.id === hit.colId);
    const at = ci < 0 ? cs.node.children.length : (hit.side === 'left' ? ci : ci + 1);
    cs.node.children.splice(at, 0, { id: uid(), type: 'column', style: {}, children: [N] });
    cs.node.cols = cs.node.children.length;
    selectedId = N.id; structural(); renderInspector(); changed(); announce('Added column');
  }
  function endDrag(e) {
    if (!drag || (e && e.pointerId !== drag.pointerId)) return;
    const d = drag; drag = null; clearDragVisuals(d);
    if (!d.fromFrame) { try { handleEl.releasePointerCapture && handleEl.releasePointerCapture(d.pointerId); } catch (er) {} }
    if (d.moved && d.kind === 'new') dragJustDropped = true; // suppress the palette button's click-to-add after a drag
    if (d.moved && d.lastHit) {
      const hit = d.lastHit;
      if (hit.mode === 'wrap') commitWrap(d, hit);
      else if (hit.mode === 'colinsert') commitColInsert(d, hit);
      else if (d.kind === 'new') { const node = d.make(); history.record('drop-new'); history.seal(); if (insertNode(node, hit.zoneId, hit.index)) { selectedId = node.id; structural(); renderInspector(); changed(); announce('Added ' + node.type); } }
      else { history.record('drop-move'); history.seal(); const t = byId(d.id) ? byId(d.id).type : 'block'; if (moveNode(d.id, hit.zoneId, hit.index)) { structural(); renderInspector(); changed(); announce('Moved ' + t); } }
    }
    placeHandle();
  }
  // app-realm pointer stream (handle + palette captured → events bubble to window)
  function winMove(e) { if (drag && !drag.fromFrame) onMove(e); }
  function winUp(e) { if (drag && !drag.fromFrame) endDrag(e); }
  window.addEventListener('pointermove', winMove, true);
  window.addEventListener('pointerup', winUp, true);
  window.addEventListener('pointercancel', winUp, true);
  window.addEventListener('blur', abortDrag);
  // touch long-press inside the iframe: implicit capture keeps move/up firing in cdoc
  function attachLongPress() {
    if (!cdoc) return;
    cdoc.addEventListener('pointerdown', (e) => {
      if (e.pointerType !== 'touch') return; const n = e.target.closest && e.target.closest('[data-bv-id]'); if (!n) return; const id = n.getAttribute('data-bv-id');
      lpTimer = setTimeout(() => { lpTimer = 0; try { navigator.vibrate && navigator.vibrate(10); } catch (er) {} selectedId = id; beginReorderDrag(e, id, true); drag.last = e; startVisuals(); }, 450);
    }, { passive: true });
    const cancelLp = () => { if (lpTimer) { clearTimeout(lpTimer); lpTimer = 0; } };
    cdoc.addEventListener('pointermove', (e) => { cancelLp(); if (drag && drag.fromFrame) onMove(e); }, { passive: true });
    cdoc.addEventListener('pointerup', (e) => { cancelLp(); if (drag && drag.fromFrame) endDrag(e); });
    cdoc.addEventListener('pointercancel', (e) => { cancelLp(); if (drag && drag.fromFrame) endDrag(e); });
  }

  // ---------- ops ----------
  function changed() { dirty = true; setStatus('Unsaved…'); if (isPublishing) { editedDuringPublish = true; return; } clearTimeout(saveTimer); saveTimer = setTimeout(saveModel, 1500); }
  function addEl(el) {
    flushActiveEdit(); history.record('add');
    const s = selectedId ? slotOf(selectedId) : null;
    if (s && ZONE_PARENTS.has(s.node.type)) { if (canDropInto(el.type, s.node.id)) s.node.children.push(el); else model.page.elements.push(el); }
    else if (s) { if (canDropInto(el.type, s.parent ? s.parent.id : '__root__')) s.list.splice(s.index + 1, 0, el); else model.page.elements.push(el); }
    else model.page.elements.push(el);
    selectedId = el.id; reindex(); structural(); renderInspector(); changed();
  }
  function move(id, d) { flushActiveEdit(); const s = slotOf(id); if (!s) return; const j = s.index + d; if (j < 0 || j >= s.list.length) return; history.record('move'); const a = s.list;[a[s.index], a[j]] = [a[j], a[s.index]]; reindex(); structural(); changed(); announce('Moved ' + (byId(id) ? byId(id).type : 'block') + (d < 0 ? ' up' : ' down')); }
  function moveOut(id) { flushActiveEdit(); const s = slotOf(id); if (!s || !s.parent) return; const ps = slotOf(s.parent.id); if (!ps) return; history.record('out'); s.list.splice(s.index, 1); ps.list.splice(ps.index + 1, 0, s.node); reindex(); structural(); renderInspector(); changed(); announce('Moved out to ' + (ps.parent ? ps.parent.type : 'page')); }
  function moveInto(id, zoneId) { flushActiveEdit(); const s = slotOf(id); if (!s) return; if (!canDropInto(s.node.type, zoneId) || containsId(s.node, zoneId) || id === zoneId) { announce("Can't move there"); return; } history.record('into'); const dest = zoneList(zoneId); if (!dest) return; s.list.splice(s.index, 1); dest.push(s.node); reindex(); structural(); renderInspector(); changed(); announce('Moved into ' + zoneKind(zoneId)); }
  function dup(id) { flushActiveEdit(); const s = slotOf(id); if (!s) return; history.record('dup'); const c = regenIds(clone(s.node)); s.list.splice(s.index + 1, 0, c); selectedId = c.id; reindex(); structural(); renderInspector(); changed(); announce('Duplicated ' + c.type); }
  function del(id) { flushActiveEdit(); const s = slotOf(id); if (!s) return; const t = s.node.type; history.record('del'); s.list.splice(s.index, 1); selectedId = null; reindex(); structural(); renderInspector(); changed(); announce(t + ' deleted'); }
  function select(id) { selectedId = id; highlight(); renderInspector(); if (id && isMobile()) inspector.classList.add('bvb-open'); if (id && byId(id)) announce('Selected ' + byId(id).type); }
  function afterHistory() { reindex(); selectedId = byId(selectedId) ? selectedId : null; remount(); renderInspector(); setStatus('Unsaved…'); dirty = true; clearTimeout(saveTimer); saveTimer = setTimeout(saveModel, 3000); updateUndo(); }
  function doUndo() { flushActiveEdit(); if (history.undo()) afterHistory(); }
  function doRedo() { flushActiveEdit(); if (history.redo()) afterHistory(); }
  function updateUndo() { undoBtn.disabled = !history.canUndo(); redoBtn.disabled = !history.canRedo(); }
  updateUndo();
  document.addEventListener('keydown', kbd);
  function kbd(e) { if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 'z') return; if (!root.isConnected) { teardown(); return; } const t = e.target; if (t && /^(input|textarea|select)$/i.test(t.tagName)) return; e.preventDefault(); if (e.shiftKey) doRedo(); else doUndo(); }
  // ---------- teardown ----------
  function onHide() { flushActiveEdit(); if (dirty && !saving) saveModel(); }
  function onVis() { if (document.visibilityState === 'hidden') onHide(); }
  let torn = false;
  function teardown() { if (torn) return; torn = true; try { mo.disconnect(); } catch (e) {} document.removeEventListener('keydown', kbd); window.removeEventListener('pagehide', onHide); window.removeEventListener('visibilitychange', onVis); window.removeEventListener('pointermove', winMove, true); window.removeEventListener('pointerup', winUp, true); window.removeEventListener('pointercancel', winUp, true); window.removeEventListener('blur', abortDrag); abortDrag(); onHide(); }
  const mo = new MutationObserver(() => { if (!root.isConnected) teardown(); });
  try { mo.observe(container, { childList: true }); } catch (e) {}
  window.addEventListener('pagehide', onHide);
  window.addEventListener('visibilitychange', onVis);

  // ---------- templates ----------
  function openTemplates() {
    const prevFocus = document.activeElement;
    const overlay = h('div', { class: 'bvb-modal', onclick: (e) => { if (e.target === overlay) close(); } });
    const box = h('div', { class: 'bvb-modal-box', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Start from a template', tabindex: '-1' });
    const closeBtn = h('button', { type: 'button', class: 'bvb-act', onclick: () => close() }, 'Close');
    box.appendChild(h('div', { style: 'display:flex;justify-content:space-between;align-items:center;margin-bottom:.6rem' }, h('strong', null, 'Start from a template'), closeBtn));
    box.appendChild(h('p', { style: 'color:#666;font-size:.85rem;margin:.2rem 0 .8rem' }, 'Applying a template replaces your current page. Your uploaded images are kept.'));
    const grid = h('div', { class: 'bvb-tpl-grid' });
    for (const t of TEMPLATES) { const p = presetById(t.preset); const card = h('button', { type: 'button', class: 'bvb-tpl', onclick: () => { applyTemplate(t); close(); } }); card.appendChild(h('div', { style: 'font-weight:700;margin-bottom:.3rem' }, t.name)); const sw = h('div', { style: 'display:flex;gap:.2rem' }); for (const k of ['pageBg', 'accent', 'text']) sw.appendChild(h('span', { class: 'bvb-sw', style: 'background:' + p.colors[k] })); card.appendChild(sw); grid.appendChild(card); }
    box.appendChild(grid); overlay.appendChild(box); container.appendChild(overlay);
    try { root.setAttribute('aria-hidden', 'true'); root.inert = true; } catch (e) {}
    overlay.addEventListener('keydown', onKey); closeBtn.focus();
    function onKey(e) {
      if (e.key === 'Escape') { e.preventDefault(); close(); return; }
      if (e.key !== 'Tab') return;
      const f = Array.prototype.slice.call(box.querySelectorAll('button,[href],input,select,textarea,[tabindex]:not([tabindex="-1"])')).filter((x) => x.offsetParent !== null || x === document.activeElement);
      if (!f.length) return; const first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
    function close() { overlay.removeEventListener('keydown', onKey); overlay.remove(); try { root.removeAttribute('aria-hidden'); root.inert = false; } catch (e) {} if (prevFocus && prevFocus.focus) { try { prevFocus.focus(); } catch (e) {} } }
  }
  function applyTemplate(t) { history.record('template'); history.seal(); const p = presetById(t.preset); const title = model.page.title; model = normalize({ theme: defThemeFrom(p.id, t.align), page: { title, elements: t.els() } }); selectedId = null; reindex(); remount(); renderInspector(); changed(); updateUndo(); }

  // ---------- inspector ----------
  const field = (label, control) => { const w = h('label', { class: 'bvb-field' }, label); w.appendChild(control); return w; };
  function selCtl(value, opts, onchange) { const s = h('select', { onchange: (e) => onchange(e.target.value) }); for (const [v, lbl] of opts) s.appendChild(h('option', { value: v }, lbl)); s.value = value; return s; }
  function colorRow(label, role, againstRole) {
    const row = h('div', { style: 'display:flex;align-items:center;gap:.4rem;margin-bottom:.45rem' });
    const inp = h('input', { type: 'color', value: cssColorOr(model.theme.colors[role], '#000000'), style: 'width:2.2rem;height:2.2rem;padding:0;border:1px solid #ccc;border-radius:.3rem', oninput: (e) => { history.record('color:' + role); model.theme.colors[role] = e.target.value; applyTheme(); changed(); updateBadge(); } });
    const lbl = h('span', { style: 'flex:1;font-size:.8rem' }, label);
    const badge = h('span', { class: 'bvb-badge' });
    const fixBtn = h('button', { type: 'button', class: 'bvb-act', style: 'padding:.1rem .5rem;font-size:.72rem;display:none', onclick: () => { const fg = role; const bg = againstRole; history.record('fix:' + fg); model.theme.colors[fg] = fixContrast(model.theme.colors[fg], model.theme.colors[bg], false); inp.value = model.theme.colors[fg]; applyTheme(); changed(); updateBadge(); } }, 'Fix');
    function updateBadge() { if (!againstRole) { badge.style.display = 'none'; fixBtn.style.display = 'none'; return; } const ratio = contrastRatio(model.theme.colors[role], model.theme.colors[againstRole]); const ok = AA(ratio, false), okL = AA(ratio, true); badge.textContent = ok ? 'AA' : okL ? 'AA large' : 'low'; badge.style.background = ok ? '#dcfce7' : okL ? '#fef9c3' : '#fee2e2'; badge.style.color = ok ? '#166534' : okL ? '#854d0e' : '#991b1b'; badge.style.display = ''; fixBtn.style.display = ok ? 'none' : ''; }
    updateBadge(); row.appendChild(inp); row.appendChild(lbl); row.appendChild(badge); row.appendChild(fixBtn); return row;
  }
  function breadcrumb(id) {
    const chain = []; let s = slotOf(id); while (s) { chain.unshift(s.node); s = s.parent ? slotOf(s.parent.id) : null; }
    const wrap = h('div', { class: 'bvb-crumb' }); wrap.appendChild(h('span', null, 'Page'));
    chain.forEach((n) => { wrap.appendChild(h('span', null, ' › ')); wrap.appendChild(h('button', { type: 'button', onclick: () => select(n.id) }, n.type)); });
    return wrap;
  }
  function renderInspector() {
    inspector.replaceChildren(); inspector.appendChild(drawerCloser(inspector));
    const el = (selectedId && byId(selectedId)) ? byId(selectedId) : null;
    if (el) {
      inspector.appendChild(breadcrumb(el.id));
      inspector.appendChild(h('div', { class: 'bvb-panelh' }, 'Selected: ' + el.type));
      const tabs = h('div', { class: 'bvb-tabs', role: 'tablist', 'aria-label': 'Element settings' }); const panel = h('div', { id: 'bvpanel', role: 'tabpanel', 'aria-labelledby': 'bvtab-' + inspectorTab });
      for (const [k, lbl] of [['content', 'Content'], ['style', 'Style'], ['layout', 'Layout']]) { const tb = h('button', { type: 'button', class: 'bvb-tab', role: 'tab', id: 'bvtab-' + k, 'aria-controls': 'bvpanel', 'aria-selected': inspectorTab === k ? 'true' : 'false', onclick: () => { inspectorTab = k; renderInspector(); } }, lbl); tabs.appendChild(tb); }
      inspector.appendChild(tabs); inspector.appendChild(panel);
      if (inspectorTab === 'content') renderContentTab(panel, el);
      else if (inspectorTab === 'style') renderStyleTab(panel, el);
      else renderLayoutTab(panel, el);
      inspector.appendChild(h('hr', { style: 'border:0;border-top:1px solid #eee;margin:.7rem 0' }));
    } else {
      const ob = h('div', { class: 'bvb-onboard' });
      ob.appendChild(h('div', { style: 'font-weight:700' }, 'Build your page'));
      ob.appendChild(h('p', null, 'Add a block, then click it on the page to edit. Drag the ✥ handle (or long-press on touch) to move things around.'));
      ob.appendChild(h('button', { type: 'button', class: 'bvb-act', onclick: () => { if (isMobile()) palette.classList.add('bvb-open'); else { try { (palette.querySelector('.bvb-palbtn') || palette).focus(); } catch (e) {} } } }, '+ Add a block'));
      ob.appendChild(h('button', { type: 'button', class: 'bvb-act', onclick: () => openTemplates() }, '✨ Start from a template'));
      inspector.appendChild(ob);
    }
    // ---- Design (theme) ----
    inspector.appendChild(h('div', { class: 'bvb-panelh' }, 'Design'));
    const pg = h('div', { class: 'bvb-presets', style: 'margin-bottom:.7rem' });
    for (const p of PRESETS) { const b = h('button', { type: 'button', class: 'bvb-preset', 'aria-label': 'Theme: ' + p.name, onclick: () => applyPreset(p.id) }); const dots = h('span', { style: 'display:flex;gap:.15rem' }); for (const k of ['pageBg', 'accent', 'heading']) dots.appendChild(h('span', { class: 'bvb-sw', style: 'background:' + p.colors[k] })); b.appendChild(dots); b.appendChild(h('span', { style: 'font-size:.78rem' }, p.name)); pg.appendChild(b); }
    inspector.appendChild(field('Theme presets', pg));
    const more = h('details'); more.appendChild(h('summary', { style: 'cursor:pointer;font-size:.82rem;margin-bottom:.4rem' }, 'Colors & type'));
    more.appendChild(colorRow('Page background', 'pageBg', null));
    more.appendChild(colorRow('Text', 'text', 'pageBg'));
    more.appendChild(colorRow('Headings', 'heading', 'pageBg'));
    more.appendChild(colorRow('Accent (buttons)', 'accent', null));
    more.appendChild(colorRow('Links', 'link', 'pageBg'));
    more.appendChild(colorRow('Surface (cards)', 'surface', null));
    more.appendChild(colorRow('Borders', 'border', 'pageBg'));
    more.appendChild(field('Typography', selCtl(model.theme.pairing, Object.entries(PAIRINGS).map(([k, v]) => [k, v.name]), (v) => { history.record('pairing'); model.theme.pairing = v; applyTheme(); changed(); })));
    more.appendChild(field('Text size', selCtl(model.theme.scale, [['sm', 'Small'], ['md', 'Medium'], ['lg', 'Large']], (v) => { history.record('scale'); model.theme.scale = v; applyTheme(); changed(); })));
    more.appendChild(field('Line spacing', selCtl(model.theme.lineHeight, [['tight', 'Tight'], ['normal', 'Normal'], ['relaxed', 'Relaxed']], (v) => { history.record('lh'); model.theme.lineHeight = v; applyTheme(); changed(); })));
    more.appendChild(field('Content width', selCtl(model.theme.measure, [['narrow', 'Narrow'], ['normal', 'Normal'], ['wide', 'Wide']], (v) => { history.record('measure'); model.theme.measure = v; applyTheme(); changed(); })));
    more.appendChild(field('Corner roundness', selCtl(model.theme.radius, [['none', 'Square'], ['sm', 'Slight'], ['md', 'Rounded'], ['lg', 'Large'], ['pill', 'Pill']], (v) => { history.record('radius'); model.theme.radius = v; applyTheme(); changed(); })));
    more.appendChild(field('Spacing', selCtl(model.theme.density, [['compact', 'Compact'], ['comfortable', 'Comfortable'], ['roomy', 'Roomy']], (v) => { history.record('density'); model.theme.density = v; applyTheme(); changed(); })));
    more.appendChild(field('Button style', selCtl(model.theme.button.style, [['solid', 'Solid'], ['outline', 'Outline'], ['soft', 'Soft']], (v) => { history.record('btnstyle'); model.theme.button.style = v; applyTheme(); changed(); })));
    more.appendChild(field('Page alignment', selCtl(model.theme.align, [['left', 'Left'], ['center', 'Center']], (v) => { history.record('align'); model.theme.align = v; applyTheme(); changed(); })));
    more.appendChild(field('Dark mode', selCtl(model.theme.darkMode, [['auto', 'Auto (visitor setting)'], ['off', 'Off'], ['force', 'Always dark']], (v) => { history.record('dark'); model.theme.darkMode = v; applyTheme(); changed(); })));
    more.appendChild(field('Page title (browser tab)', h('input', { type: 'text', value: model.page.title || '', oninput: (e) => { history.record('title'); model.page.title = e.target.value; changed(); } })));
    inspector.appendChild(more);
    // ---- SEO & directory (powers #/explore search + page <meta>) ----
    const seo = h('details'); seo.appendChild(h('summary', { style: 'cursor:pointer;font-size:.82rem;margin:.7rem 0 .4rem' }, 'SEO & directory'));
    const descTa = h('textarea', { rows: '3', maxlength: '300', placeholder: 'A short description for search results & the Explore directory.', style: 'width:100%;box-sizing:border-box;font:inherit;resize:vertical' });
    descTa.value = model.page.description || '';
    descTa.addEventListener('input', () => { history.record('desc'); model.page.description = descTa.value.slice(0, 300); changed(); });
    seo.appendChild(field('Site description', descTa));
    seo.appendChild(field('Tags (comma-separated)', h('input', { type: 'text', value: (model.page.tags || []).join(', '), placeholder: 'art, blog, music', oninput: (e) => { history.record('tags'); model.page.tags = e.target.value.split(',').map((t) => t.trim().toLowerCase()).filter(Boolean).slice(0, 10); changed(); } })));
    const listChk = h('input', { type: 'checkbox' }); listChk.checked = model.page.listed !== false;
    listChk.addEventListener('change', () => { history.record('listed'); model.page.listed = listChk.checked; changed(); api('POST', '/api/sites/settings', { listed: listChk.checked }).catch(() => {}); });
    const listLbl = h('label', { style: 'display:flex;align-items:center;gap:.5rem;cursor:pointer;font-size:.85rem;margin:.2rem 0' }); listLbl.appendChild(listChk); listLbl.appendChild(h('span', null, 'List my site in the Explore directory'));
    seo.appendChild(listLbl);
    seo.appendChild(h('p', { style: 'font-size:.74rem;color:#64748b;margin:.3rem 0 0' }, 'Description & tags are added to your page and power search in Explore. Unchecking hides your site from the directory — it stays reachable at your address.'));
    inspector.appendChild(seo);
  }
  function renderContentTab(panel, el) {
    if (el.type === 'heading') panel.appendChild(field('Level', selCtl(String(el.level), [['1', 'H1 (largest)'], ['2', 'H2'], ['3', 'H3']], (v) => { history.record('hl'); el.level = +v; patchEl(el.id); changed(); })));
    if (el.type === 'button') {
      panel.appendChild(field('Link URL', h('input', { type: 'text', value: el.href || '', placeholder: 'https://…', oninput: (e) => { history.record('href:' + el.id); el.href = e.target.value; changed(); }, onchange: () => patchEl(el.id) })));
      if (!String(el.href || '').replace('#', '').trim()) panel.appendChild(h('p', { style: 'color:#9a5b00;font-size:.78rem;margin:-.4rem 0 .6rem' }, 'This button has no link yet.'));
      panel.appendChild(field('Button look', selCtl(el.variant || 'solid', [['solid', 'Solid'], ['outline', 'Outline'], ['soft', 'Soft']], (v) => { history.record('bvar'); el.variant = v; patchEl(el.id); changed(); })));
    }
    if (el.type === 'image') {
      panel.appendChild(field('Alt text (describe the image)', h('input', { type: 'text', value: el.alt || '', oninput: (e) => { history.record('alt:' + el.id); el.alt = e.target.value; changed(); } })));
      const file = h('input', { type: 'file', accept: 'image/*' }); const upMsg = h('div', { style: 'font-size:.78rem;color:#666;margin-top:.3rem' });
      file.addEventListener('change', async () => { const f = file.files && file.files[0]; if (!f) return; upMsg.style.color = '#666'; upMsg.textContent = 'Uploading…'; try { const { name, b64 } = await prepImage(f); const r = await api('PUT', '/api/sites/file', { path: name, data_b64: b64 }); if (r.ok) { cacheAsset(name, b64); history.record('img'); el.asset = name; patchEl(el.id); changed(); upMsg.style.color = '#070'; upMsg.textContent = 'Added.'; } else { upMsg.style.color = '#b00'; upMsg.textContent = 'Upload failed: ' + (r.data && r.data.error || r.status); } } catch (e) { upMsg.style.color = '#b00'; upMsg.textContent = 'Could not process image.'; } });
      const fl = field('Upload / replace image', file); fl.appendChild(upMsg); panel.appendChild(fl);
    }
    if (el.type === 'list') { panel.appendChild(field('Style', selCtl(el.ordered ? 'ol' : 'ul', [['ul', 'Bulleted'], ['ol', 'Numbered']], (v) => { history.record('lk'); el.ordered = v === 'ol'; patchEl(el.id); changed(); }))); panel.appendChild(field('Items (one per line)', h('textarea', { rows: '5', style: 'resize:vertical', oninput: (e) => { history.record('items:' + el.id); el.items = e.target.value.split('\n'); changed(); }, onchange: () => patchEl(el.id) }, (el.items || []).join('\n')))); }
    if (el.type === 'spacer') panel.appendChild(field('Height', selCtl(el.size || 'md', [['sm', 'Small'], ['md', 'Medium'], ['lg', 'Large']], (v) => { history.record('sp'); el.size = v; patchEl(el.id); changed(); })));
    if (el.type === 'divider') panel.appendChild(h('p', { style: 'color:#888;font-size:.85rem' }, 'A horizontal divider line.'));
    if (el.type === 'nav') renderNavEditor(panel, el);
    if (el.type === 'section') {
      const bgRow = h('div', { style: 'display:flex;align-items:center;gap:.4rem;margin-bottom:.5rem' });
      const bgInp = h('input', { type: 'color', value: cssColorOr(el.bg, '#ffffff'), style: 'width:2.2rem;height:2.2rem;padding:0;border:1px solid #ccc;border-radius:.3rem', oninput: (e) => { history.record('secbg:' + el.id); el.bg = e.target.value; patchEl(el.id); changed(); } });
      bgRow.appendChild(bgInp); bgRow.appendChild(h('span', { style: 'flex:1;font-size:.8rem' }, 'Background colour'));
      bgRow.appendChild(h('button', { type: 'button', class: 'bvb-act', style: 'font-size:.72rem', onclick: () => { history.record('secbg:' + el.id); el.bg = ''; patchEl(el.id); renderInspector(); changed(); } }, 'Clear'));
      panel.appendChild(bgRow);
      renderSectionBg(panel, el);
      panel.appendChild(field('Vertical padding', selCtl(el.pad || 'md', [['none', 'None'], ['sm', 'Small'], ['md', 'Medium'], ['lg', 'Large']], (v) => { history.record('secpad:' + el.id); el.pad = v; patchEl(el.id); changed(); })));
      panel.appendChild(field('Content alignment', selCtl(el.align || 'left', [['left', 'Left'], ['center', 'Center']], (v) => { history.record('secal:' + el.id); el.align = v; patchEl(el.id); changed(); })));
      panel.appendChild(h('p', { style: 'color:#888;font-size:.78rem' }, 'Add or drag blocks into this section.'));
    }
    if (el.type === 'columns') {
      panel.appendChild(field('Columns', selCtl(String(Math.max(2, Math.min(4, (el.children || []).length || 2))), [['2', '2 columns'], ['3', '3 columns'], ['4', '4 columns']], (v) => { history.record('cols:' + el.id); setColumnCount(el, +v); patchEl(el.id); renderInspector(); changed(); })));
      panel.appendChild(field('Gap', selCtl(el.gap || 'md', [['sm', 'Small'], ['md', 'Medium'], ['lg', 'Large']], (v) => { history.record('colgap:' + el.id); el.gap = v; patchEl(el.id); changed(); })));
      panel.appendChild(field('On phones', selCtl(el.stack === false ? 'no' : 'yes', [['yes', 'Stack vertically'], ['no', 'Keep side by side']], (v) => { history.record('colstack:' + el.id); el.stack = v === 'yes'; patchEl(el.id); changed(); })));
    }
    if (el.type === 'column') panel.appendChild(h('p', { style: 'color:#888;font-size:.85rem' }, 'A column. Add or drag blocks into it.'));
    if (el.type === 'gallery') renderGalleryEditor(panel, el);
    if (el.type === 'form') renderFormEditor(panel, el);
    if (el.type === 'tabs') renderPanelsEditor(panel, el, { itemNoun: 'Tab', childType: 'tabpanel', labelField: true });
    if (el.type === 'accordion') renderPanelsEditor(panel, el, { itemNoun: 'Section', childType: 'accitem', labelField: true });
    if (el.type === 'carousel') renderPanelsEditor(panel, el, { itemNoun: 'Slide', childType: 'slide', labelField: false });
    if (PANEL_TYPES.has(el.type)) { const nm = { tabpanel: 'tab', accitem: 'section', slide: 'slide' }[el.type]; panel.appendChild(h('p', { style: 'color:#888;font-size:.85rem' }, 'Add or drag blocks into this ' + nm + '. Reorder or rename ' + nm + 's from the parent block above.')); }
  }
  function renderNavEditor(panel, el) {
    panel.appendChild(field('Brand / site name', h('input', { type: 'text', value: el.brand || '', placeholder: handle, oninput: (e) => { history.record('navbrand:' + el.id); el.brand = e.target.value; changed(); }, onchange: () => patchEl(el.id) })));
    panel.appendChild(h('div', { style: 'font-size:.78rem;color:#64748b;margin:.4rem 0 .2rem' }, 'Menu items'));
    const reNav = () => { patchEl(el.id); renderInspector(); changed(); };
    const sbtn = (label, title, fn) => h('button', { type: 'button', class: 'bvb-act', style: 'padding:.2rem .45rem;min-height:34px', title: title || label, onclick: fn }, label);
    el.items.forEach((it, i) => {
      const box = h('div', { style: 'border:1px solid #e5e7eb;border-radius:.4rem;padding:.4rem;margin-bottom:.4rem' });
      const row = h('div', { style: 'display:flex;gap:.3rem;align-items:center;margin-bottom:.3rem' });
      row.appendChild(h('input', { type: 'text', value: it.label || '', placeholder: 'Label', style: 'flex:1;min-width:4rem;min-height:34px;padding:.3rem;border:1px solid #ccc;border-radius:.3rem', oninput: (e) => { history.record('navlbl:' + it.id); it.label = e.target.value; changed(); }, onchange: () => patchEl(el.id) }));
      row.appendChild(sbtn('↑', 'Move up', () => { if (i > 0) { history.record('navmv'); const a = el.items;[a[i - 1], a[i]] = [a[i], a[i - 1]]; reNav(); } }));
      row.appendChild(sbtn('↓', 'Move down', () => { if (i < el.items.length - 1) { history.record('navmv'); const a = el.items;[a[i + 1], a[i]] = [a[i], a[i + 1]]; reNav(); } }));
      row.appendChild(sbtn('✕', 'Remove item', () => { history.record('navrm'); el.items.splice(i, 1); reNav(); }));
      box.appendChild(row);
      if (it.children && it.children.length) box.appendChild(h('p', { style: 'color:#94a3b8;font-size:.74rem;margin:.1rem 0 .3rem' }, 'This item opens a dropdown — set links on the items below.'));
      else box.appendChild(field('Link (use #id to jump, or full URL)', h('input', { type: 'text', value: it.href || '', placeholder: '#section or https://…', oninput: (e) => { history.record('navhref:' + it.id); it.href = e.target.value; changed(); }, onchange: () => patchEl(el.id) })));
      if (it.children && it.children.length) {
        box.appendChild(h('div', { style: 'font-size:.72rem;color:#94a3b8;margin:.1rem 0' }, 'Dropdown items'));
        it.children.forEach((s, j) => {
          const sr = h('div', { style: 'display:flex;gap:.3rem;align-items:center;margin-bottom:.25rem;padding-left:.5rem' });
          sr.appendChild(h('input', { type: 'text', value: s.label || '', placeholder: 'Label', style: 'flex:1;min-width:3rem;min-height:34px;padding:.3rem;border:1px solid #ccc;border-radius:.3rem', oninput: (e) => { history.record('navslbl:' + s.id); s.label = e.target.value; changed(); }, onchange: () => patchEl(el.id) }));
          sr.appendChild(h('input', { type: 'text', value: s.href || '', placeholder: '#…', style: 'flex:1;min-width:3rem;min-height:34px;padding:.3rem;border:1px solid #ccc;border-radius:.3rem', oninput: (e) => { history.record('navshref:' + s.id); s.href = e.target.value; changed(); }, onchange: () => patchEl(el.id) }));
          sr.appendChild(sbtn('✕', 'Remove dropdown item', () => { history.record('navsrm'); it.children.splice(j, 1); reNav(); }));
          box.appendChild(sr);
        });
      }
      box.appendChild(sbtn('+ Dropdown item', 'Add a dropdown item under this menu', () => { history.record('navsadd'); it.children = it.children || []; it.children.push({ id: uid(), label: 'New item', href: '#' }); reNav(); }));
      panel.appendChild(box);
    });
    panel.appendChild(h('button', { type: 'button', class: 'bvb-act', style: 'min-height:38px', onclick: () => { history.record('navadd'); el.items.push({ id: uid(), label: 'New link', href: '#', children: [] }); reNav(); } }, '+ Add menu item'));
  }
  async function loadContact() { if (contactLoaded) return; contactLoaded = true; try { const r = await api('GET', '/api/sites/settings'); if (r && r.ok && r.data) { contactEmail = r.data.contact_email || ''; const sel = selectedId && byId(selectedId); if (sel && sel.type === 'form') renderInspector(); } } catch (e) {} }
  function renderSectionBg(panel, el) {
    const file = h('input', { type: 'file', accept: 'image/*' }); const msg = h('div', { style: 'font-size:.76rem;color:#666;margin-top:.2rem' });
    file.addEventListener('change', async () => { const f = file.files && file.files[0]; if (!f) return; msg.style.color = '#666'; msg.textContent = 'Uploading…'; try { const { name, b64 } = await prepImage(f); const r = await api('PUT', '/api/sites/file', { path: name, data_b64: b64 }); if (r.ok) { cacheAsset(name, b64); history.record('secbgimg:' + el.id); el.bgImage = name; if (!el.overlay) el.overlay = 0.35; patchEl(el.id); renderInspector(); changed(); } else { msg.style.color = '#b00'; msg.textContent = 'Upload failed.'; } } catch (e) { msg.style.color = '#b00'; msg.textContent = 'Could not process image.'; } });
    const fl = field(el.bgImage ? 'Replace background image' : 'Background image', file); fl.appendChild(msg); panel.appendChild(fl);
    if (el.bgImage) {
      panel.appendChild(h('button', { type: 'button', class: 'bvb-act', style: 'font-size:.72rem;margin-bottom:.5rem', onclick: () => { history.record('secbgimg:' + el.id); el.bgImage = ''; patchEl(el.id); renderInspector(); changed(); } }, 'Remove background image'));
      const ow = h('label', { style: 'display:block;font-size:.8rem;margin:.1rem 0 .4rem' }, 'Darken image for readable text');
      const oi = h('input', { type: 'range', min: '0', max: '0.8', step: '0.05', value: String(typeof el.overlay === 'number' ? el.overlay : 0.35), style: 'width:100%' }); oi.addEventListener('input', () => { history.record('secov:' + el.id); el.overlay = parseFloat(oi.value); patchEl(el.id); changed(); }); ow.appendChild(oi); panel.appendChild(ow);
      const lt = h('label', { style: 'display:flex;align-items:center;gap:.4rem;font-size:.82rem;margin:.1rem 0 .4rem;cursor:pointer' }); const lc = h('input', { type: 'checkbox' }); lc.checked = !!el.lightText; lc.addEventListener('change', () => { history.record('seclt:' + el.id); el.lightText = lc.checked; patchEl(el.id); changed(); }); lt.appendChild(lc); lt.appendChild(h('span', null, 'Light text (for dark images)')); panel.appendChild(lt);
    }
  }
  function renderGalleryEditor(panel, el) {
    panel.appendChild(field('Columns', selCtl(String(oneOf(el.cols, [2, 3, 4], 3)), [['2', '2'], ['3', '3'], ['4', '4']], (v) => { history.record('gcols:' + el.id); el.cols = +v; patchEl(el.id); changed(); })));
    const reG = () => { patchEl(el.id); renderInspector(); changed(); };
    const sbtn = (l, t, fn) => h('button', { type: 'button', class: 'bvb-act', style: 'padding:.2rem .45rem;min-height:34px', title: t || l, onclick: fn }, l);
    el.items = el.items || [];
    el.items.forEach((g, i) => {
      const row = h('div', { style: 'display:flex;gap:.4rem;align-items:center;margin-bottom:.4rem;border:1px solid #e5e7eb;border-radius:.4rem;padding:.35rem' });
      if (g.asset) row.appendChild(h('img', { src: '/' + g.asset, alt: '', style: 'width:2.6rem;height:2.6rem;object-fit:cover;border-radius:.3rem;flex:none' }));
      row.appendChild(h('input', { type: 'text', value: g.alt || '', placeholder: 'Alt text (describe image)', style: 'flex:1;min-width:0;min-height:32px;padding:.3rem;border:1px solid #ccc;border-radius:.3rem', oninput: (e) => { history.record('galt:' + el.id + i); g.alt = e.target.value; changed(); } }));
      const col = h('div', { style: 'display:flex;flex-direction:column;gap:.15rem' });
      col.appendChild(sbtn('↑', 'Move up', () => { if (i > 0) { history.record('gmv'); const a = el.items;[a[i - 1], a[i]] = [a[i], a[i - 1]]; reG(); } }));
      col.appendChild(sbtn('↓', 'Move down', () => { if (i < el.items.length - 1) { history.record('gmv'); const a = el.items;[a[i + 1], a[i]] = [a[i], a[i + 1]]; reG(); } }));
      row.appendChild(col);
      row.appendChild(sbtn('✕', 'Remove', () => { history.record('grm'); el.items.splice(i, 1); reG(); }));
      panel.appendChild(row);
    });
    const file = h('input', { type: 'file', accept: 'image/*', multiple: '' }); const msg = h('div', { style: 'font-size:.78rem;color:#666;margin-top:.3rem' });
    file.addEventListener('change', async () => { const files = Array.prototype.slice.call(file.files || []); if (!files.length) return; msg.style.color = '#666'; msg.textContent = 'Uploading ' + files.length + '…'; let added = 0; for (const f of files) { try { const { name, b64 } = await prepImage(f); const r = await api('PUT', '/api/sites/file', { path: name, data_b64: b64 }); if (r.ok) { cacheAsset(name, b64); el.items.push({ asset: name, alt: '' }); added++; } } catch (e) {} } history.record('gadd'); msg.style.color = added ? '#070' : '#b00'; msg.textContent = added ? ('Added ' + added + '.') : 'Upload failed.'; reG(); });
    const fl = field('Add images', file); fl.appendChild(msg); panel.appendChild(fl);
    panel.appendChild(h('p', { style: 'color:#888;font-size:.78rem' }, 'Visitors click an image to view it large.'));
  }
  function renderFormEditor(panel, el) {
    loadContact();
    const emHint = h('p', { style: 'font-size:.76rem;margin:.1rem 0 .5rem;color:' + (contactEmail ? '#16794a' : '#9a5b00') }, contactEmail ? 'Messages are emailed to ' + contactEmail + ' (private).' : 'Add your email so visitors can reach you — it stays private, never shown on the page.');
    const em = h('input', { type: 'email', value: contactEmail || '', placeholder: 'you@example.com', oninput: (e) => { contactEmail = e.target.value; }, onchange: (e) => { const v = e.target.value.trim(); api('POST', '/api/sites/settings', { contact_email: v }); contactEmail = v; emHint.textContent = v ? 'Saved — messages go to ' + v + '.' : 'Add your email so visitors can reach you.'; emHint.style.color = v ? '#16794a' : '#9a5b00'; } });
    panel.appendChild(field('Where replies go (your email)', em)); panel.appendChild(emHint);
    panel.appendChild(field('Submit button text', h('input', { type: 'text', value: el.submitLabel || 'Send', oninput: (e) => { history.record('fsl:' + el.id); el.submitLabel = e.target.value; changed(); }, onchange: () => patchEl(el.id) })));
    panel.appendChild(field('Success message', h('input', { type: 'text', value: el.success || '', placeholder: 'Thanks! Your message was sent.', oninput: (e) => { history.record('fsm:' + el.id); el.success = e.target.value; changed(); } })));
    panel.appendChild(h('div', { style: 'font-size:.78rem;color:#64748b;margin:.5rem 0 .2rem' }, 'Fields'));
    const reF = () => { patchEl(el.id); renderInspector(); changed(); };
    const sbtn = (l, t, fn) => h('button', { type: 'button', class: 'bvb-act', style: 'padding:.2rem .45rem;min-height:34px', title: t || l, onclick: fn }, l);
    el.fields = el.fields || [];
    el.fields.forEach((f, i) => {
      const box = h('div', { style: 'border:1px solid #e5e7eb;border-radius:.4rem;padding:.4rem;margin-bottom:.4rem' });
      const r1 = h('div', { style: 'display:flex;gap:.3rem;align-items:center;margin-bottom:.3rem' });
      r1.appendChild(h('input', { type: 'text', value: f.label || '', placeholder: 'Label', style: 'flex:1;min-width:4rem;min-height:34px;padding:.3rem;border:1px solid #ccc;border-radius:.3rem', oninput: (e) => { history.record('flbl:' + el.id + i); f.label = e.target.value; changed(); }, onchange: () => patchEl(el.id) }));
      r1.appendChild(sbtn('↑', 'Move up', () => { if (i > 0) { history.record('fmv'); const a = el.fields;[a[i - 1], a[i]] = [a[i], a[i - 1]]; reF(); } }));
      r1.appendChild(sbtn('↓', 'Move down', () => { if (i < el.fields.length - 1) { history.record('fmv'); const a = el.fields;[a[i + 1], a[i]] = [a[i], a[i + 1]]; reF(); } }));
      if (el.fields.length > 1) r1.appendChild(sbtn('✕', 'Remove', () => { history.record('frm'); el.fields.splice(i, 1); reF(); }));
      box.appendChild(r1);
      const r2 = h('div', { style: 'display:flex;gap:.5rem;align-items:center' });
      r2.appendChild(selCtl(f.type || 'text', [['text', 'Short text'], ['email', 'Email'], ['tel', 'Phone'], ['textarea', 'Long text']], (v) => { history.record('ftype:' + el.id + i); f.type = v; patchEl(el.id); changed(); }));
      const rl = h('label', { style: 'display:flex;align-items:center;gap:.3rem;font-size:.8rem;cursor:pointer' }); const rc = h('input', { type: 'checkbox' }); rc.checked = !!f.required; rc.addEventListener('change', () => { history.record('freq:' + el.id + i); f.required = rc.checked; patchEl(el.id); changed(); }); rl.appendChild(rc); rl.appendChild(h('span', null, 'Required')); r2.appendChild(rl);
      box.appendChild(r2); panel.appendChild(box);
    });
    panel.appendChild(h('button', { type: 'button', class: 'bvb-act', style: 'min-height:38px', onclick: () => { history.record('fadd'); el.fields.push({ type: 'text', label: 'New field', name: 'field' + (el.fields.length + 1), required: false }); reF(); } }, '+ Add field'));
  }
  function renderPanelsEditor(panel, el, opts) {
    const reP = () => { patchEl(el.id); renderInspector(); changed(); };
    const sbtn = (l, t, fn) => h('button', { type: 'button', class: 'bvb-act', style: 'padding:.2rem .45rem;min-height:34px', title: t || l, onclick: fn }, l);
    if (el.type === 'accordion') { const sl = h('label', { style: 'display:flex;align-items:center;gap:.4rem;font-size:.85rem;margin:.1rem 0 .5rem;cursor:pointer' }); const sc = h('input', { type: 'checkbox' }); sc.checked = !!el.single; sc.addEventListener('change', () => { history.record('accsingle:' + el.id); el.single = sc.checked; patchEl(el.id); changed(); }); sl.appendChild(sc); sl.appendChild(h('span', null, 'Only one section open at a time')); panel.appendChild(sl); }
    panel.appendChild(h('div', { style: 'font-size:.78rem;color:#64748b;margin:.2rem 0' }, opts.itemNoun + 's'));
    el.children = el.children || [];
    el.children.forEach((p, i) => {
      const row = h('div', { style: 'display:flex;gap:.3rem;align-items:center;margin-bottom:.35rem' });
      if (opts.labelField) row.appendChild(h('input', { type: 'text', value: p.label || '', placeholder: opts.itemNoun + ' label', style: 'flex:1;min-width:0;min-height:34px;padding:.3rem;border:1px solid #ccc;border-radius:.3rem', oninput: (e) => { history.record('plbl:' + p.id); p.label = e.target.value; changed(); }, onchange: () => patchEl(el.id) }));
      else row.appendChild(h('span', { style: 'flex:1;font-size:.82rem;color:#475569' }, opts.itemNoun + ' ' + (i + 1)));
      row.appendChild(h('button', { type: 'button', class: 'bvb-act', style: 'padding:.2rem .5rem;min-height:34px', onclick: () => select(p.id) }, 'Edit'));
      row.appendChild(sbtn('↑', 'Move up', () => { if (i > 0) { history.record('pmv'); const a = el.children;[a[i - 1], a[i]] = [a[i], a[i - 1]]; reP(); } }));
      row.appendChild(sbtn('↓', 'Move down', () => { if (i < el.children.length - 1) { history.record('pmv'); const a = el.children;[a[i + 1], a[i]] = [a[i], a[i + 1]]; reP(); } }));
      if (el.children.length > 1) row.appendChild(sbtn('✕', 'Remove', () => { history.record('prm'); el.children.splice(i, 1); if (selectedId && !NODE.get(selectedId)) selectedId = el.id; reP(); }));
      panel.appendChild(row);
    });
    panel.appendChild(h('button', { type: 'button', class: 'bvb-act', style: 'min-height:38px', onclick: () => { history.record('padd'); const np = { id: uid(), type: opts.childType, style: {}, children: [] }; if (opts.labelField) np.label = opts.itemNoun + ' ' + (el.children.length + 1); el.children.push(np); reP(); } }, '+ Add ' + opts.itemNoun.toLowerCase()));
    panel.appendChild(h('p', { style: 'color:#888;font-size:.78rem;margin-top:.3rem' }, 'Click "Edit" on a ' + opts.itemNoun.toLowerCase() + ', then add or drag blocks into it.'));
  }
  function setColumnCount(el, n) { el.cols = n; el.children = el.children || []; while (el.children.length < n) el.children.push({ id: uid(), type: 'column', style: {}, children: [] }); if (el.children.length > n) { const extra = el.children.splice(n); const last = el.children[n - 1]; extra.forEach((col) => { (col.children || []).forEach((c) => last.children.push(c)); }); } reindex(); if (selectedId && !NODE.get(selectedId)) selectedId = el.id; }
  function styleSel(el, key, label, opts, dflt) { return field(label, selCtl((el.style && el.style[key]) || dflt, opts, (v) => { history.record('ov:' + key); el.style = el.style || {}; if (v === dflt || v === '') delete el.style[key]; else el.style[key] = v; patchEl(el.id); changed(); })); }
  function renderStyleTab(panel, el) {
    if (isContainer(el.type)) { panel.appendChild(h('p', { style: 'color:#888;font-size:.82rem' }, 'Layout container — set its background/spacing in the Content tab; colours & fonts are global (Design, below).')); return; }
    panel.appendChild(styleSel(el, 'bg', 'Background', [['', 'None'], ['surface', 'Surface (card)'], ['accent', 'Accent']], ''));
    if (['image', 'button'].includes(el.type) || (el.style && el.style.bg)) panel.appendChild(styleSel(el, 'radius', 'Corner roundness', [['', 'Theme default'], ['none', 'Square'], ['sm', 'Slight'], ['md', 'Rounded'], ['lg', 'Large'], ['pill', 'Pill']], ''));
    panel.appendChild(h('p', { style: 'color:#888;font-size:.78rem' }, 'Colors & fonts are set globally under Design (top).'));
  }
  function renderLayoutTab(panel, el) {
    if (!isContainer(el.type)) {
      panel.appendChild(styleSel(el, 'align', 'Alignment', [['', 'Theme default'], ['left', 'Left'], ['center', 'Center'], ['right', 'Right']], ''));
      panel.appendChild(styleSel(el, 'maxW', 'Width', [['', 'Theme default'], ['narrow', 'Narrow'], ['normal', 'Normal'], ['wide', 'Wide'], ['full', 'Full width']], ''));
      panel.appendChild(styleSel(el, 'padY', 'Vertical spacing', [['', 'Default'], ['sm', 'Small'], ['md', 'Medium'], ['lg', 'Large']], ''));
    }
    const acts = h('div', { style: 'display:flex;gap:.35rem;flex-wrap:wrap;margin-top:.6rem' });
    const ab = (label, fn) => h('button', { type: 'button', class: 'bvb-act', onclick: fn }, label);
    acts.appendChild(ab('↑ Up', () => move(el.id, -1))); acts.appendChild(ab('↓ Down', () => move(el.id, 1)));
    const s = slotOf(el.id); if (s && s.parent && !PANEL_TYPES.has(el.type)) acts.appendChild(ab('⤴ Out', () => moveOut(el.id)));
    // keyboard "move into" an adjacent container sibling (DnD-free path)
    if (s) for (const d of [-1, 1]) { const sib = s.list[s.index + d]; if (sib && sib.id !== el.id && (sib.type === 'section' || sib.type === 'columns')) { const zone = sib.type === 'columns' ? (sib.children[0] && sib.children[0].id) : sib.id; if (zone && canDropInto(el.type, zone)) acts.appendChild(ab('↳ Into ' + sib.type + (d < 0 ? ' above' : ' below'), () => moveInto(el.id, zone))); } }
    if (el.type !== 'column' && !PANEL_TYPES.has(el.type)) acts.appendChild(ab('Duplicate', () => dup(el.id)));
    if (el.type !== 'column' && !PANEL_TYPES.has(el.type)) acts.appendChild(ab('Delete', () => { if (confirm('Delete this ' + el.type + '?')) del(el.id); }));
    panel.appendChild(acts);
    panel.appendChild(h('p', { style: 'color:#888;font-size:.78rem;margin-top:.4rem' }, 'Tip: drag the ✥ handle (or long-press on touch) to move this block anywhere; or use the buttons above.'));
  }
  function applyPreset(id) { const p = presetById(id); history.record('preset'); history.seal(); model.theme.preset = id; model.theme.colors = { ...p.colors }; model.theme.pairing = p.pairing; applyTheme(); renderInspector(); changed(); updateUndo(); }

  // ---------- image prep ----------
  function prepImage(file) {
    return new Promise((resolve, reject) => {
      const ext = (/\.([a-z0-9]+)$/i.exec(file.name) || [, 'png'])[1].toLowerCase();
      const b64of = async (blob, e) => { const buf = await blob.arrayBuffer(); const b = new Uint8Array(buf); let s = ''; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000)); return { name: 'media/img-' + Math.random().toString(36).slice(2, 8) + '.' + e, b64: btoa(s) }; };
      if (ext === 'svg' || file.size <= 400 * 1024) { resolve(b64of(file, ext === 'svg' ? 'svg' : ext)); return; }
      const url = URL.createObjectURL(file); const img = new Image();
      img.onload = () => { URL.revokeObjectURL(url); let w = img.naturalWidth, hh = img.naturalHeight; const s = Math.min(1, 1600 / Math.max(w, hh)); w = Math.round(w * s); hh = Math.round(hh * s); const c = document.createElement('canvas'); c.width = w; c.height = hh; c.getContext('2d').drawImage(img, 0, 0, w, hh); c.toBlob((blob) => { blob ? resolve(b64of(blob, 'jpg')) : reject(new Error('encode')); }, 'image/jpeg', 0.85); };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('decode')); }; img.src = url;
    });
  }

  // ---------- persistence ----------
  function setStatus(t) { if (saveStatus && saveStatus.isConnected) saveStatus.textContent = t; }
  async function saveModel() { if (saving) return; saving = true; setStatus('Saving…'); let ok = false; try { const r = await api('PUT', '/api/sites/file', { path: 'site.json', text: JSON.stringify(model) }); ok = r.ok; } catch (e) {} saving = false; if (ok) { dirty = false; setStatus('Saved'); } else { setStatus('Save failed — retrying'); if (saveStatus && saveStatus.isConnected) { clearTimeout(saveTimer); saveTimer = setTimeout(saveModel, 5000); } } }
  function collectImages(list, out) { for (const e of (list || [])) { if (e.type === 'image' && e.asset && !String(e.alt || '').trim()) out.push(e); if (e.children) collectImages(e.children, out); } return out; }
  publishBtn.addEventListener('click', async () => {
    flushActiveEdit();
    const noAlt = collectImages(model.page.elements, []);
    if (noAlt.length) { publishMsg.style.color = '#9a5b00'; publishMsg.textContent = 'Add alt text to ' + noAlt.length + ' image(s) first.'; select(noAlt[0].id); return; }
    const c = model.theme.colors, bad = []; if (!AA(contrastRatio(c.text, c.pageBg), false)) bad.push('text'); if (!AA(contrastRatio(bestOn(c.accent), c.accent), false)) bad.push('button');
    if (bad.length && !window.confirm(bad.length + ' color pair(s) are hard to read. Click OK to auto-fix and publish, or Cancel to adjust.')) return;
    if (bad.length) { c.text = fixContrast(c.text, c.pageBg, false); applyTheme(); }
    isPublishing = true; editedDuringPublish = false; clearTimeout(saveTimer); publishBtn.disabled = true; publishMsg.style.color = '#666'; publishMsg.textContent = 'Publishing…';
    let ok = true;
    for (const [path, text] of [['site.json', JSON.stringify(model)], ['index.html', publishHtml()], ['styles.css', cssText(model.theme)]]) { try { const r = await api('PUT', '/api/sites/file', { path, text }); if (!r.ok) { ok = false; publishMsg.style.color = '#b00'; publishMsg.textContent = 'Error saving ' + path; break; } } catch (e) { ok = false; publishMsg.style.color = '#b00'; publishMsg.textContent = 'Network error'; break; } }
    if (ok) { dirty = false; await api('POST', '/api/sites/settings', { listed: model.page.listed !== false }); const r = await api('POST', '/api/sites/publish', {}); if (r.ok) { publishMsg.replaceChildren(); publishMsg.style.color = '#070'; publishMsg.appendChild(document.createTextNode('Published. ')); publishMsg.appendChild(h('a', { href: 'https://' + handle + '.yourdomain.com/', target: '_blank', rel: 'noopener' }, 'View site ↗')); } else { publishMsg.style.color = '#b00'; publishMsg.textContent = 'Publish error: ' + (r.data && r.data.error || r.status); } }
    isPublishing = false; publishBtn.disabled = false;
    if (editedDuringPublish) { dirty = true; editedDuringPublish = false; clearTimeout(saveTimer); saveTimer = setTimeout(saveModel, 600); }
  });

  renderInspector();
}
