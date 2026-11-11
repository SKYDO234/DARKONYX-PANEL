/* ==========================================================================
   DARKONYX PANEL — authentication (login / register / 2FA)
   ========================================================================== */
(function () {
  const { API, Store, toast, esc, Theme } = window.el;

  const FEATURES = [
    { icon: 'bolt', text: 'Instant power actions, live console & resource telemetry' },
    { icon: 'folder', text: 'Full file manager, SFTP, backups, schedules and plugins' },
    { icon: 'shield', text: 'Two-factor auth, granular sub-users and audit trails' }
  ];

  const Auth = {
    mode: 'login',
    pending2fa: null,
    registering: false,

    async logout() {
      Store.setToken(''); Store.setUser(null); Store.api = false; Store.servers = [];
      try { await API.post('/api/auth/logout'); } catch (e) {}
      toast('Signed out of DARKONYX', 'info');
      location.hash = '#/login';
      this.renderLogin();
    },

    async boot() {
      const s = Store.settings || {};
      if (s.panel_name) document.title = s.panel_name;
      const me = Store.cachedUser();
      if (Store.token && me) Store.user = me;
    },

    async checkRegistration() {
      try {
        const r = await API.get('/api/auth/registration-status');
        this.registrationEnabled = r.enabled !== false;
      } catch (e) { this.registrationEnabled = true; }
    },

    renderLogin() {
      const app = document.getElementById('app');
      Theme.apply((window.DKXStorage ? window.DKXStorage.get('dkx.theme') : null) || 'dark');
      const isRegister = this.mode === 'register';

      app.innerHTML = `
      <div class="auth-wrap">
        <div class="auth-visual">
          <div class="auth-aurora"></div>
          <div class="auth-rings"></div>
          <div class="row gap-14">
            <div class="brand-mark" style="width:44px;height:44px;flex-basis:44px">
              <svg viewBox="0 0 24 24" fill="none"><path d="M12 2.6 20.5 7v10L12 21.4 3.5 17V7L12 2.6Z" stroke="#c4b5fd" stroke-width="1.4"/><path d="M12 7.4 16.6 10v4.6L12 17.2 7.4 14.6V10L12 7.4Z" fill="#8b5cf6" fill-opacity=".85"/></svg>
            </div>
            <div class="brand-text"><strong style="font-size:15px;letter-spacing:.16em">DARKONYX</strong><span>panel</span></div>
          </div>

          <div>
            <h1 class="auth-headline">Command your<br/><em>Minecraft world</em><br/>from one obsidian deck.</h1>
            <p class="auth-tagline">DARKONYX PANEL is a self-hosted controller for Minecraft (Paper, Fabric, Forge, Purpur, Vanilla), Node.js and Python servers — power controls, live console, file manager, backups, schedules, plugins and telemetry.</p>
            <div class="auth-feats">
              ${FEATURES.map((f) => `<div class="auth-feat"><div class="afi">${I(f.icon)}</div><span>${esc(f.text)}</span></div>`).join('')}
            </div>
          </div>

          <div class="row gap-14 tiny dim" style="letter-spacing:.14em;text-transform:uppercase;font-weight:600">
            <span>${I('shield')}</span><span>Self-hosted</span><span>·</span><span>No telemetry</span><span>·</span><span>MIT</span>
          </div>
        </div>

        <div class="auth-form-side">
          <div class="auth-card">
            <div class="auth-logo">
              <div class="brand-mark"><svg viewBox="0 0 24 24" fill="none"><path d="M12 2.6 20.5 7v10L12 21.4 3.5 17V7L12 2.6Z" stroke="#c4b5fd" stroke-width="1.4"/><path d="M12 7.4 16.6 10v4.6L12 17.2 7.4 14.6V10L12 7.4Z" fill="#8b5cf6" fill-opacity=".85"/></svg></div>
              <div class="brand-text"><strong>DARKONYX</strong><span>panel</span></div>
            </div>

            <h2>${isRegister ? 'Create your account' : this.pending2fa ? 'Two-factor check' : 'Welcome back'}</h2>
            <p class="auth-sub">${isRegister ? 'Register to deploy and control your own game servers.' : this.pending2fa ? 'Enter the 6-digit code from your authenticator app.' : 'Sign in to manage your servers and infrastructure.'}</p>

            <div id="auth-error"></div>

            <form id="auth-form" class="col gap-14">
              ${isRegister ? `
                <div class="field"><label>Username</label><input class="input" name="username" placeholder="darkonyx" autocomplete="username" required /></div>
                <div class="field"><label>Email</label><input class="input" name="email" type="email" placeholder="you@domain.com" autocomplete="email" required /></div>
                <div class="field"><label>Password</label><input class="input" name="password" type="password" placeholder="At least 8 characters" autocomplete="new-password" required /></div>
              ` : this.pending2fa ? `
                <div class="field"><label>Authentication code</label>
                  <input class="input mono" name="twoFactorCode" inputmode="numeric" maxlength="6" placeholder="000000" style="letter-spacing:.4em;text-align:center;font-size:18px" autofocus required />
                </div>
              ` : `
                <div class="field"><label>Username or email</label>
                  <input class="input" name="username" placeholder="admin" autocomplete="username" value="${esc(window.DKXStorage ? (window.DKXStorage.get('dkx.lastUser') || '') : '')}" required />
                </div>
                <div class="field"><label>Password</label>
                  <div style="position:relative">
                    <input class="input" name="password" type="password" placeholder="••••••••" autocomplete="current-password" required style="padding-right:42px" />
                    <button type="button" id="pw-eye" style="position:absolute;right:8px;top:50%;transform:translateY(-50%);background:none;border:0;color:var(--text-3);cursor:pointer;display:grid;place-items:center;width:26px;height:26px;border-radius:7px">${I('eye')}</button>
                  </div>
                </div>
                <label class="switch" style="align-self:flex-start">
                  <input type="checkbox" name="remember" checked /><span class="track"></span>
                  <span class="switch-label">Keep me signed in on this device</span>
                </label>
              `}
              <button class="btn btn-primary btn-lg btn-block" type="submit" id="auth-submit" style="margin-top:4px">
                ${isRegister ? 'Create account' : this.pending2fa ? 'Verify & continue' : 'Sign in'} ${I('arrowRight')}
              </button>
            </form>

            <div class="auth-foot">
              ${this.pending2fa ? `<a id="auth-back">← Use a different account</a>`
                : isRegister ? `Already have an account? <a id="auth-toggle">Sign in</a>`
                : `Need an account? <a id="auth-toggle">Register</a>`}
            </div>

            <div class="card card-pad mt-22" style="border-style:dashed">
              <div class="row gap-8 tiny dim"><span>${I('info')}</span><span>Fresh install? Default credentials are <b class="mono" style="color:var(--text-2)">admin / admin</b> — change them immediately.</span></div>
            </div>
          </div>
        </div>
      </div>`;

      Security.attach();
      const form = document.getElementById('auth-form');
      const errBox = document.getElementById('auth-error');
      const showErr = (msg) => {
        errBox.innerHTML = `<div class="auth-alert">${I('alert')}<span>${esc(msg)}</span></div>`;
      };

      const eye = document.getElementById('pw-eye');
      if (eye) eye.onclick = () => {
        const inp = form.querySelector('[name=password]');
        const on = inp.type === 'password';
        inp.type = on ? 'text' : 'password';
        eye.innerHTML = I(on ? 'eyeOff' : 'eye');
      };

      const toggle = document.getElementById('auth-toggle');
      if (toggle) toggle.onclick = () => { this.mode = isRegister ? 'login' : 'register'; this.pending2fa = null; this.renderLogin(); };
      const back = document.getElementById('auth-back');
      if (back) back.onclick = () => { this.pending2fa = null; this.renderLogin(); };

      form.onsubmit = async (e) => {
        e.preventDefault();
        const btn = document.getElementById('auth-submit');
        const data = Object.fromEntries(new FormData(form).entries());
        btn.disabled = true;
        errBox.innerHTML = '';
        try {
          if (isRegister) {
            const r = await API.post('/api/auth/register', data);
            if (r.token) { this.complete(r); return; }
            toast('Account created — please sign in', 'ok', 'Welcome');
            this.mode = 'login';
            this.renderLogin();
          } else {
            const payload = { username: data.username || this.pending2fa?.username, password: data.password || this.pending2fa?.password, twoFactorCode: data.twoFactorCode };
            const r = await API.post('/api/auth/login', payload);
            if (r.requires2FA) {
              this.pending2fa = { username: data.username, password: data.password, userId: r.userId };
              this.renderLogin();
              return;
            }
            this.complete(r, data.username);
          }
        } catch (err) {
          showErr(err.message);
          btn.disabled = false;
        }
      };
    },

    complete(r, username) {
      Store.setToken(r.token);
      Store.setUser(r.user);
      if (username && window.DKXStorage) window.DKXStorage.set('dkx.lastUser', username);
      Store.api = true;
      toast(`Signed in as ${r.user.username}`, 'ok', 'Access granted');
      const target = Store.isAdmin() ? '/admin/overview' : '/portal/overview';
      location.hash = '#' + target;
      // start() wires the hashchange listener on first login and resolves the
      // route; calling resolve() alone here left navigation dead until reload.
      window.DKX.Router.start();
    }
  };

  /* tiny hardening hints for the login form (no external captcha dependency) */
  const Security = {
    attach() {
      document.querySelectorAll('input, button, a').forEach((el) => {
        el.addEventListener('contextmenu', (e) => e.stopPropagation());
      });
    }
  };

  window.el.Auth = Auth;
  window.Auth = Auth;
})();
