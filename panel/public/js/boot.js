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

  /* ---- stale-build guard -------------------------------------------------
     A tab left open across a deploy keeps the old bundle in memory while the
     server serves the new one. The symptom is indistinguishable from a broken
     UI: clicks did fire, but against code that no longer matches the DOM.
     Compare the build id baked into this page with the server's and reload
     once (guarded so a flapping deploy cannot cause a reload loop). */
  const BUILD = (document.querySelector('meta[name="dkx-build"]') || {}).content || '';
  window.DKX_BUILD = BUILD;
  async function checkBuild(reloadOnMismatch, overrideBuild) {
    const build = overrideBuild || BUILD;
    if (!build) return true;
    try {
      const r = await fetch('/api/build', { cache: 'no-store' });
      const data = await r.json();
      const same = !data.build || data.build === build;
      if (!same && reloadOnMismatch !== false) {
        const key = 'dkx.reloaded.' + data.build;
        try {
          if (!sessionStorage.getItem(key)) {
            sessionStorage.setItem(key, '1');
            location.reload();
          }
        } catch (e) { /* storage blocked: leave the tab alone */ }
      }
      return same;
    } catch (e) { return true; }
  }
  window.DKX_checkBuild = checkBuild;

  async function boot() {
    window.DKX.Theme.init();
    checkBuild(true);
    setInterval(() => checkBuild(true), 120000);

    // restore cached identity for instant paint
    const cached = Store.cachedUser();
    if (Store.token && cached) Store.user = cached;

    // public branding bootstrap (never blocks the UI on failure)
    API.get('/api/bootstrap')
      .then((r) => {
        Store.settings = { ...(Store.settings || {}), ...(r.settings || {}) };
        // branding (title, favicon, wallpaper, logo, blur) is applied by Theme
        window.DKX.Theme.applyMedia(Store.settings);
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
      window.DKX.Theme.applyMedia(Store.settings);
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
