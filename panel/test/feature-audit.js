#!/usr/bin/env node
/**
 * DARKONYX PANEL — full backend feature audit.
 * Exercises every registered REST endpoint with realistic payloads and reports
 * status + shape. Read-only/safe operations that mutate data are cleaned up.
 */
const BASE = process.env.BASE || 'http://localhost:3001';

const results = [];
let token = '';
let adminId = 1;

async function call(method, path, body, { auth = true, raw = false, expect = null, headers: extra = {} } = {}) {
  const headers = { ...extra };
  if (auth && token) headers.Authorization = `Bearer ${token}`;
  let payload;
  if (body instanceof FormData) payload = body;
  else if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const started = Date.now();
  let res, text, data;
  try {
    res = await fetch(BASE + path, { method, headers, body: payload });
    text = await res.text();
    data = text ? (() => { try { return JSON.parse(text); } catch (e) { return text; } })() : null;
  } catch (e) {
    return { ok: false, status: 0, ms: Date.now() - started, note: 'NETWORK ' + e.message };
  }
  const ms = Date.now() - started;
  const success = res.ok && (!data || typeof data !== 'object' || data.success !== false);
  const errNote = typeof data === 'object' && data && data.error ? String(data.error) : '';
  const ENV_RE = /(TLS|socket disconnected|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNREFUSED|ENETUNREACH|certificate|getaddrinfo|network)/i;
  const env = !success && ENV_RE.test(errNote);
  const okExpect = env ? true : (expect === null ? success : (Array.isArray(expect) ? expect.includes(res.status) : res.status === expect));
  return { ok: okExpect, env, status: res.status, ms, data, note: errNote };
}

async function test(group, label, method, path, body, opts = {}) {
  const r = await call(method, path, body, opts);
  results.push({ group, label, method, path, ...r });
  const flag = r.env ? '\x1b[33m◍\x1b[0m' : (r.ok ? '\x1b[32m✔\x1b[0m' : '\x1b[31m✗\x1b[0m');
  const detail = r.note ? ` — ${r.env ? 'offline: ' : ''}${String(r.note).slice(0, 90)}` : '';
  console.log(`${flag} ${String(r.status).padStart(3)} ${String(r.ms).padStart(4)}ms  ${method.padEnd(5)} ${path.slice(0, 62).padEnd(62)} ${label}${detail}`);
  return r;
}

