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

  // a live server (nodejs is installed on this host) so the console has a real
  // process to attach to
  const loginRes = await fetch(BASE + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin' })
  }).then((r) => r.json());
  const apiToken = loginRes.token;
  const apiCall = async (method, path, body) => {
    const res = await fetch(BASE + path, {
      method,
      headers: { Authorization: `Bearer ${apiToken}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined
    });
    return res.json().catch(() => ({}));
  };
  // Leftovers from an interrupted earlier run would keep a port busy and make
  // the fixture die with EADDRINUSE, which looks like a console bug.
  const leftovers = await apiCall('GET', '/api/servers');
  for (const srv of (leftovers.servers || [])) {
    if (!/^Console Load Audit/.test(srv.name || '')) continue;
    await apiCall('POST', `/api/servers/${srv.id}/power`, { action: 'kill' });
    await sleep(700);
    await apiCall('DELETE', `/api/servers/${srv.id}`);
  }
  const made = await apiCall('POST', '/api/servers', {
    name: 'Console Load Audit', user_id: loginRes.user.id, node_id: 1,
    memory_mb: 512, cpu_limit: 100, disk_mb: 1024, server_type: 'nodejs'
  });
  const consoleServerId = made.serverId;
  if (consoleServerId) await apiCall('POST', `/api/servers/${consoleServerId}/power`, { action: 'start' });
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
  /* ---- the console workspace, loaded over HTTP like a real browser ---- */
  console.log('\n--- console workspace ---');
  if (consoleServerId) {
    w.location.hash = `#/server/${consoleServerId}/console`;
    await sleep(3200);
    const view = d.querySelector('#view-inner');
    const grabSel = (sel) => (d.querySelector(sel) || {}).textContent || '';
    ok('console workspace mounts', !!d.querySelector('#con-form') && !!d.querySelector('#con-out'), w.location.hash);
    ok('console renders the server name', new RegExp('Console Load Audit').test(view.textContent || ''));
    ok('console has no unrendered values', !/undefined|NaN|\[object Object\]/.test(view.innerHTML));
    ok('stat cards show measured values', /\d/.test(grabSel('#con-mem-v')) && !/^—$/.test(grabSel('#con-mem-v').trim()),
      `cpu ${grabSel('#con-cpu-v')} · mem ${grabSel('#con-mem-v')} · disk ${grabSel('#con-disk-v')}`);
    ok('uptime is live from the process', /\ds/.test(grabSel('#con-uptime')), grabSel('#con-uptime'));
    ok('telemetry says where it came from', /measured|not measured/.test(grabSel('#con-note')), grabSel('#con-note').slice(0, 70));
    ok('console received the process output', d.querySelectorAll('#con-out .con-line').length > 0,
      `${d.querySelectorAll('#con-out .con-line').length} lines`);

    // filter + only-matches + clear are wired through the live DOM
    d.querySelector('#con-find').click();
    const q = d.querySelector('#con-query');
    q.value = 'DARKONYX';
    q.dispatchEvent(new w.Event('input', { bubbles: true }));
    await sleep(200);
    ok('filter marks matches', d.querySelectorAll('mark.con-hit').length > 0, grabSel('#con-hits'));
    d.querySelector('#con-only').checked = true;
    d.querySelector('#con-only').dispatchEvent(new w.Event('change', { bubbles: true }));
    await sleep(200);
    ok('only-matches narrows the pane', d.querySelectorAll('#con-out .con-line').length < 6 && d.querySelectorAll('#con-out .con-line').length > 0,
      `${d.querySelectorAll('#con-out .con-line').length} lines`);
    d.querySelector('#con-find-close').click();
    d.querySelector('#con-time').click();
    ok('timestamp toggle re-renders lines', d.querySelectorAll('#con-out .con-ts').length > 0);
    d.querySelector('#con-wrap').click();
    ok('wrap toggle changes the pane', d.querySelector('#con-out').classList.contains('nowrap'));
    d.querySelector('#con-clear').click();
    await sleep(150);
    ok('clear empties only the view', d.querySelectorAll('#con-out .con-line').length === 0);

    await apiCall('POST', `/api/servers/${consoleServerId}/power`, { action: 'stop' });
    await sleep(400);
    await apiCall('DELETE', `/api/servers/${consoleServerId}`);
  } else {
    ok('console audit fixture could be created', false, 'server creation failed');
  }

  ok('still no script errors after navigating', realErrors().length === 0, realErrors().slice(0, 3).join(' | ') || 'clean');

  console.log(`\n=== ${pass}/${pass + fail} page-load checks passed ===`);
  process.exit(fail ? 1 : 0);
})();
