/* ==========================================================================
   DARKONYX PANEL — extended administration views
   Node operations · addons · social login · panel updates · server databases
   ========================================================================== */
(function () {
  const { esc, fmt, API, Store, toast, confirmDialog, emptyState } = window.el;

  /* --------------------------------------------------------- node operations */
  async function nodeDetail(nodeId) {
    let node = null, stats = null, fw = [], logs = '';
    try {
      const [n, s] = await Promise.all([
        API.get(`/api/admin/nodes/${nodeId}`).catch(() => null),
        API.get(`/api/admin/nodes/${nodeId}/stats`).catch(() => null)
      ]);
      node = n && n.node ? n.node : n;
      stats = s;
    } catch (e) {}

    const m = window.el.modal({
      title: node ? node.name : `Node #${nodeId}`,
      subtitle: node ? `${node.fqdn}:${node.daemon_port} · SFTP ${node.sftp_port}` : 'Node operations',
      size: 'wide',
      body: `<div class="tabs" id="nd-tabs">
          <button class="tab active" data-ndt="0">Live stats</button>
          <button class="tab" data-ndt="1">Firewall</button>
          <button class="tab" data-ndt="2">Service</button>
          <button class="tab" data-ndt="3">Logs</button>
        </div>
        <div class="mt-14" data-ndp="0"><div id="nd-stats">${window.el.skeleton(4)}</div></div>
        <div class="mt-14 hidden" data-ndp="1"><div id="nd-fw">${window.el.skeleton(3)}</div></div>
        <div class="mt-14 hidden" data-ndp="2">
          <div class="row wrap gap-8">
            <button class="btn btn-sm" id="nd-svc-start">${I('play')} Start daemon</button>
            <button class="btn btn-sm" id="nd-svc-restart">${I('restart')} Restart daemon</button>
            <button class="btn btn-sm btn-warn" id="nd-svc-reboot">${I('power')} Reboot host</button>
          </div>
          <p class="dim small mt-14">Rebooting the host terminates every game server on this node.</p>
        </div>
        <div class="mt-14 hidden" data-ndp="3"><pre class="mono tiny" id="nd-logs" style="white-space:pre-wrap;max-height:340px;overflow:auto;color:var(--text-2)">Loading…</pre></div>`,
      footer: `<button class="btn" data-close>Close</button>`,
      onMount(wrap, close) {
        wrap.querySelector('[data-close]').onclick = close;
        wrap.querySelectorAll('[data-ndt]').forEach((b) => b.onclick = () => {
          wrap.querySelectorAll('[data-ndt]').forEach((x) => x.classList.toggle('active', x === b));
          wrap.querySelectorAll('[data-ndp]').forEach((p) => p.classList.toggle('hidden', p.dataset.ndp !== b.dataset.ndt));
        });

        // stats (node daemon returns flat snake_case counters)
        const st = (stats && (stats.stats || stats)) || {};
        const cpu = Number(st.cpu_percent || st.cpu || 0);
        const ramUsed = Number(st.ram_used_mb || st.used_mb || 0);
        const ramTotal = Number(st.ram_total_mb || st.total_mb || 0);
        const diskUsed = Number(st.disk_used_mb || 0);
        const diskTotal = Number(st.disk_total_mb || 0);
        wrap.querySelector('#nd-stats').innerHTML = `
          <div class="three-col">
            <div class="stat"><div class="stat-top">${I('cpu')} CPU</div>
              <div class="stat-value">${Math.round(cpu)}<small>%</small></div>
              <div class="stat-foot">load ${esc(st.load_avg || '—')} · ${esc(st.cores || '—')} cores</div>
              <div class="mt-8">${window.el.meter(cpu, cpu > 85 ? 'danger' : cpu > 65 ? 'warn' : '')}</div></div>
            <div class="stat"><div class="stat-top">${I('memory')} Memory</div>
              <div class="stat-value" style="font-size:20px">${esc(fmt.mb(ramUsed))}</div>
              <div class="stat-foot">of ${esc(fmt.mb(ramTotal))}</div>
              <div class="mt-8">${window.el.meter(ramTotal ? (ramUsed / ramTotal) * 100 : 0, 'live')}</div></div>
            <div class="stat"><div class="stat-top">${I('disk')} Disk</div>
              <div class="stat-value" style="font-size:20px">${diskTotal ? esc(fmt.mb(diskUsed)) : '—'}</div>
              <div class="stat-foot">${diskTotal ? 'of ' + esc(fmt.mb(diskTotal)) : 'not reported'}</div>
              <div class="mt-8">${window.el.meter(diskTotal ? (diskUsed / diskTotal) * 100 : 0, 'blue')}</div></div>
          </div>
          <div class="card mt-14"><div class="card-body">
            <div class="kv"><span class="k">Daemon</span><span class="v">${esc(st.daemon_status || st.status || 'online')}</span></div>
            <div class="kv"><span class="k">Uptime</span><span class="v">${esc(st.uptime_seconds ? fmt.uptime(st.uptime_seconds) : (st.uptime || '—'))}</span></div>
            <div class="kv"><span class="k">Servers</span><span class="v">${esc(st.servers_running !== undefined ? `${st.servers_running} running` : (st.servers || '—'))}</span></div>
            <div class="kv"><span class="k">Node</span><span class="v mono">${esc((node && node.fqdn) || '—')}:${esc((node && node.daemon_port) || '')}</span></div>
          </div></div>`;

        // firewall
        const paintFw = async () => {
          const box = wrap.querySelector('#nd-fw');
          try {
            const r = await API.get(`/api/admin/nodes/${nodeId}/firewall`);
            fw = r.rules || [];
            box.innerHTML = `${fw.length ? `<div class="table-wrap"><table class="data"><thead><tr><th>Port</th><th>Proto</th><th>Action</th><th>Source</th><th></th></tr></thead>
              <tbody>${fw.map((r2) => `<tr><td class="mono">${esc(r2.port)}</td><td class="mono">${esc(r2.protocol)}</td>
              <td>${r2.action === 'allow' ? '<span class="chip chip-live">allow</span>' : '<span class="chip chip-danger">deny</span>'}</td>
              <td class="mono dim">${esc(r2.target_ip || 'any')}</td>
              <td><div class="cell-actions"><button class="btn btn-xs btn-ghost" data-fwdel="${r2.id}">${I('trash')}</button></div></td></tr>`).join('')}</tbody></table></div>` : '<p class="dim small">No firewall rules.</p>'}
              <div class="row wrap gap-8 mt-14">
                <input class="input" id="fw-port" placeholder="25565" style="max-width:130px" />
                <select class="select" id="fw-proto" style="max-width:110px"><option>tcp</option><option>udp</option></select>
                <button class="btn btn-sm btn-primary" id="fw-add">${I('plus')} Add rule</button>
                <button class="btn btn-sm btn-danger" id="fw-flush">${I('trash')} Flush all</button>
              </div>`;
            box.querySelectorAll('[data-fwdel]').forEach((b) => b.onclick = async () => {
              try { await API.del(`/api/admin/nodes/${nodeId}/firewall/rule/${b.dataset.fwdel}`); paintFw(); } catch (e) { toast(e.message, 'err'); }
            });
            box.querySelector('#fw-add').onclick = async () => {
              try {
                await API.post(`/api/admin/nodes/${nodeId}/firewall/rule`, { port: Number(box.querySelector('#fw-port').value), protocol: box.querySelector('#fw-proto').value, action: 'allow' });
                toast('Rule added', 'ok'); paintFw();
              } catch (e) { toast(e.message, 'err'); }
            };
            box.querySelector('#fw-flush').onclick = () => confirmDialog({
              title: 'Flush firewall rules?', message: 'All managed rules for this node are removed.', confirmLabel: 'Flush',
              onConfirm: async () => { await API.post(`/api/admin/nodes/${nodeId}/firewall/flush`); paintFw(); }
            });
          } catch (e) { box.innerHTML = `<p class="dim small">${esc(e.message)}</p>`; }
        };
        paintFw();

        wrap.querySelector('#nd-svc-start').onclick = async () => {
          try { await API.post(`/api/admin/nodes/${nodeId}/service`, { action: 'start' }); toast('Daemon start requested', 'ok'); } catch (e) { toast(e.message, 'err'); }
        };
        wrap.querySelector('#nd-svc-restart').onclick = async () => {
          try { await API.post(`/api/admin/nodes/${nodeId}/service`, { action: 'restart' }); toast('Daemon restart requested', 'ok'); } catch (e) { toast(e.message, 'err'); }
        };
        wrap.querySelector('#nd-svc-reboot').onclick = () => confirmDialog({
          title: 'Reboot the host?', message: 'Every server on this node will be terminated.', confirmLabel: 'Reboot host',
          onConfirm: async () => { await API.post(`/api/admin/nodes/${nodeId}/reboot-vps`); toast('Reboot signal sent', 'warn'); }
        });

        API.get(`/api/admin/nodes/${nodeId}/logs`).then((r) => {
          const text = typeof r === 'string' ? r : (r.logs || r.output || r.data || JSON.stringify(r, null, 2));
          wrap.querySelector('#nd-logs').textContent = String(text).slice(-8000) || 'No logs available.';
        }).catch((e) => { wrap.querySelector('#nd-logs').textContent = e.message; });
      }
    });
    return m;
  }

  /* ------------------------------------------------------------------ addons */
  async function addons(host) {
    host.innerHTML = `<div class="page-head">
      <div><div class="eyebrow">Administration</div><h1>Addons</h1>
      <p class="sub">Extensions that plug extra capability into DARKONYX — subdomains, splitter, auto-backups, playit tunnels and more.</p></div>
      <div class="head-actions"><button class="btn btn-warn" id="ad-reset">${I('refresh')} Reset defaults</button></div></div>
      <div id="ad-body">${window.el.skeleton(4)}</div>`;

    document.getElementById('ad-reset').onclick = () => confirmDialog({
      title: 'Reset all addons?', message: 'Every addon returns to its default configuration.', confirmLabel: 'Reset all',
      onConfirm: async () => { await API.post('/api/admin/addons/reset'); toast('Addons reset', 'ok'); window.DKX.Router.resolve(); }
    });

    try {
      const r = await API.get('/api/admin/addons');
      const list = r.addons || [];
      const box = document.getElementById('ad-body');
      box.innerHTML = list.length ? `<div class="bento">${list.map((a) => {
        const enabled = a.config && (a.config.enabled === true || a.config.enabled === '1' || a.config.enabled === 'true');
        return `<div class="span-6"><div class="card card-pad">
          <div class="row gap-14">
            <div class="srv-icon">${I((a.icon && window.ICONS[a.icon]) ? a.icon : 'puzzle')}</div>
            <div class="grow"><h3 style="font-size:14px">${esc(a.name || a.key)}</h3>
              <p class="dim small">${esc(a.description || '')}</p></div>
            <span class="chip ${enabled ? 'chip-live' : ''}">${enabled ? 'Enabled' : 'Disabled'}</span>
          </div>
          <div class="row gap-8 mt-14">
            <button class="btn btn-sm" data-ad-open="${esc(a.key)}">${I('sliders')} Configure</button>
            <span class="dim tiny">key: <span class="mono">${esc(a.key)}</span></span>
          </div>
        </div></div>`;
      }).join('')}</div>`
        : emptyState('puzzle', 'No addons registered', 'Addons are discovered from the addon service at boot.');

      box.querySelectorAll('[data-ad-open]').forEach((b) => b.onclick = () => {
        const a = list.find((x) => x.key === b.dataset.adOpen);
        const cfg = a.config || {};
        window.el.modal({
          title: a.name || a.key, subtitle: a.description || '',
          body: `<div class="col gap-14">${Object.keys(cfg).length ? Object.entries(cfg).map(([k, v]) => `
            <div class="row gap-14">
              <div class="grow"><b class="small mono">${esc(k)}</b></div>
              ${typeof v === 'boolean' || v === 'true' || v === 'false' || v === '1' || v === '0'
              ? `<label class="switch"><input type="checkbox" data-cfg="${esc(k)}" ${(v === true || v === 'true' || v === '1') ? 'checked' : ''}/><span class="track"></span></label>`
              : `<input class="input" data-cfg="${esc(k)}" value="${esc(v)}" style="max-width:240px" />`}
            </div>`).join('') : '<p class="dim small">This addon has no configurable values.</p>'}</div>`,
          footer: `<button class="btn" data-cancel>Cancel</button><button class="btn btn-primary" data-save>${I('save')} Save addon</button>`,
          onMount(wrap, close) {
            wrap.querySelector('[data-cancel]').onclick = close;
            wrap.querySelector('[data-save]').onclick = async () => {
              const payload = {};
              wrap.querySelectorAll('[data-cfg]').forEach((el) => {
                payload[el.dataset.cfg] = el.type === 'checkbox' ? (el.checked ? '1' : '0') : el.value;
              });
              try { await API.post(`/api/admin/addons/${a.key}`, payload); toast('Addon saved', 'ok'); close(); window.DKX.Router.resolve(); }
              catch (e) { toast(e.message, 'err'); }
            };
          }
        });
      });
    } catch (e) { document.getElementById('ad-body').innerHTML = emptyState('alert', 'Addons unavailable', e.message); }
  }

  /* ------------------------------------------------------------ social login */
  async function social(host) {
    host.innerHTML = `<div class="page-head">
      <div><div class="eyebrow">Administration</div><h1>Social login</h1>
      <p class="sub">Let users sign in with Discord, Google, GitHub and more via OAuth.</p></div></div>
      <div id="so-body">${window.el.skeleton(4)}</div>`;

    const paint = async () => {
      try {
        const r = await API.get('/api/admin/sociallogin');
        const providers = r.providers || [];
        const supported = r.supported_providers || [];
        const known = new Set(providers.map((p) => p.short_name));
        document.getElementById('so-body').innerHTML = `
          <div class="card mb-14"><div class="card-body row wrap gap-14">
            <label class="switch"><input type="checkbox" id="so-reg" ${r.settings.allow_register ? 'checked' : ''}/><span class="track"></span>
              <span class="switch-label">Allow registration through providers</span></label>
            <label class="switch"><input type="checkbox" id="so-conn" ${r.settings.allow_connecting ? 'checked' : ''}/><span class="track"></span>
              <span class="switch-label">Allow linking to existing accounts</span></label>
            <span class="grow"></span>
            <button class="btn btn-sm btn-primary" id="so-save">${I('save')} Save</button>
          </div></div>

          <div class="card"><div class="card-head"><h3>Providers</h3></div><div class="card-body">
            <div class="table-wrap"><table class="data">
              <thead><tr><th>Provider</th><th>Client ID</th><th>Secret</th><th>Status</th><th></th></tr></thead>
              <tbody>${(supported.length ? supported : providers.map((p) => p.short_name)).map((sn) => {
                const p = providers.find((x) => x.short_name === sn) || { short_name: sn, name: sn, enabled: false, client_id: '', has_secret: false };
                return `<tr>
                  <td><b>${esc(p.name || sn)}</b><div class="tiny dim mono">${esc(sn)}</div></td>
                  <td class="mono dim">${esc(p.client_id || '—')}</td>
                  <td>${p.has_secret ? '<span class="chip chip-live">set</span>' : '<span class="chip">missing</span>'}</td>
                  <td>${p.enabled ? '<span class="chip chip-live">Enabled</span>' : '<span class="chip">Disabled</span>'}</td>
                  <td><div class="cell-actions"><button class="btn btn-xs" data-prov="${esc(sn)}" data-name="${esc(p.name || sn)}">${I('edit')} Configure</button></div></td>
                </tr>`;
              }).join('')}</tbody></table></div>
          </div></div>`;

        document.getElementById('so-save').onclick = async () => {
          try {
            await API.patch('/api/admin/sociallogin/settings', {
              allow_register: document.getElementById('so-reg').checked,
              allow_connecting: document.getElementById('so-conn').checked
            });
            toast('Social settings saved', 'ok');
          } catch (e) { toast(e.message, 'err'); }
        };

        document.querySelectorAll('[data-prov]').forEach((b) => b.onclick = () => {
          const p = providers.find((x) => x.short_name === b.dataset.prov) || {};
          window.el.modal({
            title: `Configure ${b.dataset.name}`, size: 'narrow',
            body: `<div class="col gap-14">
              <div class="field"><label>Client ID</label><input class="input mono" id="sp-id" value="${esc(p.client_id || '')}" /></div>
              <div class="field"><label>Client secret <span class="hint">(leave blank to keep)</span></label><input class="input mono" id="sp-secret" placeholder="${p.has_secret ? '••••••••' : ''}" /></div>
              <label class="switch"><input type="checkbox" id="sp-enabled" ${p.enabled ? 'checked' : ''}/><span class="track"></span><span class="switch-label">Enable this provider</span></label>
              <div class="hint">Callback URL: <span class="mono">${esc(location.origin)}/api/auth/social/callback</span></div>
            </div>`,
            footer: `<button class="btn" data-cancel>Cancel</button><button class="btn btn-primary" data-save-prov>Save</button>`,
            onMount(wrap, close) {
              wrap.querySelector('[data-cancel]').onclick = close;
              wrap.querySelector('[data-save-prov]').onclick = async () => {
                const body = {
                  short_name: b.dataset.prov,
                  name: b.dataset.name,
                  client_id: wrap.querySelector('#sp-id').value.trim(),
                  enabled: wrap.querySelector('#sp-enabled').checked
                };
                const secret = wrap.querySelector('#sp-secret').value.trim();
                if (secret) body.client_secret = secret;
                try { await API.post('/api/admin/sociallogin/providers', body); toast('Provider saved', 'ok'); close(); paint(); }
                catch (e) { toast(e.message, 'err'); }
              };
            }
          });
        });
      } catch (e) { document.getElementById('so-body').innerHTML = emptyState('info', 'Social login unavailable', e.message); }
    };
    paint();
  }

  /* ---------------------------------------------------------------- updates */
  async function updates(host) {
    host.innerHTML = `<div class="page-head">
      <div><div class="eyebrow">Administration</div><h1>Panel updates</h1>
      <p class="sub">Version, release channel and self-update for the DARKONYX engine.</p></div>
      <div class="head-actions">
        <button class="btn" id="up-check">${I('refresh')} Check for updates</button>
        <button class="btn btn-primary" id="up-run">${I('download')} Update now</button>
      </div></div>
      <div class="bento" id="up-body">${window.el.skeleton(4)}</div>`;

    const paint = async (force = false) => {
      try {
        const r = await API.get(`/api/admin/updates/status${force ? '?force=true' : ''}`);
        const body = document.getElementById('up-body');
        const rel = r.latest_release;
        body.innerHTML = `
          <div class="span-6"><div class="stat">
            <div class="stat-top">${I('package')} Installed version</div>
            <div class="stat-value">v${esc(r.current_version || '1.0.0')}</div>
            <div class="stat-foot">${r.has_update ? `<span class="chip chip-warn">update available</span>` : `<span class="chip chip-live">up to date</span>`}</div>
          </div></div>
          <div class="span-6"><div class="stat">
            <div class="stat-top">${I('git')} Source</div>
            <div class="stat-value" style="font-size:18px">${r.git && r.git.isGit ? esc(r.git.branch) : 'standalone'}</div>
            <div class="stat-foot mono tiny">${esc(r.git && r.git.commit ? String(r.git.commit).slice(0, 12) : 'no git metadata')}</div>
          </div></div>
          <div class="span-12"><div class="card">
            <div class="card-head"><div class="grow"><h3>Release notes</h3>
              <div class="card-sub">${rel ? `${esc(rel.tag_name)} · published ${esc(fmt.date(rel.published_at, false))}` : 'No release feed reachable from this host'}</div></div>
              ${rel && rel.html_url ? `<a class="btn btn-sm btn-ghost" href="${esc(rel.html_url)}" target="_blank" rel="noopener">${I('external')} GitHub</a>` : ''}</div>
            <div class="card-body">
              ${rel ? `<pre class="mono small" style="white-space:pre-wrap;color:var(--text-2)">${esc((rel.body || '').slice(0, 4000))}</pre>`
            : `<p class="dim small">DARKONYX runs fine without the GitHub release feed. Updates can always be applied with <span class="mono">./menu.sh update</span> on the host.${r.warning ? `<br/><br/><span class="mono tiny">${esc(r.warning)}</span>` : ''}</p>`}
            </div>
          </div></div>`;
      } catch (e) { document.getElementById('up-body').innerHTML = `<div class="span-12"><div class="card card-pad">${emptyState('info', 'Update check failed', e.message)}</div></div>`; }
    };

    document.getElementById('up-check').onclick = () => { toast('Checking release feed…', 'info'); paint(true); };
    document.getElementById('up-run').onclick = () => confirmDialog({
      title: 'Run panel self-update?', message: 'This pulls the latest engine from the configured git remote, reinstalls dependencies and restarts the panel. Back up data first.',
      confirmLabel: 'Start update', danger: false,
      onConfirm: async () => {
        try { await API.post('/api/admin/updates/run', { mode: 'standard' }); toast('Update pipeline started', 'ok'); }
        catch (e) { toast(e.message, 'err'); }
      }
    });
    paint();
  }

  /* --------------------------------------------------- per-server databases */
  async function serverDatabases(host, serverId) {
    host.innerHTML = `<div class="card">
      <div class="card-head"><div class="grow"><h3>Databases</h3><div class="card-sub">Provision MySQL/MariaDB databases for plugins and mods</div></div>
        <button class="btn btn-sm btn-primary" id="sdb-new">${I('plus')} New database</button></div>
      <div id="sdb-body">${window.el.skeleton(3)}</div></div>`;

    const paint = async () => {
      try {
        const r = await API.get(`/api/servers/${serverId}/databases`);
        const list = r.databases || [];
        document.getElementById('sdb-body').innerHTML = list.length ? `<div class="table-wrap"><table class="data">
          <thead><tr><th>Database</th><th>User</th><th>Password</th><th>Host</th><th></th></tr></thead>
          <tbody>${list.map((d) => `<tr>
            <td class="mono">${esc(d.database_name)}</td>
            <td class="mono dim">${esc(d.username)}</td>
            <td style="max-width:180px">${window.el.copyField(d.password)}</td>
            <td class="mono dim tiny">${esc(d.host || '')}:${esc(d.host_port || '')}</td>
            <td><div class="cell-actions">
              <button class="btn btn-xs" data-reset="${d.id}">${I('key')} Reset</button>
              <button class="btn btn-xs btn-danger" data-del="${d.id}">${I('trash')}</button>
            </div></td></tr>`).join('')}</tbody></table></div>`
          : emptyState('database', 'No databases', 'Create one — perfect for LuckPerms, CoreProtect or a web map.');

        document.querySelectorAll('[data-reset]').forEach((b) => b.onclick = async () => {
          try { const res = await API.post(`/api/servers/${serverId}/databases/${b.dataset.reset}/reset-password`); toast(`New password: ${res.newPassword}`, 'ok', 'Password reset'); paint(); }
          catch (e) { toast(e.message, 'err'); }
        });
        document.querySelectorAll('[data-del]').forEach((b) => b.onclick = () => confirmDialog({
          title: 'Delete database?', message: 'The database and its user are dropped from the host.', confirmLabel: 'Delete',
          onConfirm: async () => { await API.del(`/api/servers/${serverId}/databases/${b.dataset.del}`); paint(); }
        }));
      } catch (e) { document.getElementById('sdb-body').innerHTML = emptyState('info', 'Databases unavailable', e.message); }
    };

    document.getElementById('sdb-new').onclick = () => window.el.promptDialog({
      title: 'New database', label: 'Database name', value: 'smp', confirmLabel: 'Create',
      onSubmit: async (name) => {
        const res = await API.post(`/api/servers/${serverId}/databases`, { database_name: name });
        toast(`Database ${res.database.database_name} created`, 'ok');
        paint();
      }
    });
    paint();
  }

  window.DKX.Views.admin.nodeDetail = nodeDetail;
  window.DKX.Views.admin.addons = addons;
  window.DKX.Views.admin.social = social;
  window.DKX.Views.admin.updates = updates;
  window.DKX.Views.server.databases = serverDatabases;
})();
