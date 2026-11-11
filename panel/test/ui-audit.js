#!/usr/bin/env node
/**
 * DARKONYX PANEL — frontend UI regression harness.
 *
 * Loads the real SPA shell in jsdom, logs in through the actual login form and
 * walks every route, then drives the admin node + server panels and asserts the
 * rendered markup is real (no `undefined`, `NaN` or `[object Object]`) and that
 * bulk actions actually take effect against the API.
 *
 * Requires: a running panel (default http://localhost:3001) and `jsdom`
 * (installed with `npm install --no-save jsdom`).
 *
 *   node test/ui-audit.js
 */
const PATH = require('path');
const fs = require('fs');

const BASE = process.env.BASE || 'http://localhost:3001';
const PANEL = PATH.join(__dirname, '..');

let JSDOM;
try {
  ({ JSDOM } = require('jsdom'));
} catch (e) {
  console.error('jsdom is required: npm install --no-save jsdom');
  process.exit(2);
}

const results = [];
const ok = (label, pass, note = '') => {
  results.push({ label, pass });
  console.log(`${pass ? '\x1b[32m✔\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${label}${note ? ' — ' + note : ''}`);
};

const api = async (method, path, token, body) => {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(BASE + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let data = text;
  try { data = JSON.parse(text); } catch (e) { /* keep text */ }
  return { status: res.status, data };
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  console.log('\n=== DARKONYX UI AUDIT ===\n');

  const login = await api('POST', '/api/auth/login', null, { username: 'admin', password: 'admin' });
  if (login.status !== 200) {
    console.error('Cannot log in as admin/admin — is the panel running on ' + BASE + '?');
    process.exit(1);
  }
  const token = login.data.token;

  // a server so the workspace + admin tables have real rows
  const created = [];
  const mkServer = async (name) => {
    const r = await api('POST', '/api/servers', token, {
      name, user_id: login.data.user.id, node_id: 1, memory_mb: 1024,
      cpu_limit: 100, disk_mb: 1024, server_type: 'minecraft', jar_type: 'paper', jar_version: '1.21.4'
    });
    const id = r.data && r.data.serverId;
    if (id) created.push(id);
    return id;
  };
  const sid = await mkServer('UI Audit A');
  await mkServer('UI Audit B');
  ok('fixtures created', !!sid, `server ${sid}`);

  const dom = new JSDOM(
    fs.readFileSync(PATH.join(PANEL, 'public/index.html'), 'utf8').replace(/<script[^>]*><\/script>/g, ''),
    { url: BASE + '/', runScripts: 'outside-only', pretendToBeVisual: true }
  );
  const { window } = dom;
  const doc = window.document;
  window.fetch = (u, o) => fetch(u.startsWith('http') ? u : BASE + u, o);
  window.WebSocket = class { constructor() { this.readyState = 3; } send() {} close() {} };

  for (const f of ['icons.js', 'core.js', 'auth.js', 'portal.js', 'server.js', 'console.js', 'admin.js', 'market.js', 'admin-extra.js', 'boot.js']) {
    window.eval(fs.readFileSync(PATH.join(PANEL, 'public/js', f), 'utf8'));
  }
  await sleep(400);

  /* ---- login through the real form ---- */
  const form = doc.querySelector('#auth-form');
  form.querySelector('[name=username]').value = 'admin';
  form.querySelector('[name=password]').value = 'admin';
  form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await sleep(1500);
  ok('login form authenticates', !!window.DKX.Store.token);

  /* ---- the router must be live the moment the shell paints ---- */
  ok('router started after login (hashchange listener attached)', window.DKX.Router._started === true);

  {
    const link = doc.querySelector('[data-nav="admin-users"]');
    ok('sidebar exposes nav links', !!link);
    link.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
    await sleep(60);
    const immediate = (doc.querySelector('.rail-item.active') || {}).dataset?.nav;
    ok('sidebar click highlights the destination immediately', immediate === 'admin-users', immediate || 'none');
    await sleep(1300);
    const h1 = (doc.querySelector('#view-inner h1') || {}).textContent || '';
    ok('sidebar click actually renders that page', /users/i.test(h1), h1 || 'nothing');
    ok('route progress bar completes', (() => {
      const bar = doc.querySelector('#route-progress');
      return !!bar && !bar.classList.contains('is-on');
    })());
  }

  /* Navigate exactly like a click does: change the hash and let the router's
     own hashchange listener do the work. Calling resolve() by hand here would
     hide a broken listener (that bug shipped once — see the nav tests below). */
  const go = async (hash, ms = 900) => {
    window.location.hash = '#' + hash;
    await sleep(ms);
    return doc.querySelector('#view-inner');
  };
  const dirty = (html) => {
    const bad = [];
    if (/undefined/.test(html)) bad.push('undefined×' + (html.match(/undefined/g) || []).length);
    if (/>NaN|NaN</.test(html)) bad.push('NaN');
    if (/\[object Object\]/.test(html)) bad.push('objObj');
    return bad;
  };

  /* ---- every route renders clean ---- */
  const routes = [
    '/admin/overview', '/admin/servers', '/admin/users', '/admin/nodes', '/admin/network',
    '/admin/databases', '/admin/backups', '/admin/settings', '/admin/addons', '/admin/social', '/admin/updates',
    '/portal/overview', '/portal/servers', '/portal/activity', '/account', '/marketplace',
    ...['console', 'files', 'players', 'worlds', 'backups', 'schedules', 'network', 'users', 'addons', 'marketplace', 'databases', 'activity', 'settings']
      .map((t) => `/server/${sid}/${t}`),
    '/server/99999/console'
  ];
  let clean = 0;
  for (const r of routes) {
    const v = await go(r);
    const bad = dirty(v.innerHTML);
    if (!bad.length) clean++;
    else console.log(`    ${r.padEnd(24)} ${bad.join(', ')}`);
  }
  ok(`all ${routes.length} routes render clean`, clean === routes.length, `${clean}/${routes.length}`);

  /* ---- admin servers: selection + bulk actions ---- */
  await go('/admin/servers', 1200);
  let html = doc.querySelector('#view-inner').innerHTML;
  ok('servers page has bulk toolbar', /Bulk actions/.test(html));
  ok('servers table has selectable rows', (html.match(/data-sel=/g) || []).length >= 2);
  ok('bulk handlers attached', typeof doc.querySelector('#as-bulk-suspend').onclick === 'function');

  doc.querySelectorAll('[data-sel]').forEach((b) => { b.checked = true; });
  doc.querySelector('#as-bulk-suspend').click();
  await sleep(600);
  const dlg = doc.querySelector('.scrim .modal');
  ok('bulk suspend opens confirm', !!dlg);
  if (dlg && dlg.querySelector('[data-ok]')) {
    dlg.querySelector('[data-ok]').click();
    await sleep(1400);
    const after = await api('GET', '/api/servers', token);
    const ours = (after.data.servers || []).filter((s) => created.includes(s.id));
    ok('bulk suspend took effect', ours.length > 0 && ours.every((s) => s.is_suspended),
      ours.map((s) => s.is_suspended).join(','));
    await api('POST', '/api/admin/servers/bulk-unsuspend', token, { server_ids: created });
  }

  /* ---- node detail: all panels render real data ---- */
  await go('/admin/nodes', 1300);
  html = doc.querySelector('#view-inner').innerHTML;
  ok('node card shows port usage', /ports used/.test(html), (html.match(/(\d+)\/(\d+) ports used/) || [''])[0]);

  const detailBtn = doc.querySelector('[data-nodes-detail]');
  ok('node detail trigger present', !!detailBtn);
  if (detailBtn) {
    detailBtn.click();
    await sleep(1800);
    const modal = doc.querySelector('.scrim .modal');
    ok('node dialog opens', !!modal);
    if (modal) {
      const expect = [
        ['Live stats', 0], ['Wings stats', 4], ['Allocations', 5],
        ['Servers', 6], ['Backups', 7], ['Firewall', 1], ['Service', 2], ['Logs', 3]
      ];
      const tabs = [...modal.querySelectorAll('[data-ndt]')].map((t) => t.textContent.trim());
      ok('all 8 node panels present', tabs.length === 8, tabs.join(' | '));

      for (const [name, ndt] of expect) {
        modal.querySelector(`[data-ndt="${ndt}"]`).click();
        await sleep(800);
        const pane = modal.querySelector(`[data-ndp="${ndt}"]`);
        const txt = (pane.textContent || '').replace(/\s+/g, ' ').trim();
        const bad = dirty(pane.innerHTML);
        ok(`  ${name} panel renders`, txt.length > 25 && !bad.length, bad.length ? bad.join(',') : txt.slice(0, 50));
      }
      ok('  allocations has add-port form', !!modal.querySelector('#nd-al-add'));
      ok('  allocations has clear-unassigned', !!modal.querySelector('#nd-alloc-clear'));
      const x = modal.querySelector('[data-x]'); if (x) x.click();
    }
  }

  /* ---- server workspace: settings danger zone ---- */
  await go(`/server/${sid}/settings`, 1200);
  ok('server settings has toggle-install', !!doc.querySelector('#dz-install'));

  /* ---- cleanup ---- */
  for (const id of created) await api('DELETE', '/api/servers/' + id, token);

  const passed = results.filter((r) => r.pass).length;
  console.log(`\n=== ${passed}/${results.length} UI checks passed ===`);
  if (passed !== results.length) {
    console.log('\nFAILED:');
    results.filter((r) => !r.pass).forEach((r) => console.log('  ' + r.label));
  }
  process.exit(passed === results.length ? 0 : 1);
})();
