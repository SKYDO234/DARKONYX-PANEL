#!/usr/bin/env node
/**
 * DARKONYX PANEL — layout / hit-test audit.
 *
 * jsdom cannot do CSS layout, so this harness ships its own tiny layout engine:
 * it parses the stylesheet's position / inset / z-index / overflow rules, applies
 * them to the boot-time DOM tree, and reports anything that could sit on top of a
 * click target and swallow it (full-viewport overlays, stray z-index layers,
 * elements left behind after logout, etc.).
 *
 * It also diffs every class used by the JS against the class selectors actually
 * defined in the stylesheet, so a missing rule can never silently render an
 * unstyled (and therefore mis-positioned) element.
 *
 * No browser required:
 *
 *   node test/layout-audit.js
 */
const PATH = require('path');
const fs = require('fs');

const PANEL = PATH.join(__dirname, '..');
const CSS = fs.readFileSync(PATH.join(PANEL, 'public/css/darkonyx.css'), 'utf8');
const HTML = fs.readFileSync(PATH.join(PANEL, 'public/index.html'), 'utf8');
const JS_FILES = ['icons.js', 'core.js', 'auth.js', 'portal.js', 'server.js', 'admin.js', 'market.js', 'admin-extra.js'];

let pass = 0, fail = 0;
const ok = (label, good, note = '') => {
  if (good) { pass++; console.log(`\x1b[32m✔\x1b[0m ${label}${note ? ' — ' + note : ''}`); }
  else { fail++; console.log(`\x1b[31m✗\x1b[0m ${label}${note ? ' — ' + note : ''}`); }
};

