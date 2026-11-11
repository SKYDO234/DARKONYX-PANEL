/* ==========================================================================
   DARKONYX PANEL — entry point
   ========================================================================== */
(function () {
  /* boot watchdog: if the runtime never came up (a blocked storage API, a
     failed script, an old cached bundle) show a way out instead of a dead
     splash screen that swallows every click. */
  function bootFailed(why) {
    const status = document.getElementById('boot-status');
    const actions = document.getElementById('boot-actions');
    if (status) status.textContent = why || 'the panel could not start';
    if (actions) actions.style.display = '';
    console.error('[DARKONYX] boot failed:', why);
  }
  window.addEventListener('DOMContentLoaded', () => {
    setTimeout(() => {
      if (!window.DKX || !window.el) {
        bootFailed(window.el ? 'core runtime did not finish loading' : 'panel scripts did not load');
      }
    }, 6000);
  });

  if (!window.el) { bootFailed('core runtime did not load'); return; }

  const { Store, API } = window.el;
  const Theme = () => window.DKX.Theme;
  const Auth = () => window.Auth;

  async function boot() {
    window.DKX.Theme.init();

    // restore cached identity for instant paint
    const cached = Store.cachedUser();
    if (Store.token && cached) Store.user = cached;

    // public branding bootstrap (never blocks the UI on failure)
    API.get('/api/bootstrap')
      .then((r) => {
        Store.settings = { ...(Store.settings || {}), ...(r.settings || {}) };
        if (r.settings && r.settings.panel_name) document.title = r.settings.panel_name;
        if (r.settings && r.settings.favicon_logo) {
          const f = document.querySelector('link[rel=icon]');
          if (f) f.href = r.settings.favicon_logo;
        }
      })
      .catch(() => {});

    if (!Store.token) {
      window.Auth.renderLogin();
      window.DKX.booted = true;
      return;
    }

    try {
      const me = await API.get('/api/auth/me');
      Store.setUser(me.user);
      Store.settings = { ...(Store.settings || {}), ...(me.settings || {}) };
      Store.api = true;
    } catch (e) {
      Store.setToken(''); Store.setUser(null);
      window.Auth.renderLogin();
      window.DKX.booted = true;
      return;
    }

    if (!location.hash || location.hash === '#' || location.hash === '#/') {
      location.hash = Store.isAdmin() ? '#/admin/overview' : '#/portal/overview';
    }

    window.DKX.Shell.mount();
    window.DKX.Shell.syncUser();
    window.DKX.Router.start();
    window.DKX.booted = true;

    // keep the sidebar live-metrics chip warm
    setInterval(async () => {
      try {
        if (!Store.token) return;
        const r = await API.get('/api/servers');
        const badge = document.getElementById('nav-server-count');
        if (badge) badge.textContent = (r.servers || []).length ? String(r.servers.length) : '';
      } catch (e) {}
    }, 60000);
  }

  // surface unexpected errors instead of failing silently
  window.addEventListener('error', (e) => {
    if (e && e.message && /Script error/.test(e.message)) return;
    console.error('[DARKONYX]', e.message);
  });
  window.addEventListener('unhandledrejection', (e) => {
    const msg = e.reason && e.reason.message ? e.reason.message : String(e.reason || '');
    if (msg && !/AbortError/.test(msg)) console.warn('[DARKONYX] unhandled', msg);
  });

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
