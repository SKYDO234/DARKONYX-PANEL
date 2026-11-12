/* ==========================================================================
   DARKONYX PANEL — core runtime (api, store, router, shell, ui kit)
   ========================================================================== */
(function () {
  'use strict';

  /* ---------------------------------------------------------------- utils */
  /* ------------------------------------------------------------- storage */
  /* Some browsers block storage entirely (private mode, blocked third-party
     storage, an iframe without allow-same-origin). Reading `localStorage`
     throws in that situation and used to take the whole panel down at load
     time, leaving a dead boot splash. Everything below degrades to memory. */
  const SafeStore = (() => {
    let backing = null;
    try {
      const probe = '__dkx_probe__';
      window.localStorage.setItem(probe, '1');
      window.localStorage.removeItem(probe);
      backing = window.localStorage;
    } catch (e) { backing = null; }
    const memory = new Map();
    return {
      available: !!backing,
      get(k) {
        try { if (backing) return backing.getItem(k); } catch (e) { /* fall through */ }
        return memory.has(k) ? memory.get(k) : null;
      },
      set(k, v) {
        memory.set(k, String(v));
        try { if (backing) backing.setItem(k, String(v)); } catch (e) { /* memory only */ }
      },
      remove(k) {
        memory.delete(k);
        try { if (backing) backing.removeItem(k); } catch (e) { /* memory only */ }
      }
    };
  })();
  window.DKXStorage = SafeStore;

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const fmt = {
    bytes(n, digits = 1) {
      n = Number(n || 0);
      if (!n) return '0 B';
      const u = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
      const i = Math.min(u.length - 1, Math.floor(Math.log(Math.abs(n)) / Math.log(1024)));
      return `${(n / Math.pow(1024, i)).toFixed(i === 0 ? 0 : digits)} ${u[i]}`;
    },
    mb(n) {
      n = Number(n || 0);
      return n >= 1024 ? `${(n / 1024).toFixed(1)} GB` : `${Math.round(n)} MB`;
    },
    pct(n) { return `${Math.max(0, Math.min(100, Math.round(Number(n) || 0)))}%`; },
    num(n) { return new Intl.NumberFormat().format(Number(n || 0)); },
    date(v, withTime = true) {
      if (!v) return '—';
      const d = new Date(String(v).replace(' ', 'T'));
      if (isNaN(d)) return String(v);
      const opts = withTime
        ? { year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' }
        : { year: 'numeric', month: 'short', day: '2-digit' };
      return d.toLocaleString(undefined, opts);
    },
    ago(v) {
      if (!v) return 'never';
      const d = new Date(String(v).replace(' ', 'T'));
      if (isNaN(d)) return String(v);
      const s = Math.floor((Date.now() - d.getTime()) / 1000);
      if (s < 45) return 'just now';
      const steps = [[60, 's'], [60, 'm'], [24, 'h'], [30, 'd'], [12, 'mo'], [9999, 'y']];
      let v2 = s, unit = 's';
      for (const [div, u] of steps) {
        if (v2 < div) { unit = u; break; }
        v2 = Math.floor(v2 / div); unit = u;
      }
      return `${v2}${unit} ago`;
    },
    uptime(sec) {
      sec = Math.max(0, Math.floor(Number(sec) || 0));
      const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
      if (d) return `${d}d ${h}h`;
      if (h) return `${h}h ${m}m`;
      return `${m}m`;
    },
    clock(sec) {
      sec = Math.max(0, Math.floor(Number(sec) || 0));
      const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
      return [h, m, s].map((x) => String(x).padStart(2, '0')).join(':');
    },
    initials(name) { return String(name || '?').trim().slice(0, 2).toUpperCase(); },
    slug(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''); }
  };

  const STATUS_META = {
    running: { label: 'Running', cls: 'live', dot: 'live' },
    starting: { label: 'Starting', cls: 'warn', dot: 'warn' },
    offline: { label: 'Offline', cls: '', dot: 'off' },
    stopping: { label: 'Stopping', cls: 'warn', dot: 'warn' },
    suspended: { label: 'Suspended', cls: 'danger', dot: 'danger' },
    installing: { label: 'Installing', cls: 'info', dot: 'warn' }
  };

  const statusChip = (status) => {
    const m = STATUS_META[status] || STATUS_META.offline;
    return `<span class="chip ${m.cls ? 'chip-' + m.cls : 'chip-plain'}"><i class="dot ${m.dot}"></i>${m.label}</span>`;
  };

  /* ------------------------------------------------------------------ api */
  const Store = {
    token: SafeStore.get('dkx.token') || '',
    user: null,
    settings: {},
    servers: [],
    serverOrder: [],
    setToken(t) { this.token = t || ''; if (t) SafeStore.set('dkx.token', t); else SafeStore.remove('dkx.token'); },
    setUser(u) { this.user = u; SafeStore.set('dkx.user', JSON.stringify(u || null)); },
    cachedUser() { try { return JSON.parse(SafeStore.get('dkx.user') || 'null'); } catch (e) { return null; } },
    isAdmin() { return !!this.user && this.user.role === 'admin'; },
    has(perm) { return this.isAdmin() || (this.permissions || []).includes(perm) || (this.permissions || []).includes('*'); }
  };

  async function request(path, { method = 'GET', body, headers = {}, raw = false } = {}) {
    const opts = { method, headers: { ...headers } };
    if (Store.token) opts.headers.Authorization = `Bearer ${Store.token}`;
    if (body instanceof FormData) opts.body = body;
    else if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }

    let res;
    try { res = await fetch(path, opts); } catch (e) {
      throw new Error('Network unreachable. Is the panel daemon running?');
    }
    if (raw) {
      if (!res.ok) throw new Error(`Request failed (${res.status})`);
      return res;
    }
    let data = null;
    const text = await res.text();
    try { data = text ? JSON.parse(text) : {}; } catch (e) { data = { success: false, error: text || 'Malformed response' }; }
    if (res.status === 401) {
      Store.setToken('');
      Store.setUser(null);
      if (!location.hash.startsWith('#/login')) Router.go('/login');
      throw new Error(data.error || 'Session expired. Please sign in again.');
    }
    if (!res.ok || data.success === false) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
  }

  const API = {
    get: (p) => request(p),
    post: (p, b) => request(p, { method: 'POST', body: b === undefined ? {} : b }),
    put: (p, b) => request(p, { method: 'PUT', body: b }),
    patch: (p, b) => request(p, { method: 'PATCH', body: b }),
    del: (p, b) => request(p, { method: 'DELETE', body: b }),
    upload: (p, form) => request(p, { method: 'POST', body: form }),
    raw: (p, o) => request(p, { ...o, raw: true })
  };

  /* ------------------------------------------------------------------ ui */
  function toast(message, kind = 'ok', title) {
    const root = $('#toast-root');
    const el = document.createElement('div');
    const icons = { ok: 'check', err: 'alert', info: 'info', warn: 'alert' };
    el.className = `toast ${kind}`;
    el.innerHTML = `<div class="toast-ico">${I(icons[kind] || 'info')}</div>
      <div class="toast-body"><strong>${esc(title || (kind === 'err' ? 'Something went wrong' : kind === 'ok' ? 'Done' : 'Heads up'))}</strong><span>${esc(message)}</span></div>`;
    root.appendChild(el);
    setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 260); }, kind === 'err' ? 6200 : 3800);
    return el;
  }

  function modal({ title, subtitle, body, footer, size = '', onMount, closable = true }) {
    const root = $('#modal-root');
    const wrap = document.createElement('div');
    wrap.className = 'scrim';
    wrap.innerHTML = `<div class="modal ${size}" role="dialog" aria-modal="true">
      <div class="modal-head">
        <div><h3>${esc(title || '')}</h3>${subtitle ? `<p>${esc(subtitle)}</p>` : ''}</div>
        ${closable ? `<button class="icon-btn modal-x" data-x>${I('x')}</button>` : ''}
      </div>
      <div class="modal-body">${body || ''}</div>
      ${footer ? `<div class="modal-foot">${footer}</div>` : ''}
    </div>`;
    root.appendChild(wrap);
    const close = () => { wrap.remove(); document.removeEventListener('keydown', onKey); };
    const onKey = (e) => { if (e.key === 'Escape' && closable) close(); };
    document.addEventListener('keydown', onKey);
    wrap.addEventListener('mousedown', (e) => { if (e.target === wrap && closable) close(); });
    const x = wrap.querySelector('[data-x]'); if (x) x.onclick = close;
    if (onMount) onMount(wrap, close);
    return { el: wrap, close };
  }

  function confirmDialog({ title, message, confirmLabel = 'Confirm', danger = true, onConfirm }) {
    return modal({
      title, size: 'narrow', body: `<p class="muted small" style="line-height:1.65">${esc(message)}</p>`,
      footer: `<button class="btn" data-cancel>Cancel</button><button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-ok>${esc(confirmLabel)}</button>`,
      onMount(wrap, close) {
        wrap.querySelector('[data-cancel]').onclick = close;
        const ok = wrap.querySelector('[data-ok]');
        ok.onclick = async () => {
          ok.disabled = true; ok.textContent = 'Working…';
          try { await onConfirm(); close(); } catch (e) { ok.disabled = false; ok.textContent = confirmLabel; toast(e.message, 'err'); }
        };
      }
    });
  }

  function promptDialog({ title, label, value = '', placeholder = '', type = 'text', hint, confirmLabel = 'Save', onSubmit }) {
    return modal({
      title, size: 'narrow',
      body: `<div class="field"><label>${esc(label)}</label>
        <input class="input" data-inp type="${type}" value="${esc(value)}" placeholder="${esc(placeholder)}" />
        ${hint ? `<div class="hint">${esc(hint)}</div>` : ''}</div>`,
      footer: `<button class="btn" data-cancel>Cancel</button><button class="btn btn-primary" data-ok>${esc(confirmLabel)}</button>`,
      onMount(wrap, close) {
        const inp = wrap.querySelector('[data-inp]');
        setTimeout(() => inp.focus(), 60);
        wrap.querySelector('[data-cancel]').onclick = close;
        const submit = async () => {
          const btn = wrap.querySelector('[data-ok]');
          btn.disabled = true; btn.textContent = 'Saving…';
          try { await onSubmit(inp.value); close(); } catch (e) { btn.disabled = false; btn.textContent = confirmLabel; toast(e.message, 'err'); }
        };
        wrap.querySelector('[data-ok]').onclick = submit;
        inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
      }
    });
  }

  async function copy(text) {
    try { await navigator.clipboard.writeText(String(text)); toast('Copied to clipboard', 'ok', 'Copied'); }
    catch (e) { toast('Clipboard unavailable in this browser', 'err'); }
  }

  function copyField(value, label) {
    return `<div class="copy-field" title="${esc(label || value)}"><span>${esc(value)}</span>
      <button data-copy="${esc(value)}" aria-label="Copy">${I('copy')}</button></div>`;
  }

  function emptyState(icon, title, text, action = '') {
    return `<div class="empty"><div class="empty-icon">${I(icon)}</div><h4>${esc(title)}</h4><p>${esc(text)}</p>${action}</div>`;
  }

  function skeleton(rows = 3) {
    return `<div class="col gap-8" style="padding:18px">${Array.from({ length: rows }).map(() => `<div class="skel" style="height:44px"></div>`).join('')}</div>`;
  }

  function sparkline(values = [], { color = '#e8a33d', height = 46, fill = true } = {}) {
    const vals = values.length ? values.map(Number) : [0];
    const max = Math.max(...vals, 1), min = Math.min(...vals, 0);
    const span = Math.max(1, max - min);
    const w = 100, h = 100;
    const pts = vals.map((v, i) => {
      const x = vals.length === 1 ? 0 : (i / (vals.length - 1)) * w;
      const y = h - ((v - min) / span) * (h - 12) - 6;
      return [x, y];
    });
    const d = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(2)} ${p[1].toFixed(2)}`).join(' ');
    const area = `${d} L${w} ${h} L0 ${h} Z`;
    const gid = 'g' + Math.random().toString(36).slice(2, 8);
    return `<div class="chart-box" style="height:${height}px"><svg viewBox="0 0 100 100" preserveAspectRatio="none">
      <defs><linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="${color}" stop-opacity=".38"/><stop offset="100%" stop-color="${color}" stop-opacity="0"/>
      </linearGradient></defs>
      ${fill ? `<path d="${area}" fill="url(#${gid})"/>` : ''}
      <path d="${d}" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" vector-effect="non-scaling-stroke"/>
    </svg></div>`;
  }

  function meter(pct, variant = '') {
    const p = Math.max(0, Math.min(100, Number(pct) || 0));
    return `<div class="meter ${variant}"><span style="width:${p}%"></span></div>`;
  }

  /* -------------------------------------------------------------- app chrome */
  const NAV = [
    {
      title: 'Server', roles: ['user', 'admin'], items: [
        { id: 'portal-overview', label: 'Overview', icon: 'grid', hash: '/portal/overview' },
        { id: 'portal-servers', label: 'My Servers', icon: 'server', hash: '/portal/servers' },
        { id: 'portal-activity', label: 'Activity', icon: 'activity', hash: '/portal/activity' }
      ]
    },
    {
      title: 'Discover', roles: ['user', 'admin'], items: [
        { id: 'market', label: 'Marketplace', icon: 'package', hash: '/marketplace' },
        { id: 'account', label: 'Account', icon: 'user', hash: '/account' }
      ]
    },
    {
      title: 'Administration', roles: ['admin'], items: [
        { id: 'admin-overview', label: 'Command Center', icon: 'gauge', hash: '/admin/overview' },
        { id: 'admin-servers', label: 'All Servers', icon: 'layers', hash: '/admin/servers' },
        { id: 'admin-users', label: 'Users', icon: 'users', hash: '/admin/users' },
        { id: 'admin-nodes', label: 'Nodes', icon: 'network', hash: '/admin/nodes' },
        { id: 'admin-network', label: 'Network', icon: 'globe', hash: '/admin/network' },
        { id: 'admin-databases', label: 'Databases', icon: 'database', hash: '/admin/databases' },
        { id: 'admin-backups', label: 'Backups', icon: 'archive', hash: '/admin/backups' },
        { id: 'admin-addons', label: 'Addons', icon: 'puzzle', hash: '/admin/addons' },
        { id: 'admin-social', label: 'Social login', icon: 'discord', hash: '/admin/social' },
        { id: 'admin-updates', label: 'Panel updates', icon: 'download', hash: '/admin/updates' },
        { id: 'admin-settings', label: 'Settings', icon: 'sliders', hash: '/admin/settings' }
      ]
    }
  ];

  const Shell = {
    mount() {
      const app = $('#app');
      app.innerHTML = `
        <div class="shell">
          <aside class="rail" id="rail">
            <div class="rail-top">
              <button class="rail-logo" id="rail-logo" title="${esc((Store.settings.panel_name || 'DARKONYX'))}">${I('mark')}</button>
            </div>
            <div class="rail-scroll" id="rail-nav"></div>
            <div class="rail-footer">
              <button class="rail-user" id="rail-user" title="Account">
                <span class="avatar" id="rail-avatar">DK</span>
              </button>
            </div>
          </aside>
          <div class="main">
            <header class="topbar">
              <button class="icon-btn only-mobile" id="btn-menu" aria-label="Toggle navigation">${I('menu')}</button>
              <div class="cmdbar" id="btn-search" role="button" tabindex="0" aria-label="Search or jump to">
                ${I('search')}
                <span class="cmdbar-ph">Search servers, pages, people…</span>
                <kbd>⌘K</kbd>
              </div>
              <div class="crumbs" id="crumbs"></div>
              <div class="topbar-actions">
                <span class="clock-chip" id="topbar-clock"></span>
                <button class="icon-btn" id="btn-theme" aria-label="Toggle theme">${I('sun')}</button>
                <button class="icon-btn" id="btn-signout" aria-label="Sign out">${I('logout')}</button>
              </div>
            </header>
            <main class="view" id="view"><div class="view-inner" id="view-inner"></div></main>
          </div>
        </div>`;
      this.bind();
      this.renderNav();
      this.syncUser();
    },

    bind() {
      $('#btn-menu').onclick = () => {
        const rail = $('#rail');
        if (window.innerWidth <= 900) rail.classList.toggle('is-open');
        else { rail.classList.toggle('is-collapsed'); SafeStore.set('dkx.collapsed', rail.classList.contains('is-collapsed') ? '1' : '0'); }
      };
      if (SafeStore.get('dkx.collapsed') === '1' && window.innerWidth > 900) $('#rail').classList.add('is-collapsed');
      $('#btn-theme').onclick = () => Theme.toggle();
      $('#btn-search').onclick = () => Palette.open();
      $('#btn-signout').onclick = () => window.Auth.logout();
      $('#rail-user').onclick = (e) => { e.stopPropagation(); Menu.user(); };
      const logo = $('#rail-logo');
      if (logo) logo.onclick = () => Router.go('/portal/overview');
      document.addEventListener('click', (e) => {
        if (!e.target.closest('.menu') && !e.target.closest('#rail-user')) Menu.close();
      });
      document.addEventListener('keydown', (e) => {
        if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); Palette.open(); }
      });
      setInterval(() => { const el = $('#topbar-clock'); if (el) el.textContent = new Date().toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' }); }, 1000);
    },

    renderNav() {
      const nav = $('#rail-nav');
      if (!nav) return;
      const role = Store.user ? Store.user.role : 'user';
      nav.innerHTML = NAV.filter((g) => g.roles.includes(role)).map((g) => `
        <div class="rail-group">
          <div class="rail-group-title" title="${esc(g.title)}"><span>${esc(g.title)}</span></div>
          ${g.items.map((it) => `<a class="rail-item" data-nav="${it.id}" href="#${it.hash}" title="${esc(it.label)}" aria-label="${esc(it.label)}">
            ${I(it.icon)}<span class="rail-label">${esc(it.label)}</span>
            ${it.id === 'admin-servers' ? `<span class="rail-badge" id="nav-server-count"></span>` : ''}
          </a>`).join('')}
        </div>`).join('');
      nav.querySelectorAll('[data-nav]').forEach((a) => a.addEventListener('click', () => {
        if (window.innerWidth <= 900) $('#rail').classList.remove('is-open');
      }));
    },

    syncUser() {
      const u = Store.user || {};
      const nameEl = $('#rail-username'), roleEl = $('#rail-role'), av = $('#rail-avatar');
      if (nameEl) nameEl.textContent = u.username || 'guest';
      if (roleEl) roleEl.textContent = u.role === 'admin' ? 'Administrator' : 'Client';
      if (av) av.textContent = fmt.initials(u.username || 'DK');
      const name = (Store.settings.panel_name || 'DARKONYX').replace(/\s+panel$/i, '');
      document.title = `${name} — control panel`;
    },

    setActive(id) {
      $$('.rail-item').forEach((el) => el.classList.toggle('active', el.dataset.nav === id));
    },

    setCrumbs(parts) {
      const el = $('#crumbs');
      if (!el) return;
      el.innerHTML = parts.map((p, i) => `${i ? '<span class="sep">/</span>' : ''}${p.hash ? `<a href="#${p.hash}" class="dim">${esc(p.label)}</a>` : `<b>${esc(p.label)}</b>`}`).join('');
    }
  };

  /* ----------------------------------------------------------------- theme */
  const Theme = {
    apply(mode) {
      document.documentElement.setAttribute('data-theme', mode);
      SafeStore.set('dkx.theme', mode);
      const btn = $('#btn-theme');
      if (btn) btn.innerHTML = I(mode === 'dark' ? 'sun' : 'moon');
    },
    toggle() { this.apply(document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark'); },

    /* Panel branding coming from the admin settings. The old build stored
       panel_bg / panel_logo / blur / transparency and then never rendered any
       of them, so choosing a wallpaper did nothing visible. These fields are
       now projected onto the document as CSS variables and a real background
       layer the moment settings arrive — no reload needed. */
    media: { bg: '', type: 'image', logo: '', blur: 16, transparency: 18 },
    // until the first bootstrap response arrives, "no wallpaper chosen" must not
    // be reported as a broken URL everywhere
    probed: false,

    isImg(url) {
      const clean = String(url || '').split('?')[0].toLowerCase();
      return /\.(png|jpe?g|gif|webp|avif|svg|bmp)$/.test(clean)
        || (/^https?:/i.test(url || '') && !/\.(mp4|webm|ogv|mov|m4v)(\?|$)/i.test(url || ''));
    },
    isVid(url) {
      return /\.(mp4|webm|ogv|mov|m4v)(\?|$)/i.test(String(url || '')) || String(url || '').startsWith('data:video/');
    },

    applyMedia(settings) {
      const s = settings || {};
      this.probed = true;
      const doc = document.documentElement;
      const bg = String(s.panel_bg || '').trim();
      const logo = String(s.panel_logo || s.favicon_logo || '').trim();
      const blur = Number(s.blur_bar);
      const transparency = Number(s.transparency_bar);

      this.media.bg = bg;
      this.media.logo = logo;
      this.media.type = this.isVid(bg) ? 'video' : this.isImg(bg) ? 'image' : 'none';
      this.media.blur = isFinite(blur) && s.blur_bar !== undefined && s.blur_bar !== '' ? Math.max(0, Math.min(40, blur)) : 16;
      this.media.transparency = isFinite(transparency) && s.transparency_bar !== undefined && s.transparency_bar !== ''
        ? Math.max(0, Math.min(96, transparency)) : 18;

      doc.style.setProperty('--panel-blur', `${this.media.blur}px`);
      doc.style.setProperty('--panel-veil', String(this.media.transparency / 100));
      doc.classList.toggle('has-bg', this.media.type !== 'none');
      doc.dataset.bgType = this.media.type;
      if (this.media.type === 'image') doc.style.setProperty('--panel-bg-image', `url("${bg.replace(/"/g, '%22')}")`);
      else doc.style.removeProperty('--panel-bg-image');

      // branding: a logo replaces the mark on the rail, the login card and the splash
      if (logo) {
        doc.classList.add('has-logo');
        doc.style.setProperty('--panel-logo', `url("${logo.replace(/"/g, '%22')}")`);
      } else {
        doc.classList.remove('has-logo');
        doc.style.removeProperty('--panel-logo');
      }

      this.paintBackground();
      if (s.panel_name) {
        // the wordmark in the old rail is gone; the name lives in the title bar
        document.title = `${String(s.panel_name).replace(/\s+panel$/i, '')} — control panel`;
      }
      if (s.favicon_logo) {
        const f = document.querySelector('link[rel="icon"]');
        if (f) { f.href = s.favicon_logo; f.type = ''; }
      }
    },

    paintBackground() {
      const layer = document.getElementById('panel-bg');
      if (!layer) return;
      const { bg, type } = this.media;
      layer.innerHTML = '';
      layer.classList.toggle('is-on', type !== 'none');
      if (type === 'none') return;

      if (type === 'video') {
        // a CSS background cannot play a video, so video wallpapers get a node
        const v = document.createElement('video');
        v.src = bg;
        v.autoplay = true; v.muted = true; v.loop = true; v.playsInline = true;
        v.setAttribute('muted', ''); v.setAttribute('playsinline', '');
        v.onerror = () => {
          layer.innerHTML = '';
          layer.classList.remove('is-on');
          if (this.probed && window.el && window.el.toast) {
            window.el.toast('The background video could not be loaded — check the link or upload a file', 'err', 'Wallpaper');
          }
        };
        v.play && v.play().catch(() => {});
        layer.appendChild(v);
        return;
      }

      // images are painted by CSS (instant, no JS decode wait); the layer class
      // is already on, and a URL that fails to load gets reported and removed
      const img = new Image();
      img.onerror = () => {
        if (this.media.bg !== bg) return;
        layer.classList.remove('is-on');
        document.documentElement.classList.remove('has-bg');
        if (this.probed && window.el && window.el.toast) {
          window.el.toast('The wallpaper URL could not be loaded — check the link or upload a file', 'err', 'Wallpaper');
        }
      };
      img.src = bg;
    },

    init() {
      this.apply(SafeStore.get('dkx.theme') || (Store.settings && Store.settings.theme_mode) || 'dark');
      if (Store.settings) this.applyMedia(Store.settings);
    }
  };

  /* ------------------------------------------------------------------ menu */
  const Menu = {
    close() { $('#menu-root').innerHTML = ''; },
    open(anchor, items) {
      this.close();
      const rect = anchor.getBoundingClientRect();
      const el = document.createElement('div');
      el.className = 'menu';
      el.innerHTML = items.map((it) => it.sep ? '<div class="menu-sep"></div>'
        : `<div class="menu-item ${it.danger ? 'danger' : ''}" data-k="${esc(it.key)}">${it.icon ? I(it.icon) : ''}<span>${esc(it.label)}</span></div>`).join('');
      $('#menu-root').appendChild(el);
      const top = Math.min(rect.bottom + 6, window.innerHeight - el.offsetHeight - 12);
      el.style.top = `${Math.max(8, top)}px`;
      el.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - el.offsetWidth - 12))}px`;
      el.querySelectorAll('[data-k]').forEach((n) => n.onclick = () => {
        const it = items.find((x) => x.key === n.dataset.k);
        this.close();
        if (it && it.run) it.run();
      });
    },
    user() {
      const u = Store.user || {};
      const items = [
        { key: 'acct', label: 'Account settings', icon: 'user', run: () => Router.go('/account') },
        { key: 'activity', label: 'Recent activity', icon: 'activity', run: () => Router.go('/portal/activity') }
      ];
      if (u.role === 'admin') items.push({ key: 'admin', label: 'Command center', icon: 'gauge', run: () => Router.go('/admin/overview') });
      items.push({ sep: true }, { key: 'out', label: 'Sign out', icon: 'logout', danger: true, run: () => window.Auth.logout() });
      this.open($('#rail-user'), items);
    }
  };

  /* --------------------------------------------------------------- palette */
  const Palette = {
    open() {
      if (Store.api) {
        const wrap = document.createElement('div');
        wrap.className = 'scrim palette-scrim';
        wrap.innerHTML = `<div class="palette"><input placeholder="Search pages, servers, actions…" autocomplete="off"/>
          <div class="palette-list" id="pal-list"></div></div>`;
        $('#modal-root').appendChild(wrap);
        const input = wrap.querySelector('input');
        const list = wrap.querySelector('#pal-list');

        const entries = [];
        NAV.forEach((g) => g.roles.includes(Store.user && Store.user.role) && g.items.forEach((it) => entries.push({ label: it.label, icon: it.icon, hint: g.title, run: () => Router.go(it.hash) })));
        (Store.servers || []).forEach((s) => entries.push({ label: s.name, icon: 'server', hint: 'server', run: () => Router.go(`/server/${s.id}/console`) }));
        entries.push({ label: 'New server', icon: 'plus', hint: 'action', run: () => { if (Store.isAdmin()) Views.admin.createServer(); else toast('Only administrators can create servers', 'warn'); } });
        entries.push({ label: 'Toggle theme', icon: 'moon', hint: 'action', run: () => Theme.toggle() });
        entries.push({ label: 'Sign out', icon: 'logout', hint: 'action', run: () => window.Auth.logout() });

        let sel = 0;
        const paint = (q = '') => {
          const filtered = entries.filter((e) => (e.label + ' ' + e.hint).toLowerCase().includes(q.toLowerCase())).slice(0, 9);
          sel = 0;
          list.innerHTML = filtered.length ? filtered.map((e, i) => `<div class="palette-item ${i === 0 ? 'sel' : ''}" data-i="${i}">${I(e.icon)}<span>${esc(e.label)}</span><span class="palette-hint">${esc(e.hint)}</span></div>`).join('')
            : `<div class="empty" style="padding:26px"><p>No matches</p></div>`;
          list.querySelectorAll('[data-i]').forEach((n) => n.onclick = () => { filtered[Number(n.dataset.i)].run(); close(); });
          return filtered;
        };
        let current = paint();
        input.oninput = () => { current = paint(input.value); };
        input.onkeydown = (e) => {
          const items = $$('.palette-item', list);
          if (e.key === 'ArrowDown') { e.preventDefault(); sel = Math.min(items.length - 1, sel + 1); }
          else if (e.key === 'ArrowUp') { e.preventDefault(); sel = Math.max(0, sel - 1); }
          else if (e.key === 'Enter') { if (current[sel]) { current[sel].run(); close(); } return; }
          else if (e.key === 'Escape') { close(); return; }
          items.forEach((n, i) => n.classList.toggle('sel', i === sel));
          if (items[sel]) items[sel].scrollIntoView({ block: 'nearest' });
        };
        const close = () => { wrap.remove(); document.removeEventListener('keydown', ekey); };
        const ekey = (e) => { if (e.key === 'Escape') close(); };
        document.addEventListener('keydown', ekey);
        wrap.addEventListener('mousedown', (e) => { if (e.target === wrap) close(); });
        setTimeout(() => input.focus(), 40);
      }
    }
  };

  /* ----------------------------------------------------------------- router */
  /* A thin top bar is the cheapest honest feedback that a click registered:
     the view fetch takes a beat on a slow link, and without it the UI looks
     frozen. The bar completes when the new view has painted. */
  const Progress = {
    el: null,
    ensure() {
      if (!this.el) {
        this.el = document.createElement('div');
        this.el.id = 'route-progress';
        document.body.appendChild(this.el);
      }
      return this.el;
    },
    start() {
      const el = this.ensure();
      el.classList.add('is-on');
      el.style.width = '18%';
      clearTimeout(this._t1); clearTimeout(this._t2);
      this._t1 = setTimeout(() => { el.style.width = '62%'; }, 180);
      this._t2 = setTimeout(() => { el.style.width = '86%'; }, 620);
    },
    done() {
      const el = this.ensure();
      clearTimeout(this._t1); clearTimeout(this._t2);
      el.style.width = '100%';
      setTimeout(() => { el.classList.remove('is-on'); el.style.width = '0'; }, 240);
    }
  };

  /* Highlight the destination immediately on click instead of waiting for the
     route to finish resolving — the sidebar must feel wired to the pointer. */
  function highlightFor(hash) {
    const path = String(hash || '').replace(/^#/, '');
    const parts = path.split('/').filter(Boolean);
    const idMap = {
      'portal/overview': 'portal-overview', 'portal/servers': 'portal-servers', 'portal/activity': 'portal-activity',
      marketplace: 'market', account: 'account'
    };
    let id = idMap[parts.slice(0, 2).join('/')] || idMap[parts[0]] || '';
    if (parts[0] === 'server') id = 'portal-servers';
    if (parts[0] === 'admin') id = 'admin-' + (parts[1] || 'overview');
    if (id && $('#rail-nav')) $$('.rail-item').forEach((el) => el.classList.toggle('active', el.dataset.nav === id));
  }

  const Views = {};
  const Router = {
    current: '',
    go(path) {
      const h = '#' + (path.startsWith('/') ? path : '/' + path);
      if (location.hash === h) this.resolve();
      else location.hash = h;
    },
    async resolve() {
      const hash = (location.hash || '#/').replace(/^#/, '');
      if (!Store.token) { window.Auth.renderLogin(); return; }
      Progress.start();
      highlightFor(hash);
      try {
        await this._resolve(hash);
      } finally {
        Progress.done();
      }
    },
    async _resolve(hash) {
      if (!Store.user) {
        try {
          const r = await API.get('/api/auth/me');
          Store.setUser(r.user);
          Store.settings = r.settings || {};
        } catch (e) { window.Auth.renderLogin(); return; }
      } else if (!Store.api) {
        try { const r = await API.get('/api/auth/me'); Store.settings = r.settings || {}; } catch (e) {}
      }
      Store.api = true;

      const parts = hash.split('/').filter(Boolean);
      const root = parts[0] || 'portal';
      if (parts.length === 0) { Router.go(Store.isAdmin() ? '/admin/overview' : '/portal/overview'); return; }

      let navId = '';
      let crumbs = [];

      const mount = (viewFn, activeId, crumbParts) => {
        if (!$('#view-inner')) Shell.mount();
        Shell.setActive(activeId);
        Shell.setCrumbs(crumbParts);
        const host = $('#view-inner');
        host.className = 'view-inner';
        host.innerHTML = '';
        document.getElementById('view').setAttribute('data-view', hash);
        document.getElementById('view').scrollTop = 0;
        Router.current = hash;
        return viewFn(host);
      };

      try {
        if (root === 'login') { window.Auth.renderLogin(); return; }
        if (root === 'portal') {
          const sub = parts[1] || 'overview';
          const map = {
            overview: [Views.portal.overview, 'portal-overview', [{ label: 'Server', hash: '/portal/overview' }, { label: 'Overview' }]],
            servers: [Views.portal.servers, 'portal-servers', [{ label: 'Server', hash: '/portal/overview' }, { label: 'My Servers' }]],
            activity: [Views.portal.activity, 'portal-activity', [{ label: 'Server', hash: '/portal/overview' }, { label: 'Activity' }]]
          };
          if (!map[sub]) { Router.go('/portal/overview'); return; }
          return mount(...map[sub]);
        }
        if (root === 'account') return mount(Views.portal.account, 'account', [{ label: 'Client', hash: '/portal/overview' }, { label: 'Account' }]);
        if (root === 'marketplace') return mount(Views.market.view, 'market', [{ label: 'Discover' }, { label: 'Marketplace' }]);

        if (root === 'server') {
          const id = parts[1];
          const tab = parts[2] || 'console';
          const allowed = ['console', 'files', 'settings', 'backups', 'schedules', 'players', 'worlds', 'users', 'network', 'addons', 'marketplace', 'databases', 'activity'];
          if (!id || !allowed.includes(tab)) { Router.go(`/server/${id || ''}/console`); return; }
          return mount((host) => Views.server.shell(host, id, tab), 'portal-servers', [{ label: 'Servers', hash: '/portal/servers' }, { label: `#${id}` }]);
        }

        if (root === 'admin') {
          if (!Store.isAdmin()) { toast('Administrator access required', 'err'); Router.go('/portal/overview'); return; }
          const sub = parts[1] || 'overview';
          const map = {
            overview: [Views.admin.overview, 'admin-overview', [{ label: 'Admin' }, { label: 'Command Center' }]],
            servers: [Views.admin.servers, 'admin-servers', [{ label: 'Admin' }, { label: 'Servers' }]],
            users: [Views.admin.users, 'admin-users', [{ label: 'Admin' }, { label: 'Users' }]],
            nodes: [Views.admin.nodes, 'admin-nodes', [{ label: 'Admin' }, { label: 'Nodes' }]],
            network: [Views.admin.network, 'admin-network', [{ label: 'Admin' }, { label: 'Network' }]],
            databases: [Views.admin.databases, 'admin-databases', [{ label: 'Admin' }, { label: 'Databases' }]],
            backups: [Views.admin.backups, 'admin-backups', [{ label: 'Admin' }, { label: 'Backups' }]],
            settings: [Views.admin.settings, 'admin-settings', [{ label: 'Admin' }, { label: 'Settings' }]],
            addons: [Views.admin.addons, 'admin-addons', [{ label: 'Admin' }, { label: 'Addons' }]],
            social: [Views.admin.social, 'admin-social', [{ label: 'Admin' }, { label: 'Social login' }]],
            updates: [Views.admin.updates, 'admin-updates', [{ label: 'Admin' }, { label: 'Panel updates' }]]
          };
          if (!map[sub]) { Router.go('/admin/overview'); return; }
          return mount(...map[sub]);
        }

        Router.go(Store.isAdmin() ? '/admin/overview' : '/portal/overview');
      } catch (err) {
        console.error(err);
        const host = $('#view-inner');
        if (host) host.innerHTML = `<div class="card card-pad">${emptyState('alert', 'Could not load this view', err.message, `<button class="btn btn-sm" onclick="location.reload()">Reload panel</button>`)}</div>`;
      }
    },
    /* Idempotent: safe to call from boot() *and* from the login flow. Without
       this, signing in from the login form left the router with no hashchange
       listener at all, so every sidebar/link click moved the URL and rendered
       nothing — the panel looked completely dead until a manual reload. */
    start() {
      if (!this._started) {
        this._started = true;
        window.addEventListener('hashchange', () => this.resolve());
        this.startLinkGuard();
      }
      this.resolve();
    },
    /* Delegated fallback: if a hashchange listener is ever lost (a view
       re-render, a proxy that swallows events, an odd embedded browser),
       clicks on any internal link still drive the router. Cheap, idempotent. */
    startLinkGuard() {
      if (this._guarded) return;
      this._guarded = true;
      document.addEventListener('click', (e) => {
        const a = e.target.closest('a[href^="#"]');
        if (!a || e.metaKey || e.ctrlKey || e.shiftKey || e.button) return;
        const target = a.getAttribute('href');
        setTimeout(() => {
          const want = (location.hash || '').replace(/^#/, '');
          if (want && '/' + want.replace(/^\//, '') !== this.current && (target || '').replace(/^#/, '') === want) {
            this.resolve();
          }
        }, 90);
      });
    }
  };

  /* --------------------------------------------------------- global delegations */
  document.addEventListener('click', (e) => {
    const t = e.target.closest('[data-copy]');
    if (t) { copy(t.dataset.copy); }
  });

  window.DKX = { $, $$, esc, fmt, API, Store, toast, modal, confirmDialog, promptDialog, copy, copyField, emptyState, skeleton, sparkline, meter, statusChip, STATUS_META, Router, Views, Shell, Theme, Palette, Menu, NAV };
  // short aliases used inside view modules
  window.el = { $, $$, esc, fmt, API, Store, toast, modal, confirmDialog, promptDialog, copy, copyField, emptyState, skeleton, sparkline, meter, statusChip, Theme, Router };
})();
