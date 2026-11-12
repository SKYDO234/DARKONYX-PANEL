#!/usr/bin/env node
/**
 * DARKONYX PANEL — file manager audit.
 *
 * The Files tab regressed badly: rows rendered nothing in the name column, the
 * rename/delete buttons were unexplained icons, and there was no import path at
 * all. This suite drives the real page against a live panel and fails if any of
 * that comes back:
 *
 *   1. every row shows its file/folder name, size and modified date
 *   2. every row exposes labelled Open/Edit/Download/Rename/Delete actions
 *   3. the editor opens the real file content and saves it back to disk
 *   4. new folder / new file / rename / delete actually change the disk
 *   5. upload writes the real bytes, import-from-URL validates and downloads
 *   6. bulk selection, breadcrumbs and the up button work
 *
 *   node test/files-audit.js
 */
const nodePath = require('path');
const fs = require('fs');

let JSDOM;
try { ({ JSDOM } = require('jsdom')); } catch (e) {
  console.error('jsdom is required: npm install --no-save jsdom');
  process.exit(2);
}

const PANEL = nodePath.join(__dirname, '..');
const BASE = process.env.BASE || 'http://localhost:3001';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const ok = (label, good, note = '') => {
  if (good) { pass++; console.log(`\x1b[32m✔\x1b[0m ${label}${note ? ' — ' + note : ''}`); }
  else { fail++; console.log(`\x1b[31m✗\x1b[0m ${label}${note ? ' — ' + note : ''}`); }
};

