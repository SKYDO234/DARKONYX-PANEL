/* ==========================================================================
   DARKONYX PANEL — administration views
   ========================================================================== */
(function () {
  const { esc, fmt, API, Store, toast, modal, confirmDialog, emptyState, sparkline, meter, statusChip } = window.el;
  const { serverAddress, typeLabel } = window.DKX.Views.portal;

  const history = { cpu: [], mem: [], net: [] };

  /* --------------------------------------------------------------- overview */
  async function overview(host) {
    host.innerHTML = `<div class="page-head">
      <div><div class="eyebrow">Administration</div><h1>Command center</h1>
      <p class="sub">Live health of this DARKONYX node — compute, storage, services and every hosted server.</p></div>
      <div class="head-actions">
        <button class="btn" id="ov-refresh">${I('refresh')} Refresh</button>
        <button class="btn btn-primary" id="ov-new">${I('plus')} New server</button>
      </div></div>
      <div id="adm-body">${window.el.skeleton(6)}</div>`;

    document.getElementById('ov-refresh').onclick = () => window.DKX.Router.resolve();
    document.getElementById('ov-new').onclick = () => createServer(() => window.DKX.Router.resolve());

    let d;
    try { d = await API.get('/api/admin/overview'); }
    catch (e) { document.getElementById('adm-body').innerHTML = `<div class="card card-pad">${emptyState('alert', 'Telemetry unavailable', e.message)}</div>`; return; }

    const sys = d.system, m = d.metrics, db = d.mariadb, docker = d.docker;
    history.cpu.push(sys.cpu.percent); if (history.cpu.length > 40) history.cpu.shift();
    history.mem.push(sys.memory.percent); if (history.mem.length > 40) history.mem.shift();
    const netRate = (sys.network.rx_bytes_sec + sys.network.tx_bytes_sec);
    history.net.push(netRate); if (history.net.length > 40) history.net.shift();

    let servers = [];
    try { servers = (await API.get('/api/servers')).servers || []; } catch (e) {}
    const running = servers.filter((s) => s.status === 'running');

    document.getElementById('adm-body').innerHTML = `
      <div class="bento">
        <div class="span-3"><div class="stat">
          <div class="stat-top">${I('cpu')} CPU load</div>
          <div class="stat-value">${Math.round(sys.cpu.percent)}<small>%</small></div>
          <div class="stat-foot"><span>${esc(sys.cpu.cores)} cores · load ${sys.cpu.load_avg.map((x) => x.toFixed(2)).join(' / ')}</span></div>
          <div class="mt-14">${sparkline(history.cpu, { color: '#8b5cf6', height: 40 })}</div>
        </div></div>
        <div class="span-3"><div class="stat">
          <div class="stat-top">${I('memory')} Memory</div>
          <div class="stat-value">${esc(fmt.bytes(sys.memory.used_bytes))}</div>
          <div class="stat-foot"><span>of ${esc(fmt.bytes(sys.memory.total_bytes))} · ${sys.memory.percent}%</span></div>
          <div class="mt-14">${sparkline(history.mem, { color: '#34d399', height: 40 })}</div>
        </div></div>
        <div class="span-3"><div class="stat">
          <div class="stat-top">${I('disk')} Disk</div>
          <div class="stat-value">${esc(fmt.bytes(sys.disk.used_bytes))}</div>
          <div class="stat-foot"><span>${sys.disk.percent}% of ${esc(fmt.bytes(sys.disk.total_bytes))}</span></div>
          <div class="mt-14">${meter(sys.disk.percent, sys.disk.percent > 90 ? 'danger' : sys.disk.percent > 70 ? 'warn' : '')}</div>
        </div></div>
        <div class="span-3"><div class="stat">
          <div class="stat-top">${I('network')} Network</div>
          <div class="stat-value" style="font-size:20px">${esc(fmt.bytes(netRate))}<small>/s</small></div>
          <div class="stat-foot"><span>↓ ${esc(fmt.bytes(sys.network.rx_bytes_sec))}/s · ↑ ${esc(fmt.bytes(sys.network.tx_bytes_sec))}/s</span></div>
          <div class="mt-14">${sparkline(history.net, { color: '#38bdf8', height: 40 })}</div>
        </div></div>

        <div class="span-8">
          <div class="card">
            <div class="card-head"><div class="grow"><h3>Servers</h3><div class="card-sub">${m.servers.total} total · ${m.servers.running} running · ${m.servers.offline} offline${m.servers.suspended ? ` · ${m.servers.suspended} suspended` : ''}</div></div>
              <a class="btn btn-sm btn-ghost" href="#/admin/servers">Manage all ${I('chevronRight')}</a></div>
            <div class="card-body">
              ${servers.length ? `<div class="table-wrap"><table class="data">
                <thead><tr><th>Server</th><th>Owner</th><th>State</th><th>Build</th><th></th></tr></thead>
                <tbody>${servers.slice(0, 8).map((s) => `<tr>
                  <td><div class="row gap-8"><div class="srv-icon" style="width:26px;height:26px;flex-basis:26px;border-radius:8px">${I('box')}</div>
                    <div><b>${esc(s.name)}</b><div class="tiny dim mono">${esc(serverAddress(s))}</div></div></div></td>
                  <td class="dim">${esc(s.owner_username || '—')}</td>
                  <td>${statusChip(s.is_suspended ? 'suspended' : s.status)}</td>
                  <td class="tiny dim">${esc(fmt.mb(s.memory_mb))} · ${esc(s.cpu_limit)}% · ${esc(fmt.mb(s.disk_mb))}</td>
                  <td><div class="cell-actions"><button class="btn btn-xs" data-open="${s.id}">${I('terminal')}</button></div></td>
                </tr>`).join('')}</tbody></table></div>`
        : emptyState('server', 'No servers yet', 'Create the first instance for this node.', `<button class="btn btn-sm btn-primary" id="ov-empty-new">${I('plus')} New server</button>`)}
            </div>
          </div>
        </div>

        <div class="span-4 col gap-14">
          <div class="card">
            <div class="card-head"><h3>Services</h3></div>
            <div class="card-body">
              <div class="kv"><span class="k">Panel</span><span class="v"><span class="chip chip-live">v${esc(sys.panel_version)}</span></span></div>
              <div class="kv"><span class="k">Database</span><span class="v">${db.status === 'connected' ? `<span class="chip chip-live">${esc(db.version.split(' ').slice(0, 2).join(' '))}</span>` : `<span class="chip chip-danger">error</span>`}</span></div>
              <div class="kv"><span class="k">DB latency</span><span class="v mono">${esc(db.latency_ms)} ms</span></div>
              <div class="kv"><span class="k">Docker</span><span class="v">${docker.available ? `<span class="chip chip-live">${docker.containers_running}/${docker.containers_total} up</span>` : `<span class="chip chip-warn">process mode</span>`}</span></div>
              <div class="kv"><span class="k">Runtime</span><span class="v mono">${esc(sys.node_version)}</span></div>
              <div class="kv"><span class="k">Host uptime</span><span class="v">${esc(fmt.uptime(sys.uptime_seconds))}</span></div>
              <div class="kv"><span class="k">Platform</span><span class="v">${esc(sys.platform)} ${esc(sys.arch)}</span></div>
            </div>
          </div>
          <div class="card">
            <div class="card-head"><h3>Fleet</h3></div>
            <div class="card-body">
              <div class="kv"><span class="k">Users</span><span class="v">${esc(m.users.total)} <span class="dim tiny">(${m.users.admins} admin)</span></span></div>
              <div class="kv"><span class="k">Allocations</span><span class="v">${m.allocations.assigned}/${m.allocations.total} <span class="dim tiny">used</span></span></div>
              <div class="kv"><span class="k">Backups</span><span class="v">${m.backups.total} · ${esc(fmt.bytes(m.backups.total_bytes))}</span></div>
              <div class="kv"><span class="k">Databases</span><span class="v">${m.databases.total}</span></div>
              <div class="kv"><span class="k">Nodes</span><span class="v">${m.nodes.total}</span></div>
            </div>
          </div>
        </div>
      </div>`;

    host.querySelectorAll('[data-open]').forEach((b) => b.onclick = () => location.hash = `#/server/${b.dataset.open}/console`);
    const en = document.getElementById('ov-empty-new');
    if (en) en.onclick = () => createServer(() => window.DKX.Router.resolve());
  }

  /* ---------------------------------------------------------------- servers */
  async function servers(host) {
    host.innerHTML = `<div class="page-head">
      <div><div class="eyebrow">Administration</div><h1>All servers</h1>
      <p class="sub">Every instance on the panel — power, suspend, transfer and delete from one table.</p></div>
      <div class="head-actions">
        <input class="input" id="as-search" placeholder="Search name, owner, node…" style="width:220px" />
        <button class="btn" id="as-refresh">${I('refresh')}</button>
        <button class="btn btn-primary" id="as-new">${I('plus')} New server</button>
      </div></div>
      <div id="as-bulk" class="row wrap gap-8 mb-14" style="align-items:center">
        <span class="section-label" style="margin:0">Bulk actions</span>
        <button class="btn btn-sm" id="as-bulk-suspend">${I('lock')} Suspend</button>
        <button class="btn btn-sm" id="as-bulk-unsuspend">${I('unlock')} Unsuspend</button>
        <button class="btn btn-sm" id="as-bulk-transfer">${I('bolt')} Transfer</button>
        <button class="btn btn-sm btn-danger" id="as-bulk-delete">${I('trash')} Delete</button>
        <span class="dim tiny">Tick servers in the table to act on them</span>
      </div>
      <div class="card" id="as-card">${window.el.skeleton(8)}</div>`;

    document.getElementById('as-new').onclick = () => createServer(() => window.DKX.Router.resolve());
    document.getElementById('as-refresh').onclick = () => window.DKX.Router.resolve();

    const paint = async (q = '') => {
      const card = document.getElementById('as-card');
      try {
        const r = await API.get('/api/servers');
        const list = (r.servers || []).filter((s) => (s.name + ' ' + (s.owner_username || '') + ' ' + (s.node_name || '')).toLowerCase().includes(q.toLowerCase()));
        card.innerHTML = list.length ? `<div class="table-wrap"><table class="data">
          <thead><tr><th style="width:28px"><label class="checkbox"><input type="checkbox" id="as-selall" /></label></th>
          <th>Server</th><th>Owner</th><th>Node</th><th>State</th><th>Build</th><th>Created</th><th style="text-align:right">Actions</th></tr></thead>
          <tbody>${list.map((s) => `<tr>
            <td style="width:28px"><label class="checkbox"><input type="checkbox" data-sel="${s.id}" /></label></td>
            <td><div class="row gap-8"><div class="srv-icon" style="width:28px;height:28px;flex-basis:28px;border-radius:9px">${I('box')}</div>
              <div style="min-width:0"><b>${esc(s.name)}</b><div class="tiny dim mono truncate">${esc(serverAddress(s))}</div></div></div></td>
            <td class="dim">${esc(s.owner_username || '—')}</td>
            <td class="dim">${esc(s.node_name || '—')}</td>
            <td>${statusChip(s.is_suspended ? 'suspended' : s.status)}</td>
            <td class="tiny dim">${esc(fmt.mb(s.memory_mb))} · ${esc(s.cpu_limit)}%</td>
            <td class="dim tiny">${esc(fmt.date(s.created_at, false))}</td>
            <td><div class="cell-actions">
              <button class="btn btn-xs" data-open="${s.id}" title="Console">${I('terminal')}</button>
              <button class="btn btn-xs btn-ghost" data-susp="${s.id}" data-on="${s.is_suspended ? 1 : 0}" title="${s.is_suspended ? 'Unsuspend' : 'Suspend'}">${I(s.is_suspended ? 'unlock' : 'lock')}</button>
              <button class="btn btn-xs btn-ghost" data-edit="${s.id}" title="Edit build">${I('sliders')}</button>
              <button class="btn btn-xs btn-ghost" data-del="${s.id}" title="Delete">${I('trash')}</button>
            </div></td>
          </tr>`).join('')}</tbody></table></div>`
          : emptyState('server', q ? 'No matching servers' : 'No servers on this panel', q ? 'Try another search.' : 'Create one to get started.');
        // ---- bulk selection + fleet actions (admin endpoints) ----
        const selIds = () => [...card.querySelectorAll('[data-sel]:checked')].map((c) => Number(c.dataset.sel));
        const allBox = card.querySelector('#as-selall');
        if (allBox) allBox.onchange = () => {
          card.querySelectorAll('[data-sel]').forEach((c) => { c.checked = allBox.checked; });
        };
        // the bulk toolbar lives in the page head, outside the re-rendered table card
        const bulk = (id, fn) => { const b = document.getElementById(id.replace('#', '')); if (b) b.onclick = fn; };
        bulk('#as-bulk-suspend', () => confirmDialog({
          title: 'Suspend selected servers?', message: 'Owners lose power control until you unsuspend them.', confirmLabel: 'Suspend',
          onConfirm: async () => {
            try { const res = await API.post('/api/admin/servers/bulk-suspend', { server_ids: selIds() }); toast(res.message || 'Servers suspended', 'ok'); paint(q); }
            catch (e) { toast(e.message, 'err'); }
          }
        }));
        bulk('#as-bulk-unsuspend', async () => {
          try { const res = await API.post('/api/admin/servers/bulk-unsuspend', { server_ids: selIds() }); toast(res.message || 'Servers unsuspended', 'ok'); paint(q); }
          catch (e) { toast(e.message, 'err'); }
        });
        bulk('#as-bulk-transfer', () => modal({
          title: 'Transfer selected servers', subtitle: 'Servers move to the destination node with a free allocation',
          body: `<div class="field"><label>Destination node</label><select class="select" id="bt-node"></select></div>
                 <p class="dim small mt-8">Allocations are chosen automatically on the target node.</p>`,
          footer: `<button class="btn" data-cancel>Cancel</button><button class="btn btn-primary" data-ok>${I('bolt')} Transfer</button>`,
          onMount(w, close) {
            w.querySelector('[data-cancel]').onclick = close;
            API.get('/api/admin/nodes').then((nr) => {
              w.querySelector('#bt-node').innerHTML = (nr.nodes || []).map((n) => `<option value="${n.id}">${esc(n.name)} (${esc(n.fqdn)})</option>`).join('');
            }).catch(() => {});
            w.querySelector('[data-ok]').onclick = async () => {
              const nodeId = Number(w.querySelector('#bt-node').value);
              if (!nodeId) return toast('Pick a destination node', 'err');
              try { const res = await API.post('/api/admin/servers/bulk-transfer', { server_ids: selIds(), node_id: nodeId }); toast(res.message || 'Servers transferred', 'ok'); close(); paint(q); }
              catch (e) { toast(e.message, 'err'); }
            };
          }
        }));
        bulk('#as-bulk-delete', () => {
          const ids = selIds();
          if (!ids.length) return toast('Select at least one server', 'err');
          confirmDialog({
            title: `Delete ${ids.length} server(s)?`, message: 'Files, backups and allocations are removed permanently.', confirmLabel: 'Delete permanently',
            onConfirm: async () => {
              try { const res = await API.post('/api/admin/servers/bulk-delete', { server_ids: ids }); toast(res.message || 'Servers deleted', 'ok'); paint(q); }
              catch (e) { toast(e.message, 'err'); }
            }
          });
        });

        card.querySelectorAll('[data-open]').forEach((b) => b.onclick = () => location.hash = `#/server/${b.dataset.open}/console`);
        card.querySelectorAll('[data-susp]').forEach((b) => b.onclick = () => confirmDialog({
          title: b.dataset.on === '1' ? 'Unsuspend server?' : 'Suspend server?',
          message: b.dataset.on === '1' ? 'The owner will regain power controls immediately.' : 'The server will be stopped and the owner cannot start it until unsuspended.',
          confirmLabel: b.dataset.on === '1' ? 'Unsuspend' : 'Suspend',
          onConfirm: async () => { await API.post(`/api/servers/${b.dataset.susp}/suspend`, { suspended: b.dataset.on !== '1' }); toast('Server updated', 'ok'); paint(q); }
        }));
        card.querySelectorAll('[data-edit]').forEach((b) => b.onclick = () => editBuild(list.find((x) => String(x.id) === b.dataset.edit), () => paint(q)));
        card.querySelectorAll('[data-del]').forEach((b) => b.onclick = () => {
          const srv = list.find((x) => String(x.id) === b.dataset.del);
          confirmDialog({
            title: `Delete "${srv.name}"?`, message: 'This permanently removes the server, its files, backups and allocations.', confirmLabel: 'Delete permanently',
            onConfirm: async () => { await API.del(`/api/servers/${srv.id}`); toast('Server deleted', 'ok'); paint(q); }
          });
        });
      } catch (e) { card.innerHTML = emptyState('alert', 'Could not load servers', e.message); }
    };
    let t;
    document.getElementById('as-search').oninput = (e) => { clearTimeout(t); t = setTimeout(() => paint(e.target.value), 220); };
    paint();
  }

  function editBuild(srv, after) {
    if (!srv) return;
    modal({
      title: `Edit ${srv.name}`, subtitle: 'Build configuration applies on next server start',
      body: `<div class="col gap-14">
        <div class="two-col">
          <div class="field"><label>Memory (MB)</label><input class="input" id="eb-mem" type="number" value="${esc(srv.memory_mb)}" /></div>
          <div class="field"><label>CPU limit (%)</label><input class="input" id="eb-cpu" type="number" value="${esc(srv.cpu_limit)}" /></div>
        </div>
        <div class="two-col">
          <div class="field"><label>Disk (MB)</label><input class="input" id="eb-disk" type="number" value="${esc(srv.disk_mb)}" /></div>
          <div class="field"><label>Expiration date</label><input class="input" id="eb-exp" type="date" value="${esc((srv.expiration_date || '').slice(0, 10))}" /></div>
        </div>
        <div class="field"><label>Startup command</label><input class="input mono" id="eb-cmd" value="${esc(srv.startup_cmd || '')}" /></div>
      </div>`,
      footer: `<button class="btn" data-cancel>Cancel</button><button class="btn btn-primary" data-save>${I('save')} Save build</button>`,
      onMount(wrap, close) {
        wrap.querySelector('[data-cancel]').onclick = close;
        wrap.querySelector('[data-save]').onclick = async () => {
          try {
            await API.put(`/api/servers/${srv.id}`, {
              memory_mb: Number(wrap.querySelector('#eb-mem').value),
              cpu_limit: Number(wrap.querySelector('#eb-cpu').value),
              disk_mb: Number(wrap.querySelector('#eb-disk').value),
              expiration_date: wrap.querySelector('#eb-exp').value || null,
              startup_cmd: wrap.querySelector('#eb-cmd').value
            });
            toast('Build updated', 'ok'); close(); after && after();
          } catch (e) { toast(e.message, 'err'); }
        };
      }
    });
  }

  /* ------------------------------------------------------- create server UI */
  async function createServer(after) {
    let users = [], nodes = [], allocs = [], images = null, types = [];
    try {
      const [u, n, a, s] = await Promise.all([
        API.get('/api/admin/users'), API.get('/api/admin/nodes'), API.get('/api/admin/network'), API.get('/api/admin/settings').catch(() => null)
      ]);
      users = u.users || []; nodes = n.nodes || []; allocs = a.allocations || [];
      images = s && s.dockerTemplates ? s.dockerTemplates : null;
    } catch (e) { toast(e.message, 'err'); return; }
    try { const t = await API.get('/api/mcjars/types'); types = t.types || []; } catch (e) {}

    const m = modal({
      title: 'Deploy a server', subtitle: 'Minecraft, Node.js, Python or a virtual machine', size: 'wide',
      body: `<div class="col gap-14">
        <div class="two-col">
          <div class="field"><label>Server name</label><input class="input" id="cs-name" placeholder="Survival SMP" /></div>
          <div class="field"><label>Owner</label><select class="select" id="cs-owner">${users.map((u) => `<option value="${u.id}">${esc(u.username)} — ${esc(u.email)}</option>`).join('')}</select></div>
        </div>
        <div class="two-col">
          <div class="field"><label>Server type</label><select class="select" id="cs-type">
            <option value="minecraft">Minecraft</option><option value="nodejs">Node.js</option><option value="python">Python</option>
            <option value="lumenvm">KVM Virtual Machine</option><option value="nokvm">No-KVM Virtual Machine</option>
          </select></div>
          <div class="field"><label>Node</label><select class="select" id="cs-node">${nodes.map((n) => `<option value="${n.id}">${esc(n.name)} (${esc(n.fqdn)})</option>`).join('')}</select></div>
        </div>
        <div id="cs-mc" class="col gap-14">
          <div class="two-col">
            <div class="field"><label>Server software</label><select class="select" id="cs-jar">${(types.length ? types : [{ id: 'paper', name: 'Paper' }, { id: 'vanilla', name: 'Vanilla' }]).map((t) => `<option value="${esc(t.id || t)}">${esc(t.name || t.id || t)}</option>`).join('')}</select></div>
            <div class="field"><label>Minecraft version</label><input class="input mono" id="cs-version" value="1.21.4" /></div>
          </div>
        </div>
        <div class="three-col">
          <div class="field"><label>Memory (MB)</label><input class="input" id="cs-mem" type="number" value="2048" /></div>
          <div class="field"><label>CPU (%)</label><input class="input" id="cs-cpu" type="number" value="100" /></div>
          <div class="field"><label>Disk (MB)</label><input class="input" id="cs-disk" type="number" value="10240" /></div>
        </div>
        <div class="field"><label>Port allocation</label><select class="select" id="cs-alloc">
          <option value="">Auto-assign the first free port</option>
          ${allocs.filter((a) => !a.assigned).slice(0, 80).map((a) => `<option value="${a.id}">${esc(a.ip)}:${esc(a.port)} — ${esc(a.node_name || 'node ' + a.node_id)}</option>`).join('')}
        </select></div>
        <div class="field"><label>Description</label><input class="input" id="cs-desc" placeholder="Optional" /></div>
      </div>`,
      footer: `<button class="btn" data-cancel>Cancel</button><button class="btn btn-primary" data-create>${I('rocket')} Deploy server</button>`,
      onMount(wrap, close) {
        const typeSel = wrap.querySelector('#cs-type');
        typeSel.onchange = () => {
          const isMc = typeSel.value === 'minecraft';
          wrap.querySelector('#cs-mc').style.display = isMc ? '' : 'none';
          const mem = wrap.querySelector('#cs-mem'), disk = wrap.querySelector('#cs-disk');
          if (typeSel.value === 'lumenvm' || typeSel.value === 'nokvm') { mem.value = 4096; disk.value = 20480; }
        };
        wrap.querySelector('[data-cancel]').onclick = close;
        wrap.querySelector('[data-create]').onclick = async () => {
          const btn = wrap.querySelector('[data-create]');
          btn.disabled = true; btn.textContent = 'Deploying…';
          const body = {
            name: wrap.querySelector('#cs-name').value.trim(),
            description: wrap.querySelector('#cs-desc').value,
            server_type: typeSel.value,
            user_id: Number(wrap.querySelector('#cs-owner').value),
            node_id: Number(wrap.querySelector('#cs-node').value),
            memory_mb: Number(wrap.querySelector('#cs-mem').value),
            cpu_limit: Number(wrap.querySelector('#cs-cpu').value),
            disk_mb: Number(wrap.querySelector('#cs-disk').value),
            allocation_id: wrap.querySelector('#cs-alloc').value ? Number(wrap.querySelector('#cs-alloc').value) : undefined
          };
          if (typeSel.value === 'minecraft') {
            body.mc_jar_type = wrap.querySelector('#cs-jar').value;
            body.mc_jar_version = wrap.querySelector('#cs-version').value.trim();
          }
          if (!body.name) { toast('Give your server a name', 'warn'); btn.disabled = false; btn.innerHTML = `${I('rocket')} Deploy server`; return; }
          try {
            await API.post('/api/servers', body);
            toast('Server deployed', 'ok', 'Success');
            close(); after && after();
          } catch (e) {
            toast(e.message, 'err');
            btn.disabled = false; btn.innerHTML = `${I('rocket')} Deploy server`;
          }
        };
      }
    });
    return m;
  }

  /* ------------------------------------------------------------------ users */
  async function users(host) {
    host.innerHTML = `<div class="page-head">
      <div><div class="eyebrow">Administration</div><h1>Users</h1>
      <p class="sub">Accounts, roles, resource totals and suspensions.</p></div>
      <div class="head-actions">
        <input class="input" id="us-search" placeholder="Search users…" style="width:200px" />
        <button class="btn btn-primary" id="us-new">${I('plus')} New user</button>
      </div></div>
      <div class="card" id="us-card">${window.el.skeleton(6)}</div>`;

    document.getElementById('us-new').onclick = () => modal({
      title: 'Create user',
      body: `<div class="col gap-14">
        <div class="two-col">
          <div class="field"><label>Username</label><input class="input" id="nu-user" /></div>
          <div class="field"><label>Email</label><input class="input" id="nu-email" type="email" /></div>
        </div>
        <div class="two-col">
          <div class="field"><label>Password</label><input class="input" id="nu-pass" type="text" value="${Math.random().toString(36).slice(2, 12)}" /></div>
          <div class="field"><label>Role</label><select class="select" id="nu-role"><option value="user">Client</option><option value="admin">Administrator</option></select></div>
        </div>
      </div>`,
      footer: `<button class="btn" data-cancel>Cancel</button><button class="btn btn-primary" data-ok>Create user</button>`,
      onMount(wrap, close) {
        wrap.querySelector('[data-cancel]').onclick = close;
        wrap.querySelector('[data-ok]').onclick = async () => {
          try {
            await API.post('/api/admin/users', {
              username: wrap.querySelector('#nu-user').value.trim(),
              email: wrap.querySelector('#nu-email').value.trim(),
              password: wrap.querySelector('#nu-pass').value,
              role: wrap.querySelector('#nu-role').value
            });
            toast('User created', 'ok'); close(); window.DKX.Router.resolve();
          } catch (e) { toast(e.message, 'err'); }
        };
      }
    });

    const paint = async (q = '') => {
      const card = document.getElementById('us-card');
      try {
        const r = await API.get('/api/admin/users');
        const list = (r.users || []).filter((u) => (u.username + ' ' + u.email).toLowerCase().includes(q.toLowerCase()));
        card.innerHTML = `<div class="table-wrap"><table class="data">
          <thead><tr><th>User</th><th>Role</th><th>Servers</th><th>Memory</th><th>Last login</th><th>Status</th><th style="text-align:right">Actions</th></tr></thead>
          <tbody>${list.map((u) => `<tr>
            <td><div class="row gap-8"><div class="avatar" style="width:28px;height:28px;flex-basis:28px;border-radius:9px;font-size:10px">${esc(fmt.initials(u.username))}</div>
              <div><b>${esc(u.username)}</b><div class="tiny dim">${esc(u.email)}</div></div></div></td>
            <td>${u.role === 'admin' ? '<span class="chip chip-onyx">Admin</span>' : '<span class="chip">Client</span>'}</td>
            <td class="num">${esc(u.server_count || 0)}</td>
            <td class="num dim">${esc(fmt.mb(u.total_memory_mb || 0))}</td>
            <td class="dim tiny">${esc(u.last_login_at ? fmt.ago(u.last_login_at) : 'never')}</td>
            <td>${u.suspended ? '<span class="chip chip-danger">Suspended</span>' : '<span class="chip chip-live">Active</span>'}</td>
            <td><div class="cell-actions">
              <button class="btn btn-xs btn-ghost" data-imp="${u.id}" title="Sign in as user">${I('external')}</button>
              <button class="btn btn-xs btn-ghost" data-sus="${u.id}" data-on="${u.suspended ? 1 : 0}" title="${u.suspended ? 'Reactivate' : 'Suspend'}">${I(u.suspended ? 'unlock' : 'lock')}</button>
              <button class="btn btn-xs btn-ghost" data-edit="${u.id}" title="Edit">${I('edit')}</button>
              <button class="btn btn-xs btn-ghost" data-del="${u.id}" title="Delete">${I('trash')}</button>
            </div></td>
          </tr>`).join('')}</tbody></table></div>`;

        card.querySelectorAll('[data-sus]').forEach((b) => b.onclick = () => confirmDialog({
          title: b.dataset.on === '1' ? 'Reactivate user?' : 'Suspend user?',
          message: b.dataset.on === '1' ? 'They will be able to sign in again immediately.' : 'They will be locked out of the panel and their servers stop.',
          confirmLabel: b.dataset.on === '1' ? 'Reactivate' : 'Suspend',
          onConfirm: async () => { await API.post(`/api/admin/users/${b.dataset.sus}/suspend`, { suspended: b.dataset.on !== '1' }); paint(q); }
        }));
        card.querySelectorAll('[data-imp]').forEach((b) => b.onclick = async () => {
          try {
            const r = await API.post(`/api/admin/users/${b.dataset.imp}/impersonate`);
            if (r.token) { Store.setToken(r.token); Store.setUser(r.user); toast(`Now signed in as ${r.user.username}`, 'info'); location.hash = '#/portal/overview'; window.DKX.Router.resolve(); }
            else toast('Impersonation not available', 'warn');
          } catch (e) { toast(e.message, 'err'); }
        });
        card.querySelectorAll('[data-edit]').forEach((b) => {
          const u = list.find((x) => String(x.id) === b.dataset.edit);
          b.onclick = () => modal({
            title: `Edit ${u.username}`,
            body: `<div class="col gap-14">
              <div class="two-col"><div class="field"><label>Username</label><input class="input" id="eu-user" value="${esc(u.username)}" /></div>
              <div class="field"><label>Email</label><input class="input" id="eu-email" value="${esc(u.email)}" /></div></div>
              <div class="field"><label>Role</label><select class="select" id="eu-role"><option value="user" ${u.role !== 'admin' ? 'selected' : ''}>Client</option><option value="admin" ${u.role === 'admin' ? 'selected' : ''}>Administrator</option></select></div>
              <div class="field"><label>New password <span class="hint">(leave blank to keep)</span></label><input class="input" id="eu-pass" /></div>
            </div>`,
            footer: `<button class="btn" data-cancel>Cancel</button><button class="btn btn-primary" data-ok>Save</button>`,
            onMount(wrap, close) {
              wrap.querySelector('[data-cancel]').onclick = close;
              wrap.querySelector('[data-ok]').onclick = async () => {
                const body = { username: wrap.querySelector('#eu-user').value, email: wrap.querySelector('#eu-email').value, role: wrap.querySelector('#eu-role').value };
                const pw = wrap.querySelector('#eu-pass').value;
                if (pw) body.password = pw;
                try { await API.put(`/api/admin/users/${u.id}`, body); toast('User updated', 'ok'); close(); paint(q); }
                catch (e) { toast(e.message, 'err'); }
              };
            }
          });
        });
        card.querySelectorAll('[data-del]').forEach((b) => {
          const u = list.find((x) => String(x.id) === b.dataset.del);
          b.onclick = () => confirmDialog({
            title: `Delete ${u.username}?`, message: 'Their servers, backups and API keys will be destroyed.', confirmLabel: 'Delete user',
            onConfirm: async () => { await API.del(`/api/admin/users/${u.id}`); toast('User deleted', 'ok'); paint(q); }
          });
        });
      } catch (e) { card.innerHTML = emptyState('alert', 'Could not load users', e.message); }
    };
    let t;
    document.getElementById('us-search').oninput = (e) => { clearTimeout(t); t = setTimeout(() => paint(e.target.value), 200); };
    paint();
  }

  /* ------------------------------------------------------------------ nodes */
  async function nodes(host) {
    host.innerHTML = `<div class="page-head">
      <div><div class="eyebrow">Administration</div><h1>Nodes</h1>
      <p class="sub">Daemon hosts that run your game servers, with live health probes.</p></div>
      <div class="head-actions">
        <button class="btn" id="nd-refresh">${I('refresh')}</button>
        <button class="btn btn-primary" id="nd-new">${I('plus')} Add node</button>
      </div></div>
      <div id="nd-body">${window.el.skeleton(4)}</div>`;

    document.getElementById('nd-refresh').onclick = () => window.DKX.Router.resolve();
    document.getElementById('nd-new').onclick = async () => {
      let locations = [];
      try { locations = (await API.get('/api/admin/locations')).locations || []; } catch (e) {}
      modal({
        title: 'Add node', subtitle: 'The daemon must be reachable on the FQDN and port',
        body: `<div class="col gap-14">
          <div class="two-col"><div class="field"><label>Name</label><input class="input" id="nn-name" placeholder="EU Node 1" /></div>
          <div class="field"><label>FQDN / IP</label><input class="input" id="nn-fqdn" placeholder="node1.example.com" /></div></div>
          <div class="three-col">
            <div class="field"><label>Daemon port</label><input class="input" id="nn-dport" type="number" value="3003" /></div>
            <div class="field"><label>SFTP port</label><input class="input" id="nn-sport" type="number" value="3004" /></div>
            <div class="field"><label>Location</label><select class="select" id="nn-loc">${locations.map((l) => `<option value="${l.id}">${esc(l.name)}</option>`).join('') || '<option value="1">Default</option>'}</select></div>
          </div>
          <div class="three-col">
            <div class="field"><label>Memory (MB)</label><input class="input" id="nn-mem" type="number" value="16384" /></div>
            <div class="field"><label>Disk (MB)</label><input class="input" id="nn-disk" type="number" value="102400" /></div>
            <div class="field"><label>Port range</label><input class="input" id="nn-ports" placeholder="25565-25575" /></div>
          </div>
        </div>`,
        footer: `<button class="btn" data-cancel>Cancel</button><button class="btn btn-primary" data-ok>Add node</button>`,
        onMount(wrap, close) {
          wrap.querySelector('[data-cancel]').onclick = close;
          wrap.querySelector('[data-ok]').onclick = async () => {
            try {
              await API.post('/api/admin/nodes', {
                name: wrap.querySelector('#nn-name').value.trim(),
                fqdn: wrap.querySelector('#nn-fqdn').value.trim(),
                daemon_port: Number(wrap.querySelector('#nn-dport').value),
                sftp_port: Number(wrap.querySelector('#nn-sport').value),
                location_id: Number(wrap.querySelector('#nn-loc').value || 1),
                memory_mb: Number(wrap.querySelector('#nn-mem').value),
                disk_mb: Number(wrap.querySelector('#nn-disk').value),
                port_range: wrap.querySelector('#nn-ports').value.trim() || undefined
              });
              toast('Node added', 'ok'); close(); window.DKX.Router.resolve();
            } catch (e) { toast(e.message, 'err'); }
          };
        }
      });
    };

    try {
      const [r, upd] = await Promise.all([
        API.get('/api/admin/nodes'),
        API.get('/api/admin/nodes/updates').catch(() => null)
      ]);
      const list = r.nodes || [];
      const needsUpdate = upd && upd.update_available;
      const banner = needsUpdate ? `<div class="card card-pad mb-14" style="border-color:var(--warn, #d97706)">
        <div class="row wrap gap-14" style="align-items:center">
          <div class="srv-icon">${I('bolt')}</div>
          <div class="grow"><b>Daemon update available</b>
            <div class="dim small">This host runs v${esc(upd.current_version)} — v${esc(upd.latest_version)} is published.</div></div>
          <button class="btn btn-sm" id="nd-upd-view">${I('info')} What's new</button>
        </div></div>` : '';
      const massBar = list.length > 1 ? `<div class="row wrap gap-8 mb-14" style="align-items:center">
        <span class="section-label" style="margin:0">Fleet actions</span>
        <input class="input" id="nd-appname" placeholder="App name for all nodes" style="max-width:230px" value="${esc((window.DKX.Store.bootstrap && window.DKX.Store.bootstrap.company_name) || '')}" />
        <button class="btn btn-sm" id="nd-appname-set">${I('save')} Apply name</button>
        <button class="btn btn-sm" id="nd-fleet-restart">${I('restart')} Restart all daemons</button>
      </div>` : '';

      document.getElementById('nd-body').innerHTML = banner + massBar + (list.length ? `<div class="srv-grid">${list.map((n) => {
        const used = Number(n.assigned_ports || n.used_memory_mb || 0);
        return `<article class="srv-card" style="cursor:default">
          <div class="srv-glow"></div>
          <div class="srv-head">
            <div class="srv-icon">${I('network')}</div>
            <div class="srv-title grow"><h4>${esc(n.name)}</h4>
              <div class="srv-meta mono">${esc(n.fqdn)}:${esc(n.daemon_port)}</div></div>
            <span class="chip chip-live"><i class="dot live"></i>Online</span>
          </div>
          <div class="srv-body">
            <div class="srv-specs">
              <div class="spec"><span>Memory</span><b>${esc(fmt.mb(n.memory_mb))}</b></div>
              <div class="spec"><span>Disk</span><b>${esc(fmt.mb(n.disk_mb))}</b></div>
              <div class="spec"><span>Servers</span><b>${esc(n.server_count || 0)}</b></div>
            </div>
            <div class="meta row wrap gap-8 tiny dim">
              <span>${esc(n.location_name || 'default location')}</span>
              <span class="chip">${esc(n.assigned_allocations || 0)}/${esc(n.total_allocations || 0)} ports used</span>
              <span class="mono">SFTP ${esc(n.sftp_port)}</span>
            </div>
          </div>
          <div class="srv-foot">
            <a class="btn btn-sm grow" href="#/admin/network">${I('globe')} Allocations</a>
            <button class="btn btn-sm btn-ghost" data-nodes-detail="${n.id}">${I('activity')} Details</button>
          </div>
        </article>`;
      }).join('')}</div>` : emptyState('network', 'No nodes', 'Add a node to start deploying servers.'));

      const updView = document.getElementById('nd-upd-view');
      if (updView) updView.onclick = () => modal({
        title: 'Daemon update', subtitle: `Installed v${upd.current_version} · latest v${upd.latest_version}`,
        body: `<p class="small muted" style="line-height:1.65">${esc((upd.release_notes || upd.notes || 'A newer daemon build is published. Update the agent on each host with your normal package workflow.'))}</p>`,
        footer: `<button class="btn" data-close>Close</button>`,
        onMount(w, close) { w.querySelector('[data-close]').onclick = close; }
      });

      const applyName = document.getElementById('nd-appname-set');
      if (applyName) applyName.onclick = async () => {
        const appName = document.getElementById('nd-appname').value.trim();
        if (!appName) return toast('Enter an app name first', 'err');
        try {
          const res = await API.post('/api/admin/nodes/mass-action', { action: 'set_app_name', app_name: appName });
          toast(res.message || 'App name applied', 'ok');
        } catch (e) { toast(e.message, 'err'); }
      };
      const fleetRestart = document.getElementById('nd-fleet-restart');
      if (fleetRestart) fleetRestart.onclick = () => confirmDialog({
        title: 'Restart every daemon?', message: 'All nodes will restart their agent service. Servers keep running, but the panel loses telemetry for a few seconds.',
        confirmLabel: 'Restart all', danger: false,
        onConfirm: async () => {
          try {
            const res = await API.post('/api/admin/nodes/mass-action', { action: 'wings_service', service_action: 'restart', node_ids: list.map((n) => n.id) });
            toast(res.message || 'Restart dispatched', 'ok');
          } catch (e) { toast(e.message, 'err'); }
        }
      });

      document.querySelectorAll('[data-nodes-detail]').forEach((b) => b.onclick = () => {
        if (window.DKX.Views.admin.nodeDetail) window.DKX.Views.admin.nodeDetail(b.dataset.nodesDetail);
      });
    } catch (e) { document.getElementById('nd-body').innerHTML = emptyState('alert', 'Could not load nodes', e.message); }
  }

  /* ---------------------------------------------------------------- network */
  async function network(host) {
    host.innerHTML = `<div class="page-head">
      <div><div class="eyebrow">Administration</div><h1>Network</h1>
      <p class="sub">Port allocations across every node — assign, inspect and free them.</p></div>
      <div class="head-actions"><input class="input" id="nw-search" placeholder="Filter by port, IP or server…" style="width:240px" /></div>
    </div>
    <div class="bento" id="nw-stats"></div>
    <div class="card mt-14" id="nw-card">${window.el.skeleton(6)}</div>`;

    const paint = async (q = '') => {
      try {
        const r = await API.get('/api/admin/network');
        const allocs = (r.allocations || []).filter((a) => (`${a.port} ${a.ip} ${a.server_name || ''} ${a.node_name || ''}`).toLowerCase().includes(q.toLowerCase()));
        const total = (r.allocations || []).length;
        const used = (r.allocations || []).filter((a) => a.assigned).length;
        document.getElementById('nw-stats').innerHTML = `
          <div class="span-4"><div class="stat"><div class="stat-top">${I('globe')} Total ports</div><div class="stat-value">${total}</div>
            <div class="stat-foot">across ${(r.nodes || []).length} node(s)</div></div></div>
          <div class="span-4"><div class="stat"><div class="stat-top">${I('bolt')} Assigned</div><div class="stat-value">${used}</div>
            <div class="stat-foot">${meter(total ? (used / total) * 100 : 0, 'live')}</div></div></div>
          <div class="span-4"><div class="stat"><div class="stat-top">${I('plus')} Available</div><div class="stat-value">${total - used}</div>
            <div class="stat-foot">ready for new servers</div></div></div>`;
        document.getElementById('nw-card').innerHTML = allocs.length ? `<div class="table-wrap"><table class="data">
          <thead><tr><th>Address</th><th>Node</th><th>Server</th><th>State</th></tr></thead>
          <tbody>${allocs.map((a) => `<tr>
            <td class="mono">${esc(a.ip)}:${esc(a.port)}</td>
            <td>${esc(a.node_name || '—')}</td>
            <td>${a.server_name ? `<a href="#/server/${a.server_id}/console" style="color:#c4b5fd">${esc(a.server_name)}</a>` : '<span class="dim">—</span>'}</td>
            <td>${a.assigned ? '<span class="chip chip-onyx">Assigned</span>' : '<span class="chip chip-live">Free</span>'}</td>
          </tr>`).join('')}</tbody></table></div>`
          : emptyState('globe', 'No allocations', 'Create port allocations on a node to assign them to servers.');
      } catch (e) { document.getElementById('nw-card').innerHTML = emptyState('alert', 'Could not load network', e.message); }
    };
    let t;
    document.getElementById('nw-search').oninput = (e) => { clearTimeout(t); t = setTimeout(() => paint(e.target.value), 200); };
    paint();
  }

  /* -------------------------------------------------------------- databases */
  async function databases(host) {
    host.innerHTML = `<div class="page-head">
      <div><div class="eyebrow">Administration</div><h1>Databases</h1>
      <p class="sub">MySQL/MariaDB hosts used for server databases plus every database created for clients.</p></div>
      <div class="head-actions"><button class="btn btn-primary" id="db-add">${I('plus')} Add host</button></div></div>
      <div class="two-col">
        <div class="card"><div class="card-head"><h3>Database hosts</h3></div><div id="db-hosts">${window.el.skeleton(3)}</div></div>
        <div class="card"><div class="card-head"><h3>Client databases</h3></div><div id="db-dbs">${window.el.skeleton(3)}</div></div>
      </div>`;

    document.getElementById('db-add').onclick = () => modal({
      title: 'Add database host',
      body: `<div class="col gap-14">
        <div class="two-col"><div class="field"><label>Label</label><input class="input" id="dh-name" placeholder="MariaDB EU" /></div>
        <div class="field"><label>Host</label><input class="input" id="dh-host" placeholder="127.0.0.1" /></div></div>
        <div class="three-col">
          <div class="field"><label>Port</label><input class="input" id="dh-port" type="number" value="3306" /></div>
          <div class="field"><label>Username</label><input class="input" id="dh-user" value="root" /></div>
          <div class="field"><label>Password</label><input class="input" id="dh-pass" type="text" /></div>
        </div>
      </div>`,
      footer: `<button class="btn" data-cancel>Cancel</button><button class="btn btn-primary" data-ok>Add host</button>`,
      onMount(wrap, close) {
        wrap.querySelector('[data-cancel]').onclick = close;
        wrap.querySelector('[data-ok]').onclick = async () => {
          try {
            await API.post('/api/admin/databases/hosts', {
              name: wrap.querySelector('#dh-name').value.trim(),
              host: wrap.querySelector('#dh-host').value.trim(),
              port: Number(wrap.querySelector('#dh-port').value),
              username: wrap.querySelector('#dh-user').value.trim(),
              password: wrap.querySelector('#dh-pass').value
            });
            toast('Database host added', 'ok'); close(); window.DKX.Router.resolve();
          } catch (e) { toast(e.message, 'err'); }
        };
      }
    });

    try {
      const r = await API.get('/api/admin/databases');
      document.getElementById('db-hosts').innerHTML = (r.hosts || []).length ? `<div class="table-wrap"><table class="data">
        <thead><tr><th>Host</th><th>Endpoint</th><th>Databases</th></tr></thead>
        <tbody>${(r.hosts || []).map((h) => `<tr><td><b>${esc(h.name)}</b></td><td class="mono dim">${esc(h.host)}:${esc(h.port)}</td><td class="num">${esc(h.database_count || 0)}</td></tr>`).join('')}</tbody></table></div>`
        : emptyState('database', 'No database hosts', 'Add a MySQL/MariaDB host to provision per-server databases.');
      document.getElementById('db-dbs').innerHTML = (r.databases || []).length ? `<div class="table-wrap"><table class="data">
        <thead><tr><th>Database</th><th>Server</th><th>User</th></tr></thead>
        <tbody>${(r.databases || []).map((d) => `<tr><td class="mono">${esc(d.database_name)}</td><td class="dim">${esc(d.server_name || '—')}</td><td class="mono dim">${esc(d.username)}</td></tr>`).join('')}</tbody></table></div>`
        : emptyState('database', 'No client databases', 'Databases are created from a server’s Databases tab.');
    } catch (e) {
      document.getElementById('db-hosts').innerHTML = emptyState('alert', 'Unavailable', e.message);
      document.getElementById('db-dbs').innerHTML = '';
    }
  }

  /* ---------------------------------------------------------------- backups */
  async function backups(host) {
    host.innerHTML = `<div class="page-head">
      <div><div class="eyebrow">Administration</div><h1>Backups</h1>
      <p class="sub">Every backup across the fleet, with total storage usage.</p></div>
      <div class="head-actions"><button class="btn" id="bk-refresh">${I('refresh')}</button></div></div>
      <div class="card" id="bk-card">${window.el.skeleton(5)}</div>`;
    document.getElementById('bk-refresh').onclick = () => window.DKX.Router.resolve();
    try {
      const r = await API.get('/api/admin/backups');
      const list = r.backups || [];
      const sum = r.summary || { count: 0, total_size: 0 };
      document.getElementById('bk-card').innerHTML = list.length ? `
        <div class="card-head" style="border-bottom:1px solid var(--line)"><div class="grow"><h3>${sum.count} backups</h3>
          <div class="card-sub">${esc(fmt.bytes(sum.total_size))} stored on disk</div></div></div>
        <div class="table-wrap"><table class="data">
        <thead><tr><th>Name</th><th>Server</th><th>Owner</th><th>Size</th><th>Type</th><th>Created</th></tr></thead>
        <tbody>${list.map((b) => `<tr>
          <td><b>${esc(b.name)}</b></td>
          <td>${esc(b.server_name || '—')}</td>
          <td class="dim">${esc(b.owner_username || '—')}</td>
          <td class="num">${esc(fmt.bytes(b.file_size))}</td>
          <td>${b.is_locked ? '<span class="chip chip-warn">Locked</span>' : b.is_automatic ? '<span class="chip chip-info">Auto</span>' : '<span class="chip">Manual</span>'}</td>
          <td class="dim tiny">${esc(fmt.date(b.created_at))}</td>
        </tr>`).join('')}</tbody></table></div>`
        : emptyState('archive', 'No backups', 'Backups created from any server appear here.');
    } catch (e) { document.getElementById('bk-card').innerHTML = emptyState('alert', 'Could not load backups', e.message); }
  }

  /* --------------------------------------------------------------- settings */
  async function settings(host) {
    host.innerHTML = `<div class="page-head">
      <div><div class="eyebrow">Administration</div><h1>Settings</h1>
      <p class="sub">Branding, registration, security and panel-wide defaults.</p></div>
      <div class="head-actions"><button class="btn btn-primary" id="st-save">${I('save')} Save settings</button></div></div>
      <div id="st-body">${window.el.skeleton(6)}</div>`;

    let data;
    try { data = await API.get('/api/admin/settings'); } catch (e) { document.getElementById('st-body').innerHTML = emptyState('alert', 'Settings unavailable', e.message); return; }
    const s = data.settings || {};
    const tabs = ['General', 'Branding', 'Security', 'API keys'];

    document.getElementById('st-body').innerHTML = `
      <div class="tabs" id="st-tabs">${tabs.map((t, i) => `<button class="tab ${i === 0 ? 'active' : ''}" data-st="${i}">${esc(t)}</button>`).join('')}</div>
      <div class="mt-14" id="st-panels">
        <div class="card" data-panel="0"><div class="card-head"><h3>General</h3></div><div class="card-body col gap-14">
          <div class="two-col">
            <div class="field"><label>Panel name</label><input class="input" data-set="panel_name" value="${esc(s.panel_name || 'DARKONYX')}" /></div>
            <div class="field"><label>Company / org</label><input class="input" data-set="company_name" value="${esc(s.company_name || 'DARKONYX')}" /></div>
          </div>
          <div class="two-col">
            <div class="field"><label>Default language</label><select class="select" data-set="default_language">
              ${['en', 'de', 'fr', 'es', 'pt', 'hi', 'ru', 'ja', 'zh', 'ar', 'tr'].map((l) => `<option value="${l}" ${s.default_language === l ? 'selected' : ''}>${l.toUpperCase()}</option>`).join('')}
            </select></div>
            <div class="field"><label>Default theme</label><select class="select" data-set="theme_mode">
              <option value="dark" ${s.theme_mode !== 'light' ? 'selected' : ''}>Dark</option><option value="light" ${s.theme_mode === 'light' ? 'selected' : ''}>Light</option>
            </select></div>
          </div>
          <label class="switch"><input type="checkbox" data-set="registration_enabled" ${s.registration_enabled !== '0' ? 'checked' : ''}/><span class="track"></span>
            <span class="switch-label">Allow public registration</span></label>
          <label class="switch"><input type="checkbox" data-set="tutorials_enabled" ${s.tutorials_enabled !== '0' ? 'checked' : ''}/><span class="track"></span>
            <span class="switch-label">Enable in-panel tutorials</span></label>
        </div></div>

        <div class="card hidden" data-panel="1"><div class="card-head"><h3>Branding</h3></div><div class="card-body col gap-14">
          <div class="two-col">
            <div class="field"><label>Logo URL</label><input class="input" data-set="panel_logo" value="${esc(s.panel_logo || '')}" placeholder="/uploads/branding/logo.png" /></div>
            <div class="field"><label>Favicon URL</label><input class="input" data-set="favicon_logo" value="${esc(s.favicon_logo || '')}" /></div>
          </div>
          <div class="field"><label>Background URL / video</label><input class="input" data-set="panel_bg" value="${esc(s.panel_bg || '')}" placeholder="https://… or /uploads/branding/bg.mp4" /></div>
          <div class="row gap-8 wrap">
            <label class="btn btn-sm">${I('upload')} Upload branding<input type="file" id="st-upload" style="display:none" /></label>
            <span class="dim tiny">Images or video up to 100MB. Uploaded assets are stored under /uploads/branding.</span>
          </div>
          <div class="section-label mt-8">Bundled wallpapers</div>
          <div class="row wrap gap-8" id="st-wallpapers">${window.el.skeleton(2)}</div>
        </div></div>

        <div class="card hidden" data-panel="2"><div class="card-head"><h3>Security</h3></div><div class="card-body col gap-14">
          <div class="two-col">
            <div class="field"><label>Two-factor requirement</label><select class="select" data-set="two_factor_requirement">
              ${[['0', 'Not required'], ['1', 'Admins only'], ['2', 'All users']].map(([v, l]) => `<option value="${v}" ${s.two_factor_requirement === v ? 'selected' : ''}>${l}</option>`).join('')}
            </select></div>
            <div class="field"><label>HTTP request timeout (s)</label><input class="input" data-set="http_request_timeout" type="number" value="${esc(s.http_request_timeout || 60)}" /></div>
          </div>
          <label class="switch"><input type="checkbox" data-set="recaptcha_enabled" ${String(s.recaptcha_enabled) === 'true' ? 'checked' : ''}/><span class="track"></span><span class="switch-label">Enable reCAPTCHA on login</span></label>
          <div class="two-col">
            <div class="field"><label>reCAPTCHA site key</label><input class="input" data-set="recaptcha_site_key" value="${esc(s.recaptcha_site_key || '')}" /></div>
            <div class="field"><label>reCAPTCHA secret</label><input class="input" data-set="recaptcha_secret_key" value="${esc(s.recaptcha_secret_key || '')}" /></div>
          </div>
          <div class="banner-strip">${I('shield')}<span>DARKONYX stores passwords with bcrypt, issues signed JWTs and keeps an append-only audit trail for every privileged action.</span></div>
        </div></div>

        <div class="card hidden" data-panel="3"><div class="card-head"><div class="grow"><h3>API keys</h3><div class="card-sub">Use <span class="mono">X-API-Key</span> or <span class="mono">Authorization: Bearer</span> headers</div></div>
          <button class="btn btn-sm btn-primary" id="ak-new">${I('plus')} New key</button></div>
          <div id="ak-body">${window.el.skeleton(3)}</div></div>
      </div>`;

    document.querySelectorAll('[data-st]').forEach((b) => b.onclick = () => {
      document.querySelectorAll('[data-st]').forEach((x) => x.classList.toggle('active', x === b));
      document.querySelectorAll('[data-panel]').forEach((p) => p.classList.toggle('hidden', p.dataset.panel !== b.dataset.st));
    });

    document.getElementById('st-save').onclick = async () => {
      const payload = {};
      document.querySelectorAll('[data-set]').forEach((el) => {
        payload[el.dataset.set] = el.type === 'checkbox' ? (el.checked ? 'true' : 'false') : el.value;
      });
      try { await API.put('/api/admin/settings', payload); toast('Settings saved', 'ok'); }
      catch (e) { toast(e.message, 'err'); }
    };

    document.getElementById('st-upload').onchange = async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const fd = new FormData(); fd.append('file', file); fd.append('type', file.type.startsWith('video') ? 'background' : 'logo');
      try { const r = await API.upload('/api/admin/settings/upload', fd); toast('Branding uploaded', 'ok'); document.querySelector('[data-set=panel_logo]').value = r.url; }
      catch (err) { toast(err.message, 'err'); }
    };

    try {
      const wp = await API.get('/api/admin/settings/wallpapers/bundled');
      document.getElementById('st-wallpapers').innerHTML = (wp.wallpapers || []).map((w) => `
        <button class="btn btn-xs" data-wp="${esc(w.url)}">${esc(w.name)}</button>`).join('');
      document.querySelectorAll('[data-wp]').forEach((b) => b.onclick = () => { document.querySelector('[data-set=panel_bg]').value = b.dataset.wp; toast('Wallpaper selected — save to apply', 'info'); });
    } catch (e) {}

    const paintKeys = async () => {
      try {
        const r = await API.get('/api/admin/api-keys');
        const keys = r.keys || r.apiKeys || [];
        document.getElementById('ak-body').innerHTML = keys.length ? `<div class="table-wrap"><table class="data">
          <thead><tr><th>Label</th><th>Key</th><th>Last used</th><th>Created</th><th></th></tr></thead>
          <tbody>${keys.map((k) => `<tr><td><b>${esc(k.description || 'API key')}</b></td>
            <td>${window.el.copyField(k.key_token)}</td>
            <td class="dim">${esc(k.last_used_at ? fmt.ago(k.last_used_at) : 'never')}</td>
            <td class="dim tiny">${esc(fmt.date(k.created_at, false))}</td>
            <td><div class="cell-actions"><button class="btn btn-xs btn-danger" data-delkey="${k.id}">${I('trash')}</button></div></td></tr>`).join('')}</tbody></table></div>`
          : emptyState('key', 'No API keys', 'Create a key to control the panel from scripts.');
        document.querySelectorAll('[data-delkey]').forEach((b) => b.onclick = () => confirmDialog({
          title: 'Revoke API key?', message: 'Any integration using this key will stop working immediately.', confirmLabel: 'Revoke',
          onConfirm: async () => { await API.del(`/api/admin/api-keys/${b.dataset.delkey}`); paintKeys(); }
        }));
      } catch (e) { document.getElementById('ak-body').innerHTML = emptyState('info', 'API keys unavailable', e.message); }
    };
    document.getElementById('ak-new').onclick = () => window.el.promptDialog({
      title: 'Create API key', label: 'Label', placeholder: 'CI deploy key',
      onSubmit: async (label) => {
        await API.post('/api/admin/api-keys', { description: label || 'API key' });
        toast('API key created', 'ok'); paintKeys();
      }
    });
    paintKeys();
  }

  window.DKX.Views.admin = { overview, servers, users, nodes, network, databases, backups, settings, createServer, editBuild };
})();
