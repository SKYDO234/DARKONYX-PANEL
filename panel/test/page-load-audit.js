#!/usr/bin/env node
/**
 * DARKONYX PANEL — real page-load audit.
 *
 * Unlike ui-audit.js (which evals the bundles by hand) this loads the panel
 * over HTTP and lets jsdom execute the real <script src> tags in document
 * order, with no injected shortcuts. It is the closest thing to a browser we
 * can run in CI: if a script fails to parse, 404s, or the boot order breaks,
 * this test fails instead of the user finding out.
 *
 *   node test/page-load-audit.js
 */
/* Load the page over HTTP exactly like a browser: let jsdom fetch and RUN the
   real <script src> tags, instead of eval'ing files by hand. */
const { JSDOM, VirtualConsole } = require('jsdom');
const BASE = 'http://localhost:3001';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const vc = new VirtualConsole();
  const logs = [];
  vc.on('jsdomError', (e) => logs.push('JSDOMERR ' + e.message));
  vc.on('error', (...a) => logs.push('console.error ' + a.join(' ').slice(0, 200)));
  const dom = await JSDOM.fromURL(BASE + '/', {
    runScripts: 'dangerously',
    resources: 'usable',
    pretendToBeVisual: true,
    virtualConsole: vc
  });
  const w = dom.window, d = w.document;
  w.fetch = (u, o) => fetch(String(u).startsWith('http') ? u : BASE + u, o);
  w.WebSocket = class { constructor() { this.readyState = 3; } send() {} close() {} };
  await new Promise((r) => w.addEventListener('load', r, { once: true }));
  await sleep(2500);

  let pass = 0, fail = 0;
  const ok = (label, good, note = '') => {
    if (good) { pass++; console.log(`\x1b[32m✔\x1b[0m ${label}${note ? ' — ' + note : ''}`); }
    else { fail++; console.log(`\x1b[31m✗\x1b[0m ${label}${note ? ' — ' + note : ''}`); }
  };
  const fontNoise = (m) => /fonts\.googleapis/.test(m);
  const realErrors = () => logs.filter((m) => !fontNoise(m));

  ok('every script tag executed', ['DKX', 'I', 'el', 'Auth'].every((k) => typeof w[k] !== 'undefined'),
    ['DKX', 'I', 'el', 'Auth'].map((k) => k + '=' + typeof w[k]).join(' '));
  ok('no script errors beyond the blocked webfont', realErrors().length === 0, realErrors().slice(0, 3).join(' | ') || 'clean');
  ok('page carries a build id', !!d.querySelector('meta[name="dkx-build"]'), (d.querySelector('meta[name="dkx-build"]') || {}).content);
  const versioned = [...d.querySelectorAll('script[src]')].every((s2) => /\?v=/.test(s2.src));
  ok('asset URLs are cache-busted', versioned);
  ok('login form renders', !!d.querySelector('#auth-form'));

  const form = d.querySelector('#auth-form');
  if (form) {
    form.querySelector('[name=username]').value = 'admin';
    form.querySelector('[name=password]').value = 'admin';
    form.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
    await sleep(2500);
    ok('signed in through the form', !!w.DKX.Store.token, w.location.hash);
    ok('router started on the login path', w.DKX.Router._started === true);
    ok('dashboard rendered', /command center/i.test((d.querySelector('#view-inner h1') || {}).textContent || ''),
      (d.querySelector('#view-inner h1') || {}).textContent);

    // click every sidebar entry the way a user would and require a real page
    const links = [...d.querySelectorAll('.rail-item')];
    ok('sidebar links exist', links.length >= 5, `${links.length} links`);
    let navigated = 0;
    for (const link of links.slice(0, 6)) {
      const before = w.location.hash;
      link.dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
      await sleep(900);
      const h1 = (d.querySelector('#view-inner h1') || {}).textContent || '';
      if (w.location.hash !== before && h1 && !/could not load/i.test(h1)) navigated++;
    }
    ok('every sidebar click renders its page', navigated === Math.min(6, links.length), `${navigated}/${Math.min(6, links.length)}`);

    // stale-build detection: pretend the server moved on
    const same = await w.DKX_checkBuild(false);
    ok('build check agrees with the server', same === true, 'no spurious reload');

    // simulate an old tab: pass a build id that cannot match the server
    const mismatch = await w.DKX_checkBuild(false, 'deadbeef00');
    ok('stale build is detected', mismatch === false, 'would have reloaded');
  }
  ok('still no script errors after navigating', realErrors().length === 0, realErrors().slice(0, 3).join(' | ') || 'clean');

  console.log(`\n=== ${pass}/${pass + fail} page-load checks passed ===`);
  process.exit(fail ? 1 : 0);
})();
