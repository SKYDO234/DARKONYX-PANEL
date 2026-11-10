/* ==========================================================================
   DARKONYX PANEL — marketplace (maps, plugins, mods, modpacks)
   ========================================================================== */
(function () {
  const { esc, fmt, API, Store, toast, emptyState } = window.el;

  const state = { tab: 'maps', serverId: null, servers: [], query: '' };

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
        ${[['maps', 'Worlds & maps', 'map'], ['modrinth', 'Mods & plugins', 'puzzle'], ['modpacks', 'Modpacks', 'package']]
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
        if (state.tab === 'maps') return paintMaps(body);
        if (state.tab === 'modrinth') return paintModrinth(body);
        return paintModpacks(body);
      } catch (e) {
        body.innerHTML = emptyState('alert', 'Marketplace unavailable', e.message);
      }
    }

    function installButton(item) {
      if (!state.serverId) return `<button class="btn btn-sm" disabled>No server</button>`;
      return `<button class="btn btn-sm btn-primary" data-install="${esc(item.id)}" data-kind="${esc(item.kind)}" data-title="${esc(item.title)}">${I('download')} Install</button>`;
    }

    function bindInstall(kind) {
      document.querySelectorAll('[data-install]').forEach((b) => b.onclick = async () => {
        if (!state.serverId) return toast('Select a server first', 'warn');
        b.disabled = true; b.textContent = 'Installing…';
        try {
          if (kind === 'map') {
            await API.post(`/api/servers/${state.serverId}/worlds/install-map`, { mapId: b.dataset.install });
          } else {
            await API.post(`/api/marketplace/install`, {
              serverId: state.serverId, projectId: b.dataset.install, projectType: 'mod', title: b.dataset.title
            });
          }
          toast(`${b.dataset.title} installed`, 'ok', 'Installed');
          b.textContent = 'Installed';
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
      const r = await API.get(`/api/marketplace/search?query=${encodeURIComponent(q)}&limit=24`);
      const hits = r.hits || r.results || r.projects || [];
      body.innerHTML = hits.length ? `<div class="srv-grid">${hits.map((h) => `
        <article class="srv-card" style="cursor:default">
          <div class="srv-glow"></div>
          <div class="srv-head">
            <div class="srv-icon" style="padding:0;overflow:hidden">${h.iconUrl || h.icon_url ? `<img src="${esc(h.iconUrl || h.icon_url)}" alt="" style="width:100%;height:100%;object-fit:cover" onerror="this.remove()"/>` : I('puzzle')}</div>
            <div class="srv-title grow"><h4>${esc(h.title || h.name || h.slug)}</h4>
              <div class="srv-meta"><span>${esc(h.author || h.team || 'community')}</span><span class="dim">·</span><span>↓ ${esc(fmt.num(h.downloads || 0))}</span></div></div>
          </div>
          <div class="srv-body">
            <p class="dim small" style="min-height:38px">${esc(String(h.description || '').slice(0, 110))}${String(h.description || '').length > 110 ? '…' : ''}</p>
            <div class="row wrap gap-4">${(h.categories || []).slice(0, 3).map((c) => `<span class="chip chip-plain tiny">${esc(c)}</span>`).join('')}</div>
          </div>
          <div class="srv-foot">${installButton({ id: h.project_id || h.id || h.slug, kind: 'mod', title: h.title || h.slug })}</div>
        </article>`).join('')}</div>`
        : emptyState('puzzle', 'Nothing found', `No projects matched “${esc(q)}”.`);
      bindInstall('mod');
    }

    async function paintModpacks(body) {
      const r = await API.get('/api/marketplace/search?query=' + encodeURIComponent(state.query || 'modpack') + '&limit=24');
      const hits = r.hits || r.results || [];
      body.innerHTML = hits.length ? `<div class="srv-grid">${hits.map((h) => `
        <article class="srv-card" style="cursor:default">
          <div class="srv-glow"></div>
          <div class="srv-head">
            <div class="srv-icon">${I('package')}</div>
            <div class="srv-title grow"><h4>${esc(h.title || h.slug)}</h4>
            <div class="srv-meta"><span>${esc(h.author || 'community')}</span><span class="dim">·</span><span>↓ ${esc(fmt.num(h.downloads || 0))}</span></div></div>
          </div>
          <div class="srv-body"><p class="dim small">${esc(String(h.description || '').slice(0, 120))}</p></div>
          <div class="srv-foot">${installButton({ id: h.project_id || h.id, kind: 'mod', title: h.title })}</div>
        </article>`).join('')}</div>`
        : emptyState('package', 'No modpacks found', 'Try another search keyword.');
      bindInstall('mod');
    }

    paint();
  }

  window.DKX.Views.market = { view };
})();
