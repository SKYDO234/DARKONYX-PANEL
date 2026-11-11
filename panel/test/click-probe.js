#!/usr/bin/env node
/**
 * DARKONYX PANEL — click probe.
 * Walks every route and clicks every button/link/tab in the rendered view,
 * recording JS errors, unhandled rejections and "click that did nothing".
 */
const PATH = require('path'), fs = require('fs');
let JSDOM; try { ({ JSDOM } = require('jsdom')); } catch (e) { console.error('npm install --no-save jsdom'); process.exit(2); }
const BASE = process.env.BASE || 'http://localhost:3001';
const PANEL = PATH.join(__dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const login = await (await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'admin' }) })).json();
  const token = login.token;
  const mk = async (n) => (await (await fetch(BASE + '/api/servers', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: JSON.stringify({ name: n, user_id: login.user.id, node_id: 1, memory_mb: 1024, cpu_limit: 100, disk_mb: 1024, server_type: 'minecraft', jar_type: 'paper' }) })).json()).serverId;
  const sid = await mk('Click Probe');

  const dom = new JSDOM(fs.readFileSync(PANEL + '/public/index.html', 'utf8').replace(/<script[^>]*><\/script>/g, ''), { url: BASE + '/', runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window, d = w.document;
  w.fetch = (u, o) => fetch(u.startsWith('http') ? u : BASE + u, o);
  w.WebSocket = class { constructor() { this.readyState = 3; } send() {} close() {} };
  const errors = [];
  w.addEventListener('error', (e) => errors.push('window.error: ' + e.message));
  w.addEventListener('unhandledrejection', (e) => errors.push('rejection: ' + ((e.reason && e.reason.message) || e.reason)));
  const origErr = console.error; console.error = (...a) => { errors.push('console.error: ' + a.map(String).join(' ').slice(0, 160)); };

  for (const f of ['icons.js', 'core.js', 'auth.js', 'portal.js', 'server.js', 'console.js', 'admin.js', 'market.js', 'admin-extra.js', 'boot.js'])
    w.eval(fs.readFileSync(PANEL + '/public/js/' + f, 'utf8'));
  await sleep(300);
  const form = d.querySelector('#auth-form');
  form.querySelector('[name=username]').value = 'admin';
  form.querySelector('[name=password]').value = 'admin';
  form.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
  await sleep(1600);

  const routes = ['/admin/overview', '/admin/servers', '/admin/users', '/admin/nodes', '/admin/network', '/admin/databases', '/admin/backups', '/admin/settings', '/admin/addons', '/admin/social', '/admin/updates', '/portal/overview', '/portal/servers', '/portal/activity', '/account', '/marketplace',
    ...['console', 'files', 'players', 'worlds', 'backups', 'schedules', 'network', 'users', 'addons', 'marketplace', 'databases', 'activity', 'settings'].map((t) => `/server/${sid}/${t}`)];

  const problems = [];
  for (const r of routes) {
    await w.DKX.Router.go(r); await sleep(1100);
    const before = errors.length;
    const view = d.querySelector('#view-inner');
    if (!view) { problems.push([r, 'no view']); continue; }
    // disabled controls are meant to be inert (no server selected, no rows, etc.)
    const targets = [...view.querySelectorAll('button, a[href^="#"], [role=tab], .tab, .chip-btn, [data-nav]')]
      .filter((el) => !el.disabled && !el.classList.contains('is-disabled'))
      .slice(0, 40);
    for (const el of targets) {
      const label = (el.textContent || el.id || el.tagName).trim().slice(0, 34).replace(/\s+/g, ' ');
      if (/^(delete|remove|wipe|kill|reboot)/i.test(label)) continue; // destructive/dialog-driven
      const h0 = w.location.hash;
      const inner0 = (d.querySelector('#view-inner') || {}).innerHTML || '';
      // a re-render that produces identical markup is still a response, so watch
      // the DOM instead of comparing HTML strings
      let mutations = 0;
      const mo = new w.MutationObserver((recs) => { mutations += recs.length; });
      const viewEl = d.querySelector('#view-inner');
      if (viewEl) mo.observe(viewEl, { subtree: true, childList: true, characterData: true });
      const mod0 = d.querySelectorAll('#modal-root > *').length;
      const toasts0 = d.querySelectorAll('#toast-root > *').length;
      try { el.click(); } catch (e) { problems.push([r, label, 'THREW ' + e.message]); continue; }
      await sleep(260);
      const newErr = errors.slice(before);
      if (newErr.length) problems.push([r, label, newErr[newErr.length - 1]]);
      const modalOpened = d.querySelectorAll('#modal-root > *').length > mod0;
      // a toast (success, validation error, "nothing to do") is a real response
      const toastShown = d.querySelectorAll('#toast-root > *').length > toasts0;
      // close any modal we opened
      const x = d.querySelector('#modal-root [data-x], #modal-root [data-cancel]');
      if (x) x.click();
      await sleep(60);
      const h1 = w.location.hash;
      const inner1 = (d.querySelector('#view-inner') || {}).innerHTML || '';
      mo.disconnect();
      if (h0 === h1 && inner0 === inner1 && !modalOpened && !toastShown && mutations === 0)
        problems.push([r, label, 'NO-OP (no nav, no modal, no repaint)']);
    }
  }
  console.log('\n### problems by route ###');
  const grouped = {};
  for (const [r, l, m] of problems) (grouped[r] = grouped[r] || []).push(`${l} :: ${m}`);
  for (const [r, list] of Object.entries(grouped)) console.log(`\n${r}\n  ` + list.slice(0, 12).join('\n  '));
  console.log('\ntotal problems:', problems.length);
  if (sid) await fetch(BASE + '/api/servers/' + sid, { method: 'DELETE', headers: { Authorization: 'Bearer ' + token } });
  process.exit(0);
})();