const api = async (method, url, token, body) => {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(BASE + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let data = text;
  try { data = JSON.parse(text); } catch (e) { /* raw */ }
  return { status: res.status, data };
};

(async () => {
  console.log('\n=== DARKONYX FILE MANAGER AUDIT ===\n');

  const login = await api('POST', '/api/auth/login', null, { username: 'admin', password: 'admin' });
  if (login.status !== 200) {
    console.error(`Cannot log in as admin/admin — is the panel running on ${BASE}?`);
    process.exit(1);
  }
  const token = login.data.token;

  const forced = process.env.SERVER_ID;
  let sid = forced ? Number(forced) : null;
  if (!sid) {
    const made = await api('POST', '/api/servers', token, {
      name: 'Files Audit', user_id: login.data.user.id, node_id: 1,
      memory_mb: 1024, cpu_limit: 100, disk_mb: 2048, server_type: 'minecraft'
    });
    sid = made.data.serverId;
  }
  if (!sid) { console.error('Could not create a fixture server.'); process.exit(1); }
  const root = nodePath.join(PANEL, 'storage', 'servers', `server${sid}`);
  console.log(`fixture server ${sid} → ${nodePath.relative(PANEL, root)}\n`);

  // seed known content
  await api('POST', `/api/servers/${sid}/files/directory`, token, { dirPath: 'plugins' });
  await api('POST', `/api/servers/${sid}/files/content`, token, { filePath: 'audit.properties', content: 'motd=original\n' });

  const dom = new JSDOM(fs.readFileSync(nodePath.join(PANEL, 'public/index.html'), 'utf8').replace(/<script[^>]*><\/script>/g, ''), {
    url: `${BASE}/`, runScripts: 'outside-only', pretendToBeVisual: true
  });
  const w = dom.window, d = w.document;
  w.fetch = (u, o) => fetch(String(u).startsWith('http') ? u : BASE + String(u), o);
  w.WebSocket = class { constructor() { this.readyState = 3; } send() {} close() {} };
  w.URL.createObjectURL = () => 'blob:audit';
  w.URL.revokeObjectURL = () => {};
  const errors = [];
  w.addEventListener('error', (e) => errors.push('err ' + e.message));
  w.addEventListener('unhandledrejection', (e) => errors.push('rej ' + ((e.reason && e.reason.message) || e.reason)));
  console.error = (...a) => errors.push('console.error ' + a.map(String).join(' ').slice(0, 180));

  for (const f of ['icons.js', 'core.js', 'auth.js', 'portal.js', 'server.js', 'console.js', 'admin.js', 'market.js', 'admin-extra.js', 'boot.js'])
    w.eval(fs.readFileSync(nodePath.join(PANEL, 'public/js', f), 'utf8'));
  await sleep(350);

  const form = d.querySelector('#auth-form');
  form.querySelector('[name=username]').value = 'admin';
  form.querySelector('[name=password]').value = 'admin';
  form.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
  await sleep(1800);

  await w.DKX.Router.go(`/server/${sid}/files`);
  await sleep(1600);
  const view = d.querySelector('#view-inner');
  const rowInfo = () => [...view.querySelectorAll('.fm-row')].map((r) => ({
    name: (r.querySelector('.fm-label') || {}).textContent || '',
    size: (r.querySelector('.fm-size') || {}).textContent || '',
    date: (r.querySelector('.fm-date') || {}).textContent || '',
    dir: r.dataset.dir === '1',
    actions: [...r.querySelectorAll('.fm-actions button')].map((b) => (b.getAttribute('title') || b.textContent || '').trim())
  }));

  /* ------------------------------------------------ 1. names are visible */
  console.log('--- rendering ---');
  let rows = rowInfo();
  ok('the file list renders rows', rows.length >= 2, `${rows.length} rows`);
  ok('every row shows its name', rows.length > 0 && rows.every((r) => r.name.trim().length > 0),
    rows.map((r) => r.name).join(', '));
  ok('folders are marked as folders', rows.some((r) => r.dir && r.name === 'plugins'));
  ok('files show a size', rows.filter((r) => !r.dir).every((r) => /\d/.test(r.size)),
    rows.filter((r) => !r.dir).map((r) => r.size).join(' '));
  ok('rows show a modified date or an explicit dash', rows.every((r) => r.date.trim().length > 0));
  ok('the folder footer reports real counts', /item/.test(view.querySelector('#fm-foot').textContent),
    view.querySelector('#fm-foot').textContent);

  /* ------------------------------------------ 2. labelled row actions */
  console.log('\n--- actions ---');
  const fileRow = rows.find((r) => !r.dir);
  ok('files offer Edit and Download', !!fileRow && /Edit/.test(fileRow.actions.join(' ')) && /Download/.test(fileRow.actions.join(' ')),
    fileRow && fileRow.actions.join(' / '));
  ok('every row offers Rename and Delete', rows.every((r) => /Rename/i.test(r.actions.join(' ')) && /Delete/.test(r.actions.join(' '))));
  ok('folders offer Open instead of Edit', rows.filter((r) => r.dir).every((r) => /Open/.test(r.actions.join(' '))));
  ok('the toolbar offers New file / New folder / Upload / Import',
    ['#fm-new-file', '#fm-new-dir', '#fm-upload', '#fm-import'].every((sel) => !!view.querySelector(sel)));

  /* ------------------------------------------------ 3. editor round-trip */
  console.log('\n--- editor ---');
  [...view.querySelectorAll('[data-edit]')].find((b) => b.dataset.edit === 'audit.properties').click();
  await sleep(900);
  const modal = d.querySelector('#modal-root .modal');
  ok('the editor opens', !!modal);
  const ta = modal.querySelector('#fm-editor');
  ok('the editor loads the real file content', ta && ta.value === 'motd=original\n', JSON.stringify(ta && ta.value));
  ta.value = 'motd=edited-by-audit\n';
  ta.dispatchEvent(new w.Event('input'));
  ok('the editor reports unsaved changes', /unsaved/.test(modal.querySelector('#fm-ed-state').textContent));
  modal.querySelector('[data-save]').click();
  await sleep(1400);
  const onDisk = fs.readFileSync(nodePath.join(root, 'audit.properties'), 'utf8');
  ok('saving writes the file to disk', onDisk === 'motd=edited-by-audit\n', JSON.stringify(onDisk));
  ok('the editor closes after a successful save', !d.querySelector('#modal-root .modal'));

  /* ------------------------------------------------ 4. create / rename / delete */
  console.log('\n--- create, rename, delete ---');
  view.querySelector('#fm-new-dir').click();
  await sleep(500);
  let dlg = d.querySelector('#modal-root .modal');
  dlg.querySelector('input').value = 'audit-folder';
  dlg.querySelector('[data-ok]').click();
  await sleep(1500);
  ok('New folder creates a real directory', fs.existsSync(nodePath.join(root, 'audit-folder')));

  view.querySelector('#fm-new-file').click();
  await sleep(500);
  dlg = d.querySelector('#modal-root .modal');
  dlg.querySelector('input').value = 'audit-created.txt';
  dlg.querySelector('[data-ok]').click();
  await sleep(1500);
  ok('New file creates a real file', fs.existsSync(nodePath.join(root, 'audit-created.txt')));

  [...view.querySelectorAll('[data-ren]')].find((b) => b.dataset.ren === 'audit-created.txt').click();
  await sleep(600);
  dlg = d.querySelector('#modal-root .modal');
  ok('the rename dialog is prefilled with the current name', dlg.querySelector('input').value === 'audit-created.txt');
  dlg.querySelector('input').value = 'audit-renamed.txt';
  dlg.querySelector('[data-ok]').click();
  await sleep(1600);
  ok('rename moves the file on disk',
    !fs.existsSync(nodePath.join(root, 'audit-created.txt')) && fs.existsSync(nodePath.join(root, 'audit-renamed.txt')));
  ok('the list shows the new name without a manual reload',
    rowInfo().some((r) => r.name === 'audit-renamed.txt'));

  [...view.querySelectorAll('[data-del]')].find((b) => b.dataset.del === 'audit-renamed.txt').click();
  await sleep(600);
  dlg = d.querySelector('#modal-root .modal');
  ok('delete asks for confirmation by name', /audit-renamed\.txt/.test(dlg.textContent));
  dlg.querySelector('[data-ok]').click();
  await sleep(1600);
  ok('delete removes the file from disk', !fs.existsSync(nodePath.join(root, 'audit-renamed.txt')));
  ok('the row disappears from the list', !rowInfo().some((r) => r.name === 'audit-renamed.txt'));

  /* ------------------------------------------------ 5. upload + import */
  console.log('\n--- upload + import ---');
  const payload = 'uploaded-by-audit';
  const uploaded = await (async () => {
    const fd = new FormData();
    fd.append('file', new Blob([payload]), 'audit-upload.bin');
    const res = await fetch(`${BASE}/api/servers/${sid}/files/upload?directory=`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: fd
    });
    return res.json();
  })();
  ok('upload answers with the stored name', uploaded.success && uploaded.fileName === 'audit-upload.bin', JSON.stringify(uploaded));
  const uploadedPath = nodePath.join(root, 'audit-upload.bin');
  ok('upload writes the real bytes', fs.existsSync(uploadedPath) && fs.readFileSync(uploadedPath, 'utf8') === payload);

  view.querySelector('#fm-import').click();
  await sleep(500);
  dlg = d.querySelector('#modal-root .modal');
  ok('the import dialog opens with a URL field', !!dlg.querySelector('#fm-url'));
  dlg.querySelector('#fm-url').value = 'file:///etc/passwd';
  dlg.querySelector('#fm-url-check').click();
  await sleep(700);
  ok('a non-http link is rejected', /http/i.test(dlg.querySelector('#fm-url-info').textContent),
    dlg.querySelector('#fm-url-info').textContent.slice(0, 48));
  dlg.querySelector('#fm-url').value = `${BASE}/assets/darkonyx/favicon.svg`;
  dlg.querySelector('#fm-url-check').click();
  await sleep(1200);
  const info = dlg.querySelector('#fm-url-info').textContent;
  ok('a reachable link is inspected with a real size', /\d/.test(info) && /svg/i.test(info), info.slice(0, 60));
  dlg.querySelector('#fm-url-name').value = 'audit-import.svg';
  dlg.querySelector('#fm-url-go').click();
  await sleep(2500);
  const importedPath = nodePath.join(root, 'audit-import.svg');
  ok('import downloads a real file', fs.existsSync(importedPath) && fs.statSync(importedPath).size > 100,
    fs.existsSync(importedPath) ? `${fs.statSync(importedPath).size} bytes` : 'missing');

  const failedImport = await api('POST', `/api/servers/${sid}/files/pull-url`, token, {
    url: 'http://127.0.0.1:9/nope.jar', directory: '', filename: 'audit-bad.jar'
  });
  ok('a failed import returns a real error and leaves no file',
    failedImport.data.success === false && !fs.existsSync(nodePath.join(root, 'audit-bad.jar')) && !fs.existsSync(nodePath.join(root, 'audit-bad.jar.part')),
    String(failedImport.data.error).slice(0, 60));

  /* ------------------------------------------------ 6. bulk + navigation */
  console.log('\n--- selection + navigation ---');
  const all = view.querySelector('#fm-all');
  all.checked = true;
  all.dispatchEvent(new w.Event('change'));
  await sleep(200);
  ok('select-all opens the bulk bar', !view.querySelector('#fm-bulk').hidden);
  ok('select-all counts every row', view.querySelector('#fm-bulk-n').textContent === `${rowInfo().length} selected`,
    view.querySelector('#fm-bulk-n').textContent);
  view.querySelector('#fm-bulk-clear').click();
  await sleep(200);
  ok('clearing the selection hides the bulk bar', view.querySelector('#fm-bulk').hidden);

  const dirRow = [...view.querySelectorAll('.fm-row')].find((r) => r.dataset.name === 'plugins');
  dirRow.querySelector('[data-open]').click();
  await sleep(1200);
  ok('Open navigates into the folder', /\/plugins/.test(view.querySelector('#fm-foot').textContent),
    view.querySelector('#fm-foot').textContent);
  ok('the up button becomes available', !view.querySelector('#fm-up').disabled);
  view.querySelector('#fm-up').click();
  await sleep(1200);
  ok('the up button returns to the parent', /^root/.test(view.querySelector('#fm-foot').textContent),
    view.querySelector('#fm-foot').textContent);
  ok('breadcrumbs lead back to the root', !!view.querySelector('#fm-crumbs [data-crumb=""]'));

  ok('the page ran without JS errors', errors.length === 0, errors.slice(0, 3).join(' | ') || 'clean');
  ok('no unrendered values in the markup', !/undefined|NaN|\[object Object\]/.test(view.innerHTML));

  // cleanup
  if (!forced) {
    await api('DELETE', `/api/servers/${sid}`, token);
  } else {
    for (const n of ['audit.properties', 'audit-upload.bin', 'audit-import.svg', 'audit-folder']) {
      await api('POST', `/api/servers/${sid}/files/delete`, token, { itemPath: n });
    }
  }

  console.log(`\n=== ${pass}/${pass + fail} file manager checks passed ===`);
  if (fail) console.log(`\n${fail} check(s) failed.`);
  process.exit(fail ? 1 : 0);
})();
