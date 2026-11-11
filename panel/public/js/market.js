/* ==========================================================================
   DARKONYX PANEL — marketplace (maps, plugins, mods, modpacks)
   ========================================================================== */
(function () {
  const { esc, fmt, API, Store, toast, emptyState } = window.el;

  const state = { tab: 'maps', serverId: null, servers: [], query: '' };

  /* Resolve a downloadable file for a Modrinth project (version-aware) then install */
  async function installModrinth(projectSlug, title, server) {
    const gameVersion = server && server.jar_version ? server.jar_version : null;
    const loader = server && server.jar_type ? String(server.jar_type).toLowerCase() : null;
    const v = await API.get(`/api/marketplace/project/${encodeURIComponent(projectSlug)}/versions`);
    const versions = (v.versions || []).filter((x) => x.file && x.file.url);
    if (!versions.length) throw new Error('No downloadable file found for this project.');
    const best = (gameVersion ? versions.find((x) => (x.gameVersions || []).includes(gameVersion)) : null) || versions[0];
    await API.post('/api/marketplace/install', {
      serverId: state.serverId,
      downloadUrl: best.file.url,
      fileName: best.file.filename || `${projectSlug}.jar`,
      targetType: loader && ['fabric', 'forge', 'neoforge', 'quilt'].includes(loader) ? 'mod' : 'plugin',
      projectName: title
    });
    return best;
  }

  async function view(host) {
    try { state.servers = (await API.get('/api/servers')).servers || []; } catch (e) { state.servers = []; }
    state.serverId = state.servers.length ? state.servers[0].id : null;

    host.innerHTML = `
      <div class="page-head">
        <div><div class="eyebrow">Discover</div><h1>Marketplace</h1>
        <p class="sub">Curated maps, plugins, mods and modpacks — install straight into a server's files.</p></div>
        <div class="head-actions">
          ${state.servers.length ? `<select class="select" id="mk-server" style="min-width:210px">
            ${state.servers.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join('')}</select>` : ''}
          <div class="input-group" style="width:260px">
            <input class="input" id="mk-search" placeholder="Search resources…" />
          </div>
        </div>
      </div>

      <div class="tabs" id="mk-tabs">
        ${[['maps', 'Worlds & maps', 'map'], ['plugins', 'Plugins', 'puzzle'], ['modpacks', 'Modpacks', 'package']]
        .map(([id, label, icon]) => `<button class="tab ${id === state.tab ? 'active' : ''}" data-tab="${id}">${I(icon)} ${label}</button>`).join('')}
      </div>
      <div id="mk-body" class="mt-14">${window.el.skeleton(6)}</div>`;

    const sel = document.getElementById('mk-server');
    if (sel) sel.onchange = () => { state.serverId = Number(sel.value); };

    document.querySelectorAll('[data-tab]').forEach((b) => b.onclick = () => {
      state.tab = b.dataset.tab;
      document.querySelectorAll('[data-tab]').forEach((x) => x.classList.toggle('active', x === b));
      paint();
    });
    let t;
    document.getElementById('mk-search').oninput = (e) => {
      clearTimeout(t);
      t = setTimeout(() => { state.query = e.target.value.trim(); paint(); }, 340);
    };

    async function paint() {
      const body = document.getElementById('mk-body');
      body.innerHTML = window.el.skeleton(5);
      try {
        // await, or a rejected fetch escapes this try/catch and the tab is left
        // showing skeletons forever with an unhandled rejection in the console
        if (state.tab === 'maps') return await paintMaps(body);
        if (state.tab === 'plugins') return await paintModrinth(body);
        return await paintModpacks(body);
      } catch (e) {
        const offline = /network|socket|tls|fetch|unreachable|ENOTFOUND|ECONN/i.test(String(e.message || ''));
        body.innerHTML = emptyState(
          offline ? 'globe' : 'alert',
          offline ? 'Marketplace is offline' : 'Marketplace unavailable',
          offline
            ? 'This host cannot reach the Modrinth API right now. Curated maps still work — switch to the Worlds & maps tab. Everything else in the panel is unaffected.'
            : e.message
        );
        if (offline) toast('Modrinth is unreachable from this host', 'warn', 'Offline');
      }
    }

    function installButton(item) {
      if (!state.serverId) return `<button class="btn btn-sm" disabled>No server</button>`;
      return `<button class="btn btn-sm btn-primary" data-install="${esc(item.id)}" data-kind="${esc(item.kind)}" data-title="${esc(item.title)}">${I('download')} Install</button>`;
    }

    function bindInstall(kind) {
      document.querySelectorAll('[data-install]').forEach((b) => b.onclick = async () => {
        if (!state.serverId) return toast('Select a server first', 'warn');
        b.disabled = true; b.innerHTML = 'Installing…';
        const server = state.servers.find((x) => String(x.id) === String(state.serverId));
        try {
          if (kind === 'map') {
            await API.post(`/api/servers/${state.serverId}/worlds/install-map`, { mapId: b.dataset.install });
          } else {
            await installModrinth(b.dataset.install, b.dataset.title, server);
          }
          toast(`${b.dataset.title} installed`, 'ok', 'Installed');
          b.innerHTML = 'Installed';
        } catch (e) {
          toast(e.message, 'err');
          b.disabled = false; b.innerHTML = `${I('download')} Install`;
        }
      });
    }

    async function paintMaps(body) {
      const r = await API.get('/api/marketplace/maps');
      let maps = r.maps || [];
      if (state.query) maps = maps.filter((m) => (m.title + ' ' + (m.category || '') + ' ' + (m.tag || '')).toLowerCase().includes(state.query.toLowerCase()));
      body.innerHTML = maps.length ? `<div class="srv-grid">${maps.map((m) => `
        <article class="srv-card" style="cursor:default">
          <div class="srv-glow"></div>
          <div class="srv-head">
            <div class="srv-icon">${I('map')}</div>
            <div class="srv-title grow"><h4>${esc(m.title)}</h4>
              <div class="srv-meta"><span>${esc(m.category || 'world')}</span>${m.tag ? `<span class="dim">·</span><span>${esc(m.tag)}</span>` : ''}</div></div>
          </div>
          <div class="srv-body">
            <p class="dim small" style="min-height:38px">${esc((m.description || '').slice(0, 110))}${(m.description || '').length > 110 ? '…' : ''}</p>
            <div class="row wrap gap-4">${(m.versions || []).slice(0, 3).map((v) => `<span class="chip chip-plain tiny mono">${esc(v)}</span>`).join('')}</div>
          </div>
          <div class="srv-foot">${installButton({ id: m.id, kind: 'map', title: m.title })}</div>
        </article>`).join('')}</div>`
        : emptyState('map', 'No maps found', state.query ? 'Try a different keyword.' : 'The curated map catalogue is empty.');
      bindInstall('map');
    }

    async function paintModrinth(body) {
      const q = state.query || 'essentials';
      const r = await API.get(`/api/marketplace/search?query=${encodeURIComponent(q)}&limit=24&projectType=plugin`);
      const hits = r.projects || r.hits || r.results || [];
      body.innerHTML = hits.length ? `<div class="srv-grid">${hits.map((h) => `
        <article class="srv-card" style="cursor:default">
          <div class="srv-glow"></div>
          <div class="srv-head">
            <div class="srv-icon" style="padding:0;overflow:hidden">${h.iconUrl ? `<img src="${esc(h.iconUrl)}" alt="" style="width:100%;height:100%;object-fit:cover" onerror="this.remove()"/>` : I('puzzle')}</div>
            <div class="srv-title grow"><h4>${esc(h.title || h.slug)}</h4>
              <div class="srv-meta"><span>${esc(h.author || 'community')}</span><span class="dim">·</span><span>↓ ${esc(fmt.num(h.downloads || 0))}</span></div></div>
          </div>
          <div class="srv-body">
            <p class="dim small" style="min-height:38px">${esc(String(h.description || '').slice(0, 110))}${String(h.description || '').length > 110 ? '…' : ''}</p>
            <div class="row wrap gap-4">${(h.displayCategories && h.displayCategories.length ? h.displayCategories : h.categories || []).slice(0, 3).map((c) => `<span class="chip chip-plain tiny">${esc(c)}</span>`).join('')}</div>
          </div>
          <div class="srv-foot">${installButton({ id: h.slug || h.id, kind: 'mod', title: h.title || h.slug })}</div>
        </article>`).join('')}</div>`
        : emptyState('puzzle', 'Nothing found', `No projects matched “${esc(q)}”. The Modrinth API may be unreachable from this host.`);
      bindInstall('mod');
    }

    async function paintModpacks(body) {
      const r = await API.get('/api/marketplace/search?query=' + encodeURIComponent(state.query || 'adventure') + '&limit=24&projectType=modpack');
      const hits = r.projects || r.hits || [];
      body.innerHTML = hits.length ? `<div class="srv-grid">${hits.map((h) => `
        <article class="srv-card" style="cursor:default">
          <div class="srv-glow"></div>
          <div class="srv-head">
            <div class="srv-icon" style="padding:0;overflow:hidden">${h.iconUrl ? `<img src="${esc(h.iconUrl)}" alt="" style="width:100%;height:100%;object-fit:cover" onerror="this.remove()"/>` : I('package')}</div>
            <div class="srv-title grow"><h4>${esc(h.title || h.slug)}</h4>
            <div class="srv-meta"><span>${esc(h.author || 'community')}</span><span class="dim">·</span><span>↓ ${esc(fmt.num(h.downloads || 0))}</span></div></div>
          </div>
          <div class="srv-body"><p class="dim small">${esc(String(h.description || '').slice(0, 120))}</p></div>
          <div class="srv-foot">${installButton({ id: h.slug || h.id, kind: 'mod', title: h.title })}</div>
        </article>`).join('')}</div>`
        : emptyState('package', 'No modpacks found', 'Try another search keyword.');
      bindInstall('mod');
    }

    paint();
  }

  window.DKX.Views.market = { view };
})();
