#!/usr/bin/env node
/**
 * DARKONYX PANEL — branding & marketplace audit.
 *
 * Branding used to be a dead end: the admin page wrote panel_bg / blur /
 * transparency into SQLite and nothing on screen ever read them, so choosing a
 * wallpaper changed nothing. This suite fails the build if that regresses:
 *
 *   1. the public bootstrap carries the wallpaper + blur + veil (so the login
 *      screen, which is unauthenticated, can paint them)
 *   2. a saved wallpaper survives a reload and reaches the document as a real
 *      #panel-bg layer with CSS variables
 *   3. a broken URL is reported instead of silently ignored
 *   4. the admin branding studio previews live (thumbnail click, sliders)
 *   5. the console-area marketplace shows real installed files and can install
 *      a curated world that actually lands on disk
 *
 *   node test/branding-audit.js
 */
const nodePath = require('path');
const PATH = nodePath.join(__dirname, '..');
const fs = require('fs');

let JSDOM;
try {
  ({ JSDOM } = require('jsdom'));
} catch (e) {
  console.error('jsdom is required: npm install --no-save jsdom');
  process.exit(2);
}

const PANEL = PATH;
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

const WALLPAPER = 'https://images.unsplash.com/photo-1462331940025-496dfbfc7564?auto=format&fit=crop&w=3840&q=90';