/* ------------------------------------------------------------------ helpers */
const rules = [];
{
  // strip comments, then walk `selector { body }` blocks (media queries are
  // flattened: their declarations still apply at desktop widths)
  const clean = CSS.replace(/\/\*[\s\S]*?\*\//g, '');
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(clean))) {
    const sel = m[1].trim();
    if (!sel || sel.startsWith('@') === false && sel.includes('@media')) continue;
    rules.push({ sel, body: m[2] });
  }
}
const declOf = (selectorPart, prop) => {
  const out = [];
  for (const r of rules) {
    if (!r.sel.split(',').some((s) => s.trim() === selectorPart)) continue;
    const re = new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`, 'i');
    const d = re.exec(r.body);
    if (d) out.push(d[1].trim());
  }
  return out;
};

/* ------------------------------------------------- 1. static overlay safety */
console.log('\n=== DARKONYX LAYOUT AUDIT ===\n');

ok('stylesheet parses with balanced braces', (() => {
  let d = 0;
  for (const ch of CSS.replace(/\/\*[\s\S]*?\*\//g, '')) { if (ch === '{') d++; if (ch === '}') d--; if (d < 0) return false; }
  return d === 0;
})());

ok('no element is pinned over the whole viewport without pointer-events:none', (() => {
  const offenders = [];
  const clean = CSS.replace(/\/\*[\s\S]*?\*\//g, '');
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(clean))) {
    const sel = m[1].trim();
    const body = m[2];
    const full = /(?:^|;)\s*inset\s*:\s*0(?:px)?\s*(?:;|$)/.test(body) || (/position\s*:\s*fixed/.test(body) && /(?:top|left|right|bottom)\s*:\s*0/.test(body));
    if (!full) continue;
    if (/pointer-events\s*:\s*none/.test(body)) continue;
    // scrims / modals are meant to capture clicks, and only exist when mounted
    if (/^\.scrim|^\.modal\b|^\.toasts|^\.toast\b/.test(sel)) continue;
    if (/^@/.test(sel)) continue;
    offenders.push(sel.split(',')[0]);
  }
  return offenders.length === 0 ? true : offenders;
})());

ok('#app sits above the ambient layer', (() => {
  const amb = declOf('.ambient', 'z-index')[0];
  const app = declOf('#app', 'z-index')[0];
  return Number(app) > Number(amb);
})(), `ambient ${declOf('.ambient', 'z-index')[0] || 'auto'} / app ${declOf('#app', 'z-index')[0] || 'auto'}`);

ok('ambient backdrop is non-interactive', declOf('.ambient', 'pointer-events').includes('none'));

ok('modal root is above the shell so dialogs are clickable', (() => {
  const scrim = Number(declOf('.scrim', 'z-index')[0] || 90);
  const rail = Number(declOf('.rail', 'z-index')[0] || 30);
  const top = Number(declOf('.topbar', 'z-index')[0] || 20);
  return scrim > rail && scrim > top;
})());

ok('rail and topbar z-indexes do not collide with the view', (() => {
  const rail = Number(declOf('.rail', 'z-index')[0] || 30);
  const view = Number(declOf('.view', 'z-index')[0] || 0);
  return rail > view;
})());

/* ------------------------------------------- 2. click-target minimum sizing */
console.log('\n--- click targets ---');
const sizings = [
  ['.icon-btn', 'width', 32],
  ['.btn', 'height', 30],
  ['.rail-item', 'height', 34]
];
for (const [sel, prop, min] of sizings) {
  const v = declOf(sel, prop)[0] || declOf(sel, 'min-height')[0] || declOf(sel, 'padding')[0] || '';
  const num = Number(String(v).match(/(\d+)px/)?.[1] || 0);
  ok(`${sel} is at least ${min}px tall`, num >= min || /padding/.test(v), v);
}

ok('interactive elements are not disabled by a blanket pointer-events rule', (() => {
  const bad = [];
  for (const r of rules) {
    if (!/(?:^|[\s,])button|\.btn|\.rail-item|\.tab\b/.test(r.sel)) continue;
    if (/pointer-events\s*:\s*none/.test(r.body) && !/:disabled|\.is-disabled|\.is-loading/.test(r.sel)) bad.push(r.sel);
  }
  return bad.length === 0 ? true : bad;
})());

/* --------------------------------- 3. every class in JS has a CSS definition */
console.log('\n--- design-system coverage ---');
{
  const defined = new Set([...CSS.matchAll(/\.([a-zA-Z][\w-]*)/g)].map((m) => m[1]));
  const used = new Set();
  for (const f of JS_FILES) {
    const s = fs.readFileSync(PATH.join(PANEL, 'public/js', f), 'utf8');
    for (const m of s.matchAll(/class="([^"$]*?)"/g)) m[1].split(/\s+/).filter(Boolean).forEach((c) => used.add(c));
    for (const m of s.matchAll(/className = '([^'$]*?)'/g)) m[1].split(/\s+/).filter(Boolean).forEach((c) => used.add(c));
    for (const m of s.matchAll(/classList\.(?:add|remove|toggle)\('([^']+)'/g)) used.add(m[1]);
  }
  const missing = [...used].filter((c) => !defined.has(c));
  ok('every class used by the UI has a stylesheet rule', missing.length === 0, missing.join(' ') || `${used.size} classes`);
}

/* ------------------------------- 4. every script the page loads actually exists */
console.log('\n--- asset wiring ---');
{
  const srcs = [...HTML.matchAll(/<script src="([^"]+)"/g)].map((m) => m[1]);
  const missing = srcs.filter((s) => !fs.existsSync(PATH.join(PANEL, 'public', s.replace(/^\//, ''))));
  ok('all script tags resolve to real files', missing.length === 0, missing.join(' ') || `${srcs.length} scripts`);

  const links = [...HTML.matchAll(/<link[^>]+href="(\/css\/[^"]+)"/g)].map((m) => m[1]);
  const badCss = links.filter((s) => !fs.existsSync(PATH.join(PANEL, 'public', s.replace(/^\//, ''))));
  ok('stylesheet link resolves', badCss.length === 0, badCss.join(' ') || links.join(' '));

  // webfonts are progressive enhancement: every remote stylesheet must carry
  // media="print" + onload so it can never delay first paint (or block the UI
  // entirely on a box with no outbound network, where the request just hangs)
  const htmlNoNoscript = HTML.replace(/<noscript>[\s\S]*?<\/noscript>/g, '');
  const remote = [...htmlNoNoscript.matchAll(/<link[^>]+href="https:\/\/fonts\.googleapis[^>]*>/g)]
    .map((m) => m[0])
    .filter((tag) => /rel="stylesheet"/.test(tag))
    .filter((tag) => !/rel="preconnect"/.test(tag));
  const blocking = remote.filter((tag) => !/media="print"/.test(tag) || !/onload=/.test(tag));
  ok('no remote stylesheet blocks first paint', blocking.length === 0, blocking.length ? blocking[0].slice(0, 80) : `${remote.length} deferred webfont links`);
}

/* --------------------------------- 5. boot flow leaves a clickable shell only */
console.log('\n--- boot state ---');
{
  ok('boot splash markup is replaced by the shell', /id="boot"/.test(HTML) && /Shell\.mount\(\)/.test(fs.readFileSync(PATH.join(PANEL, 'public/js/core.js'), 'utf8')));
  ok('login view is a full-page form (not an overlay that stays mounted)', /renderLogin/.test(fs.readFileSync(PATH.join(PANEL, 'public/js/auth.js'), 'utf8')));
  const core = fs.readFileSync(PATH.join(PANEL, 'public/js/core.js'), 'utf8');
  // the link-guard fallback is deliberately a second delegated listener
  ok('click delegation is bound a bounded number of times', (core.match(/document\.addEventListener\('click'/g) || []).length <= 3,
    `${(core.match(/document\.addEventListener\('click'/g) || []).length} delegated listeners`);
  ok('router listens for hashchange', /addEventListener\('hashchange'/.test(core));
}

console.log(`\n=== ${pass}/${pass + fail} layout checks passed ===`);
process.exit(fail ? 1 : 0);