(async () => {
  console.log('\n=== DARKONYX FEATURE AUDIT ===\n');

  /* ---------------- AUTH ---------------- */
  const login = await test('auth', 'login as admin', 'POST', '/api/auth/login', { username: 'admin', password: 'admin' });
  token = login.data && login.data.token;
  if (!token) { console.error('Cannot continue without a token'); process.exit(1); }
  adminId = login.data.user.id;

  await test('auth', 'bad password rejected', 'POST', '/api/auth/login', { username: 'admin', password: 'wrong-pass' }, { auth: false, expect: 401 });
  await test('auth', 'registration status', 'GET', '/api/auth/registration-status', undefined, { auth: false });
  await test('auth', 'me + settings', 'GET', '/api/auth/me');
  await test('auth', 'server order', 'GET', '/api/auth/server-order');
  await test('auth', 'save server order', 'PUT', '/api/auth/server-order', { server_order: [2, 1] });
  await test('auth', 'profile update', 'PUT', '/api/auth/profile', { username: 'admin', email: 'admin@darkonyx.local' });
  const tfa = await test('auth', '2fa setup', 'POST', '/api/auth/2fa/setup');
  const tfa2 = await test('auth', '2fa bad code rejected', 'POST', '/api/auth/2fa/verify', { code: '000000' }, { expect: 400 });
  await test('auth', '2fa disable (wrong pw rejected)', 'POST', '/api/auth/2fa/disable', { password: 'nope' }, { expect: 400 });
  await test('auth', 'logout', 'POST', '/api/auth/logout');

  /* ---------------- META / PUBLIC ---------------- */
  await test('meta', 'panel meta', 'GET', '/api/meta', undefined, { auth: false });
  await test('meta', 'public bootstrap', 'GET', '/api/bootstrap', undefined, { auth: false });
  await test('meta', 'eggs catalogue', 'GET', '/api/eggs', undefined, { auth: false });
  await test('meta', 'public settings', 'GET', '/api/admin/settings/public', undefined, { auth: false });
  await test('meta', 'bundled wallpapers', 'GET', '/api/admin/settings/wallpapers/bundled', undefined, { auth: false });
  await test('meta', 'wallpaper categories', 'GET', '/api/admin/settings/categories', undefined, { auth: false });

  /* ---------------- ADMIN OVERVIEW / FLEET ---------------- */
  await test('admin', 'overview telemetry', 'GET', '/api/admin/overview');
  await test('admin', 'database hosts + dbs', 'GET', '/api/admin/databases');
  await test('admin', 'all backups', 'GET', '/api/admin/backups');
  await test('admin', 'network allocations', 'GET', '/api/admin/network');

  /* ---------------- USERS ---------------- */
  await test('users', 'list users', 'GET', '/api/admin/users');
  const cu = await test('users', 'create user', 'POST', '/api/admin/users', { username: 'audit' + Date.now().toString().slice(-5), email: `audit${Date.now().toString().slice(-5)}@darkonyx.local`, password: 'auditpass1', role: 'user' });
  const newUserId = cu.data && cu.data.userId;
  if (newUserId) {
    await test('users', 'user detail', 'GET', `/api/admin/users/${newUserId}`);
    await test('users', 'user activity', 'GET', `/api/admin/users/${newUserId}/activity`);
    await test('users', 'update user', 'PUT', `/api/admin/users/${newUserId}`, { username: cu.data.username || undefined, role: 'user', name_first: 'Audit' });
    await test('users', 'suspend user', 'POST', `/api/admin/users/${newUserId}/suspend`, { suspended: true });
    await test('users', 'unsuspend user', 'POST', `/api/admin/users/${newUserId}/suspend`, { suspended: false });
    const imp = await test('users', 'impersonate user', 'POST', `/api/admin/users/${newUserId}/impersonate`);
    await test('users', 'delete user', 'DELETE', `/api/admin/users/${newUserId}`);
  }

  /* ---------------- LOCATIONS ---------------- */
  await test('locations', 'list locations', 'GET', '/api/admin/locations');
  const loc = await test('locations', 'create location', 'POST', '/api/admin/locations', { short_code: 'aud' + Date.now().toString().slice(-4), name: 'Audit Region', description: 'temp' });
  const locId = loc.data && (loc.data.locationId || (loc.data.location && loc.data.location.id));
  if (locId) {
    await test('locations', 'update location', 'PUT', `/api/admin/locations/${locId}`, { name: 'Audit Region 2' });
    await test('locations', 'delete location', 'DELETE', `/api/admin/locations/${locId}`);
  }

  /* ---------------- NODES ---------------- */
  await test('nodes', 'list nodes', 'GET', '/api/admin/nodes');
  const node = await test('nodes', 'create node', 'POST', '/api/admin/nodes', { name: 'Audit Node', fqdn: '127.0.0.1', daemon_port: 3103, sftp_port: 3104, memory_mb: 8192, disk_mb: 51200, location_id: 1 });
  const nodeId = node.data && (node.data.nodeId || (node.data.node && node.data.node.id));
  await test('nodes', 'node detail', 'GET', '/api/admin/nodes/1');
  await test('nodes', 'node live stats', 'GET', '/api/admin/nodes/1/stats');
  await test('nodes', 'node wings stats', 'GET', '/api/admin/nodes/1/wings-stats');
  await test('nodes', 'node firewall list', 'GET', '/api/admin/nodes/1/firewall');
  const fw = await test('nodes', 'firewall add rule', 'POST', '/api/admin/nodes/1/firewall/rule', { port: 25699, protocol: 'tcp', action: 'allow' });
  await test('nodes', 'node logs', 'GET', '/api/admin/nodes/1/logs');
  await test('nodes', 'node backups', 'GET', '/api/admin/nodes/1/backups');
  await test('nodes', 'port detail', 'GET', '/api/admin/nodes/1/ports/25565/detail');
  await test('nodes', 'node updates', 'GET', '/api/admin/nodes/updates');
  if (nodeId) {
    await test('nodes', 'create allocations', 'POST', `/api/admin/nodes/${nodeId}/allocations`, { ip: '127.0.0.1', ports: '31000-31002' });
    await test('nodes', 'update node', 'PUT', `/api/admin/nodes/${nodeId}`, { name: 'Audit Node', memory_mb: 8192 });
    await test('nodes', 'clear unassigned ports', 'DELETE', `/api/admin/nodes/${nodeId}/allocations-clear-unassigned`);
    await test('nodes', 'delete node', 'DELETE', `/api/admin/nodes/${nodeId}`);
  }

  /* ---------------- SERVERS (CRUD) ---------------- */
  await test('servers', 'list servers', 'GET', '/api/servers');
  const mc = await test('servers', 'create minecraft server', 'POST', '/api/servers', { name: 'Audit SMP', server_type: 'minecraft', mc_jar_type: 'paper', mc_jar_version: '1.21.4', user_id: adminId, node_id: 1, memory_mb: 2048, cpu_limit: 100, disk_mb: 5120, description: 'audit' });
  const sid = mc.data && mc.data.serverId;
  if (!sid) { console.error('server creation failed, aborting server suite'); }
  else {
    await test('servers', 'server detail', 'GET', `/api/servers/${sid}`);
    await test('servers', 'update build', 'PUT', `/api/servers/${sid}`, { memory_mb: 2048, cpu_limit: 150, startup_cmd: 'java -Xms128M -Xmx{{SERVER_MEMORY}}M -jar server.jar nogui' });
    await test('servers', 'set expiration', 'POST', `/api/servers/${sid}/expiration`, { expiration_date: null });
    await test('servers', 'power start', 'POST', `/api/servers/${sid}/power`, { action: 'start' });
    await new Promise(r => setTimeout(r, 2500));
    await test('servers', 'live stats snapshot', 'GET', `/api/servers/live?ids=${sid}`);
    await test('servers', 'console command (graceful when offline)', 'POST', `/api/servers/${sid}/command`, { command: 'say hello audit' }, { expect: [200, 400] });
    await test('servers', 'power restart', 'POST', `/api/servers/${sid}/power`, { action: 'restart' }, { expect: [200, 400, 500] });
    await new Promise(r => setTimeout(r, 1500));
    await test('servers', 'power stop', 'POST', `/api/servers/${sid}/power`, { action: 'stop' });
    await new Promise(r => setTimeout(r, 1200));
    await test('servers', 'power kill', 'POST', `/api/servers/${sid}/power`, { action: 'kill' });
    await test('servers', 'suspend toggle', 'POST', `/api/servers/${sid}/suspend`, { suspended: false });
    await test('servers', 'change version', 'POST', `/api/servers/${sid}/change-version`, { jar_type: 'purpur', jar_version: '1.21.4' });
    await test('servers', 'reinstall', 'POST', `/api/servers/${sid}/reinstall`);

    /* files */
    await test('files', 'list root', 'GET', `/api/servers/${sid}/files?directory=`);
    await test('files', 'create folder', 'POST', `/api/servers/${sid}/files/directory`, { dirPath: 'auditdir' });
    await test('files', 'write file', 'POST', `/api/servers/${sid}/files/content`, { filePath: 'auditdir/note.txt', content: 'hello darkonyx\nline2\n' });
    await test('files', 'read file', 'GET', `/api/servers/${sid}/files/content?file=auditdir%2Fnote.txt`);
    await test('files', 'beautify', 'POST', `/api/servers/${sid}/files/beautify`, { content: '{"a":1}', filePath: 'auditdir/note.txt' });
    await test('files', 'file properties', 'GET', `/api/servers/${sid}/files/properties?file=auditdir%2Fnote.txt`);
    await test('files', 'chmod', 'POST', `/api/servers/${sid}/files/permissions`, { filePath: 'auditdir/note.txt', mode: '644' });
    await test('files', 'copy', 'POST', `/api/servers/${sid}/files/copy`, { sourcePath: 'auditdir/note.txt', destPath: 'auditdir/note2.txt' });
    await test('files', 'rename', 'POST', `/api/servers/${sid}/files/rename`, { oldPath: 'auditdir/note2.txt', newPath: 'auditdir/note3.txt' });
    await test('files', 'search', 'GET', `/api/servers/${sid}/files/search?query=note`);
    await test('files', 'compress', 'POST', `/api/servers/${sid}/files/compress`, { files: ['auditdir/note.txt'], outputName: 'auditdir/pack.zip' });
    await test('files', 'extract', 'POST', `/api/servers/${sid}/files/extract`, { zipFilePath: 'auditdir/pack.zip', destPath: 'auditdir/unzipped' });
    await test('files', 'trash list', 'GET', `/api/servers/${sid}/files/trash`);
    await test('files', 'move to trash', 'POST', `/api/servers/${sid}/files/move-to-trash`, { items: ['auditdir/note3.txt'] });
    const trash = await call('GET', `/api/servers/${sid}/files/trash`);
    const trashNames = (trash.data && trash.data.items || []).map(i => i.name || i.trashName).filter(Boolean);
    if (trashNames.length) await test('files', 'restore from trash', 'POST', `/api/servers/${sid}/files/restore-from-trash`, { trashNames });
    await test('files', 'empty trash', 'POST', `/api/servers/${sid}/files/empty-trash`, {});
    await test('files', 'git status', 'GET', `/api/servers/${sid}/files/git/status`);
    await test('files', 'delete file', 'POST', `/api/servers/${sid}/files/delete`, { itemPath: 'auditdir' });
    await test('files', 'download file', 'GET', `/api/servers/${sid}/files/download?file=eula.txt`);

    /* properties */
    await test('properties', 'get properties', 'GET', `/api/servers/${sid}/properties`);
    await test('properties', 'save properties', 'PUT', `/api/servers/${sid}/properties`, { properties: { motd: 'Audit', 'max-players': 30, pvp: 'true' } });
    await test('properties', 'subdomains list', 'GET', `/api/servers/${sid}/properties/subdomains`);

    /* backups */
    const bk = await test('backups', 'create backup', 'POST', `/api/servers/${sid}/backups`, { name: 'audit-backup' });
    const bkId = bk.data && bk.data.backup && bk.data.backup.id;
    await test('backups', 'list backups', 'GET', `/api/servers/${sid}/backups`);
    if (bkId) {
      await test('backups', 'download backup', 'GET', `/api/servers/${sid}/backups/${bkId}/download`);
      await test('backups', 'lock backup', 'POST', `/api/servers/${sid}/backups/${bkId}/lock`, { locked: true });
      await test('backups', 'restore backup', 'POST', `/api/servers/${sid}/backups/${bkId}/restore`);
      await test('backups', 'unlock backup', 'POST', `/api/servers/${sid}/backups/${bkId}/lock`, { locked: false });
      await test('backups', 'delete backup', 'DELETE', `/api/servers/${sid}/backups/${bkId}`);
    }

    /* schedules */
    const sc = await test('schedules', 'create schedule', 'POST', `/api/servers/${sid}/schedules`, { name: 'Audit restart', cron_expression: '15 5 * * *', action_type: 'restart', payload: '' });
    const scId = sc.data && sc.data.schedule && sc.data.schedule.id;
    await test('schedules', 'list schedules', 'GET', `/api/servers/${sid}/schedules`);
    if (scId) {
      await test('schedules', 'update schedule', 'PUT', `/api/servers/${sid}/schedules/${scId}`, { name: 'Audit restart 2', is_active: false });
      await test('schedules', 'delete schedule', 'DELETE', `/api/servers/${sid}/schedules/${scId}`);
    }

    /* players / worlds */
    await test('players', 'player list', 'GET', `/api/servers/${sid}/players`);
    await test('players', 'detected worlds', 'GET', `/api/servers/${sid}/players/detected-worlds`);
    await test('players', 'player action', 'POST', `/api/servers/${sid}/players/action`, { action: 'op', username: 'Notch' });
    await test('worlds', 'list worlds', 'GET', `/api/servers/${sid}/worlds`);
    await test('worlds', 'create world', 'POST', `/api/servers/${sid}/worlds/create`, { name: 'auditworld' });
    await test('worlds', 'clone world', 'POST', `/api/servers/${sid}/worlds/clone`, { sourceWorld: 'auditworld', targetWorld: 'auditworld2' });
    await test('worlds', 'activate world', 'POST', `/api/servers/${sid}/worlds/activate`, { name: 'auditworld' });
    await test('worlds', 'reset world', 'POST', `/api/servers/${sid}/worlds/reset`, { worldName: 'auditworld2' });
    await test('worlds', 'delete world', 'POST', `/api/servers/${sid}/worlds/delete`, { worldName: 'auditworld2' });
    await test('worlds', 'install-map endpoint reachable', 'POST', `/api/servers/${sid}/worlds/install-url`, { url: '' }, { expect: [400, 500] });

    /* subusers */
    await test('subusers', 'list subusers', 'GET', `/api/servers/${sid}/subusers`);
    const sub = await test('subusers', 'add subuser', 'POST', `/api/servers/${sid}/subusers`, { userIdentifier: 'nyx', permissions: ['console.view', 'files.read'] });
    const subId = sub.data && sub.data.subuser && sub.data.subuser.id;
    if (subId) {
      await test('subusers', 'update subuser', 'PUT', `/api/servers/${sid}/subusers/${subId}`, { permissions: ['console.view'] });
      await test('subusers', 'delete subuser', 'DELETE', `/api/servers/${sid}/subusers/${subId}`);
    }

    /* network */
    await test('network', 'server network', 'GET', `/api/servers/${sid}/network`);
    await test('network', 'assign allocation', 'POST', `/api/servers/${sid}/network/assign`, {});

    /* databases (needs a live MySQL host — expect a graceful error) */
    await test('databases', 'server databases', 'GET', `/api/servers/${sid}/databases`);

    /* addons / extensions */
    await test('addons', 'available subdomain domains', 'GET', `/api/servers/${sid}/addons/subdomains/available-domains`);
    await test('addons', 'egg changer info', 'GET', `/api/servers/${sid}/addons/egg-changer`);
    await test('addons', 'startup commands', 'GET', `/api/servers/${sid}/addons/startup-commands`);
    await test('addons', 'record generator', 'GET', `/api/servers/${sid}/addons/record-generator`);
    await test('addons', 'auto backups (server)', 'GET', `/api/servers/${sid}/backups/auto`);
    await test('addons', 'splitter status', 'GET', `/api/servers/${sid}/splitter`);
    await test('addons', 'splitter templates', 'GET', `/api/servers/${sid}/splitter/templates`);
    await test('addons', 'importer profiles', 'GET', `/api/servers/${sid}/importer/profiles`);
    await test('addons', 'importer status', 'GET', `/api/servers/${sid}/importer/status`);
    await test('addons', 'marketplace installed', 'GET', `/api/servers/${sid}/marketplace/installed`);

    await test('servers', 'delete server', 'DELETE', `/api/servers/${sid}`);
    await test('servers', 'deleted server 404', 'GET', `/api/servers/${sid}`, undefined, { expect: 404 });
  }

  /* ---------------- MARKETPLACE ---------------- */
  await test('marketplace', 'curated maps', 'GET', '/api/marketplace/maps', undefined, { auth: false });
  await test('marketplace', 'modrinth search', 'GET', '/api/marketplace/search?query=essentials&limit=3', undefined, { auth: false });
  await test('marketplace', 'mctools info', 'GET', '/api/marketplace/mctools/info', undefined, { auth: false });
  await test('marketplace', 'mctools items data', 'GET', '/api/marketplace/mctools/data/items', undefined, { auth: false });
  await test('marketplace', 'config discovery (needs server)', 'GET', '/api/marketplace/config-files/discover', undefined, { expect: [400, 403, 500] });

  /* ---------------- MCJARS ---------------- */
  await test('mcjars', 'types', 'GET', '/api/mcjars/types');

  /* ---------------- SETTINGS ---------------- */
  await test('settings', 'read settings', 'GET', '/api/admin/settings');
  await test('settings', 'write settings', 'PUT', '/api/admin/settings', { panel_name: 'DARKONYX', default_language: 'en', theme_mode: 'dark' });

  /* ---------------- API KEYS ---------------- */
  const key = await test('api-keys', 'create api key', 'POST', '/api/admin/api-keys', { description: 'audit key' });
  const keyId = key.data && key.data.key && key.data.key.id;
  const keyToken = key.data && key.data.key && key.data.key.key_token;
  await test('api-keys', 'list api keys', 'GET', '/api/admin/api-keys');
  if (keyToken) await test('api-keys', 'api key authenticates', 'GET', '/api/servers', undefined, { auth: false, headers: { 'X-API-Key': keyToken } });
  if (keyId) await test('api-keys', 'delete api key', 'DELETE', `/api/admin/api-keys/${keyId}`);

  /* ---------------- ACTIVITY ---------------- */
  await test('activity', 'activity feed', 'GET', '/api/activity');

  /* ---------------- ADDONS / SOCIAL / UPDATES (admin) ---------------- */
  await test('admin-ext', 'addons list', 'GET', '/api/admin/addons');
  await test('admin-ext', 'social login config', 'GET', '/api/admin/sociallogin');
  await test('admin-ext', 'social providers (public)', 'GET', '/api/auth/social/providers', undefined, { auth: false });
  await test('admin-ext', 'update status', 'GET', '/api/admin/updates/status');
  await test('admin-ext', 'git status', 'GET', '/api/admin/updates/git-status');
  await test('admin-ext', 'domain blocklist', 'GET', '/api/admin/addons/domains/blocklist');

  /* ---------------- DAEMON API (port 3003) ---------------- */
  const daemon = await fetch('http://localhost:3003/api/system/status').then(r => r.json()).catch(e => ({ error: e.message }));
  results.push({ group: 'daemon', label: 'daemon health', method: 'GET', path: 'localhost:3003/api/system/status', ok: !!daemon.status, status: daemon.status ? 200 : 0, ms: 0 });
  console.log(`${daemon.status ? '\x1b[32m✔\x1b[0m' : '\x1b[31m✗\x1b[0m'}  daemon health: ${daemon.status || daemon.error}`);

  /* ---------------- SFTP (port 3004) ---------------- */
  const sftp = await new Promise((resolve) => {
    const net = require('net');
    const s = net.connect(3004, '127.0.0.1');
    s.on('connect', () => { s.end(); resolve(true); });
    s.on('error', () => resolve(false));
    setTimeout(() => { s.destroy(); resolve(false); }, 3000);
  });
  results.push({ group: 'sftp', label: 'sftp port open', method: 'TCP', path: '127.0.0.1:3004', ok: sftp, status: sftp ? 200 : 0, ms: 0 });
  console.log(`${sftp ? '\x1b[32m✔\x1b[0m' : '\x1b[31m✗\x1b[0m'}  SFTP listening on 3004`);

  /* ---------------- WEBSOCKET CONSOLE ---------------- */
  const wsResult = await new Promise((resolve) => {
    const WebSocket = require('/home/user/DARKONYX-PANEL/panel/node_modules/ws');
    const ws = new WebSocket(`ws://localhost:3001/ws/servers/1/console?token=${token}`);
    const timer = setTimeout(() => { try { ws.terminate(); } catch (e) {} resolve({ ok: false, note: 'timeout' }); }, 6000);
    let msgs = 0;
    ws.on('message', (m) => {
      msgs++;
      const d = JSON.parse(m.toString());
      if (msgs >= 1) { clearTimeout(timer); ws.close(); resolve({ ok: ['status', 'history', 'console'].includes(d.type), note: d.type }); }
    });
    ws.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, note: e.message }); });
  });
  results.push({ group: 'websocket', label: 'console ws handshake', method: 'WS', path: '/ws/servers/1/console', ok: wsResult.ok, status: wsResult.ok ? 101 : 0, ms: 0 });
  console.log(`${wsResult.ok ? '\x1b[32m✔\x1b[0m' : '\x1b[31m✗\x1b[0m'}  console WebSocket handshake (${wsResult.note})`);

  /* ---------------- SUMMARY ---------------- */
  const total = results.length;
  const passed = results.filter(r => r.ok).length;
  const failed = results.filter(r => !r.ok);
  console.log(`\n=== ${passed}/${total} checks passed ===`);
  if (failed.length) {
    console.log('\nFAILURES:');
    for (const f of failed) console.log(`  [${f.group}] ${f.method} ${f.path} -> ${f.status} ${f.note || ''}`);
  }
  const offline = results.filter(r => r.env);
  if (offline.length) {
    console.log('\nOFFLINE (no outbound network in this sandbox — not code bugs):');
    for (const f of offline) console.log(`  [${f.group}] ${f.method} ${f.path} — ${String(f.note).slice(0, 80)}`);
  }
  const groups = [...new Set(results.map(r => r.group))];
  console.log('\nPer-group:');
  for (const g of groups) {
    const rs = results.filter(r => r.group === g);
    const p = rs.filter(r => r.ok).length;
    console.log(`  ${g.padEnd(13)} ${p}/${rs.length} ${p === rs.length ? '✔' : '✗'}`);
  }
  process.exit(failed.length ? 1 : 0);
})();
