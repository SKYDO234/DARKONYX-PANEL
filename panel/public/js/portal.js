/* ==========================================================================
   DARKONYX PANEL — client portal views (overview, servers, activity, account)
   ========================================================================== */
(function () {
  const { esc, fmt, API, Store, toast, modal, confirmDialog, emptyState, sparkline, meter, statusChip } = window.el;

  let cache = { servers: [], at: 0 };

  async function loadServers(force = false) {
    if (!force && cache.servers.length && Date.now() - cache.at < 4000) return cache.servers;
    const r = await API.get('/api/servers');
    cache = { servers: r.servers || [], at: Date.now() };
    Store.servers = cache.servers;
    const badge = document.getElementById('nav-server-count');
    if (badge) badge.textContent = cache.servers.length ? String(cache.servers.length) : '';
    return cache.servers;
  }

  const serverAddress = (s) => (s.ip ? `${s.ip === '127.0.0.1' ? (location.hostname || '127.0.0.1') : s.ip}:${s.port}` : '—');

  const typeLabel = (t) => ({
    minecraft: 'Minecraft', nodejs: 'Node.js', python: 'Python',
    lumenvm: 'KVM VM', vm: 'KVM VM', nokvm: 'No-KVM VM', lumenvm_nokvm: 'No-KVM VM'
  }[t] || (t || 'server'));

  /* ------------------------------------------------------------------ cards */
  function serverCard(s, { compact = false } = {}) {
    const running = s.status === 'running';
    const suspended = s.is_suspended || s.status === 'suspended';
    return `
    <article class="srv-card" data-server="${s.id}">
      <div class="srv-glow"></div>
      <div class="srv-head">
        <div class="srv-icon">${I('box')}</div>
        <div class="srv-title grow">
          <h4>${esc(s.name)}</h4>
          <div class="srv-meta">
            <span>${esc(typeLabel(s.server_type))}</span><span class="dim">·</span>
            <span class="mono">${esc(serverAddress(s))}</span>
          </div>
        </div>
        ${statusChip(suspended ? 'suspended' : s.status)}
      </div>
      <div class="srv-body">
        <div class="srv-specs">
          <div class="spec"><span>Memory</span><b>${esc(fmt.mb(s.memory_mb))}</b></div>
          <div class="spec"><span>CPU</span><b>${esc(s.cpu_limit || 100)}%</b></div>
          <div class="spec"><span>Disk</span><b>${esc(fmt.mb(s.disk_mb))}</b></div>
        </div>
        ${compact ? '' : `<div class="row gap-8 tiny dim">
          <span>${I('network')}</span><span class="mono">${esc(s.node_name || 'local node')}</span>
          <span class="grow"></span><span>created ${esc(fmt.ago(s.created_at))}</span>
        </div>`}
      </div>
      <div class="srv-foot">
        <button class="btn btn-sm btn-primary grow" data-open="${s.id}">${I('terminal')} Manage</button>
        <button class="power-btn start" data-power="start" data-id="${s.id}" ${running || suspended ? 'disabled' : ''} title="Start">${I('play')}</button>
        <button class="power-btn restart" data-power="restart" data-id="${s.id}" ${!running || suspended ? 'disabled' : ''} title="Restart">${I('restart')}</button>
        <button class="power-btn stop" data-power="stop" data-id="${s.id}" ${!running ? 'disabled' : ''} title="Stop">${I('stop')}</button>
      </div>
    </article>`;
  }

  function bindCards(root) {
    root.querySelectorAll('[data-open]').forEach((b) => b.onclick = (e) => { e.stopPropagation(); location.hash = `#/server/${b.dataset.open}/console`; });
    root.querySelectorAll('.srv-card').forEach((c) => c.onclick = () => { location.hash = `#/server/${c.dataset.server}/console`; });
    root.querySelectorAll('[data-power]').forEach((b) => b.onclick = async (e) => {
      e.stopPropagation();
      const id = b.dataset.id, action = b.dataset.power;
      b.disabled = true;
      try {
        await API.post(`/api/servers/${id}/power`, { action });
        toast(`Sent ${action} signal`, 'ok', 'Power action');
        setTimeout(() => window.DKX.Router.resolve(), 1200);
      } catch (err) { toast(err.message, 'err'); b.disabled = false; }
    });
  }

  /* -------------------------------------------------------------- overview */
  async function overview(host) {
    host.innerHTML = `<div class="page-head">
      <div><div class="eyebrow">Client portal</div><h1>Hello, ${esc(Store.user.username)}</h1>
      <p class="sub">Your servers at a glance — power state, live resource usage and shortcuts to everything you control.</p></div>
      <div class="head-actions">
        ${Store.isAdmin() ? `<button class="btn btn-primary" id="ov-create">${I('plus')} New server</button>` : ''}
        <button class="btn" id="ov-refresh">${I('refresh')} Refresh</button>
      </div>
    </div>
    <div id="ov-body">${window.el.skeleton(4)}</div>`;

    const refresh = () => window.DKX.Router.resolve();
    document.getElementById('ov-refresh').onclick = refresh;
    const createBtn = document.getElementById('ov-create');
    if (createBtn) createBtn.onclick = () => window.DKX.Views.admin.createServer(refresh);

    let servers = [];
    try { servers = await loadServers(true); } catch (e) { document.getElementById('ov-body').innerHTML = `<div class="card card-pad">${emptyState('alert', 'Unable to load servers', e.message)}</div>`; return; }

    const running = servers.filter((s) => s.status === 'running').length;
    const suspended = servers.filter((s) => s.is_suspended).length;
    const memAllocated = servers.reduce((a, s) => a + Number(s.memory_mb || 0), 0);
    const diskAllocated = servers.reduce((a, s) => a + Number(s.disk_mb || 0), 0);

    const body = document.getElementById('ov-body');
    body.innerHTML = `
      <div class="bento">
        <div class="span-3"><div class="stat">
          <div class="stat-top">${I('server')} Servers</div>
          <div class="stat-value">${servers.length}</div>
          <div class="stat-foot"><span class="trend up">${I('bolt')} ${running} online</span>${suspended ? `<span class="trend down">${suspended} suspended</span>` : ''}</div>
        </div></div>
        <div class="span-3"><div class="stat">
          <div class="stat-top">${I('memory')} Allocated RAM</div>
          <div class="stat-value">${esc(fmt.mb(memAllocated)).replace(' ', '<small>')}${memAllocated ? '</small>' : ''}</div>
          <div class="stat-foot"><div class="meter live" style="flex:1"><span style="width:${Math.min(100, (memAllocated / 32768) * 100)}%"></span></div></div>
        </div></div>
        <div class="span-3"><div class="stat">
          <div class="stat-top">${I('disk')} Allocated Disk</div>
          <div class="stat-value">${esc(fmt.mb(diskAllocated))}</div>
          <div class="stat-foot">across ${servers.length} instance${servers.length === 1 ? '' : 's'}</div>
        </div></div>
        <div class="span-3"><div class="stat">
          <div class="stat-top">${I('shield')} Access level</div>
          <div class="stat-value" style="font-size:20px">${Store.isAdmin() ? 'Administrator' : 'Client'}</div>
          <div class="stat-foot">${Store.isAdmin() ? `<a href="#/admin/overview" class="trend up" style="cursor:pointer">Open command center ${I('arrowRight')}</a>` : 'Contact an admin for more servers'}</div>
        </div></div>

        <div class="span-8">
          <div class="card">
            <div class="card-head"><div class="grow"><h3>Your servers</h3><div class="card-sub">Live state pulled from the daemon</div></div>
              <a class="btn btn-sm btn-ghost" href="#/portal/servers">View all ${I('chevronRight')}</a></div>
            <div class="card-body">
              ${servers.length ? `<div class="srv-grid">${servers.slice(0, 4).map((s) => serverCard(s, { compact: true })).join('')}</div>`
        : emptyState('server', 'No servers yet', Store.isAdmin() ? 'Create your first Minecraft instance from the command center.' : 'Ask an administrator to assign a server to your account.',
          Store.isAdmin() ? `<button class="btn btn-primary" id="ov-create-2">${I('plus')} Create server</button>` : '')}
            </div>
          </div>
        </div>

        <div class="span-4">
          <div class="card">
            <div class="card-head"><h3>Quick actions</h3></div>
            <div class="card-body col gap-8">
              <a class="rail-item" href="#/marketplace" style="border:1px solid var(--line)">${I('package')}<span class="rail-label">Browse marketplace</span>${I('chevronRight')}</a>
              <a class="rail-item" href="#/portal/activity" style="border:1px solid var(--line)">${I('activity')}<span class="rail-label">Activity log</span>${I('chevronRight')}</a>
              <a class="rail-item" href="#/account" style="border:1px solid var(--line)">${I('shield')}<span class="rail-label">Security & 2FA</span>${I('chevronRight')}</a>
              ${Store.isAdmin() ? `<a class="rail-item" href="#/admin/nodes" style="border:1px solid var(--line)">${I('network')}<span class="rail-label">Node health</span>${I('chevronRight')}</a>` : ''}
            </div>
          </div>
          <div class="card mt-14">
            <div class="card-head"><h3>Panel</h3></div>
            <div class="card-body" id="ov-meta">${window.el.skeleton(3)}</div>
          </div>
        </div>
      </div>`;

    const create2 = document.getElementById('ov-create-2');
    if (create2) create2.onclick = () => window.DKX.Views.admin.createServer(refresh);
    bindCards(body);

    try {
      const meta = await API.get('/api/meta');
      document.getElementById('ov-meta').innerHTML = `
        <div class="kv"><span class="k">Panel</span><span class="v">${esc(meta.panel)} v${esc(meta.version)}</span></div>
        <div class="kv"><span class="k">Database</span><span class="v">${esc(meta.database)}</span></div>
        <div class="kv"><span class="k">Runtime</span><span class="v">Node ${esc(meta.node)}</span></div>
        <div class="kv"><span class="k">Uptime</span><span class="v">${esc(fmt.uptime(meta.uptime_seconds))}</span></div>
        <div class="kv"><span class="k">SFTP</span><span class="v mono">port ${esc(meta.ports.sftp)}</span></div>`;
    } catch (e) { document.getElementById('ov-meta').innerHTML = `<div class="dim small">Panel metadata unavailable</div>`; }
  }

  /* --------------------------------------------------------------- servers */
  async function servers(host) {
    host.innerHTML = `<div class="page-head">
      <div><div class="eyebrow">Instances</div><h1>My servers</h1>
      <p class="sub">Every instance you own or co-manage. Power actions are applied instantly through the daemon.</p></div>
      <div class="head-actions">
        <div class="input-group" style="width:230px"><input class="input" id="srv-search" placeholder="Search servers…" /></div>
        ${Store.isAdmin() ? `<button class="btn btn-primary" id="srv-create">${I('plus')} New server</button>` : ''}
      </div>
    </div>
    <div id="srv-body">${window.el.skeleton(3)}</div>`;

    if (Store.isAdmin()) document.getElementById('srv-create').onclick = () => window.DKX.Views.admin.createServer(() => window.DKX.Router.resolve());

    let list = [];
    try { list = await loadServers(true); } catch (e) {
      document.getElementById('srv-body').innerHTML = `<div class="card card-pad">${emptyState('alert', 'Unable to load servers', e.message)}</div>`; return;
    }
    const paint = (q = '') => {
      const filtered = list.filter((s) => (s.name + ' ' + (s.server_type || '') + ' ' + (s.node_name || '')).toLowerCase().includes(q.toLowerCase()));
      const body = document.getElementById('srv-body');
      body.innerHTML = filtered.length
        ? `<div class="srv-grid">${filtered.map((s) => serverCard(s)).join('')}</div>`
        : `<div class="card card-pad">${emptyState('server', q ? 'No matches' : 'No servers yet', q ? 'Try a different search term.' : 'Nothing is assigned to this account right now.')}</div>`;
      bindCards(body);
    };
    paint();
    document.getElementById('srv-search').oninput = (e) => paint(e.target.value);
  }

  /* -------------------------------------------------------------- activity */
  async function activity(host) {
    host.innerHTML = `<div class="page-head"><div><div class="eyebrow">Audit</div><h1>Activity</h1>
      <p class="sub">Every action your account performs on the panel is recorded here.</p></div>
      <div class="head-actions"><button class="btn" id="act-refresh">${I('refresh')} Refresh</button></div></div>
      <div class="card" id="act-card">${window.el.skeleton(6)}</div>`;
    document.getElementById('act-refresh').onclick = () => window.DKX.Router.resolve();

    const paint = async () => {
      const card = document.getElementById('act-card');
      try {
        const r = await API.get('/api/activity');
        const logs = r.logs || [];
        card.innerHTML = logs.length ? `<div class="table-wrap"><table class="data">
          <thead><tr><th>Action</th><th>Details</th><th>Server</th><th>IP</th><th>When</th></tr></thead>
          <tbody>${logs.map((l) => `<tr>
            <td><span class="chip chip-onyx">${esc(l.action)}</span></td>
            <td class="muted">${esc(l.details || '—')}</td>
            <td class="mono dim">${l.server_id ? '#' + esc(l.server_id) : '—'}</td>
            <td class="mono dim">${esc(l.ip_address || '—')}</td>
            <td class="dim">${esc(fmt.ago(l.created_at))}</td>
          </tr>`).join('')}</tbody></table></div>`
          : emptyState('activity', 'No activity yet', 'Actions such as logins, power changes and file edits will appear here.');
      } catch (e) { card.innerHTML = emptyState('alert', 'Could not load activity', e.message); }
    };
    paint();
  }

  /* --------------------------------------------------------------- account */
  async function account(host) {
    const u = Store.user || {};
    host.innerHTML = `<div class="page-head"><div><div class="eyebrow">Client</div><h1>Account</h1>
      <p class="sub">Profile, password and two-factor authentication for your panel account.</p></div></div>
      <div class="split">
        <div class="col gap-14">
          <div class="card">
            <div class="card-head"><h3>Profile</h3></div>
            <div class="card-body">
              <form id="acc-form" class="col gap-14">
                <div class="two-col">
                  <div class="field"><label>Username</label><input class="input" name="username" value="${esc(u.username || '')}" /></div>
                  <div class="field"><label>Email</label><input class="input" name="email" type="email" value="${esc(u.email || '')}" /></div>
                </div>
                <div class="field"><label>Avatar URL <span class="hint">(optional)</span></label><input class="input" name="avatar" value="${esc(u.avatar || '')}" placeholder="https://…" /></div>
                <div class="section-label mt-8">Change password</div>
                <div class="two-col">
                  <div class="field"><label>Current password</label><input class="input" name="currentPassword" type="password" placeholder="••••••••" autocomplete="current-password" /></div>
                  <div class="field"><label>New password</label><input class="input" name="newPassword" type="password" placeholder="min. 6 characters" autocomplete="new-password" /></div>
                </div>
                <div class="row gap-8"><button class="btn btn-primary" type="submit">${I('save')} Save profile</button></div>
              </form>
            </div>
          </div>
          <div class="card">
            <div class="card-head"><div class="grow"><h3>Two-factor authentication</h3><div class="card-sub">Protect your account with a TOTP authenticator</div></div>
              <span class="chip ${u.two_factor_enabled ? 'chip-live' : 'chip-warn'}">${u.two_factor_enabled ? 'Enabled' : 'Disabled'}</span></div>
            <div class="card-body" id="acc-2fa">
              ${u.two_factor_enabled
        ? `<p class="muted small mb-14">2FA is active on this account. You will be asked for a code on every sign-in.</p>
                   <button class="btn btn-danger" id="tfa-disable">${I('unlock')} Disable 2FA</button>`
        : `<p class="muted small mb-14">Add an extra layer of security — scan the QR code with Google Authenticator, Aegis, 1Password or any TOTP app.</p>
                   <button class="btn btn-primary" id="tfa-enable">${I('shield')} Enable 2FA</button>`}
            </div>
          </div>
        </div>
        <div class="col gap-14">
          <div class="card card-pad">
            <div class="row gap-14">
              <div class="avatar" style="width:48px;height:48px;flex-basis:48px;font-size:16px;border-radius:14px">${esc(fmt.initials(u.username))}</div>
              <div><h3 style="font-size:15px">${esc(u.username || '')}</h3>
                <div class="dim tiny">${esc(u.email || '')}</div></div>
            </div>
            <div class="mt-14">
              <div class="kv"><span class="k">Role</span><span class="v">${u.role === 'admin' ? 'Administrator' : 'Client'}</span></div>
              <div class="kv"><span class="k">Account ID</span><span class="v mono">#${esc(u.id)}</span></div>
              <div class="kv"><span class="k">UUID</span><span class="v mono tiny truncate" style="max-width:150px">${esc(u.uuid || '—')}</span></div>
              <div class="kv"><span class="k">2FA</span><span class="v">${u.two_factor_enabled ? 'On' : 'Off'}</span></div>
            </div>
          </div>
          <div class="card card-pad">
            <div class="section-label">API access</div>
            <p class="dim small">Generate API keys from the admin panel to drive DARKONYX from scripts or CI.</p>
            ${Store.isAdmin() ? `<a class="btn btn-sm mt-14" href="#/admin/settings">${I('key')} Manage API keys</a>` : ''}
          </div>
        </div>
      </div>`;

    document.getElementById('acc-form').onsubmit = async (e) => {
      e.preventDefault();
      const f = e.target;
      const payload = Object.fromEntries(new FormData(f).entries());
      if (!payload.newPassword) delete payload.newPassword;
      if (!payload.currentPassword) delete payload.currentPassword;
      const btn = f.querySelector('button[type=submit]');
      btn.disabled = true;
      try {
        const r = await API.put('/api/auth/profile', payload);
        Store.setUser(r.user);
        window.DKX.Shell.syncUser();
        toast('Profile updated', 'ok');
      } catch (err) { toast(err.message, 'err'); }
      btn.disabled = false;
    };

    const en = document.getElementById('tfa-enable');
    if (en) en.onclick = async () => {
      try {
        const r = await API.post('/api/auth/2fa/setup');
        window.el.modal({
          title: 'Scan with your authenticator', size: 'narrow',
          body: `<div class="col gap-14" style="align-items:center">
            <img src="${r.qrCodeUrl}" alt="2FA QR" style="width:190px;height:190px;border-radius:12px;background:#fff;padding:8px" />
            <div class="copy-field" style="width:100%"><span>${esc(r.secret)}</span><button data-copy="${esc(r.secret)}">${I('copy')}</button></div>
            <div class="field" style="width:100%"><label>Verification code</label><input class="input mono" id="tfa-code" maxlength="6" placeholder="000000" style="text-align:center;letter-spacing:.3em" /></div>
          </div>`,
          footer: `<button class="btn" data-cancel>Cancel</button><button class="btn btn-primary" data-ok>Activate</button>`,
          onMount(wrap, close) {
            wrap.querySelector('[data-cancel]').onclick = close;
            wrap.querySelector('[data-ok]').onclick = async () => {
              try {
                await API.post('/api/auth/2fa/verify', { code: wrap.querySelector('#tfa-code').value.trim() });
                toast('Two-factor authentication enabled', 'ok');
                close(); window.DKX.Router.resolve();
              } catch (e) { toast(e.message, 'err'); }
            };
          }
        });
      } catch (e) { toast(e.message, 'err'); }
    };

    const dis = document.getElementById('tfa-disable');
    if (dis) dis.onclick = () => window.el.promptDialog({
      title: 'Disable 2FA', label: 'Confirm your password', type: 'password', confirmLabel: 'Disable',
      onSubmit: async (pw) => {
        await API.post('/api/auth/2fa/disable', { password: pw });
        toast('2FA disabled', 'info');
        window.DKX.Router.resolve();
      }
    });
  }

  window.el.Auth = window.el.Auth || {};
  window.DKX = window.DKX || {};
  window.DKX.Views = window.DKX.Views || {};
  window.DKX.Views.portal = { overview, servers, activity, account, loadServers, serverCard, bindCards, serverAddress, typeLabel };
})();
