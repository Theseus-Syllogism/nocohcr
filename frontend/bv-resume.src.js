// bv-resume — Resume Builder editor chunk (loaded by the #/resume route).
// Exports renderResume(container, ctx) — a structured form + live A4 preview.
// renderResumeHtml(model) is the SINGLE pure renderer used for preview, publish, and
// PDF (so all three are identical). Every field is escaped; the output is a
// self-contained document (inline CSS, system fonts, photo as a data URI).

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const safeUrl = (v) => { const s = String(v || '').trim(); if (!s) return ''; if (/^(https?:|mailto:|tel:)/i.test(s)) return s; if (/^[\w.+-]+@[\w.-]+\.\w+$/.test(s)) return 'mailto:' + s; if (/^[\d+()\s-]{6,}$/.test(s)) return 'tel:' + s.replace(/\s+/g, ''); if (/^[\w-]+(\.[\w-]+)+/.test(s)) return 'https://' + s; return ''; };
const oneOf = (v, set, d) => (set.indexOf(v) >= 0 ? v : d);
const cssColor = (c) => (/^#[0-9a-fA-F]{6}$/.test(String(c || '')) ? String(c).toLowerCase() : null);

const TEMPLATES = [['classic', 'Classic'], ['sidebar', 'Sidebar'], ['compact', 'Compact'], ['minimal', 'Minimal'], ['modern', 'Modern']];
const FONTS = {
  sans: "system-ui,-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif",
  serif: "Georgia,Cambria,'Times New Roman',serif",
  mono: "'SF Mono','JetBrains Mono',Menlo,Consolas,monospace",
};

const ICONS = {
  email:    `<svg aria-hidden="true" viewBox="0 0 14 12" fill="none" stroke="currentColor" stroke-width="1.4" width="12" height="11" style="vertical-align:-.12em;margin-right:3pt"><rect x="1" y="1" width="12" height="10" rx="1"/><path d="M1 3l6 4 6-4"/></svg>`,
  phone:    `<svg aria-hidden="true" viewBox="0 0 13 13" fill="currentColor" width="11" height="11" style="vertical-align:-.12em;margin-right:3pt"><path d="M2.2 1h2.7L6 4 4 5.3A8.7 8.7 0 0 0 7.7 9L9 7l3 1.1v2.7c0 .7-.6 1.2-1.2 1.2C3.8 12 1 5.3 1 2.2 1 1.5 1.5 1 2.2 1z"/></svg>`,
  location: `<svg aria-hidden="true" viewBox="0 0 12 15" fill="none" stroke="currentColor" stroke-width="1.5" width="10" height="12" style="vertical-align:-.12em;margin-right:3pt"><path d="M6 1a4.5 4.5 0 0 1 4.5 4.5C10.5 9 6 14 6 14S1.5 9 1.5 5.5A4.5 4.5 0 0 1 6 1z"/><circle cx="6" cy="5.5" r="1.6" fill="currentColor" stroke="none"/></svg>`,
  globe:    `<svg aria-hidden="true" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.4" width="12" height="11" style="vertical-align:-.12em;margin-right:3pt"><circle cx="7" cy="7" r="6"/><path d="M7 1c-2 2-2 10 0 12M7 1c2 2 2 10 0 12M1.5 5h11M1.5 9h11"/></svg>`,
  link:     `<svg aria-hidden="true" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5" width="12" height="11" style="vertical-align:-.12em;margin-right:3pt"><path d="M5.5 2H3a1.5 1.5 0 0 0-1.5 1.5v7A1.5 1.5 0 0 0 3 12h7a1.5 1.5 0 0 0 1.5-1.5V9"/><path d="M8.5 2H12v3.5M12 2 6 8"/></svg>`,
};
const SECTION_KEYS = ['experience', 'education', 'skills', 'projects']; // reorderable body sections
function normalize(m) {
  m = m || {};
  const b = m.basics || {};
  const arr = (x) => (Array.isArray(x) ? x : []);
  const str = (x) => String(x == null ? '' : x);
  let sections = arr(m.sections).filter((k) => SECTION_KEYS.includes(k));
  sections = sections.filter((k, i) => sections.indexOf(k) === i);
  for (const k of SECTION_KEYS) if (!sections.includes(k)) sections.push(k);
  return {
    sections,
    v: 1,
    template: oneOf(m.template, TEMPLATES.map((t) => t[0]), 'classic'),
    theme: { accent: cssColor(m.theme && m.theme.accent) || '#2563eb', font: oneOf(m.theme && m.theme.font, ['sans', 'serif', 'mono'], 'sans') },
    basics: { name: str(b.name), title: str(b.title), email: str(b.email), phone: str(b.phone), location: str(b.location), website: str(b.website), photo: typeof b.photo === 'string' && b.photo.startsWith('data:image/') ? b.photo : '', summary: str(b.summary) },
    links: arr(m.links).map((l) => ({ label: str(l && l.label), url: str(l && l.url) })).slice(0, 12),
    experience: arr(m.experience).map((e) => ({ role: str(e && e.role), company: str(e && e.company), location: str(e && e.location), start: str(e && e.start), end: str(e && e.end), current: !!(e && e.current), bullets: arr(e && e.bullets).map(str) })).slice(0, 30),
    education: arr(m.education).map((e) => ({ degree: str(e && e.degree), school: str(e && e.school), location: str(e && e.location), start: str(e && e.start), end: str(e && e.end), details: str(e && e.details) })).slice(0, 20),
    skills: arr(m.skills).map(str).filter(Boolean).slice(0, 60),
    projects: arr(m.projects).map((p) => ({ name: str(p && p.name), url: str(p && p.url), description: str(p && p.description) })).slice(0, 20),
  };
}

// ---------- the single pure renderer ----------
function renderResumeHtml(model) {
  const m = normalize(model);
  const acc = m.theme.accent, font = FONTS[m.theme.font] || FONTS.sans, b = m.basics;
  const when = (s, e, cur) => [esc(s), cur ? 'Present' : esc(e)].filter(Boolean).join(' – ');
  const contactItems = () => {
    const out = [];
    if (b.email) out.push(`<a href="${esc(safeUrl(b.email))}">${ICONS.email}${esc(b.email)}</a>`);
    if (b.phone) out.push(`<a href="${esc(safeUrl(b.phone))}">${ICONS.phone}${esc(b.phone)}</a>`);
    if (b.location) out.push(`<span>${ICONS.location}${esc(b.location)}</span>`);
    if (b.website) out.push(`<a href="${esc(safeUrl(b.website))}">${ICONS.globe}${esc(b.website.replace(/^https?:\/\//, ''))}</a>`);
    for (const l of m.links) if (l.url || l.label) out.push(`<a href="${esc(safeUrl(l.url))}">${ICONS.link}${esc(l.label || l.url)}</a>`);
    return out;
  };
  const sec = (title, inner) => inner ? `<section class="section"><h2>${esc(title)}</h2>${inner}</section>` : '';
  const summaryHtml = () => b.summary ? `<p class="summary">${esc(b.summary)}</p>` : '';
  const expHtml = () => !m.experience.length ? '' : sec('Experience', m.experience.map((e) => `<div class="entry"><div class="row"><div><span class="role">${esc(e.role || 'Role')}</span>${e.company ? ` <span class="org">— ${esc(e.company)}</span>` : ''}</div><div class="when">${when(e.start, e.end, e.current)}</div></div>${e.location ? `<div class="meta">${esc(e.location)}</div>` : ''}${e.bullets.filter(Boolean).length ? `<ul>${e.bullets.filter(Boolean).map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}</div>`).join(''));
  const eduHtml = () => !m.education.length ? '' : sec('Education', m.education.map((e) => `<div class="entry"><div class="row"><div><span class="role">${esc(e.degree || 'Degree')}</span>${e.school ? ` <span class="org">— ${esc(e.school)}</span>` : ''}</div><div class="when">${when(e.start, e.end, false)}</div></div>${e.details ? `<div class="meta">${esc(e.details)}</div>` : ''}</div>`).join(''));
  const projHtml = () => !m.projects.length ? '' : sec('Projects', m.projects.map((p) => `<div class="entry"><div class="row"><div><span class="role">${esc(p.name || 'Project')}</span></div>${p.url ? `<div class="when"><a href="${esc(safeUrl(p.url))}">${esc(p.url.replace(/^https?:\/\//, ''))}</a></div>` : ''}</div>${p.description ? `<div class="meta">${esc(p.description)}</div>` : ''}</div>`).join(''));
  const skillsHtml = () => !m.skills.length ? '' : sec('Skills', `<div class="skills">${m.skills.map((s) => `<span class="skill">${esc(s)}</span>`).join('')}</div>`);
  const photoTag = (cls) => b.photo ? `<img class="${cls}" src="${esc(b.photo)}" alt="">` : '';

  const tpl = m.template;
  const secMap = { experience: expHtml(), education: eduHtml(), skills: skillsHtml(), projects: projHtml() };
  const inOrder = (keys) => m.sections.filter((k) => keys.indexOf(k) >= 0).map((k) => secMap[k]).join('');
  let body;
  if (tpl === 'sidebar') {
    const contactLines = contactItems().map((x) => `<div class="cline">${x}</div>`).join('');
    body = `<div class="page sidebar"><aside class="side">${photoTag('photo')}${contactLines ? `<div class="side-contact">${contactLines}</div>` : ''}${inOrder(['skills', 'education'])}</aside><main class="main"><div class="name">${esc(b.name || 'Your Name')}</div>${b.title ? `<div class="title">${esc(b.title)}</div>` : ''}${summaryHtml()}${inOrder(['experience', 'projects'])}</main></div>`;
  } else if (tpl === 'modern') {
    const contacts = contactItems();
    body = `<div class="page tpl-modern"><header class="head">${photoTag('photo')}<div class="head-main"><div class="name">${esc(b.name || 'Your Name')}</div>${b.title ? `<div class="title">${esc(b.title)}</div>` : ''}</div></header>${contacts.length ? `<div class="contact-bar">${contacts.map((x) => `<span>${x}</span>`).join('')}</div>` : ''}${summaryHtml()}${inOrder(['experience', 'education', 'skills', 'projects'])}</div>`;
  } else {
    const contact = contactItems();
    const head = `<header class="head">${photoTag('photo')}<div class="head-main"><div class="name">${esc(b.name || 'Your Name')}</div>${b.title ? `<div class="title">${esc(b.title)}</div>` : ''}${contact.length ? `<div class="contact">${contact.map((x) => `<span>${x}</span>`).join('')}</div>` : ''}</div></header>`;
    body = `<div class="page tpl-${esc(tpl)}">${head}${summaryHtml()}${inOrder(['experience', 'education', 'skills', 'projects'])}</div>`;
  }
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(b.name || 'Resume')}</title><style>${cssFor(tpl, acc, font)}</style></head><body>${body}</body></html>`;
}

function cssFor(tpl, acc, font) {
  const base = `:root{--acc:${acc};--soft:color-mix(in srgb,${acc} 13%,#fff)}
*{box-sizing:border-box}html,body{margin:0;padding:0}
body{font-family:${font};color:#222;font-size:10.5pt;line-height:1.45;background:#fff;-webkit-print-color-adjust:exact;print-color-adjust:exact}
.page{max-width:210mm;min-height:297mm;margin:0 auto;padding:15mm 16mm;background:#fff}
a{color:var(--acc);text-decoration:none}
.name{font-size:23pt;font-weight:700;letter-spacing:-.01em;color:#111;line-height:1.1}
.title{font-size:12pt;color:var(--acc);font-weight:600;margin-top:3pt}
.contact{display:flex;flex-wrap:wrap;gap:3pt 12pt;font-size:9pt;color:#555;margin-top:7pt}
.section{margin-top:13pt}
.section>h2{font-size:10.5pt;text-transform:uppercase;letter-spacing:.09em;color:var(--acc);border-bottom:1.5px solid var(--acc);padding-bottom:3pt;margin:0 0 7pt}
.entry{margin-bottom:9pt;break-inside:avoid}.entry+.entry{border-top:1pt solid #e8ecf0}
.entry .row{display:flex;justify-content:space-between;align-items:baseline;gap:10pt}
.role{font-weight:700;color:#111}.org{font-weight:600;color:#333}
.when{font-size:9pt;color:#666;white-space:nowrap}
.meta{font-size:9pt;color:#666;margin-top:1pt}
.entry ul{margin:4pt 0 0;padding-left:15pt}.entry li{margin:2.5pt 0}
.summary{margin:8pt 0 0;color:#333}
.skills{display:flex;flex-wrap:wrap;gap:5pt}
.skill{background:var(--soft);color:#1f2937;border-radius:3pt;padding:2.5pt 8pt;font-size:9pt}
.photo{width:84px;height:84px;border-radius:50%;object-fit:cover;flex:none}
@page{size:A4;margin:0}`;
  const head = `.head{display:flex;align-items:center;gap:16pt;border-bottom:2px solid var(--acc);padding-bottom:11pt;margin-bottom:4pt}.head-main{flex:1;min-width:0}`;
  if (tpl === 'classic') return base + '\n' + head + '\n.head{text-align:left}';
  if (tpl === 'minimal') return base + `\n.head{display:flex;align-items:center;gap:16pt;padding-bottom:9pt;margin-bottom:2pt}.head-main{flex:1}.name{font-size:26pt;color:#111}.title{color:#555}.section>h2{border-bottom:0;color:#111;letter-spacing:.12em;font-size:9.5pt;color:#888}.section{margin-top:15pt}`;
  if (tpl === 'compact') return base + '\n' + head + `\nbody{font-size:9.7pt;line-height:1.34}.page{padding:12mm 13mm}.name{font-size:20pt}.title{font-size:11pt}.section{margin-top:10pt}.entry{margin-bottom:6.5pt}.head{padding-bottom:8pt;gap:12pt}`;
  if (tpl === 'modern') return base + `
.tpl-modern .head{background:var(--acc);margin:-15mm -16mm 0;padding:15mm 16mm 14pt;display:flex;align-items:center;gap:16pt;min-width:0}
.tpl-modern .head-main{flex:1;min-width:0}
.tpl-modern .head .photo{border:2.5pt solid rgba(255,255,255,.3)}
.tpl-modern .name{font-size:26pt;color:#fff;line-height:1.1;letter-spacing:-.01em}
.tpl-modern .title{color:rgba(255,255,255,.82);font-size:12pt;font-weight:500;margin-top:3pt}
.tpl-modern .contact-bar{display:flex;flex-wrap:wrap;gap:4pt 14pt;font-size:9pt;color:#374151;background:color-mix(in srgb,var(--acc) 8%,#fff);margin:0 -16mm;padding:7pt 16mm;border-bottom:1pt solid color-mix(in srgb,var(--acc) 20%,#e2e8f0)}
.tpl-modern .contact-bar a{color:#374151}
.tpl-modern .summary{margin-top:12pt}
.tpl-modern .section{margin-top:14pt}
.tpl-modern .section>h2{border-bottom:0;border-left:3pt solid var(--acc);padding:0 0 0 7pt;color:#111;letter-spacing:.07em;margin-bottom:8pt}`;
  // sidebar
  return base + `\n.page.sidebar{display:grid;grid-template-columns:58mm 1fr;gap:0;padding:0;min-height:297mm}
.side{background:var(--soft);padding:15mm 8mm;display:flex;flex-direction:column;gap:11pt}
.side .photo{width:96px;height:96px;margin:0 auto 4pt}
.side-contact .cline{font-size:9pt;color:#374151;margin:2.5pt 0;word-break:break-word}
.side .section{margin-top:6pt}.side .section>h2{border-bottom:0;border-top:1.5px solid var(--acc);padding:6pt 0 0;color:var(--acc)}
.side .skills{gap:4pt}.side .skill{background:#fff}
.main{padding:15mm 14mm}.main .name{font-size:23pt}.main>.title{margin-bottom:2pt}`;
}

// ---------- editor ----------
export async function renderResume(container, ctx) {
  const { api } = ctx;
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
  const isMobile = () => { try { return window.matchMedia('(max-width:54rem)').matches; } catch (e) { return false; } };

  if (!document.getElementById('bv-resume-css')) {
    const st = document.createElement('style'); st.id = 'bv-resume-css';
    st.textContent = `.bvr{--c:#2563eb;--line:#e2e8f0;--surf:#fff;--bg:#eef2f7;--muted:#64748b;display:grid;grid-template-rows:auto 1fr;height:calc(100vh - 3.5rem);font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;color:#1f2937;background:var(--bg)}
.bvr-bar{display:flex;gap:.5rem;align-items:center;flex-wrap:wrap;padding:.5rem .8rem;background:var(--surf);border-bottom:1px solid var(--line);box-shadow:0 1px 2px rgba(15,23,42,.04);z-index:5}
.bvr-bar strong{font-size:1rem;margin-right:.3rem}
.bvr-bar select,.bvr-bar input[type=color]{font:inherit;min-height:36px;border:1px solid var(--line);border-radius:.4rem;background:#fff}
.bvr-bar input[type=color]{width:36px;height:36px;padding:2px}
.bvr-status{color:var(--muted);font-size:.82rem;margin-left:auto}
.bvr-btn{min-height:36px;padding:.35rem .85rem;border-radius:.5rem;border:1px solid var(--c);background:var(--c);color:#fff;font:inherit;font-weight:600;cursor:pointer}
.bvr-btn.sec{background:#fff;color:var(--c)}
.bvr-body{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);overflow:hidden;min-height:0}
.bvr-form{overflow:auto;padding:1rem 1.1rem;display:flex;flex-direction:column;gap:.5rem;border-right:1px solid var(--line)}
.bvr-prev{overflow:auto;background:#cbd5e1;display:flex;justify-content:center;padding:1.2rem}
.bvr-prev iframe{width:210mm;min-height:297mm;border:0;background:#fff;box-shadow:0 6px 24px rgba(0,0,0,.2);transform-origin:top center}
.bvr-sec{border:1px solid var(--line);border-radius:.6rem;background:#fff;overflow:hidden}
.bvr-sec>summary{padding:.6rem .8rem;font-weight:700;cursor:pointer;list-style:none;display:flex;align-items:center;gap:.4rem}
.bvr-sec>summary::-webkit-details-marker{display:none}
.bvr-sec>summary::before{content:"▸";color:var(--muted);font-size:.8rem}
.bvr-sec[open]>summary::before{content:"▾"}
.bvr-secbody{padding:.2rem .8rem .8rem}
.bvr-field{display:block;margin:.5rem 0}
.bvr-field>span{display:block;font-size:.78rem;color:var(--muted);margin-bottom:.2rem}
.bvr-field input,.bvr-field textarea{width:100%;box-sizing:border-box;padding:.5rem .6rem;border:1px solid var(--line);border-radius:.45rem;font:inherit;min-height:40px}
.bvr-field textarea{min-height:5rem;resize:vertical;line-height:1.4}
.bvr-grid2{display:grid;grid-template-columns:1fr 1fr;gap:.5rem}
.bvr-card{border:1px solid var(--line);border-radius:.5rem;padding:.5rem .6rem;margin:.5rem 0;background:#fafbfc}
.bvr-cardbar{display:flex;gap:.3rem;justify-content:flex-end;margin-bottom:.2rem}
.bvr-mini{min-height:30px;min-width:30px;padding:.1rem .45rem;border:1px solid var(--line);border-radius:.35rem;background:#fff;cursor:pointer;font:inherit}
.bvr-add{min-height:38px;width:100%;border:1px dashed var(--c);color:var(--c);background:#fff;border-radius:.5rem;cursor:pointer;font:inherit;font-weight:600;margin-top:.3rem}
.bvr-row{display:flex;align-items:center;gap:.4rem}
.bvr-drag{cursor:grab;touch-action:none;color:var(--muted);font-size:1.05rem;line-height:1;padding:0 .15rem;user-select:none}
.bvr-drag:active{cursor:grabbing}
.bvr-sectitle{flex:1;min-width:0}
.bvr-secctrls{display:flex;gap:.15rem}
.bvr-sec.bvr-dragging{opacity:.45}
.bvr-secdropline{position:fixed;height:3px;background:var(--c);border-radius:2px;z-index:60;pointer-events:none;display:none;box-shadow:0 0 0 1px #fff}
.bvr-reorder-hint{font-size:.74rem;color:var(--muted);margin:.6rem 0 .15rem;padding-left:.2rem}
.bvr-mobtab{display:none}
@media (max-width:54rem){.bvr-body{grid-template-columns:1fr}.bvr-form,.bvr-prev{display:none}.bvr-body.show-form .bvr-form{display:flex}.bvr-body.show-prev .bvr-prev{display:flex}.bvr-mobtab{display:flex;gap:.4rem}.bvr-prev iframe{width:100%;min-height:0;height:70vh}}`;
    document.head.appendChild(st);
  }

  container.replaceChildren();
  const root = h('div', { class: 'bvr' });
  container.appendChild(root);

  // load
  let model, published = null;
  try { const r = await api('GET', '/api/resume/me'); model = normalize((r.ok && r.data && r.data.model) || {}); published = (r.ok && r.data && r.data.published) || null; }
  catch (e) { model = normalize({}); }
  if (!model.basics.name && ctx.me && ctx.me.handle) model.basics.name = '';

  // ---- top bar ----
  const bar = h('div', { class: 'bvr-bar' });
  bar.appendChild(h('strong', null, 'Resume'));
  const tplSel = h('select', { 'aria-label': 'Template', onchange: () => { model.template = tplSel.value; changed(); } });
  for (const [v, l] of TEMPLATES) tplSel.appendChild(h('option', { value: v }, l));
  tplSel.value = model.template; bar.appendChild(tplSel);
  const fontSel = h('select', { 'aria-label': 'Font', onchange: () => { model.theme.font = fontSel.value; changed(); } });
  for (const [v, l] of [['sans', 'Sans'], ['serif', 'Serif'], ['mono', 'Mono']]) fontSel.appendChild(h('option', { value: v }, l));
  fontSel.value = model.theme.font; bar.appendChild(fontSel);
  const accInp = h('input', { type: 'color', value: model.theme.accent, 'aria-label': 'Accent colour', oninput: () => { model.theme.accent = accInp.value; changed(); } });
  bar.appendChild(accInp);
  const status = h('span', { class: 'bvr-status' }, 'Loading…');
  bar.appendChild(status);
  const mobTabs = h('div', { class: 'bvr-mobtab' });
  const pdfBtn = h('button', { class: 'bvr-btn sec', type: 'button', onclick: downloadPdf }, 'PDF');
  const pubBtn = h('button', { class: 'bvr-btn', type: 'button', onclick: openPublish }, 'Share link');
  bar.appendChild(pdfBtn); bar.appendChild(pubBtn);
  root.appendChild(bar);

  const body = h('div', { class: 'bvr-body show-form' });
  const formEl = h('div', { class: 'bvr-form' });
  const prevWrap = h('div', { class: 'bvr-prev' });
  const frame = h('iframe', { title: 'Resume preview', sandbox: 'allow-same-origin' });
  prevWrap.appendChild(frame);
  body.appendChild(formEl); body.appendChild(prevWrap);
  root.appendChild(body);

  // mobile form/preview toggle
  const tF = h('button', { class: 'bvr-btn sec', type: 'button', onclick: () => { body.classList.add('show-form'); body.classList.remove('show-prev'); } }, 'Edit');
  const tP = h('button', { class: 'bvr-btn sec', type: 'button', onclick: () => { body.classList.add('show-prev'); body.classList.remove('show-form'); updatePreview(); } }, 'Preview');
  mobTabs.appendChild(tF); mobTabs.appendChild(tP); bar.insertBefore(mobTabs, status);

  // ---- field helpers ----
  const field = (label, ctrl) => { const w = h('label', { class: 'bvr-field' }, h('span', null, label)); w.appendChild(ctrl); return w; };
  const input = (obj, key, ph, type) => h('input', { type: type || 'text', value: obj[key] || '', placeholder: ph || '', oninput: (e) => { obj[key] = e.target.value; changed(); } });
  const textarea = (obj, key, ph) => { const t = h('textarea', { placeholder: ph || '' }); t.value = obj[key] || ''; t.addEventListener('input', () => { obj[key] = t.value; changed(); }); return t; };
  const section = (title, openDefault) => { const d = h('details', { class: 'bvr-sec' }); if (openDefault) d.setAttribute('open', ''); d.appendChild(h('summary', null, title)); const bd = h('div', { class: 'bvr-secbody' }); d.appendChild(bd); formEl.appendChild(d); return bd; };
  const mini = (label, fn, title) => h('button', { class: 'bvr-mini', type: 'button', title: title || label, onclick: fn }, label);

  function repeatable(bd, list, makeEmpty, renderRow, addLabel) {
    const host = h('div'); bd.appendChild(host);
    const redraw = () => { host.replaceChildren(); list.forEach((item, i) => { const card = h('div', { class: 'bvr-card' }); const cbar = h('div', { class: 'bvr-cardbar' }); cbar.appendChild(mini('↑', () => { if (i > 0) { [list[i - 1], list[i]] = [list[i], list[i - 1]]; redraw(); changed(); } }, 'Move up')); cbar.appendChild(mini('↓', () => { if (i < list.length - 1) { [list[i + 1], list[i]] = [list[i], list[i + 1]]; redraw(); changed(); } }, 'Move down')); cbar.appendChild(mini('✕', () => { list.splice(i, 1); redraw(); changed(); }, 'Remove')); card.appendChild(cbar); renderRow(card, item); host.appendChild(card); }); };
    bd.appendChild(h('button', { class: 'bvr-add', type: 'button', onclick: () => { list.push(makeEmpty()); redraw(); changed(); } }, addLabel));
    redraw();
  }

  // ---- reorderable body sections: builders, drag-reorder, ↑↓ ----
  function buildExperience(bd) {
    repeatable(bd, model.experience, () => ({ role: '', company: '', location: '', start: '', end: '', current: false, bullets: [] }), (card, it) => {
      const g = h('div', { class: 'bvr-grid2' }); g.appendChild(field('Role', input(it, 'role', 'Senior Designer'))); g.appendChild(field('Company', input(it, 'company', 'Acme Inc'))); card.appendChild(g);
      const g2 = h('div', { class: 'bvr-grid2' }); g2.appendChild(field('Start', input(it, 'start', '2021'))); g2.appendChild(field('End', input(it, 'end', '2024'))); card.appendChild(g2);
      const curL = h('label', { class: 'bvr-row', style: 'font-size:.82rem;margin:.2rem 0' }); const cur = h('input', { type: 'checkbox' }); cur.checked = !!it.current; cur.addEventListener('change', () => { it.current = cur.checked; changed(); }); curL.appendChild(cur); curL.appendChild(h('span', null, 'I currently work here')); card.appendChild(curL);
      card.appendChild(field('Location', input(it, 'location', 'City (optional)')));
      const bt = h('textarea', { placeholder: 'One bullet per line' }); bt.value = (it.bullets || []).join('\n'); bt.addEventListener('input', () => { it.bullets = bt.value.split('\n'); changed(); }); card.appendChild(field('Highlights (one per line)', bt));
    }, '+ Add experience');
  }
  function buildEducation(bd) {
    repeatable(bd, model.education, () => ({ degree: '', school: '', location: '', start: '', end: '', details: '' }), (card, it) => { card.appendChild(field('Degree / programme', input(it, 'degree', 'B.Sc. Computer Science'))); card.appendChild(field('School', input(it, 'school', 'University'))); const g = h('div', { class: 'bvr-grid2' }); g.appendChild(field('Start', input(it, 'start', '2016'))); g.appendChild(field('End', input(it, 'end', '2020'))); card.appendChild(g); card.appendChild(field('Details', input(it, 'details', 'Honours, GPA… (optional)'))); }, '+ Add education');
  }
  function buildSkills(bd) { const skTa = h('textarea', { placeholder: 'Comma or newline separated' }); skTa.value = (model.skills || []).join(', '); skTa.addEventListener('input', () => { model.skills = skTa.value.split(/[\n,]/).map((s) => s.trim()).filter(Boolean); changed(); }); bd.appendChild(field('Skills', skTa)); }
  function buildProjects(bd) { repeatable(bd, model.projects, () => ({ name: '', url: '', description: '' }), (card, it) => { const g = h('div', { class: 'bvr-grid2' }); g.appendChild(field('Name', input(it, 'name', 'Project'))); g.appendChild(field('URL', input(it, 'url', 'https://… (optional)'))); card.appendChild(g); card.appendChild(field('Description', input(it, 'description', 'What it is and your role.'))); }, '+ Add project'); }
  const SEC_TITLE = { experience: 'Experience', education: 'Education', skills: 'Skills', projects: 'Projects' };
  const SEC_BUILD = { experience: buildExperience, education: buildEducation, skills: buildSkills, projects: buildProjects };
  const secOpen = { experience: true, education: false, skills: false, projects: false };
  const secHost = h('div', { class: 'bvr-sections' });
  const dropline = h('div', { class: 'bvr-secdropline' }); root.appendChild(dropline);

  function buildForm() {
    formEl.replaceChildren();
    const c = section('Contact', true); const b = model.basics;
    c.appendChild(field('Full name', input(b, 'name', 'Jane Doe')));
    c.appendChild(field('Headline / title', input(b, 'title', 'Product Designer')));
    const g = h('div', { class: 'bvr-grid2' }); g.appendChild(field('Email', input(b, 'email', 'you@example.com', 'email'))); g.appendChild(field('Phone', input(b, 'phone', '+1 …'))); c.appendChild(g);
    const g2 = h('div', { class: 'bvr-grid2' }); g2.appendChild(field('Location', input(b, 'location', 'City, Country'))); g2.appendChild(field('Website', input(b, 'website', 'example.com'))); c.appendChild(g2);
    const photoRow = h('div', { class: 'bvr-row', style: 'margin:.5rem 0' });
    const photoPrev = h('img', { alt: '', style: 'width:46px;height:46px;border-radius:50%;object-fit:cover;border:1px solid var(--line);' + (b.photo ? '' : 'display:none') }); if (b.photo) photoPrev.src = b.photo;
    const photoFile = h('input', { type: 'file', accept: 'image/*' });
    photoFile.addEventListener('change', async () => { const f = photoFile.files && photoFile.files[0]; if (!f) return; try { b.photo = await prepPhoto(f); photoPrev.src = b.photo; photoPrev.style.display = ''; changed(); } catch (e) {} });
    const photoRm = mini('Remove', () => { b.photo = ''; photoPrev.style.display = 'none'; changed(); buildForm(); });
    photoRow.appendChild(photoPrev); photoRow.appendChild(h('div', null, h('div', { style: 'font-size:.78rem;color:var(--muted)' }, 'Photo (optional)'), photoFile)); if (b.photo) photoRow.appendChild(photoRm);
    c.appendChild(photoRow);
    c.appendChild(field('Summary', textarea(b, 'summary', 'A short professional summary.')));
    const lk = section('Links', false);
    repeatable(lk, model.links, () => ({ label: '', url: '' }), (card, it) => { const g = h('div', { class: 'bvr-grid2' }); g.appendChild(field('Label', input(it, 'label', 'LinkedIn'))); g.appendChild(field('URL', input(it, 'url', 'https://…'))); card.appendChild(g); }, '+ Add link');
    formEl.appendChild(h('div', { class: 'bvr-reorder-hint' }, 'Drag ⠿ (or use ↑ ↓) to reorder sections'));
    formEl.appendChild(secHost);
    renderSections();
  }

  function renderSections() {
    secHost.replaceChildren();
    model.sections.forEach((key, i) => {
      const panel = h('details', { class: 'bvr-sec' }); if (secOpen[key]) panel.setAttribute('open', '');
      panel.addEventListener('toggle', () => { secOpen[key] = panel.open; });
      const sum = h('summary');
      const handle = h('span', { class: 'bvr-drag', 'aria-hidden': 'true', title: 'Drag to reorder' }, '⠿');
      handle.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); });
      handle.addEventListener('pointerdown', (e) => startSecDrag(e, key, panel));
      const title = h('span', { class: 'bvr-sectitle' }, SEC_TITLE[key]);
      const ctrls = h('span', { class: 'bvr-secctrls' });
      ctrls.addEventListener('click', (e) => e.stopPropagation());
      ctrls.appendChild(mini('↑', () => moveSec(i, -1), 'Move section up'));
      ctrls.appendChild(mini('↓', () => moveSec(i, 1), 'Move section down'));
      sum.appendChild(handle); sum.appendChild(title); sum.appendChild(ctrls);
      panel.appendChild(sum);
      const bd = h('div', { class: 'bvr-secbody' }); SEC_BUILD[key](bd); panel.appendChild(bd);
      secHost.appendChild(panel);
    });
  }
  function moveSec(i, d) { const j = i + d; if (j < 0 || j >= model.sections.length) return; const a = model.sections;[a[i], a[j]] = [a[j], a[i]]; renderSections(); changed(); }

  let secDrag = null;
  function startSecDrag(e, key, panel) {
    if (e.button != null && e.button !== 0) return; e.preventDefault();
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch (er) {}
    secDrag = { key, panel, pointerId: e.pointerId, target: model.sections.indexOf(key) };
    panel.classList.add('bvr-dragging');
    const move = (ev) => onSecDragMove(ev);
    const up = () => { window.removeEventListener('pointermove', move, true); window.removeEventListener('pointerup', up, true); window.removeEventListener('pointercancel', up, true); endSecDrag(); };
    window.addEventListener('pointermove', move, true); window.addEventListener('pointerup', up, true); window.addEventListener('pointercancel', up, true);
  }
  function onSecDragMove(e) {
    if (!secDrag || e.pointerId !== secDrag.pointerId) return;
    const panels = Array.prototype.slice.call(secHost.querySelectorAll('.bvr-sec'));
    let target = 0; for (let k = 0; k < panels.length; k++) { const r = panels[k].getBoundingClientRect(); if (e.clientY > (r.top + r.bottom) / 2) target = k + 1; }
    secDrag.target = target;
    const hostR = secHost.getBoundingClientRect();
    const y = target === 0 ? panels[0].getBoundingClientRect().top - 2 : panels[Math.min(target, panels.length) - 1].getBoundingClientRect().bottom - 1;
    Object.assign(dropline.style, { display: 'block', left: hostR.left + 'px', top: y + 'px', width: hostR.width + 'px' });
  }
  function endSecDrag() {
    if (!secDrag) return; const { key } = secDrag; let target = secDrag.target;
    secDrag.panel.classList.remove('bvr-dragging'); dropline.style.display = 'none';
    const a = model.sections, from = a.indexOf(key); secDrag = null;
    if (from < 0) return;
    a.splice(from, 1); if (target > from) target -= 1; target = Math.max(0, Math.min(target, a.length)); a.splice(target, 0, key);
    if (from !== target) { renderSections(); changed(); }
  }

  // ---- preview + persistence ----
  let prevTimer = 0, saveTimer = 0, saving = false, dirty = false;
  function updatePreview() { clearTimeout(prevTimer); prevTimer = setTimeout(() => { try { frame.srcdoc = renderResumeHtml(model); } catch (e) {} fitPreview(); }, 250); }
  function fitPreview() { try { if (isMobile()) { frame.style.transform = ''; return; } const avail = prevWrap.clientWidth - 32; const pageW = 794; /* 210mm @96dpi */ const s = Math.min(1, avail / pageW); frame.style.transform = s < 1 ? `scale(${s})` : ''; } catch (e) {} }
  window.addEventListener('resize', fitPreview);
  function setStatus(t) { if (status.isConnected) status.textContent = t; }
  async function saveModel() { if (saving) return; saving = true; setStatus('Saving…'); let ok = false; try { const r = await api('PUT', '/api/resume/me', { model }); ok = r.ok; } catch (e) {} saving = false; if (ok) { dirty = false; setStatus('Saved'); } else { setStatus('Save failed — retrying'); clearTimeout(saveTimer); saveTimer = setTimeout(saveModel, 5000); } }
  function changed() { dirty = true; setStatus('Editing…'); tplSel.value = model.template; updatePreview(); clearTimeout(saveTimer); saveTimer = setTimeout(saveModel, 1200); }

  function prepPhoto(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file); const img = new Image();
      img.onload = () => { URL.revokeObjectURL(url); const S = 320; let w = img.naturalWidth, hh = img.naturalHeight; const sc = Math.min(1, S / Math.max(w, hh)); w = Math.round(w * sc); hh = Math.round(hh * sc); const cv = document.createElement('canvas'); cv.width = w; cv.height = hh; cv.getContext('2d').drawImage(img, 0, 0, w, hh); resolve(cv.toDataURL('image/jpeg', 0.85)); };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('decode')); }; img.src = url;
    });
  }

  // ---- publish + pdf ----
  async function downloadPdf() {
    pdfBtn.disabled = true; const old = pdfBtn.textContent; pdfBtn.textContent = 'Rendering…';
    try {
      let auth = null; try { auth = ctx.bearer ? await ctx.bearer() : null; } catch (e) {}
      const headers = { 'content-type': 'application/json' }; if (auth) headers.authorization = auth;
      const r = await fetch('/api/resume/pdf', { method: 'POST', headers, body: JSON.stringify({ html: renderResumeHtml(model) }) });
      if (!r.ok) throw new Error('pdf');
      const blob = await r.blob(); const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = (model.basics.name ? model.basics.name.replace(/[^\w-]+/g, '_') : 'resume') + '.pdf'; document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    } catch (e) { alert('Could not generate the PDF. Please try again.'); }
    pdfBtn.disabled = false; pdfBtn.textContent = old;
  }

  function openPublish() {
    const ov = h('div', { style: 'position:fixed;inset:0;background:rgba(15,23,42,.45);display:flex;align-items:center;justify-content:center;z-index:50;padding:1rem' });
    const card = h('div', { style: 'background:#fff;border-radius:.8rem;max-width:30rem;width:100%;padding:1.2rem;font-family:inherit' });
    const close = () => ov.remove();
    card.appendChild(h('h2', { style: 'margin:.1rem 0 .3rem;font-size:1.2rem' }, 'Share your resume'));
    card.appendChild(h('p', { style: 'color:#64748b;font-size:.88rem;margin:.2rem 0 .7rem' }, 'Publish a public link you can send to anyone. Updating and re-publishing keeps the same link.'));
    const def = published && published.slug ? published.slug : (model.basics.name || 'resume').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'resume';
    const slugIn = h('input', { type: 'text', value: def, style: 'width:100%;box-sizing:border-box;padding:.55rem .6rem;border:1px solid #cbd5e1;border-radius:.45rem;font:inherit' });
    const urlPrev = h('div', { style: 'font-family:ui-monospace,Menlo,monospace;font-size:.82rem;color:#0f172a;margin:.4rem 0' });
    const msg = h('div', { style: 'min-height:1.2rem;font-size:.84rem;margin:.3rem 0' });
    const upd = () => { const s = slugIn.value.toLowerCase().replace(/[^a-z0-9-]/g, ''); slugIn.value = s; urlPrev.textContent = 'yourdomain.com/r/' + (s || 'your-name'); };
    slugIn.addEventListener('input', upd); upd();
    card.appendChild(h('label', { style: 'font-size:.78rem;color:#64748b' }, 'Link address')); card.appendChild(slugIn); card.appendChild(urlPrev); card.appendChild(msg);
    const row = h('div', { style: 'display:flex;gap:.5rem;justify-content:flex-end;margin-top:.6rem;flex-wrap:wrap' });
    if (published && published.slug) row.appendChild(h('button', { class: 'bvr-btn sec', type: 'button', onclick: async () => { msg.textContent = 'Unpublishing…'; try { await api('POST', '/api/resume/unpublish', {}); published = null; close(); } catch (e) {} } }, 'Unpublish'));
    row.appendChild(h('button', { class: 'bvr-btn sec', type: 'button', onclick: close }, 'Cancel'));
    const go = h('button', { class: 'bvr-btn', type: 'button', onclick: async () => {
      const slug = slugIn.value.trim(); if (slug.length < 3) { msg.style.color = '#b00'; msg.textContent = 'Pick at least 3 characters.'; return; }
      go.disabled = true; msg.style.color = '#64748b'; msg.textContent = 'Publishing…';
      if (dirty) { try { await api('PUT', '/api/resume/me', { model }); dirty = false; } catch (e) {} }
      const r = await api('POST', '/api/resume/publish', { html: renderResumeHtml(model), slug });
      go.disabled = false;
      if (r.ok && r.data && r.data.url) { published = { slug: r.data.slug, url: r.data.url }; msg.replaceChildren(); msg.style.color = '#16794a'; const a = h('a', { href: r.data.url, target: '_blank', rel: 'noopener', style: 'color:#2563eb' }, r.data.url); msg.appendChild(document.createTextNode('Live at ')); msg.appendChild(a); }
      else { msg.style.color = '#b00'; msg.textContent = r.data && r.data.error === 'slug_taken' ? 'That address is taken — try another.' : ('Could not publish (' + ((r.data && r.data.error) || r.status) + ').'); }
    } }, 'Publish');
    row.appendChild(go); card.appendChild(row);
    ov.addEventListener('click', (e) => { if (e.target === ov) close(); });
    card.addEventListener('click', (e) => e.stopPropagation());
    ov.appendChild(card); document.body.appendChild(ov); slugIn.focus();
  }

  buildForm(); updatePreview(); setStatus('Ready');
}
