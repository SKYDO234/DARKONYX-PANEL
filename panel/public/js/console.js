/* ==========================================================================
   DARKONYX PANEL — server console workspace
   --------------------------------------------------------------------------
   A full console surface: live terminal with search, filter, wrap, text size,
   timestamps, history recall, log export, pause/jump-to-latest, live stat
   cards and rolling charts.

   Everything on this screen is measured. CPU/RAM come from the server's own
   container counters or its /proc process tree, disk from the real directory
   size, network from the container's interface counters. When the host cannot
   measure something the tile says so and shows the reason — it never prints a
   confident zero.
   ========================================================================== */
(function () {
  const { esc, fmt, copy, toast, statusChip } = window.el;

  const LS = {
    font: 'dkx.con.fontsize',
    wrap: 'dkx.con.wrap',
    time: 'dkx.con.timestamps',
    follow: 'dkx.con.follow',
    expanded: 'dkx.con.expanded'
  };
  const MAX_LINES = 3000;      // keep the DOM sane on a chatty server

  const live = {
    host: null,
    server: null,
    ctl: null,
    ws: null,
    lines: [],
    partial: '',
    dropped: 0,
    search: '',
    onlyMatches: false,
    hits: [],
    hitIndex: 0,
    follow: true,
    font: 12.2,
    wrap: true,
    timestamps: false,
    expanded: false,
    lastStats: null,
    statsTimer: null,
    statsFails: 0,
    pendingEl: null,
    destroyed: false
  };

  /* --------------------------------------------------------------- helpers */
  const num = (v) => (typeof v === 'number' && isFinite(v) ? v : null);
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  function dur(sec) {
    sec = Math.max(0, Math.floor(Number(sec) || 0));
    const d = Math.floor(sec / 86400);
    const h = Math.floor((sec % 86400) / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    if (d) return `${d}d ${h}h ${m}m`;
    if (h) return `${h}h ${m}m ${s}s`;
    if (m) return `${m}m ${s}s`;
    return `${s}s`;
  }

  function clock(at) {
    if (!at) return '';
    const d = new Date(at);
    return [d.getHours(), d.getMinutes(), d.getSeconds()].map((x) => String(x).padStart(2, '0')).join(':');
  }

  function stored(key, fallback) {
    try {
      const v = window.localStorage.getItem(key);
      return v === null ? fallback : v;
    } catch (e) { return fallback; }
  }
  function remember(key, value) {
    try { window.localStorage.setItem(key, String(value)); } catch (e) { /* private mode */ }
  }

  /* ANSI SGR → spans. Unknown escapes are stripped so the pane never shows
     raw control codes. */
  const ANSI_COLORS = {
    30: 'gray', 31: 'red', 32: 'green', 33: 'yellow', 34: 'blue', 35: 'magenta', 36: 'cyan', 37: 'gray',
    90: 'gray', 91: 'red', 92: 'green', 93: 'yellow', 94: 'blue', 95: 'magenta', 96: 'cyan', 97: 'gray'
  };

  function ansiToHtml(text) {
    return String(text)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/\x1b\[(3[0-7]|9[0-7])m/g, (m, c) => `<span class="ansi-${ANSI_COLORS[c] || 'gray'}">`)
      .replace(/\x1b\[1m/g, '<span class="ansi-bold">')
      .replace(/\x1b\[0?m/g, '</span>')
      .replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
  }

  /* Mark search hits before escaping/ANSI conversion using placeholders that
     can never appear in a log line, so a match inside an escape sequence or an
     HTML entity cannot corrupt the markup. */
  function highlightEscaped(rawText, query) {
    if (!query) return ansiToHtml(rawText);
    let text = rawText;
    try {
      const re = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
      text = text.replace(re, (m) => `\u0001${m}\u0002`);
    } catch (e) { /* an invalid query simply matches nothing */ }
    return ansiToHtml(text)
      .replace(/\u0001/g, '<mark class="con-hit">')
      .replace(/\u0002/g, '</mark>');
  }

  /* ------------------------------------------------------------------ shell */
  function render(host, server, ctl) {
    destroy();
    live.host = host;
    live.server = server;
    live.ctl = ctl || {};
    live.destroyed = false;
    live.lines = [];
    live.partial = '';
    live.dropped = 0;
    live.search = '';
    live.onlyMatches = false;
    live.hits = [];
    live.hitIndex = 0;
    live.lastStats = null;
    live.statsFails = 0;
    live.font = Number(stored(LS.font, '12.2')) || 12.2;
    live.wrap = stored(LS.wrap, '1') === '1';
    live.timestamps = stored(LS.time, '0') === '1';
    live.follow = stored(LS.follow, '1') === '1';
    live.expanded = stored(LS.expanded, '0') === '1';

    const suspended = !!server.is_suspended;
    host.innerHTML = `
      <div class="csl-wrap">

        <!-- one console card: title bar with the terminal tools, output, command line -->
        <section class="console-shell con-shell" id="con-shell">
          <div class="con-titlebar">
            <span class="csl-orb" id="con-orb" title="Server status"></span>
            <b class="con-title-name" title="${esc(server.name)}">${esc(server.name)}</b>
            <span id="con-status">${statusChip(suspended ? 'suspended' : (server.status || 'offline'))}</span>
            <span class="con-mode" id="con-mode">—</span>
            <span class="grow"></span>
            <div class="con-tools">
              <button class="con-tool" id="con-find" title="Search the console (Ctrl+F)">${I('search')}<span class="hide-sm">Find</span></button>
              <div class="con-fs">
                <button class="con-tool sq" id="con-fs-down" title="Smaller text">A−</button>
                <select class="con-fs-select" id="con-fs" title="Console text size">
                  ${[10, 11, 12, 12.2, 13, 14, 16, 18].map((sz) => `<option value="${sz}" ${Math.abs(sz - live.font) < 0.05 ? 'selected' : ''}>${sz}px</option>`).join('')}
                </select>
                <button class="con-tool sq" id="con-fs-up" title="Larger text">A+</button>
              </div>
              <button class="con-tool" id="con-wrap" title="Toggle line wrapping">${I('code')}<span class="hide-sm">Wrap</span></button>
              <button class="con-tool" id="con-time" title="Prefix each line with the time it arrived">${I('clock')}<span class="hide-sm">Time</span></button>
              <button class="con-tool" id="con-expand" title="Full-screen the terminal">${I('external')}<span class="hide-sm">Focus</span></button>
              <button class="con-tool" id="con-download" title="Download this log">${I('download')}<span class="hide-sm">Log</span></button>
              <button class="con-tool" id="con-copy" title="Copy the visible console">${I('copy')}</button>
              <button class="con-tool danger" id="con-clear" title="Clear this view only — the server log on disk is untouched">${I('trash')}<span class="hide-sm">Clear</span></button>
            </div>
          </div>

          <div class="con-findbar" id="con-findbar" hidden>
            <label class="con-find-input">
              ${I('search')}
              <input id="con-query" placeholder="Filter console output — text or regular expression" autocomplete="off" spellcheck="false" />
            </label>
            <span class="con-hits" id="con-hits">no matches</span>
            <button class="con-tool sq" id="con-prev" title="Previous match">${I('chevronUp')}</button>
            <button class="con-tool sq" id="con-next" title="Next match">${I('chevronDown')}</button>
            <label class="con-only"><input type="checkbox" id="con-only" /> <span>Only matches</span></label>
            <button class="con-tool sq" id="con-find-close" title="Close">${I('x')}</button>
          </div>

          <div class="console-out con-out" id="con-out" tabindex="0" aria-live="polite"></div>
          <button class="con-jump" id="con-jump" hidden>${I('arrowRight')} Jump to latest</button>

          <div class="con-quick" id="con-quick">
            ${[['list', 'players'], ['save-all', 'save world'], ['say Restarting soon', 'broadcast'], ['tps', 'tick rate'], ['whitelist on', 'whitelist']]
        .map(([c, label]) => `<button class="con-chip" data-quick="${esc(c)}" title="${esc(c)}">${esc(label)}</button>`).join('')}
            <span class="grow"></span>
            <span class="con-count" id="con-count">0 lines</span>
          </div>

          <form class="console-in con-in" id="con-form" autocomplete="off">
            <span class="prompt">${I('chevronRight')}</span>
            <input id="con-cmd" placeholder="${suspended ? 'Server suspended — commands are disabled' : 'Type a command and press Enter — ↑ recalls history'}"
              autocomplete="off" spellcheck="false" ${suspended ? 'disabled' : ''} />
            <button class="con-tool sq" id="con-hist" title="History (↑)">${I('clock')}</button>
            <button class="btn btn-sm btn-primary" type="submit" id="con-send" ${suspended ? 'disabled' : ''}>Send</button>
          </form>
        </section>

        <!-- the stat strip under the console: one card per measured resource -->
        <section class="csl-stats" id="csl-stats" aria-label="Live server metrics">
          <div class="csl-stat" data-metric="cpu">
            <span class="csl-watermark">${I('cpu')}</span>
            <span class="csl-k">CPU usage</span>
            <span class="csl-v"><b id="con-cpu-v">—</b><em id="con-cpu-p"></em></span>
            <span class="csl-limit" id="con-cpu-max">—</span>
            <span class="csl-fill"><span style="width:0%"></span></span>
          </div>
          <div class="csl-stat" data-metric="memory">
            <span class="csl-watermark">${I('memory')}</span>
            <span class="csl-k">Memory usage</span>
            <span class="csl-v"><b id="con-mem-v">—</b><em id="con-mem-p"></em></span>
            <span class="csl-limit" id="con-mem-max">—</span>
            <span class="csl-fill"><span style="width:0%"></span></span>
          </div>
          <div class="csl-stat" data-metric="disk">
            <span class="csl-watermark">${I('disk')}</span>
            <span class="csl-k">Disk usage</span>
            <span class="csl-v"><b id="con-disk-v">—</b><em id="con-disk-p"></em></span>
            <span class="csl-limit" id="con-disk-max">—</span>
            <span class="csl-fill"><span style="width:0%"></span></span>
          </div>
          <div class="csl-stat">
            <span class="csl-watermark">${I('clock')}</span>
            <span class="csl-k">Uptime</span>
            <span class="csl-v"><b id="con-uptime">${server.status === 'running' ? '—' : 'offline'}</b></span>
            <span class="csl-limit">since boot</span>
          </div>
          <div class="csl-stat">
            <span class="csl-watermark">${I('network')}</span>
            <span class="csl-k">Address</span>
            <button class="csl-v csl-copy mono" id="con-addr" title="Copy the game address">${esc(ctl.address || '—')}</button>
            <span class="csl-limit">click to copy</span>
          </div>
          <div class="csl-stat" data-metric="netin">
            <span class="csl-watermark">${I('downloadCloud')}</span>
            <span class="csl-k">Network in</span>
            <span class="csl-v"><b id="con-nin-v">—</b><em id="con-nin-t"></em></span>
            <span class="csl-limit">—</span>
          </div>
          <div class="csl-stat" data-metric="netout">
            <span class="csl-watermark">${I('uploadCloud')}</span>
            <span class="csl-k">Network out</span>
            <span class="csl-v"><b id="con-nout-v">—</b><em id="con-nout-t"></em></span>
            <span class="csl-limit">—</span>
          </div>
        </section>

        <div class="csl-note" id="con-note">Waiting for the first telemetry sample…</div>
      </div>`;

    const out = host.querySelector('#con-out');
    paintChrome();
    applyFont();
    applyWrap();

    /* ---- terminal rendering ---- */
    function lineEl(line, index) {
      const el = document.createElement('div');
      el.className = 'con-line';
      el.dataset.i = String(index);
      if (live.timestamps) {
        const t = document.createElement('span');
        t.className = 'con-ts';
        t.textContent = line.at ? `[${clock(line.at)}] ` : '';
        el.appendChild(t);
      }
      const body = document.createElement('span');
      body.className = 'con-text';
      body.innerHTML = highlightEscaped(line.text, live.search);
      el.appendChild(body);
      return el;
    }

    function matches(line) {
      if (!live.search) return false;
      try { return new RegExp(live.search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(line.text); }
      catch (e) { return false; }
    }

    function repaint() {
      out.innerHTML = '';
      live.hits = [];
      let shown = 0;
      live.lines.forEach((line, i) => {
        const hit = matches(line);
        if (live.onlyMatches && live.search && !hit) return;
        const el = lineEl(line, i);
        if (hit) { el.classList.add('is-hit'); live.hits.push(el); }
        out.appendChild(el);
        shown++;
      });
      if (!shown && live.search) {
        out.innerHTML = `<div class="con-empty">${I('search')}<b>No line matches “${esc(live.search)}”</b>
          <span>The buffer holds the last ${fmt.num(live.lines.length)} lines this tab has seen.</span></div>`;
      } else if (!live.lines.length) {
        out.innerHTML = emptyConsole();
      }
      live.hitIndex = live.hits.length ? 0 : 0;
      paintHits();
      paintCount(shown);
      if (live.follow) scrollToEnd();
    }

    function append(lines) {
      if (!lines.length) return;
      const nearBottom = out.scrollHeight - out.scrollTop - out.clientHeight < 120;
      const filtered = live.onlyMatches && !!live.search;
      const frag = document.createDocumentFragment();
      const added = [];
      lines.forEach((line) => {
        live.lines.push(line);
        const idx = live.lines.length - 1;
        if (filtered && !matches(line)) return;
        const el = lineEl(line, idx);
        if (matches(line)) { el.classList.add('is-hit'); live.hits.push(el); }
        frag.appendChild(el);
        added.push(el);
      });
      if (!out.querySelector('.con-line')) out.innerHTML = '';
      out.appendChild(frag);
      if (live.lines.length > MAX_LINES) {
        const over = live.lines.length - MAX_LINES;
        live.lines.splice(0, over);
        live.dropped += over;
        for (let i = 0; i < over; i++) {
          const first = out.querySelector('.con-line');
          if (!first) break;
          first.remove();
        }
        repaint();
        return;
      }
      paintCount();
      paintHits();
      if (live.follow && nearBottom) scrollToEnd();
      else paintJump();
    }

    function scrollToEnd() {
      out.scrollTop = out.scrollHeight;
      paintJump();
    }

    function paintJump() {
      const btn = host.querySelector('#con-jump');
      const away = out.scrollHeight - out.scrollTop - out.clientHeight > 160;
      if (btn) btn.hidden = !away;
    }

    function paintCount(shown) {
      const el = host.querySelector('#con-count');
      if (!el) return;
      const n = typeof shown === 'number' ? shown : (live.onlyMatches && live.search ? live.hits.length : live.lines.length);
      el.textContent = `${fmt.num(n)} line${n === 1 ? '' : 's'}${live.dropped ? ` · ${fmt.num(live.dropped)} trimmed` : ''}`;
    }

    function paintHits() {
      const el = host.querySelector('#con-hits');
      if (!el) return;
      const n = live.hits.length;
      el.textContent = !live.search ? 'no search' : n ? `${live.hitIndex + 1}/${n} match${n === 1 ? '' : 'es'}` : 'no matches';
      live.hits.forEach((h, i) => h.classList.toggle('is-current', i === live.hitIndex));
    }

    function emptyConsole() {
      const st = live.lastStats;
      if (!server.is_suspended && (!st || st.status === 'offline' || st.status === 'suspended')) {
        return `<div class="con-empty">${I('terminal')}<b>The server is stopped</b>
          <span>Start it from the power controls — output appears here the moment it boots.</span></div>`;
      }
      return `<div class="con-empty">${I('terminal')}<b>Connected — waiting for output</b>
        <span>Nothing has been printed yet. Commands you send are echoed below.</span></div>`;
    }

    /* ---- stream ingestion ---- */
    function ingest(chunk, at) {
      if (!chunk) return;
      const text = String(chunk);
      if (/\x1b\[2J/.test(text) && text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').trim() === '') {
        live.lines = [];
        live.partial = '';
        repaint();
        return;
      }
      const combined = live.partial + text;
      const parts = combined.split('\n');
      live.partial = parts.pop() || '';
      const fresh = parts.map((p) => ({ text: p.replace(/\r$/, ''), at: at || Date.now() }));
      live.partialEl = parts.length ? null : live.partial;
      if (fresh.length) append(fresh);
      paintPartial();
    }

    function paintPartial() {
      if (!live.partial) { if (live.pendingEl) { live.pendingEl.remove(); live.pendingEl = null; } return; }
      if (!live.pendingEl || !out.contains(live.pendingEl)) {
        live.pendingEl = document.createElement('div');
        live.pendingEl.className = 'con-line con-pending';
        out.appendChild(live.pendingEl);
      }
      live.pendingEl.innerHTML = `<span class="con-text">${highlightEscaped(live.partial, live.search)}</span>`;
      if (live.follow) scrollToEnd();
    }

    /* ---- wiring: toolbar ---- */
    const findbar = host.querySelector('#con-findbar');
    const queryInput = host.querySelector('#con-query');
    const setSearch = (value) => {
      live.search = String(value || '');
      repaint();
    };

    host.querySelector('#con-find').onclick = () => {
      findbar.hidden = !findbar.hidden;
      if (!findbar.hidden) queryInput.focus();
      else if (live.search) setSearch('');
    };
    queryInput.oninput = () => setSearch(queryInput.value.trim());
    host.querySelector('#con-find-close').onclick = () => { findbar.hidden = true; queryInput.value = ''; setSearch(''); };
    host.querySelector('#con-only').onchange = (e) => { live.onlyMatches = e.target.checked; repaint(); };
    const step = (dir) => {
      if (!live.hits.length) return;
      live.hitIndex = (live.hitIndex + dir + live.hits.length) % live.hits.length;
      paintHits();
      live.follow = false;
      live.hits[live.hitIndex].scrollIntoView({ block: 'center' });
      paintJump();
    };
    host.querySelector('#con-next').onclick = () => step(1);
    host.querySelector('#con-prev').onclick = () => step(-1);

    function applyFont() {
      out.style.fontSize = `${live.font}px`;
      const sel = host.querySelector('#con-fs');
      if (sel) {
        const opt = Array.from(sel.options).find((o) => Math.abs(Number(o.value) - live.font) < 0.05);
        sel.value = opt ? opt.value : '12.2';
      }
    }
    function setFont(next) {
      live.font = clamp(Math.round(next * 10) / 10, 9, 28);
      remember(LS.font, live.font);
      applyFont();
    }
    host.querySelector('#con-fs-up').onclick = () => setFont(live.font + 1);
    host.querySelector('#con-fs-down').onclick = () => setFont(live.font - 1);
    host.querySelector('#con-fs').onchange = (e) => setFont(Number(e.target.value) || 12.2);

    function applyWrap() {
      out.classList.toggle('nowrap', !live.wrap);
      host.querySelector('#con-wrap').classList.toggle('is-on', live.wrap);
    }
    host.querySelector('#con-wrap').onclick = () => { live.wrap = !live.wrap; remember(LS.wrap, live.wrap ? '1' : '0'); applyWrap(); };

    host.querySelector('#con-time').onclick = () => {
      live.timestamps = !live.timestamps;
      remember(LS.time, live.timestamps ? '1' : '0');
      paintChrome();
      repaint();
    };

    /* Focus mode: the terminal takes the whole viewport so a long stack trace is
       readable, and the telemetry panels come back when you toggle out. */
    host.querySelector('#con-expand').onclick = () => {
      live.expanded = !live.expanded;
      remember(LS.expanded, live.expanded ? '1' : '0');
      const stack = host.querySelector('.csl-wrap');
      if (stack) stack.classList.toggle('is-focus', live.expanded);
      paintChrome();
      if (live.follow) scrollToEnd();
    };

    host.querySelector('#con-clear').onclick = () => {
      live.lines = [];
      live.partial = '';
      live.dropped = 0;
      live.hits = [];
      repaint();
      toast('Console view cleared — the server log on disk is untouched', 'info', 'Cleared');
    };

    const bufferText = () => live.lines.map((l) => (live.timestamps && l.at ? `[${clock(l.at)}] ` : '') + l.text).join('\n') + (live.partial || '');

    host.querySelector('#con-copy').onclick = () => {
      if (!live.lines.length) return toast('Nothing in the console buffer yet', 'warn');
      copy(bufferText());
    };

    host.querySelector('#con-download').onclick = () => {
      if (!live.lines.length) return toast('Nothing in the console buffer yet', 'warn');
      const blob = new Blob([bufferText()], { type: 'text/plain;charset=utf-8' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `${String(server.name || 'server').replace(/[^a-z0-9._-]+/gi, '-')}-console-${new Date().toISOString().replace(/[:.]/g, '-')}.log`;
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 0);
      toast('Log downloaded from this tab’s buffer', 'ok');
    };

    host.querySelector('#con-jump').onclick = () => { live.follow = true; remember(LS.follow, '1'); scrollToEnd(); paintJump(); };
    out.addEventListener('scroll', () => {
      const atEnd = out.scrollHeight - out.scrollTop - out.clientHeight < 60;
      if (atEnd && !live.follow) { live.follow = true; remember(LS.follow, '1'); }
      else if (!atEnd && live.follow) { live.follow = false; remember(LS.follow, '0'); }
      paintJump();
    });

    /* ---- address tile ---- */
    host.querySelector('#con-addr').onclick = () => {
      const v = host.querySelector('#con-addr').textContent;
      if (v && v !== '—') copy(v);
      else toast('This server has no allocation yet', 'warn');
    };

    /* ---- command line ---- */
    const form = host.querySelector('#con-form');
    const cmd = host.querySelector('#con-cmd');
    const historyKey = `dkx.con.history.${server.id}`;
    let history = [];
    try { history = JSON.parse(stored(historyKey, '[]')); } catch (e) { history = []; }
    if (!Array.isArray(history)) history = [];
    let histCursor = history.length;

    function rememberCommand(text) {
      if (!text) return;
      if (history[history.length - 1] !== text) history.push(text);
      history = history.slice(-60);
      histCursor = history.length;
      remember(historyKey, JSON.stringify(history));
    }

    function paintChrome() {
      host.querySelector('#con-time').classList.toggle('is-on', live.timestamps);
      host.querySelector('#con-expand').classList.toggle('is-on', live.expanded);
      host.querySelector('#con-wrap').classList.toggle('is-on', live.wrap);
    }

    async function send(text) {
      const value = String(text || '').trim();
      if (!value) return;
      if (server.is_suspended) return toast('This server is suspended — commands are disabled', 'err');
      const ws = live.ctl.ws && live.ctl.ws();
      let delivered = false;
      if (ws && ws.readyState === 1) {
        ws.send(JSON.stringify({ action: 'command', command: value }));
        delivered = true;
      } else {
        // No live socket: the REST path still reaches the runner, and it answers
        // honestly when the server is not running.
        try {
          await live.ctl.sendHttp(value);
          delivered = true;
        } catch (e) {
          toast(e.message, 'err', 'Command not sent');
          return;
        }
      }
      if (delivered) {
        rememberCommand(value);
        if (live.follow) scrollToEnd();
      }
    }

    form.onsubmit = (e) => { e.preventDefault(); send(cmd.value); cmd.value = ''; };
    cmd.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowUp' && history.length) {
        e.preventDefault();
        histCursor = Math.max(0, histCursor - 1);
        cmd.value = history[histCursor] || '';
        setTimeout(() => cmd.setSelectionRange(cmd.value.length, cmd.value.length), 0);
      } else if (e.key === 'ArrowDown' && history.length) {
        e.preventDefault();
        histCursor = Math.min(history.length, histCursor + 1);
        cmd.value = histCursor === history.length ? '' : history[histCursor];
      } else if (e.key === 'Escape') {
        cmd.value = '';
      }
    });
    host.querySelector('#con-hist').onclick = () => {
      if (!history.length) return toast('No commands sent from this browser yet', 'info', 'History');
      window.el.modal({
        title: 'Command history', subtitle: `${history.length} command${history.length === 1 ? '' : 's'} sent from this browser for this server`,
        body: `<div class="col gap-4">${history.slice().reverse().map((h) => `<button class="con-hist-row mono" data-hist="${esc(h)}">${esc(h)}</button>`).join('')}</div>`,
        footer: '<button class="btn" data-cancel>Close</button>',
        onMount(wrap, close) {
          wrap.querySelector('[data-cancel]').onclick = close;
          wrap.querySelectorAll('[data-hist]').forEach((b) => b.onclick = () => { cmd.value = b.dataset.hist; close(); cmd.focus(); });
        }
      });
    };

    // Ctrl/Cmd+F focuses the filter, Ctrl/Cmd+L clears the view
    host.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        findbar.hidden = false;
        queryInput.focus();
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'l') { e.preventDefault(); host.querySelector('#con-clear').click(); }
    });

    host.querySelectorAll('[data-quick]').forEach((b) => b.onclick = () => send(b.dataset.quick));

    /* ---- stats ---- */
    host.querySelectorAll('.csl-row[data-metric]').forEach((card) => {
      card.addEventListener('click', () => {
        const note = host.querySelector('#con-note');
        if (note) note.scrollIntoView({ block: 'nearest' });
      });
    });

    /* ---- start the stream ---- */
    if (ctl.history) ingest(ctl.history, null);
    if (live.ctl.connect) {
      live.ctl.connect(
        (chunk) => ingest(chunk, Date.now()),
        (stats) => applyStats(stats),
        (status) => setStatus(status)
      );
    }
    if (live.ctl.stats) live.ctl.stats().then((st) => st && applyStats(st)).catch(() => {});
    // poll the REST snapshot as a safety net (socket paused, container restart…)
    live.statsTimer = setInterval(async () => {
      if (live.destroyed || !live.ctl.stats) return;
      try {
        const st = await live.ctl.stats();
        live.statsFails = 0;
        if (st) applyStats(st);
      } catch (e) { live.statsFails++; }
    }, 4000);


    if (live.follow) setTimeout(scrollToEnd, 30);
    setTimeout(() => { try { cmd.focus(); } catch (e) {} }, 120);

    /* ---------- stats rendering ---------- */
    function setText(id, value) {
      const el = host.querySelector('#' + id);
      if (el) el.textContent = value;
    }

    function unmeasured(card, reason) {
      const el = host.querySelector(`.csl-stat[data-metric="${card}"]`);
      if (el) el.classList.add('is-unmeasured');
      const reasonId = card === 'cpu' ? 'con-cpu-v' : card === 'memory' ? 'con-mem-v' : card === 'disk' ? 'con-disk-v' : card === 'netin' ? 'con-nin-v' : 'con-nout-v';
      setText(reasonId, 'not measured');
      const p = card === 'cpu' ? 'con-cpu-p' : card === 'memory' ? 'con-mem-p' : card === 'disk' ? 'con-disk-p' : card === 'netin' ? 'con-nin-t' : 'con-nout-t';
      setText(p, reason ? '' : '');
      const el2 = host.querySelector(`.csl-stat[data-metric="${card}"]`);
      if (el2) el2.title = reason || 'this host does not expose the metric';
    }

    /* the thin progress line under each metric tile */
    function fill(card, pct) {
      const el = host.querySelector(`.csl-stat[data-metric="${card}"] .csl-fill > span`);
      if (!el) return;
      el.style.width = `${clamp(pct || 0, 0, 100).toFixed(1)}%`;
      el.classList.toggle('is-hot', pct > 90);
      el.classList.toggle('is-warm', pct > 70 && pct <= 90);
    }

    function measured(card) {
      const el = host.querySelector(`.csl-stat[data-metric="${card}"]`);
      if (el) el.classList.remove('is-unmeasured');
    }

    function setChip(status) {
      const chip = host.querySelector('#con-status');
      if (chip) chip.innerHTML = statusChip(status);
      const orb = host.querySelector('#con-orb');
      if (orb) {
        orb.setAttribute('class', `csl-orb is-${status || 'offline'}`);
        orb.title = `Server is ${status || 'offline'}`;
      }
    }

    function setStatus(status, stats) {
      if (status) {
        setChip(status);
        if (live.ctl.setStatus) live.ctl.setStatus(status, stats);
        const offline = ['offline', 'suspended', 'stopping'].includes(status);
        const sendBtn = host.querySelector('#con-send');
        if (sendBtn) sendBtn.disabled = offline && status !== 'stopping';
        if (cmd) cmd.disabled = status === 'suspended';
        const mode = host.querySelector('#con-mode');
        if (mode && live.lastStats) mode.textContent = live.lastStats.mode === 'docker' ? 'docker container' : 'native process';
        if (offline && !live.lines.length) repaint();
        if (status === 'running' && !live.lines.length) repaint();
      }
    }

    function applyStats(st) {
      if (!st) return;
      live.lastStats = st;
      if (st.status) setChip(st.status);

      const modeEl = host.querySelector('#con-mode');
      if (modeEl) {
        modeEl.textContent = st.measured === false
          ? 'unmeasured'
          : (st.mode === 'docker' ? 'docker container' : 'native process');
        modeEl.title = st.reason || (st.mode === 'docker' ? 'Counters read from the container' : 'Counters read from the process tree in /proc');
      }

      const running = st.status === 'running' || st.status === 'starting' || st.status === 'restarting';
      setText('con-uptime', running ? dur(st.uptime) : 'offline');
      setText('con-procs', st.processes === undefined || st.processes === null
        ? '—'
        : `${st.processes} process${st.processes === 1 ? '' : 'es'}`);
      setText('con-runtime', st.measured === false ? 'not measured' : (st.mode === 'docker' ? 'docker container' : 'native process'));

      const cpuLimit = num(st.cpu_limit) && st.cpu_limit > 0 ? st.cpu_limit : 100;
      const memLimit = num(st.memory_limit) || Number(live.server.memory_mb) || 0;
      const diskLimit = num(st.disk_limit) || 0;

      setText('con-cpu-max', `/ ${cpuLimit}%`);
      setText('con-mem-max', memLimit ? `/ ${fmt.mb(memLimit)}` : '');
      setText('con-disk-max', diskLimit ? `/ ${fmt.mb(diskLimit)}` : '');

      const reason = st.reason || 'the host reported no value';

      /* CPU */
      if (st.measured === false || num(st.cpu) === null) {
        unmeasured('cpu', reason);
      } else {
        measured('cpu');
        const cpu = st.cpu;
        const pct = clamp((cpu / cpuLimit) * 100, 0, 100);
        setText('con-cpu-v', `${cpu.toFixed(2)}%`);
        setText('con-cpu-p', `${Math.round(pct)}%`);
        fill('cpu', pct);
      }

      /* Memory */
      if (st.measured === false || num(st.memory) === null) {
        unmeasured('memory', reason);
      } else {
        measured('memory');
        const pct = memLimit ? clamp((st.memory / memLimit) * 100, 0, 100) : 0;
        setText('con-mem-v', fmt.mb(st.memory));
        setText('con-mem-p', memLimit ? `${Math.round(pct)}%` : 'no limit set');
        fill('memory', pct);
      }

      /* Disk — always measurable: it is the directory's real size */
      if (num(st.disk) === null) {
        unmeasured('disk', 'the server directory could not be read');
      } else {
        measured('disk');
        const pct = diskLimit ? clamp((st.disk / diskLimit) * 100, 0, 100) : 0;
        setText('con-disk-v', fmt.mb(st.disk));
        setText('con-disk-p', diskLimit ? `${Math.round(pct)}%` : 'no quota set');
        fill('disk', pct);
      }

      /* Network — only containers expose per-server counters */
      const net = st.network || {};
      const rx = num(net.rx_sec);
      const tx = num(net.tx_sec);
      if (rx === null) {
        unmeasured('netin', 'native runs have no per-server socket counters');
        setText('con-nin-t', '');
      }
      else {
        measured('netin');
        setText('con-nin-v', `${fmt.bytes(rx)}/s`);
        setText('con-nin-t', net.rx_bytes !== null && net.rx_bytes !== undefined ? `${fmt.bytes(net.rx_bytes)} total` : '');
      }
      if (tx === null) { unmeasured('netout', 'native runs have no per-server socket counters'); setText('con-nout-t', ''); }
      else {
        measured('netout');
        setText('con-nout-v', `${fmt.bytes(tx)}/s`);
        setText('con-nout-t', net.tx_bytes !== null && net.tx_bytes !== undefined ? `${fmt.bytes(net.tx_bytes)} total` : '');
      }
      /* provenance line */
      const note = host.querySelector('#con-note');
      if (note) {
        const bits = [];
        if (st.measured === false) bits.push(st.reason || 'telemetry unavailable on this host');
        else bits.push(st.mode === 'docker' ? 'measured inside the container' : 'measured from the process tree (/proc)');
        if (st.processes) bits.push(`${st.processes} process${st.processes === 1 ? '' : 'es'}`);
        if (st.timestamp) bits.push(`sampled ${clock(st.timestamp)}`);
        note.textContent = bits.join(' · ');
      }

      if (live.ctl.setStats) live.ctl.setStats(st);
    }

    // expose the ingest/stats hooks used by the shared socket
    live.api = { ingest, applyStats, setStatus };
  }

  /* --------------------------------------------------------------- teardown */
  function destroy() {
    live.destroyed = true;
    if (live.statsTimer) { clearInterval(live.statsTimer); live.statsTimer = null; }
    live.pendingEl = null;
    live.api = null;
    live.host = null;
  }

  /* Frames arrive through the socket owned by server.js, which forwards them
     here so the console keeps one connection. */
  function pushLine(chunk) { if (live.api) live.api.ingest(chunk, Date.now()); }
  function pushStats(stats) { if (live.api) live.api.applyStats(stats); }
  function pushStatus(status) { if (live.api) live.api.setStatus(status); }

  window.DKX = window.DKX || {};
  window.DKX.Console = { render, destroy, pushLine, pushStats, pushStatus, ansiToHtml };
})();
