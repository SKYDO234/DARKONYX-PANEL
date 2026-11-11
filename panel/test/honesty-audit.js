#!/usr/bin/env node
/**
 * DARKONYX PANEL — data-integrity audit.
 *
 * The panel is only useful if every number on screen is real. This suite fails
 * the build if fabricated data comes back:
 *
 *   1. static scan — no Math.random()/hardcoded values in telemetry paths
 *   2. live telemetry — CPU/RAM/disk/net must track the host, not a constant
 *   3. measurement provenance — endpoints must say whether a value was measured
 *   4. honest failure — unreachable features report offline, not fake data
 *
 *   node test/honesty-audit.js
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const PANEL = path.join(__dirname, '..');
const BASE = process.env.BASE || 'http://localhost:3001';

let pass = 0, fail = 0;
const results = [];
const ok = (label, good, note = '') => {
  results.push({ label, good });
  if (good) { pass++; console.log(`\x1b[32m✔\x1b[0m ${label}${note ? ' — ' + note : ''}`); }
  else { fail++; console.log(`\x1b[31m✗\x1b[0m ${label}${note ? ' — ' + note : ''}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const read = (p) => fs.readFileSync(path.join(PANEL, p), 'utf8');

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
  console.log('\n=== DARKONYX DATA INTEGRITY AUDIT ===\n');

  /* ---------------------------------------------------------- 1. static scan */
  console.log('--- static scan ---');

  const telemetryFiles = ['src/routes/nodeRoutes.js', 'src/routes/adminRoutes.js', 'src/services/runnerService.js'];
  let randomHits = [];
  for (const f of telemetryFiles) {
    const src = read(f);
    src.split('\n').forEach((line, i) => {
      if (!/Math\.random\(\)/.test(line)) return;
      if (/uuid|nonce|uniqueName|dbUser|randomSuffix|upload|substring\(2, \d+\)/.test(line)) return;
      randomHits.push(`${f}:${i + 1}`);
    });
  }
  ok('no Math.random() in telemetry code', randomHits.length === 0, randomHits.join(' ') || 'clean');

  const fakeBlocks = [];
  for (const f of telemetryFiles) {
    const src = read(f);
    // hardcoded traffic / capacity / container figures
    const patterns = [
      /rx_speed:\s*'[\d.]+ MB\/s'/,
      /tx_speed:\s*'[\d.]+ MB\/s'/,
      // any non-zero canned container count (an honest 0/0 default is fine)
      /containers:\s*\{\s*total:\s*[1-9]\d*,\s*running:\s*\d+/,
      /wingsVersion:\s*'/,
      /version:\s*'1\.11\.8'/
    ];
    for (const p of patterns) if (p.test(src)) fakeBlocks.push(`${f}: ${p}`);
  }
  ok('no hardcoded container/traffic/version figures', fakeBlocks.length === 0, fakeBlocks.join(' | ') || 'clean');

  ok('no invented CPU jitter', !/randomCpuJitter/.test(read('src/routes/nodeRoutes.js')));
  ok('no synthesized server memory', !/lastMemory \|\| \(Math\.floor\(Math\.random/.test(read('src/services/runnerService.js')));
  ok('no static egg catalogue fallback', !/getFallbackEggs/.test(read('src/services/addonService.js')));

  /* -------------------------------------------------- 2. live telemetry truth */
  console.log('\n--- live telemetry ---');
  const login = await api('POST', '/api/auth/login', null, { username: 'admin', password: 'admin' });
  if (login.status !== 200) {
    console.error('Cannot log in as admin/admin — is the panel running on ' + BASE + '?');
    process.exit(1);
  }
  const token = login.data.token;

  // host CPU measured by the box itself, for comparison
  const hostCpuPercent = () => {
    const snap = () => {
      let total = 0, idle = 0;
      for (const c of os.cpus()) { for (const t in c.times) total += c.times[t]; idle += c.times.idle; }
      return { total, idle };
    };
    return { snap };
  };
  const a = hostCpuPercent().snap();
  await sleep(600);
  const b = hostCpuPercent().snap();
  const hostCpu = Math.round((1 - (b.idle - a.idle) / Math.max(1, b.total - a.total)) * 100);

  const s1 = (await api('GET', '/api/admin/nodes/1/stats', token)).data.stats;
  await sleep(700);
  const s2 = (await api('GET', '/api/admin/nodes/1/stats', token)).data.stats;

  ok('node RAM matches the host', Math.abs(s1.ram_total_mb - Math.round(os.totalmem() / 1048576)) <= 32,
    `${s1.ram_total_mb} MB reported / ${Math.round(os.totalmem() / 1048576)} MB actual`);
  ok('node RAM used is plausible', s1.ram_used_mb > 0 && s1.ram_used_mb < s1.ram_total_mb, `${s1.ram_used_mb} MB`);
  ok('node CPU is within 25 points of the host', Math.abs(s1.cpu_percent - hostCpu) <= 25,
    `panel ${s1.cpu_percent}% / host ${hostCpu}%`);
  ok('node CPU changes between samples (it is live)', s1.cpu_percent !== s2.cpu_percent || s1.cpu_percent === hostCpu,
    `${s1.cpu_percent}% → ${s2.cpu_percent}%`);
  ok('node disk is measured from the filesystem', s1.ssd_measured === true, `${s1.ssd_used_gb} GB / ${s1.ssd_total_gb} GB`);
  ok('node disk does not report a canned 100/25 GB', !(s1.ssd_total_gb === 100 && s1.ssd_used_gb === 25));

  const netTotal = parseFloat(String(s1.net_in_total).replace(/[^\d.]/g, '')) || 0;
  ok('network figures come from /proc/net/dev', s1.net_measured === true || netTotal > 0, `${s1.net_in_speed} in / ${s1.net_out_speed} out`);
  ok('idle link is not padded with invented traffic',
    !/MB\/s/.test(s1.net_in_speed) || s1.net_measured === true, s1.net_in_speed);

  /* -------------------------------------------- 3. measurement provenance */
  console.log('\n--- provenance & honesty ---');
  const wings = (await api('GET', '/api/admin/nodes/1/wings-stats', token)).data;
  ok('daemon reports the real panel version', wings.daemon && wings.daemon.version === require('../package.json').version,
    wings.daemon && `v${wings.daemon.version}`);
  ok('daemon reports its runtime mode', ['docker', 'native-process'].includes(wings.daemon.mode), wings.daemon.mode);
  ok('docker absence is stated, not faked', wings.docker.available === false
    ? /socket|not present|unavailable/i.test(String(wings.docker.error || ''))
    : typeof wings.docker.containers.total === 'number',
    wings.docker.error || `${wings.docker.containers.total} containers`);

  const overview = (await api('GET', '/api/admin/overview', token)).data;
  ok('database engine is reported truthfully', !!overview.database && !!overview.database.engine,
    `${overview.database.engine} · ${overview.database.version}`);
  ok('database latency is marked measured', overview.database.measured === true, `${overview.database.latency_ms} ms`);
  ok('disk metrics are marked measured', overview.system.disk.measured === true, `${overview.system.disk.percent}%`);

  const portDetail = await api('GET', '/api/admin/nodes/1/ports/25565/detail', token);
  ok('port detail has no fabricated throughput', portDetail.data.traffic === null, 'traffic: null');
  ok('port detail reports a real listening check', typeof portDetail.data.listening === 'boolean',
    `listening: ${portDetail.data.listening}`);

  const logs = (await api('GET', '/api/admin/nodes/1/logs', token)).data;
  ok('node logs come from the audit trail', /AUDIT|activity/.test(logs.logs), `${logs.total_lines} lines`);
  ok('node logs contain no invented daemon boot lines', !/Connecting to Docker socket .* Connected!/.test(logs.logs));

  /* ------------------------------------------------ 4. honest failure paths */
  const reboot = await api('POST', '/api/admin/nodes/1/reboot-vps', token);
  ok('host reboot is gated behind an explicit opt-in', reboot.status === 403, reboot.data.error && reboot.data.error.slice(0, 60));

  const fivem = await api('GET', '/api/addons/fivem/artifacts', token);
  ok('unreachable FiveM CDN reports offline, not a fake build list',
    fivem.data.success === false && fivem.data.offline === true, (fivem.data.error || '').slice(0, 64));

  const eggs = await api('GET', '/api/admin/addons/eggs/repo/game', token);
  ok('unreachable egg repo reports offline, not a static catalogue',
    eggs.data.success === false && eggs.data.offline === true, (eggs.data.error || '').slice(0, 64));

  const market = await api('GET', '/api/marketplace/search?query=essentials&limit=2', token);
  const marketOffline = market.data.success === false;
  ok('marketplace either returns real projects or a real error',
    !marketOffline || /network|socket|tls|unreachable/i.test(String(market.data.error)),
    marketOffline ? (market.data.error || '').slice(0, 50) : `${(market.data.projects || market.data.hits || []).length} results`);

  /* ---------------------------------------------- 5. real stats for a server */
  const created = await api('POST', '/api/servers', token, {
    name: 'Integrity Probe', user_id: login.data.user.id, node_id: 1, memory_mb: 512,
    cpu_limit: 100, disk_mb: 1024, server_type: 'nodejs', docker_image: 'node:20'
  });
  const sid = created.data.serverId;
  if (sid) {
    const dir = path.join(PANEL, 'storage', 'servers', 'server' + sid);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'index.js'),
      'const buf=Buffer.alloc(40*1024*1024,1);let x=0;setInterval(()=>{for(let i=0;i<4e6;i++)x+=Math.sqrt(i)},2);console.log("probe up",buf.length);\n');
    await api('POST', `/api/servers/${sid}/power`, token, { action: 'start' });
    // the first stats tick only establishes a baseline for the CPU delta;
    // give the monitor enough ticks to measure real work
    let live = {};
    for (let i = 0; i < 6; i++) {
      await sleep(2000);
      live = (await api('GET', `/api/servers/live?ids=${sid}`, token)).data.stats[sid] || live;
      if (Number(live.cpu) > 5) break;
    }
    ok('running server reports real memory', Number(live.memory) > 20, `${live.memory} MB`);
    ok('running server reports real CPU', Number(live.cpu) > 5, `${live.cpu}%`);
    ok('server stats are flagged as measured', live.measured === true);

    const detail = (await api('GET', `/api/servers/${sid}`, token)).data;
    const con = String(detail.console || '');
    ok('console history is served after reload', con.length > 40 && /DARKONYX PANEL|probe up/.test(con),
      `${con.length} chars`);

    await api('POST', `/api/servers/${sid}/power`, token, { action: 'stop' });
    await sleep(600);
    await api('DELETE', `/api/servers/${sid}`, token);
  } else {
    ok('running server reports real memory', false, 'fixture creation failed');
  }

  console.log(`\n=== ${pass}/${pass + fail} integrity checks passed ===`);
  if (fail) {
    console.log('\nFAILED:');
    results.filter((r) => !r.good).forEach((r) => console.log('  ' + r.label));
  }
  process.exit(fail ? 1 : 0);
})();
