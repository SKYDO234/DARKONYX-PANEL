/* ==========================================================================
   DARKONYX PANEL — server workspace (console, files, settings, backups,
   schedules, players, worlds, sub-users, network, addons)
   ========================================================================== */
(function () {
  const { esc, fmt, API, Store, toast, modal, confirmDialog, emptyState, meter, statusChip } = window.el;
  const { serverAddress, typeLabel } = window.DKX.Views.portal;

  const POWER_LABEL = { start: 'Start', restart: 'Restart', stop: 'Stop', kill: 'Force stop' };

  const TABS = [
    { id: 'console', label: 'Console', icon: 'terminal' },
    { id: 'files', label: 'Files', icon: 'folder' },
    { id: 'players', label: 'Players', icon: 'users' },
    { id: 'worlds', label: 'Worlds', icon: 'map' },
    { id: 'backups', label: 'Backups', icon: 'archive' },
    { id: 'schedules', label: 'Schedules', icon: 'clock' },
    { id: 'network', label: 'Network', icon: 'globe' },
    { id: 'databases', label: 'Databases', icon: 'database' },
    { id: 'users', label: 'Sub-users', icon: 'shield' },
    { id: 'addons', label: 'Addons', icon: 'puzzle' },
    { id: 'marketplace', label: 'Marketplace', icon: 'package' },
    { id: 'activity', label: 'Activity', icon: 'activity' },
    { id: 'settings', label: 'Settings', icon: 'sliders' }
  ];

  const state = { server: null, id: null, ws: null, consoleTab: 'console', stats: {}, history: '' };

  /* ------------------------------------------------------------- ws console */
  function connectConsole(onLine, onStats, onStatus) {
    closeSocket();
    if (!Store.token || !state.id) return;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    let ws;
    try { ws = new WebSocket(`${proto}://${location.host}/ws/servers/${state.id}/console?token=${encodeURIComponent(Store.token)}`); }
    catch (e) { return; }
    state.ws = ws;
    state.retries = 0;
    ws.onmessage = (ev) => {
      let msg; try { msg = JSON.parse(ev.data); } catch (e) { return; }
      if (msg.type === 'console' || msg.type === 'history') onLine && onLine(msg.data);
      else if (msg.type === 'stats') { onStats && onStats(msg.stats); }
      else if (msg.type === 'status') { onStatus && onStatus(msg.status, msg.stats); if (msg.stats) onStats && onStats(msg.stats); }
      else if (msg.type === 'error') toast(msg.message, 'err');
    };
    // A dropped socket used to stay dropped until the page was reloaded. Retry
    // with backoff while this socket is still the current one; the REST stats
    // poll keeps the numbers moving in the meantime.
    ws.onclose = () => {
      if (state.ws !== ws) return;
      state.ws = null;
      if (state.destroyed || !Store.token || !state.id) return;
      state.retries = (state.retries || 0) + 1;
      if (state.retries > 6) { toast('Live stream lost — reopen the console to reconnect', 'err'); return; }
      clearTimeout(state.reconnectTimer);
      state.reconnectTimer = setTimeout(() => {
        if (!state.destroyed && !state.ws) connectConsole(onLine, onStats, onStatus);
      }, Math.min(8000, 600 * Math.pow(2, state.retries - 1)));
    };
    ws.onerror = () => { try { ws.close(); } catch (e) {} };
  }
  function closeSocket() {
    try { state.ws && state.ws.close(); } catch (e) {}
    state.ws = null;
  }
  function disconnectConsole() {
    state.destroyed = true;
    state.retries = 0;
    clearTimeout(state.reconnectTimer);
    closeSocket();
    if (window.DKX.Console) window.DKX.Console.destroy();
    document.title = (Store.settings && Store.settings.panel_name) || 'DARKONYX PANEL';
  }

  /* -------------------------------------------------------------- ansi strip */
  function ansiToHtml(text) {
    const escText = String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return escText
      .replace(/\x1b\[0?m/g, '</span>')
      .replace(/\x1b\[(3[0-7])m/g, (m, c) => `<span class="ansi-${({
        30: 'gray', 31: 'red', 32: 'green', 33: 'yellow', 34: 'blue', 35: 'magenta', 36: 'cyan', 37: 'gray'
      })[c] || 'gray'}">`)
      .replace(/\x1b\[(9[0-7])m/g, (m, c) => `<span class="ansi-${({
        90: 'gray', 91: 'red', 92: 'green', 93: 'yellow', 94: 'blue', 95: 'magenta', 96: 'cyan', 97: 'gray'
      })[c] || 'gray'}">`)
      .replace(/\x1b\[1m/g, '<span class="ansi-bold">')
      .replace(/\x1b\[[0-9;]*m/g, '');
  }

  /* ------------------------------------------------------------------ shell */
  async function shell(host, id, tab) {
    state.id = id;
    state.destroyed = false;
    state.retries = 0;
    if (tab !== 'console') disconnectConsole();
    else closeSocket();

    let payload;
    try { payload = await API.get(`/api/servers/${id}`); }
    catch (e) { host.innerHTML = `<div class="card card-pad">${emptyState('alert', 'Server unavailable', e.message, `<a class="btn btn-sm" href="#/portal/servers">Back to servers</a>`)}</div>`; return; }

    const s = payload.server;
    state.server = s;
    state.history = payload.console || '';
    const perms = payload.permissions || [];
    window.DKX.Shell.setCrumbs([{ label: 'Servers', hash: '/portal/servers' }, { label: s.name }]);

    const suspended = !!s.is_suspended;
    host.innerHTML = `
      <div class="srv-shell">

        <aside class="srv-rail" id="srv-rail" aria-label="Server sections">
          <div class="srv-rail-head">
            <div class="srv-icon" style="width:36px;height:36px;flex-basis:36px">${I('box')}</div>
            <div class="srv-rail-id">
              <b class="srv-rail-name" title="${esc(s.name)}">${esc(s.name)}</b>
              <span class="srv-rail-type">${esc(typeLabel(s.server_type))}</span>
            </div>
          </div>

          <nav class="srv-rail-nav" id="srv-tabs" role="tablist" aria-orientation="vertical">
            ${TABS.map((t) => `<button class="srv-tab ${t.id === tab ? 'active' : ''}" data-tab="${t.id}" role="tab" aria-selected="${t.id === tab}" title="${t.label}">${I(t.icon)}<span class="srv-tab-l">${t.label}</span></button>`).join('')}
          </nav>

          <div class="srv-rail-foot">
            <a class="srv-rail-back" href="#/portal/servers" title="All servers">${I('chevronLeft')}<span class="srv-tab-l">All servers</span></a>
          </div>
        </aside>

        <div class="srv-main">
          <button class="srv-rail-toggle" id="srv-rail-toggle" aria-controls="srv-rail" aria-expanded="false" title="Sections">
            ${I('menu')}<span>Sections</span>
          </button>
          <div class="srv-head" id="srv-head">
            <div class="srv-head-id">
              <div class="grow" style="min-width:0">
                <div class="row gap-8 wrap">
                  <h2 class="srv-title" title="${esc(s.name)}">${esc(s.name)}</h2>
                  <span id="srv-status-chip">${statusChip(suspended ? 'suspended' : s.status)}</span>
                </div>
                <div class="row gap-8 wrap tiny dim mt-6 srv-meta">
                  <span>${esc(typeLabel(s.server_type))}</span><span>·</span>
                  <span class="mono">${esc(serverAddress(s))}</span><span>·</span>
                  <span>${esc(s.node_name || 'local node')}</span>
                  ${s.jar_type ? `<span>·</span><span>${esc(s.jar_type)} ${esc(s.jar_version || '')}</span>` : ''}
                </div>
              </div>
            </div>
            <div class="srv-live" id="live-strip">
              ${[
        ['cpu', 'CPU'], ['memory', 'RAM'], ['disk', 'Disk'], ['uptime', 'Uptime']
      ].map(([key, label]) => `<div class="srv-live-cell">
                  <span class="srv-live-k">${label}</span><b class="mono srv-live-v" id="ls-${key}-v">—</b>
                  <div id="ls-${key}-b" class="srv-live-bar">${meter(0)}</div></div>`).join('')}
            </div>
          </div>

          ${suspended ? `<div class="banner-strip mt-14" style="border-color:rgba(251,113,133,.35);background:linear-gradient(100deg,rgba(251,113,133,.16),transparent)">${I('alert')}<span>This server is suspended${s.expiration_date ? ` (expired ${esc(fmt.date(s.expiration_date, false))})` : ''}. Power actions are disabled until an administrator renews it.</span></div>` : ''}

          <div class="power-bar" id="power-bar">
            <div class="power-group" role="group" aria-label="Server power">
              <button class="power-btn start" data-pw="start" ${suspended ? 'disabled' : ''} title="Start server"><span class="power-ico">${I('play')}</span><span class="power-label">Start</span></button>
              <button class="power-btn restart" data-pw="restart" ${suspended ? 'disabled' : ''} title="Restart server"><span class="power-ico">${I('restart')}</span><span class="power-label">Restart</span></button>
              <button class="power-btn stop" data-pw="stop" ${suspended ? 'disabled' : ''} title="Graceful shutdown"><span class="power-ico">${I('stop')}</span><span class="power-label">Stop</span></button>
              <button class="power-btn kill" data-pw="kill" ${suspended ? 'disabled' : ''} title="Force stop: terminate the process immediately"><span class="power-ico">${I('skull')}</span><span class="power-label">Force stop</span></button>
            </div>
            <div class="power-hint" id="power-hint">${suspended ? 'Power actions disabled while suspended' : 'Ready'}</div>
          </div>

          <div id="srv-tab-body" class="srv-tab-body mt-14"></div>
        </div>
        <div class="srv-rail-scrim" id="srv-rail-scrim" hidden></div>
      </div>`;

    /* sidebar: on phones it slides in from the left over the content */
    const rail = host.querySelector('#srv-rail');
    const railBtn = host.querySelector('#srv-rail-toggle');
    const railScrim = host.querySelector('#srv-rail-scrim');
    const setRail = (open) => {
      if (!rail) return;
      rail.classList.toggle('is-open', open);
      if (railScrim) railScrim.hidden = !open;
      if (railBtn) railBtn.setAttribute('aria-expanded', String(open));
    };
    if (railBtn) railBtn.onclick = () => setRail(!rail.classList.contains('is-open'));
    if (railScrim) railScrim.onclick = () => setRail(false);

    host.querySelectorAll('[data-tab]').forEach((b) => b.onclick = () => {
      setRail(false);
      location.hash = `#/server/${id}/${b.dataset.tab}`;
    });
    // the tab strip is wider than a phone: keep the active tab in view
    const activeTab = host.querySelector('#srv-tabs .tab.active');
    if (activeTab && activeTab.scrollIntoView) {
      try { activeTab.scrollIntoView({ block: 'nearest', inline: 'nearest' }); } catch (e) { /* older engines */ }
    }
    const hint = host.querySelector('#power-hint');
    const power = async (action) => {
      const label = POWER_LABEL[action] || action;
      if (hint) hint.textContent = `${label} requested…`;
      try {
        const r = await API.post(`/api/servers/${id}/power`, { action });
        toast(r.message || `${label} requested`, 'ok', 'Power action');
        updateStatus(action === 'stop' || action === 'kill' ? 'stopping' : 'starting');
      } catch (e) {
        if (hint) hint.textContent = e.message;
        toast(e.message, 'err');
      }
    };
    host.querySelectorAll('[data-pw]').forEach((b) => b.onclick = () => {
      const action = b.dataset.pw;
      if (action === 'kill') {
        return window.el.confirmDialog({
          title: 'Force stop the server?',
          message: 'The process is terminated immediately with SIGKILL — unsaved world data can be lost. Use only when the server is unresponsive.',
          confirmLabel: 'Force stop',
          onConfirm: () => power('kill')
        });
      }
      if (action === 'stop') {
        return window.el.confirmDialog({
          title: 'Stop the server?', message: 'A graceful shutdown lets Minecraft save the world before exiting.',
          confirmLabel: 'Stop server', danger: false, onConfirm: () => power('stop')
        });
      }
      power(action);
    });

    const body = document.getElementById('srv-tab-body');
    const renderers = {
      console: renderConsole, files: renderFiles, players: renderPlayers, worlds: renderWorlds,
      backups: renderBackups, schedules: renderSchedules, network: renderNetwork,
      users: renderSubusers, addons: renderAddons, settings: renderSettings,
      databases: (h, srv) => (window.DKX.Views.server.databases ? window.DKX.Views.server.databases(h, srv.id) : renderConsole(h, srv)),
      activity: renderActivity,
      marketplace: renderMarketplace
    };
    (renderers[tab] || renderConsole)(body, s, perms);
  }

  function updateStatus(status, stats) {
    const chip = document.getElementById('srv-status-chip');
    if (chip) chip.innerHTML = statusChip(status);
    if (stats) paintStats(stats);
  }

  function paintStats(stats) {
    const s = state.server || {};
    const cpu = Math.min(100, Math.round(stats.cpu || 0));
    // When the daemon cannot measure a process (no Docker and no /proc), say so
    // instead of drawing a confident 0%.
    const unmeasured = stats.measured === false;
    const mem = Math.round(stats.memory || 0);
    const memLimit = Number(s.memory_mb || 1024);
    const disk = Math.round(stats.disk || 0);
    const diskLimit = Number(s.disk_mb || 10240);
    const set = (k, text, pct) => {
      const v = document.getElementById(`ls-${k}-v`); if (v) v.textContent = text;
      const b = document.getElementById(`ls-${k}-b`);
      if (b) b.innerHTML = meter(pct, pct > 90 ? 'danger' : pct > 70 ? 'warn' : k === 'cpu' ? '' : 'live');
    };
    set('cpu', unmeasured ? 'not measured' : `${cpu}%`, unmeasured ? 0 : cpu);
    set('memory', unmeasured ? 'not measured' : `${fmt.mb(mem)} / ${fmt.mb(memLimit)}`, unmeasured ? 0 : (mem / memLimit) * 100);
    set('disk', `${fmt.mb(disk)} / ${fmt.mb(diskLimit)}`, (disk / diskLimit) * 100);
    const up = document.getElementById('ls-uptime-v');
    if (up) up.textContent = fmt.uptime(stats.uptime || 0);
    const b = document.getElementById('ls-uptime-b');
    if (b) b.innerHTML = `<div class="meter blue"><span style="width:100%"></span></div>`;
  }

  /* ---------------------------------------------------------------- console */
  /* The console workspace lives in js/console.js; this function only owns the
     socket and the data the console cannot fetch by itself. */
  function renderConsole(host, s) {
    const perms = state.server ? (state.server.permissions || []) : [];
    const Console = window.DKX.Console;
    if (!Console) {
      host.innerHTML = `<div class="card card-pad">${emptyState('alert', 'Console module missing', 'window.DKX.Console is not loaded — reload the panel.')}</div>`;
      return;
    }
    const statsApi = async () => {
      const r = await API.get(`/api/servers/${s.id}/stats`);
      return r.stats ? { ...r.stats, permissions: perms } : null;
    };

    Console.render(host, s, {
      address: serverAddress(s),
      history: state.history || '',
      connect: (onLine, onStats, onStatus) => {
        connectConsole(
          (chunk) => onLine(chunk),
          (stats) => onStats(stats),
          (status, stats) => {
            onStatus(status);
            updateStatus(status, stats);
          }
        );
      },
      ws: () => state.ws,
      sendHttp: async (command) => { await API.post(`/api/servers/${s.id}/command`, { command }); },
      stats: statsApi,
      setStats: (stats) => { state.stats = stats; paintStats(stats); },
      setStatus: (status) => updateStatus(status)
    });
  }

  /* ------------------------------------------------------------------ files */
  /* File manager: name-first rows, a real toolbar (new file / folder, upload,
     import from URL, refresh), and per-item actions with visible labels —
     Open / Edit / Download / Rename / Delete. Everything maps to a live
     /api/servers/:id/files/* endpoint; nothing here is decorative. */
  const fm = { path: '', sel: new Set() };
  const MENU_ICON = {
    txt: 'file', log: 'file', properties: 'sliders', yml: 'code', yaml: 'code', json: 'code',
    conf: 'code', sh: 'code', md: 'file', js: 'code', ts: 'code', toml: 'code', xml: 'code', csv: 'file'
  };
  const isArchive = (n) => /\.(zip|jar|tar|gz|tgz|rar|7z)$/i.test(n);
  const isEditable = (n) => !isArchive(n) && !/\.(png|jpe?g|gif|webp|ico|mp3|ogg|wav|mp4|mov|dll|so|dylib|class|exe)$/i.test(n);

  function fileIcon(name, isDir) {
    if (isDir) return 'folder';
    if (isArchive(name)) return 'archive';
    const ext = String(name).split('.').pop().toLowerCase();
    return MENU_ICON[ext] || 'file';
  }

  async function renderFiles(host, s) {
    /* ---- toolbar -------------------------------------------------------- */
    host.innerHTML = `
      <div class="card fm-card">
        <div class="fm-toolbar">
          <div class="fm-path">
            <button class="fm-up" id="fm-up" title="Up one level">${I('chevronLeft')}</button>
            <div class="fm-crumbs" id="fm-crumbs"></div>
          </div>
          <div class="fm-tools">
            <button class="btn btn-sm" id="fm-new-file">${I('file')} New file</button>
            <button class="btn btn-sm" id="fm-new-dir">${I('folder')} New folder</button>
            <label class="btn btn-sm btn-primary" for="fm-upload" role="button" tabindex="0">${I('upload')} Upload
              <input type="file" id="fm-upload" multiple hidden /></label>
            <button class="btn btn-sm" id="fm-import">${I('globe')} Import URL</button>
            <button class="btn btn-sm btn-ghost" id="fm-refresh" title="Reload this folder">${I('refresh')}</button>
          </div>
        </div>

        <div class="fm-bulk" id="fm-bulk" hidden>
          <span class="fm-bulk-n" id="fm-bulk-n">0 selected</span>
          <div class="row gap-6">
            <button class="btn btn-xs" id="fm-bulk-zip">${I('archive')} Zip</button>
            <button class="btn btn-xs btn-danger" id="fm-bulk-del">${I('trash')} Delete selected</button>
            <button class="btn btn-xs btn-ghost" id="fm-bulk-clear">Clear</button>
          </div>
        </div>

        <div class="fm-table-head" id="fm-table-head">
          <span class="fm-check"><input type="checkbox" id="fm-all" title="Select all" /></span>
          <span>Name</span>
          <span class="fm-col-size">Size</span>
          <span class="fm-col-date">Modified</span>
          <span class="fm-col-act">Actions</span>
        </div>
        <div class="fm-list" id="fm-list">${window.el.skeleton(5)}</div>
        <div class="fm-foot" id="fm-foot"></div>
      </div>
      <div class="fm-drop" id="fm-drop" hidden>${I('upload')} <span>Drop files to upload to <b id="fm-drop-path">/</b></span></div>`;

    const listEl = host.querySelector('#fm-list');
    const crumbsEl = host.querySelector('#fm-crumbs');
    const footEl = host.querySelector('#fm-foot');
    const bulkEl = host.querySelector('#fm-bulk');
    const dropEl = host.querySelector('#fm-drop');
    let rows = [];
    let loading = 0;

    const join = (name) => (fm.path ? `${fm.path}/${name}` : name);
    const parentOf = () => fm.path.split('/').slice(0, -1).join('/');

    /* ---- breadcrumbs + up ---------------------------------------------- */
    function paintCrumbs() {
      const parts = fm.path.split('/').filter(Boolean);
      crumbsEl.innerHTML = `<a data-crumb="" title="Server root">${I('folder')}<span>root</span></a>`
        + parts.map((p, i) => `<span class="fm-sep">/</span><a data-crumb="${esc(parts.slice(0, i + 1).join('/'))}"><span>${esc(p)}</span></a>`).join('');
      crumbsEl.querySelectorAll('[data-crumb]').forEach((a) => { a.onclick = () => load(a.dataset.crumb); });
      const up = host.querySelector('#fm-up');
      up.disabled = !fm.path;
      up.onclick = () => { if (fm.path) load(parentOf()); };
    }

    /* ---- bulk selection ------------------------------------------------- */
    function paintBulk() {
      const n = fm.sel.size;
      bulkEl.hidden = n === 0;
      host.querySelector('#fm-bulk-n').textContent = `${n} selected`;
      const all = host.querySelector('#fm-all');
      if (all) {
        all.checked = rows.length > 0 && n === rows.length;
        all.indeterminate = n > 0 && n < rows.length;
      }
    }

    /* ---- list ----------------------------------------------------------- */
    async function load(path) {
      fm.path = path || '';
      fm.sel.clear();
      paintCrumbs();
      paintBulk();
      const token = ++loading;
      listEl.innerHTML = window.el.skeleton(5);
      try {
        const r = await API.get(`/api/servers/${s.id}/files?directory=${encodeURIComponent(fm.path)}`);
        if (token !== loading) return; // a newer navigation won
        rows = (r.files || []).slice().sort((a, b) => (b.isDirectory - a.isDirectory) || a.name.localeCompare(b.name));
        if (!rows.length) {
          listEl.innerHTML = emptyState('folder', 'This folder is empty', 'Upload a file, create one, or import it from a URL.');
          footEl.textContent = `${fm.path ? '/' + fm.path : 'root'} · empty`;
          return;
        }
        listEl.innerHTML = rows.map((f) => `
          <div class="fm-row ${f.isDirectory ? 'dir' : ''}" data-name="${esc(f.name)}" data-dir="${f.isDirectory ? 1 : 0}">
            <span class="fm-check"><input type="checkbox" data-pick="${esc(f.name)}" title="Select ${esc(f.name)}" /></span>
            <span class="fm-name" title="${esc(f.name)}">
              <span class="fm-ico">${I(fileIcon(f.name, f.isDirectory))}</span>
              <span class="fm-label">${esc(f.name)}</span>
              ${f.isDirectory ? '<span class="fm-tag">folder</span>' : ''}
            </span>
            <span class="fm-size">${f.isDirectory ? '—' : esc(fmt.bytes(f.size))}</span>
            <span class="fm-date">${f.modifiedAt ? esc(fmt.date(f.modifiedAt)) : '—'}</span>
            <span class="fm-actions">
              ${f.isDirectory
        ? `<button class="btn btn-xs" data-open="${esc(f.name)}" title="Open folder">${I('folder')} <span class="fm-btn-l">Open</span></button>`
        : `<button class="btn btn-xs" data-edit="${esc(f.name)}" title="Edit ${esc(f.name)}">${I('edit')} <span class="fm-btn-l">Edit</span></button>
                   <button class="btn btn-xs btn-ghost" data-dl="${esc(f.name)}" title="Download ${esc(f.name)}">${I('download')} <span class="fm-btn-l">Download</span></button>`}
              <button class="btn btn-xs btn-ghost" data-ren="${esc(f.name)}" title="Rename ${esc(f.name)}">${I('edit')} <span class="fm-btn-l">Rename</span></button>
              <button class="btn btn-xs btn-ghost fm-del" data-del="${esc(f.name)}" title="Delete ${esc(f.name)}">${I('trash')} <span class="fm-btn-l">Delete</span></button>
            </span>
          </div>`).join('');

        footEl.textContent = `${fm.path ? '/' + fm.path : 'root'} · ${rows.length} item${rows.length === 1 ? '' : 's'} · ${rows.filter((f) => f.isDirectory).length} folder(s) · ${rows.filter((f) => !f.isDirectory).length} file(s)`;
        wireRows();
        paintBulk();
      } catch (e) {
        if (token !== loading) return;
        rows = [];
        listEl.innerHTML = emptyState('alert', 'Cannot read this folder', e.message);
        footEl.textContent = '';
      }
    }

    function openItem(name, isDir) {
      if (isDir) load(join(name));
      else openFile(join(name));
    }

    function wireRows() {
      listEl.querySelectorAll('.fm-row').forEach((row) => {
        const name = row.dataset.name;
        const isDir = row.dataset.dir === '1';
        // single click selects, double click opens — the usual file-manager feel
        row.onclick = (e) => {
          if (e.target.closest('button') || e.target.matches('input')) return;
          const box = row.querySelector('[data-pick]');
          if (!box) return;
          box.checked = !box.checked;
          row.classList.toggle('is-picked', box.checked);
          syncPick(box);
        };
        row.ondblclick = (e) => {
          if (e.target.closest('button') || e.target.matches('input')) return;
          openItem(name, isDir);
        };
        const pick = row.querySelector('[data-pick]');
        if (pick) pick.onchange = () => syncPick(pick);
      });
      listEl.querySelectorAll('[data-open]').forEach((b) => { b.onclick = (e) => { e.stopPropagation(); load(join(b.dataset.open)); }; });
      listEl.querySelectorAll('[data-edit]').forEach((b) => { b.onclick = (e) => { e.stopPropagation(); openFile(join(b.dataset.edit)); }; });
      listEl.querySelectorAll('[data-dl]').forEach((b) => { b.onclick = (e) => { e.stopPropagation(); download(b.dataset.dl); }; });
      listEl.querySelectorAll('[data-ren]').forEach((b) => { b.onclick = (e) => { e.stopPropagation(); rename(b.dataset.ren); }; });
      listEl.querySelectorAll('[data-del]').forEach((b) => { b.onclick = (e) => { e.stopPropagation(); remove(b.dataset.del); }; });
    }

    function syncPick(box) {
      if (box.checked) fm.sel.add(box.dataset.pick); else fm.sel.delete(box.dataset.pick);
      const row = box.closest('.fm-row');
      if (row) row.classList.toggle('is-picked', box.checked);
      paintBulk();
    }

    /* ---- actions -------------------------------------------------------- */
    async function download(name) {
      try {
        const res = await API.raw(`/api/servers/${s.id}/files/download?file=${encodeURIComponent(join(name))}`);
        const blob = await res.blob();
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob); a.download = name;
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 4000);
        toast(`Downloading ${name}`, 'ok');
      } catch (e) { toast(e.message, 'err', 'Download failed'); }
    }

    function rename(name) {
      window.el.promptDialog({
        title: `Rename “${name}”`, label: 'New name', value: name, confirmLabel: 'Rename',
        onSubmit: async (val) => {
          if (!val || val === name) return;
          await API.post(`/api/servers/${s.id}/files/rename`, { oldPath: join(name), newPath: join(val) });
          toast(`Renamed to ${val}`, 'ok'); load(fm.path);
        }
      });
    }

    function remove(name, after) {
      const isDir = (rows.find((r) => r.name === name) || {}).isDirectory;
      window.el.confirmDialog({
        title: `Delete “${name}”?`,
        message: isDir
          ? 'The folder and everything inside it is removed from the server disk. This cannot be undone.'
          : 'The file is removed from the server disk. This cannot be undone.',
        confirmLabel: 'Delete', danger: true,
        onConfirm: async () => {
          await API.post(`/api/servers/${s.id}/files/delete`, { itemPath: join(name) });
          toast(`Deleted ${name}`, 'ok');
          fm.sel.delete(name);
          load(fm.path);
          if (after) after();
        }
      });
    }

    async function openFile(filePath) {
      let content = '';
      try {
        const r = await API.get(`/api/servers/${s.id}/files/content?file=${encodeURIComponent(filePath)}`);
        content = r.content;
      } catch (e) {
        // binary / oversized files cannot be edited as text — offer the download
        // instead of an empty editor that would destroy the file on save
        toast(e.message, 'err', 'Cannot open as text');
        return;
      }
      const name = filePath.split('/').pop();
      window.el.modal({
        title: name, subtitle: filePath, size: 'wide',
        body: `<div class="fm-editor-bar">
            <span class="chip chip-plain tiny mono">${esc((name.split('.').pop() || 'txt').toUpperCase())}</span>
            <span class="dim tiny" id="fm-ed-lines">${content.split('\n').length} lines</span>
            <span class="grow"></span>
            <span class="dim tiny" id="fm-ed-state">unchanged</span>
          </div>
          <textarea class="code-editor" id="fm-editor" spellcheck="false" autocomplete="off" style="min-height:min(62vh,560px)">${esc(content)}</textarea>`,
        footer: `<button class="btn" data-cancel>Close</button><button class="btn btn-primary" data-save>${I('save')} Save file</button>`,
        onMount(wrap, close) {
          const ta = wrap.querySelector('#fm-editor');
          const stateEl = wrap.querySelector('#fm-ed-state');
          const linesEl = wrap.querySelector('#fm-ed-lines');
          ta.addEventListener('input', () => {
            stateEl.textContent = 'unsaved changes';
            stateEl.classList.add('fm-dirty');
            linesEl.textContent = `${ta.value.split('\n').length} lines`;
          });
          // Ctrl/Cmd+S saves without leaving the editor
          ta.addEventListener('keydown', (e) => {
            if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); wrap.querySelector('[data-save]').click(); }
            if (e.key === 'Tab') {
              e.preventDefault();
              const a = ta.selectionStart;
              ta.value = `${ta.value.slice(0, a)}  ${ta.value.slice(ta.selectionEnd)}`;
              ta.selectionStart = ta.selectionEnd = a + 2;
              ta.dispatchEvent(new Event('input'));
            }
          });
          wrap.querySelector('[data-cancel]').onclick = close;
          wrap.querySelector('[data-save]').onclick = async () => {
            const btn = wrap.querySelector('[data-save]');
            btn.disabled = true;
            try {
              await API.post(`/api/servers/${s.id}/files/content`, { filePath, content: ta.value });
              toast(`${name} saved`, 'ok');
              close();
              load(fm.path);
            } catch (e) {
              btn.disabled = false;
              toast(e.message, 'err', 'Save failed');
            }
          };
        }
      });
    }

    async function createFile(name) {
      await API.post(`/api/servers/${s.id}/files/content`, { filePath: join(name), content: '' });
      toast(`Created ${name}`, 'ok');
      load(fm.path);
    }

    async function uploadFiles(files) {
      if (!files.length) return;
      toast(`Uploading ${files.length} file${files.length === 1 ? '' : 's'}…`, 'info', 'Upload');
      let done = 0;
      const failed = [];
      for (const f of files) {
        const fd = new FormData();
        fd.append('file', f);
        try {
          const r = await API.upload(`/api/servers/${s.id}/files/upload?directory=${encodeURIComponent(fm.path || '')}`, fd);
          done++;
          // the upload endpoint hands the stored bytes back so the UI can prove
          // what landed instead of assuming the request worked
          void r;
        } catch (err) { failed.push(`${f.name}: ${err.message}`); }
      }
      toast(`${done}/${files.length} uploaded to /${fm.path || ''}`, failed.length ? 'err' : 'ok', 'Upload');
      failed.slice(0, 3).forEach((m) => toast(m, 'err'));
      load(fm.path);
    }

    /* ---- importing from a URL (direct download link) -------------------- */
    function importDialog() {
      window.el.modal({
        title: 'Import from URL', subtitle: `Downloads into /${fm.path || ''}`,
        body: `<div class="col gap-12">
            <label class="field"><span class="field-label">Direct download link</span>
              <input class="input" id="fm-url" placeholder="https://example.com/plugin-1.2.3.jar" autocomplete="off" spellcheck="false" /></label>
            <div class="row gap-8"><button class="btn btn-sm" id="fm-url-check">${I('search')} Inspect link</button>
              <span class="dim tiny" id="fm-url-info">Paste a direct file URL — pages that need a browser login will not work here.</span></div>
            <label class="field"><span class="field-label">Save as <span class="dim">(optional)</span></span>
              <input class="input" id="fm-url-name" placeholder="filename.jar" autocomplete="off" spellcheck="false" /></label>
          </div>`,
        footer: `<button class="btn" data-cancel>Cancel</button><button class="btn btn-primary" id="fm-url-go">${I('download')} Download file</button>`,
        onMount(wrap, close) {
          const urlEl = wrap.querySelector('#fm-url');
          const nameEl = wrap.querySelector('#fm-url-name');
          const info = wrap.querySelector('#fm-url-info');
          const check = wrap.querySelector('#fm-url-check');
          const go = wrap.querySelector('#fm-url-go');
          wrap.querySelector('[data-cancel]').onclick = close;
          check.onclick = async () => {
            const url = urlEl.value.trim();
            if (!/^https?:\/\//i.test(url)) { info.textContent = 'Enter a full http(s) link.'; return; }
            check.disabled = true; info.textContent = 'Asking the server to inspect the link…';
            try {
              const r = await API.post(`/api/servers/${s.id}/files/pull-url/query`, { url });
              info.textContent = r.size
                ? `${r.filename} · ${fmt.bytes(r.size)} · ${r.contentType}`
                : `${r.filename} · size unknown from this host (the download may still work)`;
              if (!nameEl.value) nameEl.value = r.filename || '';
            } catch (e) { info.textContent = e.message; }
            check.disabled = false;
          };
          go.onclick = async () => {
            const url = urlEl.value.trim();
            if (!/^https?:\/\//i.test(url)) { info.textContent = 'Enter a full http(s) link.'; return; }
            go.disabled = true; go.textContent = 'Downloading…';
            try {
              const r = await API.post(`/api/servers/${s.id}/files/pull-url`, {
                url, directory: fm.path || '', filename: (nameEl.value || '').trim() || undefined
              });
              toast(`Saved ${r.filename}${r.size ? ` (${fmt.bytes(r.size)})` : ''}`, 'ok', 'Import');
              close();
              load(fm.path);
            } catch (e) {
              go.disabled = false;
              go.innerHTML = `${I('download')} Download file`;
              info.textContent = e.message;
              toast(e.message, 'err', 'Import failed');
            }
          };
          urlEl.focus();
        }
      });
    }

    /* ---- toolbar wiring ------------------------------------------------- */
    host.querySelector('#fm-refresh').onclick = () => load(fm.path);
    host.querySelector('#fm-new-dir').onclick = () => window.el.promptDialog({
      title: 'New folder', label: 'Folder name', value: '', confirmLabel: 'Create folder',
      onSubmit: async (name) => {
        if (!name) return;
        await API.post(`/api/servers/${s.id}/files/directory`, { dirPath: join(name) });
        toast(`Created /${join(name)}`, 'ok'); load(fm.path);
      }
    });
    host.querySelector('#fm-new-file').onclick = () => window.el.promptDialog({
      title: 'New file', label: 'File name', value: '', confirmLabel: 'Create file',
      onSubmit: async (name) => { if (name) await createFile(name); }
    });
    host.querySelector('#fm-import').onclick = importDialog;

    const uploadInput = host.querySelector('#fm-upload');
    uploadInput.addEventListener('change', (e) => {
      const files = Array.from(e.target.files || []);
      e.target.value = '';
      uploadFiles(files);
    });
    // the label is styled as a button, so keyboard users need Enter/Space
    host.querySelector('label[for="fm-upload"]').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); uploadInput.click(); }
    });

    host.querySelector('#fm-all').onchange = (e) => {
      fm.sel.clear();
      if (e.target.checked) rows.forEach((r) => fm.sel.add(r.name));
      listEl.querySelectorAll('[data-pick]').forEach((b) => {
        b.checked = e.target.checked;
        const row = b.closest('.fm-row');
        if (row) row.classList.toggle('is-picked', b.checked);
      });
      paintBulk();
    };
    host.querySelector('#fm-bulk-clear').onclick = () => {
      fm.sel.clear();
      listEl.querySelectorAll('[data-pick]').forEach((b) => {
        b.checked = false;
        const row = b.closest('.fm-row');
        if (row) row.classList.remove('is-picked');
      });
      paintBulk();
    };
    host.querySelector('#fm-bulk-del').onclick = () => {
      const names = [...fm.sel];
      if (!names.length) return;
      window.el.confirmDialog({
        title: `Delete ${names.length} item(s)?`,
        message: `Removed from disk: ${names.slice(0, 4).join(', ')}${names.length > 4 ? ` and ${names.length - 4} more` : ''}. This cannot be undone.`,
        confirmLabel: 'Delete selected', danger: true,
        onConfirm: async () => {
          const failed = [];
          for (const n of names) {
            try { await API.post(`/api/servers/${s.id}/files/delete`, { itemPath: join(n) }); }
            catch (e) { failed.push(`${n}: ${e.message}`); }
          }
          toast(`${names.length - failed.length}/${names.length} deleted`, failed.length ? 'err' : 'ok');
          failed.forEach((m) => toast(m, 'err'));
          fm.sel.clear(); load(fm.path);
        }
      });
    };
    host.querySelector('#fm-bulk-zip').onclick = () => {
      const names = [...fm.sel];
      if (!names.length) return;
      window.el.promptDialog({
        title: `Zip ${names.length} item(s)`, label: 'Archive name', value: 'archive.zip', confirmLabel: 'Create archive',
        onSubmit: async (out) => {
          await API.post(`/api/servers/${s.id}/files/compress`, {
            files: names.map(join), outputName: join(out || 'archive.zip')
          });
          toast(`Created ${out}`, 'ok'); fm.sel.clear(); load(fm.path);
        }
      });
    };

    /* ---- drag & drop upload --------------------------------------------- */
    let dragDepth = 0;
    const card = host.querySelector('.fm-card');
    const showDrop = (on) => { dropEl.hidden = !on; card.classList.toggle('is-drop', on); };
    card.addEventListener('dragenter', (e) => {
      if (!e.dataTransfer || !Array.from(e.dataTransfer.types || []).includes('Files')) return;
      e.preventDefault(); dragDepth++; host.querySelector('#fm-drop-path').textContent = fm.path ? `/${fm.path}` : '/'; showDrop(true);
    });
    card.addEventListener('dragover', (e) => { if (e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files')) e.preventDefault(); });
    card.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) showDrop(false); });
    card.addEventListener('drop', (e) => {
      if (!e.dataTransfer) return;
      e.preventDefault(); dragDepth = 0; showDrop(false);
      const files = Array.from(e.dataTransfer.files || []);
      if (files.length) uploadFiles(files);
    });

    paintCrumbs();
    load('');
  }

  /* ---------------------------------------------------------------- players */
  async function renderPlayers(host, s) {
    host.innerHTML = `<div class="card"><div class="card-head"><div class="grow"><h3>Players</h3><div class="card-sub">Online players parsed live from the server console plus known player data</div></div>
      <button class="btn btn-sm" id="pl-refresh">${I('refresh')} Refresh</button></div>
      <div id="pl-body">${window.el.skeleton(4)}</div></div>`;
    document.getElementById('pl-refresh').onclick = () => window.DKX.Router.resolve();
    try {
      const r = await API.get(`/api/servers/${s.id}/players`);
      const online = (r.players && r.players.online) || r.onlinePlayers || [];
      const known = r.allPlayers || (r.players && r.players.all) || [];
      const onlineNames = new Set(online.map((p) => p.name));
      const rows = [];
      online.forEach((p) => rows.push({ ...p, online: true }));
      known.forEach((p) => { if (!onlineNames.has(p.name)) rows.push({ ...p, online: false }); });
      (document.getElementById('pl-body') || {}).innerHTML = rows.length ? `
        <div class="table-wrap"><table class="data">
          <thead><tr><th>Player</th><th>State</th><th>Playtime / Last seen</th><th></th></tr></thead>
          <tbody>${rows.map((p) => `<tr>
            <td><div class="row gap-8"><div class="avatar" style="width:26px;height:26px;flex-basis:26px;border-radius:8px;font-size:10px">${esc(fmt.initials(p.name || p.username))}</div><b>${esc(p.name || p.username || '—')}</b></div></td>
            <td>${p.online ? '<span class="chip chip-live"><i class="dot live"></i>Online</span>' : '<span class="chip">Offline</span>'}</td>
            <td class="dim">${esc(p.lastSeen ? fmt.ago(p.lastSeen) : p.playtime ? fmt.uptime(p.playtime) : '—')}</td>
            <td><div class="cell-actions">
              <button class="btn btn-xs" data-cmd="op ${esc(p.name || p.username)}">${I('shield')} OP</button>
              <button class="btn btn-xs" data-cmd="kick ${esc(p.name || p.username)}">Kick</button>
              <button class="btn btn-xs btn-danger" data-cmd="ban ${esc(p.name || p.username)}">Ban</button>
            </div></td>
          </tr>`).join('')}</tbody></table></div>`
        : emptyState('users', 'No players yet', 'Player data appears once someone joins the server.');
      document.querySelectorAll('[data-cmd]').forEach((b) => b.onclick = async () => {
        const cmd = b.dataset.cmd;
        try { await API.post(`/api/servers/${s.id}/command`, { command: cmd }); toast(`Sent: ${cmd}`, 'ok'); }
        catch (e) { toast(e.message, 'err'); }
      });
    } catch (e) {
      (document.getElementById('pl-body') || {}).innerHTML = emptyState('info', 'Player list unavailable', e.message);
    }
  }

  /* ----------------------------------------------------------------- worlds */
  async function renderWorlds(host, s) {
    host.innerHTML = `<div class="card">
      <div class="card-head"><div class="grow"><h3>Worlds</h3><div class="card-sub">Activate, clone, reset or download world folders</div></div>
        <button class="btn btn-sm" id="w-refresh">${I('refresh')}</button></div>
      <div id="w-body">${window.el.skeleton(4)}</div></div>`;
    const wBody = () => document.getElementById('w-body');
    const paint = async () => {
      try {
        const r = await API.get(`/api/servers/${s.id}/worlds`);
        const worlds = r.worlds || [];
        const activeName = r.activeWorld;
        const wb = wBody(); if (!wb) return; // tab switched away while loading
        wb.innerHTML = worlds.length ? `
          <div class="table-wrap"><table class="data">
            <thead><tr><th>World</th><th>Size</th><th>Active</th><th>Modified</th><th></th></tr></thead>
            <tbody>${worlds.map((w) => `<tr>
              <td><b>${esc(w.name)}</b><div class="tiny dim">${esc(w.gameMode || 'Survival')} · ${esc(w.difficulty || 'default')}${w.hasNether ? ' · nether' : ''}${w.hasEnd ? ' · end' : ''}</div></td>
              <td class="num dim">${esc(w.sizeFormatted || fmt.bytes(w.sizeBytes))}</td>
              <td>${w.isActive || w.name === activeName ? '<span class="chip chip-live">Active</span>' : '<span class="chip">Idle</span>'}</td>
              <td class="dim">${esc(w.lastPlayed ? fmt.ago(w.lastPlayed) : '—')}</td>
              <td><div class="cell-actions">
                ${!(w.isActive || w.name === activeName) ? `<button class="btn btn-xs" data-act="${esc(w.name)}">${I('check')} Activate</button>` : ''}
                <button class="btn btn-xs" data-clone="${esc(w.name)}">${I('copy')} Clone</button>
                <button class="btn btn-xs btn-danger" data-del="${esc(w.name)}">${I('trash')}</button>
              </div></td>
            </tr>`).join('')}</tbody></table></div>`
          : emptyState('map', 'No worlds found', 'Start the server once so it generates its first world.');
        document.querySelectorAll('[data-act]').forEach((b) => b.onclick = async () => {
          try { await API.post(`/api/servers/${s.id}/worlds/activate`, { worldName: b.dataset.act }); toast('World activated', 'ok'); paint(); } catch (e) { toast(e.message, 'err'); }
        });
        document.querySelectorAll('[data-clone]').forEach((b) => b.onclick = () => window.el.promptDialog({
          title: 'Clone world', label: 'New world name', value: `${b.dataset.clone}-copy`, confirmLabel: 'Clone',
          onSubmit: async (name) => { await API.post(`/api/servers/${s.id}/worlds/clone`, { sourceWorld: b.dataset.clone, newName: name }); toast('World cloned', 'ok'); paint(); }
        }));
        document.querySelectorAll('[data-del]').forEach((b) => b.onclick = () => window.el.confirmDialog({
          title: `Delete ${b.dataset.del}?`, message: 'The world folder will be permanently removed from disk.', confirmLabel: 'Delete',
          onConfirm: async () => { await API.post(`/api/servers/${s.id}/worlds/delete`, { worldName: b.dataset.del }); toast('World deleted', 'ok'); paint(); }
        }));
      } catch (e) { const wb = wBody(); if (wb) wb.innerHTML = emptyState('info', 'Worlds unavailable', e.message); }
    };
    const wRefresh = document.getElementById('w-refresh');
    if (wRefresh) wRefresh.onclick = paint;
    paint();
  }

  /* ---------------------------------------------------------------- backups */
  async function renderBackups(host, s) {
    host.innerHTML = `<div class="card">
      <div class="card-head"><div class="grow"><h3>Backups</h3><div class="card-sub">Snapshot the whole server directory and restore in one click</div></div>
        <button class="btn btn-sm btn-primary" id="b-create">${I('plus')} Create backup</button></div>
      <div id="b-body">${window.el.skeleton(4)}</div></div>`;
    const paint = async () => {
      try {
        const r = await API.get(`/api/servers/${s.id}/backups`);
        const backups = r.backups || [];
        (document.getElementById('b-body') || {}).innerHTML = backups.length ? `
          <div class="table-wrap"><table class="data">
            <thead><tr><th>Name</th><th>Size</th><th>Type</th><th>Created</th><th></th></tr></thead>
            <tbody>${backups.map((b) => `<tr>
              <td><b>${esc(b.name)}</b><div class="tiny dim mono">${esc(b.fileName || b.file_name || '')}</div></td>
              <td class="num">${esc(fmt.bytes(b.fileSize !== undefined ? b.fileSize : b.file_size))}</td>
              <td>${(b.isLocked !== undefined ? b.isLocked : b.is_locked) ? '<span class="chip chip-warn"><i class="dot warn"></i>Locked</span>' : (b.isAutomatic !== undefined ? b.isAutomatic : b.is_automatic) ? '<span class="chip chip-info">Auto</span>' : '<span class="chip">Manual</span>'}</td>
              <td class="dim">${esc(fmt.date(b.createdAt || b.created_at))}</td>
              <td><div class="cell-actions">
                <button class="btn btn-xs" data-restore="${b.id}">${I('rotate')} Restore</button>
                <button class="btn btn-xs btn-ghost" data-lock="${b.id}" data-locked="${(b.isLocked !== undefined ? b.isLocked : b.is_locked) ? 1 : 0}">${I((b.isLocked !== undefined ? b.isLocked : b.is_locked) ? 'unlock' : 'lock')}</button>
                <button class="btn btn-xs btn-danger" data-del="${b.id}">${I('trash')}</button>
              </div></td>
            </tr>`).join('')}</tbody></table></div>`
          : emptyState('archive', 'No backups yet', 'Create your first snapshot — you can restore it at any time.', `<button class="btn btn-sm btn-primary" id="b-create-2">${I('plus')} Create backup</button>`);
        const c2 = document.getElementById('b-create-2');
        if (c2) c2.onclick = create;
        document.querySelectorAll('[data-restore]').forEach((b) => b.onclick = () => window.el.confirmDialog({
          title: 'Restore backup?', message: 'The current server files will be overwritten by this backup. Stop the server first for a clean restore.',
          confirmLabel: 'Restore now', danger: false,
          onConfirm: async () => { await API.post(`/api/servers/${s.id}/backups/${b.dataset.restore}/restore`); toast('Restore started', 'ok'); paint(); }
        }));
        document.querySelectorAll('[data-lock]').forEach((b) => b.onclick = async () => {
          const locked = b.dataset.locked === '1';
          try { await API.post(`/api/servers/${s.id}/backups/${b.dataset.lock}/lock`, { locked: !locked }); paint(); } catch (e) { toast(e.message, 'err'); }
        });
        document.querySelectorAll('[data-del]').forEach((b) => b.onclick = () => window.el.confirmDialog({
          title: 'Delete backup?', message: 'This permanently removes the archive from disk.', confirmLabel: 'Delete',
          onConfirm: async () => { await API.del(`/api/servers/${s.id}/backups/${b.dataset.del}`); toast('Backup deleted', 'ok'); paint(); }
        }));
      } catch (e) { (document.getElementById('b-body') || {}).innerHTML = emptyState('info', 'Backups unavailable', e.message); }
    };
    const create = async () => {
      try { toast('Creating backup — this can take a moment…', 'info'); await API.post(`/api/servers/${s.id}/backups`, { name: `manual-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}` }); toast('Backup created', 'ok'); paint(); }
      catch (e) { toast(e.message, 'err'); }
    };
    document.getElementById('b-create').onclick = create;
    paint();
  }

  /* -------------------------------------------------------------- schedules */
  async function renderSchedules(host, s) {
    host.innerHTML = `<div class="card">
      <div class="card-head"><div class="grow"><h3>Schedules</h3><div class="card-sub">Cron-driven power actions and commands</div></div>
      <button class="btn btn-sm btn-primary" id="sc-add">${I('plus')} New schedule</button></div>
      <div id="sc-body">${window.el.skeleton(4)}</div></div>`;
    const actions = [['start', 'Start server'], ['stop', 'Stop server'], ['restart', 'Restart server'], ['command', 'Send command'], ['backup', 'Create backup']];
    const paint = async () => {
      try {
        const r = await API.get(`/api/servers/${s.id}/schedules`);
        const list = r.schedules || [];
        (document.getElementById('sc-body') || {}).innerHTML = list.length ? `
          <div class="table-wrap"><table class="data">
            <thead><tr><th>Name</th><th>Cron</th><th>Action</th><th>Active</th><th>Last run</th><th></th></tr></thead>
            <tbody>${list.map((x) => `<tr>
              <td><b>${esc(x.name)}</b>${x.payload ? `<div class="tiny dim mono">${esc(String(x.payload).slice(0, 40))}</div>` : ''}</td>
              <td class="mono">${esc(x.cron_expression || x.cronExpression || '')}</td>
              <td><span class="chip chip-onyx">${esc(x.action_type || x.actionType || '')}</span></td>
              <td>${(x.is_active !== undefined ? x.is_active : x.isActive) ? '<span class="chip chip-live">Active</span>' : '<span class="chip">Paused</span>'}</td>
              <td class="dim">${esc(x.last_run_at || x.lastRunAt ? fmt.ago(x.last_run_at || x.lastRunAt) : 'never')}</td>
              <td><div class="cell-actions">
                <button class="btn btn-xs" data-toggle="${x.id}" data-active="${(x.is_active !== undefined ? x.is_active : x.isActive) ? 1 : 0}">${I((x.is_active !== undefined ? x.is_active : x.isActive) ? 'minus' : 'play')}</button>
                <button class="btn btn-xs btn-danger" data-del="${x.id}">${I('trash')}</button>
              </div></td>
            </tr>`).join('')}</tbody></table></div>`
          : emptyState('clock', 'No schedules', 'Automate restarts, backups and broadcasts on a cron schedule.');
        document.querySelectorAll('[data-toggle]').forEach((b) => b.onclick = async () => {
          try { await API.put(`/api/servers/${s.id}/schedules/${b.dataset.toggle}`, { is_active: b.dataset.active !== '1' }); paint(); } catch (e) { toast(e.message, 'err'); }
        });
        document.querySelectorAll('[data-del]').forEach((b) => b.onclick = () => window.el.confirmDialog({
          title: 'Delete schedule?', message: 'This schedule will stop running immediately.', confirmLabel: 'Delete',
          onConfirm: async () => { await API.del(`/api/servers/${s.id}/schedules/${b.dataset.del}`); paint(); }
        }));
      } catch (e) { (document.getElementById('sc-body') || {}).innerHTML = emptyState('info', 'Schedules unavailable', e.message); }
    };
    document.getElementById('sc-add').onclick = () => {
      window.el.modal({
        title: 'New schedule', subtitle: 'Use a standard 5-part cron expression',
        body: `<div class="col gap-14">
          <div class="field"><label>Name</label><input class="input" id="sc-name" placeholder="Daily restart" /></div>
          <div class="two-col">
            <div class="field"><label>Cron expression</label><input class="input mono" id="sc-cron" placeholder="0 4 * * *" value="0 4 * * *" /></div>
            <div class="field"><label>Action</label><select class="select" id="sc-action">${actions.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select></div>
          </div>
          <div class="field"><label>Payload <span class="hint">(command to run, optional)</span></label><input class="input mono" id="sc-payload" placeholder="say Restarting in 5 minutes" /></div>
          <div class="hint">Examples — <span class="mono">0 4 * * *</span> daily at 04:00 · <span class="mono">*/30 * * * *</span> every 30 min · <span class="mono">0 */6 * * *</span> every 6 hours</div>
        </div>`,
        footer: `<button class="btn" data-cancel>Cancel</button><button class="btn btn-primary" data-ok>Create schedule</button>`,
        onMount(wrap, close) {
          wrap.querySelector('[data-cancel]').onclick = close;
          wrap.querySelector('[data-ok]').onclick = async () => {
            try {
              await API.post(`/api/servers/${s.id}/schedules`, {
                name: wrap.querySelector('#sc-name').value || 'Schedule',
                cron_expression: wrap.querySelector('#sc-cron').value,
                action_type: wrap.querySelector('#sc-action').value,
                payload: wrap.querySelector('#sc-payload').value
              });
              toast('Schedule created', 'ok'); close(); paint();
            } catch (e) { toast(e.message, 'err'); }
          };
        }
      });
    };
    paint();
  }

  /* ---------------------------------------------------------------- network */
  async function renderNetwork(host, s) {
    host.innerHTML = `<div class="split">
      <div class="card"><div class="card-head"><h3>Network allocations</h3></div><div id="net-body">${window.el.skeleton(3)}</div></div>
      <div class="card"><div class="card-head"><h3>Connection details</h3></div><div class="card-body">
        <div class="section-label">Game address</div>${window.el.copyField(serverAddress(s))}
        <div class="section-label mt-14">SFTP</div>${window.el.copyField(`sftp://${s.sftp_username || 'user.' + s.id}@${s.sftp_host || location.hostname}:${s.sftp_port || 3004}`)}
      </div></div>
    </div>`;
    try {
      const r = await API.get(`/api/servers/${s.id}/network`);
      const allocs = r.allocations || r.network || [];
      (document.getElementById('net-body') || {}).innerHTML = allocs.length ? `<div class="table-wrap"><table class="data">
        <thead><tr><th>IP</th><th>Port</th><th>Primary</th><th></th></tr></thead>
        <tbody>${allocs.map((a) => `<tr><td class="mono">${esc(a.ip)}</td><td class="mono">${esc(a.port)}</td>
          <td>${Number(a.id) === Number(s.allocation_id) ? '<span class="chip chip-live">Primary</span>' : '<span class="chip">Secondary</span>'}</td>
          <td><div class="cell-actions">${Number(a.id) !== Number(s.allocation_id) ? `<button class="btn btn-xs" data-primary="${a.id}">Make primary</button>` : ''}</div></td></tr>`).join('')}</tbody></table></div>`
        : emptyState('network', 'No allocations', 'Assign ports from the admin network page.');
      document.querySelectorAll('[data-primary]').forEach((b) => b.onclick = async () => {
        try { await API.post(`/api/servers/${s.id}/network/primary`, { allocationId: b.dataset.primary }); toast('Primary allocation updated', 'ok'); window.DKX.Router.resolve(); }
        catch (e) { toast(e.message, 'err'); }
      });
    } catch (e) { (document.getElementById('net-body') || {}).innerHTML = emptyState('info', 'Network unavailable', e.message); }
  }

  /* --------------------------------------------------------------- subusers */
  async function renderSubusers(host, s) {
    const ALL_PERMS = ['console.view', 'console.command', 'power.control', 'files.read', 'files.write', 'backups.read', 'backups.create', 'schedules.read', 'schedules.create', 'settings.view', 'settings.edit', 'subusers.read', 'subusers.create', 'players.read', 'players.manage'];
    host.innerHTML = `<div class="card">
      <div class="card-head"><div class="grow"><h3>Sub-users</h3><div class="card-sub">Give other accounts scoped access to this server</div></div>
      <button class="btn btn-sm btn-primary" id="su-add">${I('plus')} Invite user</button></div>
      <div id="su-body">${window.el.skeleton(3)}</div></div>`;
    const paint = async () => {
      try {
        const r = await API.get(`/api/servers/${s.id}/subusers`);
        const subs = r.subusers || [];
        (document.getElementById('su-body') || {}).innerHTML = subs.length ? `<div class="table-wrap"><table class="data">
          <thead><tr><th>User</th><th>Email</th><th>Permissions</th><th></th></tr></thead>
          <tbody>${subs.map((u) => `<tr>
            <td><b>${esc(u.username)}</b></td><td class="dim">${esc(u.email)}</td>
            <td><div class="row wrap gap-4">${(u.permissions || []).slice(0, 4).map((p) => `<span class="chip chip-plain tiny mono">${esc(p)}</span>`).join('')}${(u.permissions || []).length > 4 ? `<span class="chip chip-plain tiny">+${u.permissions.length - 4}</span>` : ''}</div></td>
            <td><div class="cell-actions"><button class="btn btn-xs btn-danger" data-del="${u.id}">${I('trash')}</button></div></td>
          </tr>`).join('')}</tbody></table></div>`
          : emptyState('shield', 'No sub-users', 'You are the only one with access to this server.');
        document.querySelectorAll('[data-del]').forEach((b) => b.onclick = () => window.el.confirmDialog({
          title: 'Remove sub-user?', message: 'They will immediately lose access to this server.', confirmLabel: 'Remove',
          onConfirm: async () => { await API.del(`/api/servers/${s.id}/subusers/${b.dataset.del}`); paint(); }
        }));
      } catch (e) { (document.getElementById('su-body') || {}).innerHTML = emptyState('info', 'Sub-users unavailable', e.message); }
    };
    document.getElementById('su-add').onclick = () => {
      window.el.modal({
        title: 'Invite sub-user', subtitle: 'The account must already exist on the panel',
        body: `<div class="col gap-14">
          <div class="field"><label>Username or email</label><input class="input" id="su-user" placeholder="username or user@mail.com" /></div>
          <div class="field"><label>Permissions</label>
            <div class="row wrap gap-8" style="max-height:220px;overflow:auto">
              ${ALL_PERMS.map((p) => `<label class="checkbox"><input type="checkbox" value="${p}" ${['console.view', 'files.read'].includes(p) ? 'checked' : ''}/> <span class="mono tiny">${esc(p)}</span></label>`).join('')}
            </div>
          </div>
        </div>`,
        footer: `<button class="btn" data-cancel>Cancel</button><button class="btn btn-primary" data-ok>Add sub-user</button>`,
        onMount(wrap, close) {
          wrap.querySelector('[data-cancel]').onclick = close;
          wrap.querySelector('[data-ok]').onclick = async () => {
            const perms = Array.from(wrap.querySelectorAll('input[type=checkbox]:checked')).map((c) => c.value);
            try {
              await API.post(`/api/servers/${s.id}/subusers`, { userIdentifier: wrap.querySelector('#su-user').value.trim(), permissions: perms });
              toast('Sub-user added', 'ok'); close(); paint();
            } catch (e) { toast(e.message, 'err'); }
          };
        }
      });
    };
    paint();
  }

  /* ------------------------------------------------------------ marketplace */
  /* Catalogue + one-click install straight into THIS server's plugins/ or
     mods/ folder, plus the files already installed. The catalogue comes from
     the public /api/marketplace endpoints; installed state is read from disk
     by the server-scoped /api/servers/:id/addons/marketplace endpoint. */
  async function renderMarketplace(host, s) {
    const loader = String(s.jar_type || '').toLowerCase();
    const isModServer = ['fabric', 'forge', 'neoforge', 'quilt'].includes(loader);
    const isMinecraft = s.server_type === 'minecraft';
    const st = { tab: 'plugins', query: '', type: isModServer ? 'mod' : 'plugin', kind: 'modrinth', items: [], loaded: false };

    if (!isMinecraft) {
      host.innerHTML = `<div class="card card-pad">${emptyState('package', 'Marketplace is for Minecraft servers',
        `This is a ${esc(typeLabel(s.server_type))} server — plugins and mods cannot be installed into it. Use Files to manage its code.`)}</div>`;
      return;
    }

    host.innerHTML = `<div class="mk-view">
      <div class="card">
        <div class="card-head">
          <div class="grow"><h3>Marketplace</h3>
            <div class="card-sub">Resources install into <span class="mono">${isModServer ? 'mods/' : 'plugins/'}</span> on <b>${esc(s.name)}</b> — restart the server afterwards to load them</div></div>
          <div class="row gap-8">
            <div class="input-group" style="width:260px">
              <input class="input" id="mk-q" placeholder="Search ${isModServer ? 'mods' : 'plugins'}…" value="essentials" />
            </div>
            <button class="btn btn-sm" id="mk-go">${I('search')} Search</button>
          </div>
        </div>
        <div class="mk-body">
          <div class="tabs" id="mk-tabs">
            <button class="tab active" data-mk="catalogue">${I('package')} Catalogue</button>
            <button class="tab" data-mk="installed">${I('archive')} Installed <span class="mk-count" id="mk-installed-count">—</span></button>
            <button class="tab" data-mk="worlds">${I('map')} Worlds</button>
          </div>
          <div id="mk-pane" class="mt-14">${window.el.skeleton(4)}</div>
        </div>
      </div>
    </div>`;

    const pane = host.querySelector('#mk-pane');
    const qInput = host.querySelector('#mk-q');

    const setTab = (t) => {
      st.tab = t;
      host.querySelectorAll('[data-mk]').forEach((b) => b.classList.toggle('active', b.dataset.mk === t));
      paint();
    };
    host.querySelectorAll('[data-mk]').forEach((b) => b.onclick = () => setTab(b.dataset.mk));

    const runSearch = () => { st.query = (qInput.value || '').trim(); st.loaded = false; paint(); };
    host.querySelector('#mk-go').onclick = runSearch;
    qInput.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); runSearch(); } };

    async function refreshInstalledCount() {
      try {
        const r = await API.get(`/api/servers/${s.id}/addons/marketplace`);
        const el = host.querySelector('#mk-installed-count');
        if (el) el.textContent = String((r.installed || []).length);
      } catch (e) { /* count is decoration; the tab itself reports errors */ }
    }

    async function paint() {
      if (st.tab === 'installed') return paintInstalled();
      if (st.tab === 'worlds') return paintWorlds();
      return paintCatalogue();
    }

    function offlineMessage(e) {
      const text = String(e && e.message || '');
      return /network|socket|tls|cert|fetch|unreachable|ENOTFOUND|ECONN|EAI_AGAIN|Modrinth|502/i.test(text);
    }

    async function paintCatalogue() {
      pane.innerHTML = window.el.skeleton(4);
      if (st.kind === 'worlds') return paintWorlds();
      try {
        const r = await API.get(`/api/marketplace/search?query=${encodeURIComponent(st.query || 'essentials')}&limit=24&projectType=${encodeURIComponent(st.type)}`);
        const hits = r.projects || r.hits || r.results || [];
        st.items = hits;
        pane.innerHTML = hits.length ? `<div class="mk-grid">${hits.map((h) => `
          <article class="mk-card">
            <div class="mk-card-head">
              <div class="mk-ico">${h.iconUrl ? `<img src="${esc(h.iconUrl)}" alt="" onerror="this.remove()"/>` : I(st.type === 'mod' ? 'puzzle' : 'package')}</div>
              <div class="grow" style="min-width:0">
                <h4 title="${esc(h.title || h.slug)}">${esc(h.title || h.slug)}</h4>
                <div class="mk-meta"><span>${esc(h.author || 'community')}</span><span>·</span><span>↓ ${esc(fmt.num(h.downloads || 0))}</span></div>
              </div>
            </div>
            <p class="mk-desc">${esc(String(h.description || '').slice(0, 120))}${String(h.description || '').length > 120 ? '…' : ''}</p>
            <div class="row wrap gap-4">${(h.displayCategories && h.displayCategories.length ? h.displayCategories : h.categories || []).slice(0, 3)
        .map((c) => `<span class="chip chip-plain tiny">${esc(c)}</span>`).join('')}</div>
            <div class="mk-foot">
              <span class="dim tiny">for ${esc(s.jar_type || 'minecraft')}${s.jar_version ? ' ' + esc(s.jar_version) : ''}</span>
              <button class="btn btn-sm btn-primary" data-install="${esc(h.slug || h.id)}" data-title="${esc(h.title || h.slug)}">${I('download')} Install</button>
            </div>
          </article>`).join('')}</div>`
          : emptyState('search', 'Nothing found', `No ${st.type}s matched “${esc(st.query || 'essentials')}”.`);
        pane.querySelectorAll('[data-install]').forEach((b) => b.onclick = () => install(b));
      } catch (e) {
        pane.innerHTML = offlineMessage(e)
          ? emptyState('globe', 'Marketplace is offline',
            'This host cannot reach the Modrinth catalogue right now. Worlds below are curated and work offline; you can also upload jars with Files.')
          : emptyState('alert', 'Marketplace unavailable', e.message);
      }
    }

    /* Resolve the best file for this server's loader + version, then install. */
    async function install(btn) {
      const slug = btn.dataset.install;
      const title = btn.dataset.title;
      btn.disabled = true;
      const original = btn.innerHTML;
      btn.innerHTML = 'Resolving…';
      try {
        const v = await API.get(`/api/marketplace/project/${encodeURIComponent(slug)}/versions`);
        const versions = (v.versions || []).filter((x) => x.file && x.file.url);
        if (!versions.length) throw new Error('This project has no downloadable file.');
        const best = (s.jar_version ? versions.find((x) => (x.gameVersions || []).includes(s.jar_version)) : null) || versions[0];
        btn.innerHTML = 'Installing…';
        const r = await API.post('/api/marketplace/install', {
          serverId: s.id,
          downloadUrl: best.file.url,
          fileName: best.file.filename || `${slug}.jar`,
          targetType: st.type,
          projectName: title
        });
        btn.innerHTML = `${I('check')} Installed`;
        toast(`${title} → ${r.directory || (st.type === 'mod' ? 'mods/' : 'plugins/')} · restart to load`, 'ok', 'Installed');
        refreshInstalledCount();
        if (!r.restarted) window.el.toast('Restart the server to activate it', 'info', 'Reminder');
      } catch (e) {
        btn.disabled = false;
        btn.innerHTML = original;
        toast(e.message, 'err', 'Install failed');
      }
    }

    async function paintInstalled() {
      pane.innerHTML = window.el.skeleton(3);
      try {
        const r = await API.get(`/api/servers/${s.id}/addons/marketplace`);
        const items = r.installed || [];
        host.querySelector('#mk-installed-count').textContent = String(items.length);
        pane.innerHTML = `
          <div class="row wrap gap-8 mb-14">
            <span class="chip chip-plain"><span class="mono tiny">${esc(r.folder || 'plugins')}/</span></span>
            <span class="dim tiny">${items.length} file${items.length === 1 ? '' : 's'} · read from disk</span>
          </div>
          ${items.length ? `<div class="table-wrap"><table class="data">
            <thead><tr><th>File</th><th>Folder</th><th>Size</th><th>Modified</th><th></th></tr></thead>
            <tbody>${items.map((it) => `<tr>
              <td class="mono tiny">${esc(it.fileName)}</td>
              <td><span class="chip chip-plain tiny">${esc(it.directory)}</span></td>
              <td class="num">${esc(it.sizeFormatted || fmt.bytes(it.size))}</td>
              <td class="dim small">${esc(fmt.date(it.modifiedAt))}</td>
              <td><div class="cell-actions"><button class="btn btn-xs btn-danger" data-uninstall="${esc(it.fileName)}" data-dir="${esc(it.directory)}" data-type="${esc(it.type)}">${I('trash')} Remove</button></div></td>
            </tr>`).join('')}</tbody></table></div>`
            : emptyState('archive', 'Nothing installed yet', `Install ${isModServer ? 'mods' : 'plugins'} from the Catalogue tab — they land in ${esc(r.folder || 'plugins')}/.`)}`;
        pane.querySelectorAll('[data-uninstall]').forEach((b) => b.onclick = () => window.el.confirmDialog({
          title: `Remove ${b.dataset.uninstall}?`,
          message: 'The file is deleted from this server. Restart the server so it unloads.',
          confirmLabel: 'Remove file',
          onConfirm: async () => {
            try {
              await API.post('/api/marketplace/uninstall', {
                serverId: s.id, fileName: b.dataset.uninstall, directory: b.dataset.dir, targetType: b.dataset.type
              });
              toast('Removed — restart the server to unload it', 'ok');
              paintInstalled();
            } catch (e) { toast(e.message, 'err'); }
          }
        }));
      } catch (e) {
        pane.innerHTML = emptyState('alert', 'Installed list unavailable', e.message);
      }
    }

    async function paintWorlds() {
      pane.innerHTML = window.el.skeleton(3);
      try {
        const r = await API.get('/api/marketplace/maps');
        const maps = r.maps || [];
        pane.innerHTML = maps.length ? `<div class="mk-grid">${maps.map((m) => `
          <article class="mk-card">
            <div class="mk-card-head">
              <div class="mk-ico">${I('map')}</div>
              <div class="grow" style="min-width:0"><h4>${esc(m.title)}</h4>
                <div class="mk-meta"><span>${esc(m.category || 'world')}</span>${m.tag ? `<span>·</span><span>${esc(m.tag)}</span>` : ''}</div></div>
            </div>
            <p class="mk-desc">${esc(String(m.description || '').slice(0, 120))}${String(m.description || '').length > 120 ? '…' : ''}</p>
            <div class="row wrap gap-4">${(m.versions || []).slice(0, 3).map((v) => `<span class="chip chip-plain tiny mono">${esc(v)}</span>`).join('')}</div>
            <div class="mk-foot"><span class="dim tiny">curated · offline capable</span>
              <button class="btn btn-sm btn-primary" data-map="${esc(m.id)}" data-title="${esc(m.title)}">${I('download')} Install world</button></div>
          </article>`).join('')}</div>`
          : emptyState('map', 'No worlds', 'The curated world catalogue is empty.');
        pane.querySelectorAll('[data-map]').forEach((b) => b.onclick = async () => {
          b.disabled = true; b.innerHTML = 'Installing…';
          try {
            await API.post(`/api/servers/${s.id}/worlds/install-map`, { mapId: b.dataset.map });
            b.innerHTML = `${I('check')} Installed`;
            toast(`${b.dataset.title} installed and set as the active world`, 'ok');
          } catch (e) {
            b.disabled = false; b.innerHTML = `${I('download')} Install world`;
            toast(e.message, 'err');
          }
        });
      } catch (e) {
        pane.innerHTML = emptyState('globe', 'World catalogue unavailable', e.message);
      }
    }

    paint();
    refreshInstalledCount();
  }

  /* --------------------------------------------------------------- activity */
  /* The per-server audit trail: every command, power action and setting change
     the panel recorded for this server, straight from activity_logs. */
  async function renderActivity(host, s) {
    host.innerHTML = `<div class="card">
      <div class="card-head"><div class="grow"><h3>Activity</h3>
        <div class="card-sub">Everything recorded against this server — commands, power actions and configuration changes</div></div>
        <div class="row gap-8">
          <select class="select" id="act-filter" style="width:auto">
            <option value="">All actions</option>
            <option value="POWER">Power only</option>
            <option value="COMMAND">Commands only</option>
          </select>
          <button class="btn btn-sm" id="act-refresh">${I('refresh')} Refresh</button>
        </div>
      </div>
      <div id="act-body">${window.el.skeleton(4)}</div>
    </div>`;

    const badge = (action) => {
      const a = String(action || '');
      const cls = /CREATE|START/.test(a) ? 'chip-live' : /DELETE|KILL|STOP|SUSPEND/.test(a) ? 'chip-danger' : /COMMAND|UPDATE|EDIT/.test(a) ? 'chip-onyx' : 'chip-plain';
      return `<span class="chip ${cls}"><span class="mono tiny">${esc(a || '—')}</span></span>`;
    };

    const paint = async () => {
      const body = document.getElementById('act-body');
      if (!body) return;
      const filter = document.getElementById('act-filter').value;
      try {
        const r = await API.get(`/api/activity/server/${s.id}?limit=100`);
        let logs = r.logs || [];
        if (filter === 'POWER') logs = logs.filter((l) => /^(SERVER_)?(START|STOP|RESTART|KILL|SUSPEND|UNSUSPEND)/.test(String(l.action).replace(/^SERVER_/, '')));
        if (filter === 'COMMAND') logs = logs.filter((l) => /COMMAND/.test(String(l.action)));
        body.innerHTML = logs.length ? `<div class="table-wrap"><table class="data">
          <thead><tr><th>Action</th><th>User</th><th>Details</th><th>Source</th><th>When</th></tr></thead>
          <tbody>${logs.map((l) => `<tr>
            <td>${badge(l.action)}</td>
            <td><b>${esc(l.username || 'system')}</b></td>
            <td class="mono tiny" style="max-width:340px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(l.details || '')}">${esc(l.details || '—')}</td>
            <td class="dim small">${esc(l.ip_address || '—')}</td>
            <td class="dim small" title="${esc(l.created_at || '')}">${esc(fmt.ago(l.created_at))}</td>
          </tr>`).join('')}</tbody></table></div>
          <div class="row" style="padding:10px 18px;border-top:1px solid var(--line)"><span class="dim tiny">${logs.length} entr${logs.length === 1 ? 'y' : 'ies'} · newest first</span></div>`
          : emptyState('activity', 'Nothing recorded yet', filter ? 'No entries match this filter.' : 'Power actions, commands and setting changes will appear here as they happen.');
      } catch (e) {
        body.innerHTML = emptyState('alert', 'Activity unavailable', e.message);
      }
    };
    document.getElementById('act-filter').onchange = paint;
    document.getElementById('act-refresh').onclick = () => { paint(); toast('Activity refreshed', 'ok'); };
    paint();
  }

  /* ----------------------------------------------------------------- addons */
  async function renderAddons(host, s) {
    const cards = [
      { key: 'startup', title: 'Startup variables', icon: 'bolt', text: 'Edit the {{VARIABLES}} used by the launch command.', hash: 'settings' },
      { key: 'jar', title: 'Server software', icon: 'package', text: 'Switch between Paper, Fabric, Forge, Purpur, Vanilla and more.', hash: 'settings' },
      { key: 'subdomains', title: 'Subdomains', icon: 'globe', text: 'Attach a domain so players connect without a port.', action: 'subdomains' },
      { key: 'props', title: 'server.properties', icon: 'sliders', text: 'Visual editor for every Minecraft server property.', hash: 'settings' }
    ];
    host.innerHTML = `<div class="bento">
      ${cards.map((c) => `<div class="span-6"><div class="card card-pad hoverable">
        <div class="row gap-14"><div class="srv-icon">${I(c.icon)}</div>
        <div class="grow"><h3 style="font-size:14px">${esc(c.title)}</h3><p class="dim small">${esc(c.text)}</p></div></div>
        <div class="row gap-8 mt-14"><button class="btn btn-sm" data-act="${esc(c.action || '')}" data-hash="${esc(c.hash || '')}">Open</button></div>
      </div></div>`).join('')}
      <div class="span-12"><div class="card card-pad">
        <div class="section-label">Installed plugins / mods</div>
        <div id="add-plugins">${window.el.skeleton(3)}</div>
      </div></div>
    </div>`;
    host.querySelectorAll('[data-act]').forEach((b) => b.onclick = () => {
      if (b.dataset.hash) location.hash = `#/server/${s.id}/${b.dataset.hash}`;
      else if (b.dataset.act === 'subdomains') renderSubdomains();
    });

    const renderSubdomains = async () => {
      let rows = [];
      try { const r = await API.get(`/api/servers/${s.id}/properties/subdomains`); rows = r.subdomains || []; } catch (e) {}
      window.el.modal({
        title: 'Player subdomains', subtitle: 'Point a friendly hostname at this server',
        body: rows.length ? `<div class="table-wrap"><table class="data"><thead><tr><th>Domain</th><th>Created</th><th></th></tr></thead>
          <tbody>${rows.map((d) => `<tr><td class="mono">${esc(d.full_domain)}</td><td class="dim">${esc(fmt.date(d.created_at, false))}</td>
          <td><div class="cell-actions"><button class="btn btn-xs btn-danger" data-sd="${d.id}">${I('trash')}</button></div></td></tr>`).join('')}</tbody></table></div>`
          : emptyState('globe', 'No subdomains', 'Add one below once your domain is configured in the panel settings.'),
        footer: `<button class="btn" data-cancel>Close</button>`,
        onMount(wrap, close) {
          wrap.querySelector('[data-cancel]').onclick = close;
          wrap.querySelectorAll('[data-sd]').forEach((b) => b.onclick = async () => {
            try { await API.del(`/api/servers/${s.id}/properties/subdomains/${b.dataset.sd}`); toast('Removed', 'ok'); close(); } catch (e) { toast(e.message, 'err'); }
          });
        }
      });
    };

    try {
      const r = await API.get(`/api/servers/${s.id}/files?directory=${encodeURIComponent(s.jar_type && /forge|fabric|neoforge|quilt/i.test(s.jar_type) ? 'mods' : 'plugins')}`);
      const files = (r.files || []).filter((f) => !f.isDirectory && /\.jar$/i.test(f.name));
      document.getElementById('add-plugins').innerHTML = files.length
        ? `<div class="row wrap gap-8">${files.map((f) => `<span class="chip chip-plain"><span class="mono tiny">${esc(f.name)}</span></span>`).join('')}</div>`
        : `<p class="dim small">No jar files found in this folder yet. Install addons from the marketplace or upload jars in the file manager.</p>`;
    } catch (e) {
      document.getElementById('add-plugins').innerHTML = `<p class="dim small">Folder not readable yet — start the server once to generate it.</p>`;
    }
  }

  /* --------------------------------------------------------------- settings */
  async function renderSettings(host, s) {
    const isMinecraft = s.server_type === 'minecraft';
    const env = (() => { try { return typeof s.env_vars === 'string' ? JSON.parse(s.env_vars || '{}') : (s.env_vars || {}); } catch (e) { return {}; } })();

    host.innerHTML = `<div class="col gap-14">
      <div class="card">
        <div class="card-head"><h3>General</h3></div>
        <div class="card-body">
          <form id="set-form" class="col gap-14">
            <div class="two-col">
              <div class="field"><label>Server name</label><input class="input" name="name" value="${esc(s.name)}" /></div>
              <div class="field"><label>Description</label><input class="input" name="description" value="${esc(s.description || '')}" placeholder="Optional notes" /></div>
            </div>
            <div class="field"><label>Startup command</label><input class="input mono" name="startup_cmd" value="${esc(s.startup_cmd || '')}" /></div>
            <div class="hint">Variables: <span class="mono">{{SERVER_MEMORY}}</span> <span class="mono">{{SERVER_JARFILE}}</span> <span class="mono">{{SERVER_PORT}}</span> <span class="mono">{{MAIN_FILE}}</span></div>
            <div class="section-label mt-8">Resources</div>
            <div class="three-col">
              <div class="field"><label>Memory (MB)</label><input class="input" name="memory_mb" type="number" value="${esc(s.memory_mb || 1024)}" ${Store.isAdmin() ? '' : 'disabled'} /></div>
              <div class="field"><label>CPU limit (%)</label><input class="input" name="cpu_limit" type="number" value="${esc(s.cpu_limit || 100)}" ${Store.isAdmin() ? '' : 'disabled'} /></div>
              <div class="field"><label>Disk (MB)</label><input class="input" name="disk_mb" type="number" value="${esc(s.disk_mb || 5120)}" ${Store.isAdmin() ? '' : 'disabled'} /></div>
            </div>
            <div class="row gap-8"><button class="btn btn-primary" type="submit">${I('save')} Save changes</button></div>
          </form>
        </div>
      </div>

      ${isMinecraft ? `
      <div class="card">
        <div class="card-head"><div class="grow"><h3>server.properties</h3><div class="card-sub">Visual editor — restart the server to apply gameplay settings</div></div>
          <button class="btn btn-sm" id="props-save">${I('save')} Save properties</button></div>
        <div class="card-body" id="props-body">${window.el.skeleton(4)}</div>
      </div>` : ''}

      <div class="card">
        <div class="card-head"><h3>Startup variables</h3></div>
        <div class="card-body">
          <div class="col gap-8" id="env-list">
            ${Object.entries(env).length ? Object.entries(env).map(([k, v]) => `<div class="row gap-8"><input class="input mono" data-env-k value="${esc(k)}" disabled style="max-width:230px" /><input class="input mono" data-env-v value="${esc(v)}" /></div>`).join('')
        : `<p class="dim small">No custom variables set. Add the ones your startup command uses.</p>`}
          </div>
          <div class="row gap-8 mt-14">
            <input class="input mono" id="env-new-k" placeholder="VARIABLE_NAME" style="max-width:230px" />
            <input class="input mono" id="env-new-v" placeholder="value" />
            <button class="btn" id="env-add">${I('plus')} Add</button>
            <button class="btn btn-primary" id="env-save">${I('save')} Save variables</button>
          </div>
        </div>
      </div>

      ${Store.isAdmin() ? `
      <div class="card">
        <div class="card-head"><h3>Danger zone</h3></div>
        <div class="card-body">
          <div class="row wrap gap-14">
            <div class="grow"><b class="small">Reinstall server</b><p class="dim small">Re-downloads the server jar and recreates the container. World data is kept.</p></div>
            <button class="btn btn-warn" id="dz-reinstall">${I('refresh')} Reinstall</button>
          </div>
          <div class="row wrap gap-14 mt-14" style="padding-top:14px;border-top:1px solid var(--line)">
            <div class="grow"><b class="small">Re-run install</b><p class="dim small">Marks the server as installing so the daemon re-runs its install script on next boot.</p></div>
            <button class="btn" id="dz-install">${I('package')} Toggle install</button>
          </div>
          <div class="row wrap gap-14 mt-14" style="padding-top:14px;border-top:1px solid var(--line)">
            <div class="grow"><b class="small">Delete server</b><p class="dim small">Destroys the server, its files, backups and allocations. This cannot be undone.</p></div>
            <button class="btn btn-danger" id="dz-delete">${I('trash')} Delete server</button>
          </div>
        </div>
      </div>` : ''}
    </div>`;

    document.getElementById('set-form').onsubmit = async (e) => {
      e.preventDefault();
      const data = Object.fromEntries(new FormData(e.target).entries());
      ['memory_mb', 'cpu_limit', 'disk_mb'].forEach((k) => { if (data[k]) data[k] = Number(data[k]); else delete data[k]; });
      try { await API.put(`/api/servers/${s.id}`, data); toast('Server settings saved', 'ok'); window.DKX.Router.resolve(); }
      catch (err) { toast(err.message, 'err'); }
    };

    const installBtn = document.getElementById('dz-install');
    if (installBtn) installBtn.onclick = async () => {
      try {
        const r = await API.post(`/api/admin/servers/${s.id}/toggle-install`);
        toast(r.message || 'Install status toggled', 'ok');
        window.DKX.Router.resolve();
      } catch (err) { toast(err.message, 'err'); }
    };

    const envAdd = document.getElementById('env-add');
    envAdd.onclick = () => {
      const k = document.getElementById('env-new-k').value.trim().toUpperCase().replace(/[^A-Z0-9_]/g, '_');
      const v = document.getElementById('env-new-v').value;
      if (!k) return toast('Enter a variable name', 'warn');
      const list = document.getElementById('env-list');
      const row = document.createElement('div');
      row.className = 'row gap-8';
      row.innerHTML = `<input class="input mono" data-env-k value="${esc(k)}" disabled style="max-width:230px" /><input class="input mono" data-env-v value="${esc(v)}" />`;
      list.appendChild(row);
      document.getElementById('env-new-k').value = ''; document.getElementById('env-new-v').value = '';
    };
    document.getElementById('env-save').onclick = async () => {
      const vars = {};
      document.querySelectorAll('#env-list .row').forEach((r) => {
        const k = r.querySelector('[data-env-k]').value, v = r.querySelector('[data-env-v]').value;
        if (k) vars[k] = v;
      });
      try { await API.put(`/api/servers/${s.id}`, { env_vars: vars }); toast('Variables saved', 'ok'); }
      catch (e) { toast(e.message, 'err'); }
    };

    if (isMinecraft) loadProperties(s);
    if (Store.isAdmin()) {
      document.getElementById('dz-reinstall').onclick = () => window.el.confirmDialog({
        title: 'Reinstall server?', message: 'The jar will be downloaded again. Existing files stay in place.', confirmLabel: 'Reinstall', danger: false,
        onConfirm: async () => { await API.post(`/api/servers/${s.id}/reinstall`); toast('Reinstall started', 'ok'); }
      });
      document.getElementById('dz-delete').onclick = () => window.el.confirmDialog({
        title: `Delete "${s.name}"?`, message: 'All files, backups and schedules for this server will be permanently destroyed.', confirmLabel: 'Delete permanently',
        onConfirm: async () => { await API.del(`/api/servers/${s.id}`); toast('Server deleted', 'ok'); location.hash = '#/portal/servers'; }
      });
    }
  }

  async function loadProperties(s) {
    const body = document.getElementById('props-body');
    if (!body) return;
    let props = {};
    let propsError = '';
    try { const r = await API.get(`/api/servers/${s.id}/properties`); props = r.properties || {}; }
    catch (e) { propsError = e.message; }
    if (propsError) {
      body.innerHTML = `<div class="banner-strip">${I('info')}<span>${esc(propsError)} — showing defaults you can still save.</span></div>`;
    }

    const FIELDS = [
      { k: 'motd', t: 'text', l: 'MOTD' }, { k: 'max-players', t: 'number', l: 'Max players' },
      { k: 'gamemode', t: 'select', l: 'Gamemode', o: ['survival', 'creative', 'adventure', 'spectator'] },
      { k: 'difficulty', t: 'select', l: 'Difficulty', o: ['peaceful', 'easy', 'normal', 'hard'] },
      { k: 'level-name', t: 'text', l: 'World name' }, { k: 'view-distance', t: 'number', l: 'View distance' },
      { k: 'simulation-distance', t: 'number', l: 'Simulation distance' }, { k: 'server-port', t: 'number', l: 'Server port' }
    ];
    const BOOLS = ['pvp', 'online-mode', 'allow-flight', 'spawn-animals', 'spawn-monsters', 'spawn-npcs', 'enable-command-block', 'white-list', 'hardcore', 'allow-nether', 'force-gamemode'];

    body.innerHTML = `<div class="three-col">
      ${FIELDS.map((f) => `<div class="field"><label>${esc(f.l)}</label>
        ${f.t === 'select'
        ? `<select class="select" data-prop="${f.k}">${f.o.map((o) => `<option value="${o}" ${props[f.k] === o ? 'selected' : ''}>${o}</option>`).join('')}</select>`
        : `<input class="input" data-prop="${f.k}" type="${f.t}" value="${esc(props[f.k] !== undefined ? props[f.k] : '')}" />`}
      </div>`).join('')}
    </div>
    <div class="section-label mt-22">Toggles</div>
    <div class="row wrap gap-14">
      ${BOOLS.map((b) => `<label class="switch"><input type="checkbox" data-prop="${b}" ${props[b] === true || props[b] === 'true' ? 'checked' : ''}/><span class="track"></span><span class="switch-label">${esc(b)}</span></label>`).join('')}
    </div>`;

    document.getElementById('props-save').onclick = async () => {
      const next = {};
      body.querySelectorAll('[data-prop]').forEach((el) => {
        if (el.type === 'checkbox') next[el.dataset.prop] = el.checked ? 'true' : 'false';
        else next[el.dataset.prop] = el.value;
      });
      try { await API.put(`/api/servers/${s.id}/properties`, { properties: next }); toast('server.properties saved', 'ok'); }
      catch (e) { toast(e.message, 'err'); }
    };
  }

  window.DKX.Views.server = { shell, disconnectConsole };
})();