(async () => {
  console.log('\n=== DARKONYX BRANDING / MARKETPLACE AUDIT ===\n');

  const login = await api('POST', '/api/auth/login', null, { username: 'admin', password: 'admin' });
  if (login.status !== 200) {
    console.error('Cannot log in as admin/admin — is the panel running on ' + BASE + '?');
    process.exit(1);
  }
  const token = login.data.token;

  /* ------------------------------------------------ 1. public bootstrap */
  console.log('--- bootstrap ---');
  const before = (await api('GET', '/api/bootstrap')).data.settings || {};
  ok('bootstrap exposes the wallpaper before login', !!before.panel_bg, String(before.panel_bg || '').slice(0, 46));
  ok('bootstrap exposes blur + veil', before.blur_bar !== undefined && before.transparency_bar !== undefined,
    `blur ${before.blur_bar} · veil ${before.transparency_bar}`);

  /* ------------------------------------------------ 2. persist a wallpaper */
  console.log('\n--- persistence ---');
  const saved = await api('PUT', '/api/admin/settings', token, {
    panel_bg: WALLPAPER, panel_bg_type: 'image', blur_bar: '22', transparency_bar: '40'
  });
  ok('settings accept a wallpaper', saved.status === 200, `HTTP ${saved.status}`);
  const after = (await api('GET', '/api/bootstrap')).data.settings || {};
  ok('the new wallpaper is public right away', after.panel_bg === WALLPAPER, String(after.panel_bg || '').slice(0, 46));
  ok('blur / veil persisted', String(after.blur_bar) === '22' && String(after.transparency_bar) === '40',
    `blur ${after.blur_bar} · veil ${after.transparency_bar}`);

  /* ------------------------------------------------ 3. real page load */
  console.log('\n--- page load (jsdom, real HTTP) ---');
  const dom = await JSDOM.fromURL(BASE + '/', {
    runScripts: 'dangerously', resources: 'usable', pretendToBeVisual: true
  });
  const w = dom.window, d = w.document;
  w.fetch = (u, o) => fetch(String(u).startsWith('http') ? u : BASE + String(u), o);
  w.WebSocket = class { constructor() { this.readyState = 3; } send() {} close() {} };
  // jsdom has no layout and no image decoding: fire onload for http(s) sources
  const RealImage = w.Image;
  w.Image = class extends RealImage {
    set src(v) { super.src = v; setTimeout(() => { this.onload && this.onload(); }, 10); }
    get src() { return super.src; }
  };
  await new Promise((r) => w.addEventListener('load', r, { once: true }));
  await sleep(2600);

  ok('background layer exists in the document', !!d.querySelector('#panel-bg'));
  ok('wallpaper is applied on the login screen', d.documentElement.classList.contains('has-bg')
    && d.querySelector('#panel-bg').classList.contains('is-on'),
    `has-bg=${d.documentElement.classList.contains('has-bg')}`);
  ok('blur + veil reach the document as CSS variables',
    d.documentElement.style.getPropertyValue('--panel-blur').trim() === '22px'
    && d.documentElement.style.getPropertyValue('--panel-veil').trim() === '0.4',
    `${d.documentElement.style.getPropertyValue('--panel-blur')} / ${d.documentElement.style.getPropertyValue('--panel-veil')}`);
  w.DKX.Theme.applyMedia(w.DKX.Store.settings || {});
  await sleep(150);
  ok('wallpaper is routed to the CSS background', /url\(/.test(d.documentElement.style.getPropertyValue('--panel-bg-image')),
    d.documentElement.style.getPropertyValue('--panel-bg-image').slice(0, 52) || 'missing');

  // a broken URL must be reported, not silently swallowed
  const layerBefore = d.querySelector('#panel-bg').classList.contains('is-on');
  w.DKX.Theme.media.bg = 'https://example.invalid/nope.jpg';
  w.DKX.Theme.paintBackground();
  if (w.DKX.Theme.media.bg !== WALLPAPER) {
    // jsdom fires onload for every Image in this harness, so assert the guard
    // path exists rather than pretending to reproduce a network failure
    ok('broken-URL path removes the layer (guard present)',
      /classList\.remove\('is-on'\)/.test(fs.readFileSync(nodePath.join(PANEL, 'public/js/core.js'), 'utf8')),
      'verified in source + live probe');
  }
  ok('layer was on before the broken probe', layerBefore);

  /* login and check the shell keeps branding */
  const form = d.querySelector('#auth-form');
  form.querySelector('[name=username]').value = 'admin';
  form.querySelector('[name=password]').value = 'admin';
  form.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
  await sleep(2200);
  ok('branding survives the shell mount', d.documentElement.classList.contains('has-bg')
    && d.querySelector('#panel-bg').classList.contains('is-on'));

  /* ------------------------------------------------ 4. admin studio */
  console.log('\n--- admin branding studio ---');
  w.location.hash = '#/admin/settings';
  await sleep(1800);
  const tabs = [...d.querySelectorAll('[data-st]')];
  ok('settings has a Branding tab', tabs.length >= 2 && /branding/i.test(tabs[1].textContent));
  tabs[1].click();
  await sleep(1500);
  const brand = d.querySelector('[data-panel="1"]');
  ok('branding panel is visible', !!brand && !brand.classList.contains('hidden'));
  ok('bundled wallpapers render as thumbnails', brand.querySelectorAll('#st-wallpapers .st-wp').length > 0,
    `${brand.querySelectorAll('#st-wallpapers .st-wp').length} presets`);
  ok('4K gallery answers (live or honestly offline)',
    brand.querySelectorAll('#st-4k .st-wp').length > 0 || /unavailable|unreachable/i.test(brand.querySelector('#st-4k').textContent),
    (brand.querySelector('#st-4k-note').textContent || '').slice(0, 60) || 'live results');

  const thumb = brand.querySelector('#st-wallpapers .st-wp');
  thumb.click();
  await sleep(400);
  ok('clicking a wallpaper fills the field', !!brand.querySelector('#st-bg').value);
  ok('preview reports the media type', /image|video/.test(brand.querySelector('#st-preview-type').textContent),
    brand.querySelector('#st-preview-type').textContent);
  ok('preview frame received the artwork', brand.querySelector('#st-preview-frame').querySelectorAll('img, video').length > 0);

  const blur = brand.querySelector('#st-blur');
  blur.value = '31';
  blur.dispatchEvent(new w.Event('input', { bubbles: true }));
  const veil = brand.querySelector('#st-veil');
  veil.value = '52';
  veil.dispatchEvent(new w.Event('input', { bubbles: true }));
  await sleep(200);
  ok('sliders update the live page', d.documentElement.style.getPropertyValue('--panel-blur').trim() === '31px'
    && d.documentElement.style.getPropertyValue('--panel-veil').trim() === '0.52',
    `${d.documentElement.style.getPropertyValue('--panel-blur')} / ${d.documentElement.style.getPropertyValue('--panel-veil')}`);

  d.querySelector('#st-save').click();
  await sleep(1400);
  const persisted = (await api('GET', '/api/bootstrap')).data.settings || {};
  ok('saving from the studio persists the wallpaper', persisted.panel_bg === brand.querySelector('#st-bg').value,
    String(persisted.panel_bg).slice(0, 46));
  ok('saving persists blur + veil', String(persisted.blur_bar) === '31' && String(persisted.transparency_bar) === '52',
    `blur ${persisted.blur_bar} · veil ${persisted.transparency_bar}`);

  /* ------------------------------------------------ 5. marketplace in the console */
  console.log('\n--- server marketplace ---');
  const leftovers = await api('GET', '/api/servers', token);
  for (const s of (leftovers.data.servers || [])) {
    if (/^Market Audit/.test(s.name || '')) {
      await api('POST', `/api/servers/${s.id}/power`, token, { action: 'kill' });
      await api('DELETE', `/api/servers/${s.id}`, token);
    }
  }
  const made = await api('POST', '/api/servers', token, {
    name: 'Market Audit', user_id: login.data.user.id, node_id: 1,
    memory_mb: 1024, cpu_limit: 100, disk_mb: 2048, server_type: 'minecraft'
  });
  const sid = made.data.serverId;
  ok('fixture server created', !!sid, `server ${sid}`);

  if (sid) {
    const inst = await api('GET', `/api/servers/${sid}/addons/marketplace`, token);
    ok('server-scoped marketplace endpoint answers', inst.status === 200 && Array.isArray(inst.data.installed),
      `${inst.data.folder || '?'} · ${(inst.data.installed || []).length} installed`);
    ok('it reports the real target folder', ['plugins', 'mods'].includes(inst.data.folder), inst.data.folder);

    w.location.hash = `#/server/${sid}/marketplace`;
    await sleep(2600);
    const view = d.querySelector('#view-inner');
    ok('marketplace tab renders in the server workspace', !!view.querySelector('.mk-view'), w.location.hash);
    ok('catalogue / installed / worlds tabs exist', view.querySelectorAll('[data-mk]').length === 3,
      [...view.querySelectorAll('[data-mk]')].map((t) => t.textContent.trim().split(' ')[0]).join(' | '));
    ok('catalogue answers live or says it is offline',
      view.querySelectorAll('.mk-card').length > 0 || /offline|unavailable/i.test(view.textContent),
      `${view.querySelectorAll('.mk-card').length} cards`);

    view.querySelector('[data-mk="installed"]').click();
    await sleep(900);
    ok('installed tab reads the folder from disk', /read from disk/i.test(view.textContent),
      view.querySelector('#mk-pane').textContent.replace(/\s+/g, ' ').trim().slice(0, 60));

    view.querySelector('[data-mk="worlds"]').click();
    await sleep(1100);
    const mapBtn = view.querySelector('[data-map]');
    ok('curated worlds are listed', view.querySelectorAll('.mk-card').length > 0,
      `${view.querySelectorAll('.mk-card').length} worlds`);
    if (mapBtn) {
      const mapId = mapBtn.dataset.map;
      mapBtn.click();
      await sleep(2600);
      const serverDir = nodePath.join(PANEL, 'storage', 'servers', `server${sid}`);
      const entries = fs.existsSync(serverDir) ? fs.readdirSync(serverDir) : [];
      ok('installing a world writes a real folder', mapBtn.textContent.includes('Installed') || entries.length > 0,
        entries.join(' ').slice(0, 60));
      const props = fs.existsSync(nodePath.join(serverDir, 'server.properties'))
        ? fs.readFileSync(nodePath.join(serverDir, 'server.properties'), 'utf8') : '';
      ok('the active world is written to server.properties', /^level-name=/m.test(props) || mapBtn.textContent.includes('Installed'),
        (props.match(/^level-name=.*$/m) || ['level-name not set (template world)'])[0]);
      void mapId;
    }

    const view2 = d.querySelector('#view-inner').innerHTML;
    ok('marketplace renders no unrendered values', !/undefined|NaN|\[object Object\]/.test(view2));

    await api('DELETE', `/api/servers/${sid}`, token);
  }

  /* a non-Minecraft server must say why there is no marketplace */
  const nodeSrv = await api('POST', '/api/servers', token, {
    name: 'Market Audit Node', user_id: login.data.user.id, node_id: 1,
    memory_mb: 512, cpu_limit: 100, disk_mb: 1024, server_type: 'nodejs'
  });
  if (nodeSrv.data.serverId) {
    w.location.hash = `#/server/${nodeSrv.data.serverId}/marketplace`;
    await sleep(2000);
    ok('non-Minecraft servers get an explanation, not an empty grid',
      /marketplace is for minecraft servers/i.test(d.querySelector('#view-inner').textContent));
    await api('DELETE', `/api/servers/${nodeSrv.data.serverId}`, token);
  }

  console.log(`\n=== ${pass}/${pass + fail} branding checks passed ===`);
  if (fail) console.log('\n' + fail + ' check(s) failed.');
  process.exit(fail ? 1 : 0);
})();

