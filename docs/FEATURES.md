# DARKONYX PANEL — Complete Feature Inventory

Every item below is verified against the running panel (routes walked, endpoints
probed), not copied from a feature list. Numbers in brackets are API endpoints
counted from `panel/src/routes` + `panel/src/api`.

---

## 1. Accounts & authentication  [11 endpoints]

| Feature | Endpoint / detail |
|---|---|
| Username-or-email login | `POST /api/auth/login` |
| Registration (admin-toggleable) | `POST /api/auth/register`, `GET /api/auth/registration-status` |
| Logout (token revoke) | `POST /api/auth/logout` |
| Session identity + refresh | `GET /api/auth/me` |
| Profile edit (username, email, password, avatar) | `PUT /api/auth/profile` |
| Two-factor auth (TOTP) | `POST /api/auth/2fa/setup`, `/2fa/verify`, `/2fa/disable` |
| Social login — Discord, Google, GitHub | `GET /api/auth/social/providers`, `/auth/social/redirect/:provider`, `/auth/social/callback` |
| Linked-account management | `GET /api/auth/social/connections`, `DELETE /:connectionId` (10 endpoints total) |
| Per-user sidebar ordering | `GET|PUT /api/auth/server-order` |
| Password hashing | bcrypt; sessions are stateless JWTs |

## 2. Users (admin)  [8 endpoints]

- List, create, inspect, edit, delete users
- Role assignment (admin / user) and per-user permissions
- Suspend / unsuspend, with reason
- **Impersonation** — log in as any user, one click back
- Per-user activity timeline (`GET /api/admin/users/:id/activity`)
- Personal API keys (`GET/POST/DELETE /api/admin/api-keys`, 3 endpoints) for the
  daemon/automation
- Global audit log (`GET /api/activity`, `GET /api/activity/server/:serverId`)

## 3. Game servers  [19 endpoints]

- Create from an egg/template or **import** an existing install
- Lifecycle: start / stop / restart / **kill** (`POST /api/servers/:id/power`)
- Suspend / unsuspend, expiry date, delete
- Live console over WebSocket (`/ws/servers/:id/console`) — command send,
  power signals, ANSI rendering, quick commands, and a full console workspace
  (`public/js/console.js`):
  - **Terminal** — 3 000-line bounded buffer, ANSI colour + bold, search/filter
    with match stepping and "only matches", line-wrap / text-size (9–28 px) /
    timestamp toggles, per-server command history (↑/↓ + history dialog) kept in
    the browser, copy, download `.log`, clear (view only), jump-to-latest,
    expand mode, auto-reconnect with exponential backoff
  - **Telemetry rail** — CPU, memory, disk and network-in/out cards with real
    limits, plus rolling 60-second charts. Values come from the container's own
    counters or the process tree in `/proc`; disk is the real size of the server
    directory. Anything the host cannot measure prints "not measured" with the
    reason instead of a zero (`GET /api/servers/:id/stats`)
    - **Visual language** — graphite-and-ember operating console: flat hairline
    panels, a fine engineering grid behind a single warm bloom, a compact icon
    dock, a real command bar (⌘K) in the top bar, and a single centred sign-in
    card. Deliberately not the violet-on-black glass dashboard look
  - **Console layout** — a vertical stack: terminal, then a single **trend band**
    that draws CPU / RAM / Disk / Network on one shared time axis (multi-row SVG,
    each band to its own scale), then compact telemetry rows with real limits
    beside a Connection panel (address, uptime, process count, runtime, sample
    provenance). Focus mode hides the telemetry panels and gives the terminal
    the viewport
  - **Section sidebar** — a vertical rail down the left of every server
    workspace (Console, Files, Players, Worlds, Backups, Schedules, Network,
    Databases, Sub-users, Addons, Marketplace, Activity, Settings) with the
    page on the right; on phones it becomes an off-canvas drawer with a
    Sections toggle and a scrim
  - **Power bar** — Start / Restart / Stop / Force stop above the page content,
    visible on every section
  - **Marketplace tab** — the Modrinth catalogue scoped to this server (plugins
    for Bukkit-family, mods for Forge/Fabric/NeoForge/Quilt), one-click install
    that resolves the file matching the server's loader + Minecraft version, an
    **Installed** tab read straight from `plugins/` or `mods/` on disk with
    remove, and the curated **Worlds** catalogue. Catalogue failures (offline
    host) are reported as offline, never as an empty result
  - **Activity tab** — the per-server audit trail (`GET /api/activity/server/:id`,
    now scoped by `requireServerAccess('view')`)
- Resource limits & build config (CPU %, RAM, disk, swap, IO weight)
- **Version changer** (switch MC version keeping the world)
- **Egg changer** (27 selectable templates, `GET/POST .../egg-changer`)
- **Reinstall** (wipes and redeploys), toggle-install flag
- **Server splitter** — clone a server into N child instances with templates and
  subuser sync (`GET/POST/PUT/DELETE .../splitter`, 6 endpoints)
- **Importer** — test SFTP credentials, scan a remote install, profiles
  (`.../importer/test|import|status|profiles`, 6 endpoints)
- Startup command editor, startup variables
- Live resource gauges (`GET /api/servers/:id`, stats stream)

## 4. File manager  [24 endpoints]

- Name-first table: every row shows icon, full name, size and modified date,
  with labelled **Open / Edit / Download / Rename / Delete** actions
- Toolbar: New file, New folder, Upload (button, keyboard accessible, or drag
  and drop onto the list), **Import URL** (inspect a direct link first, then
  download), refresh; breadcrumbs plus a working up button
- **Import URL** streams to a `.part` file and only renames on success, so a
  failed transfer never leaves a half-written file behind
- Multi-select with select-all, bulk delete and bulk zip
- Text editor with line count, unsaved-changes indicator, Tab indent and
  Ctrl/Cmd+S; binary or oversized files are refused instead of being opened
  empty (an empty editor would truncate them on save)
- Browse, read and write files, create directories
- Upload (multipart) and download
- Rename, copy, delete, **trash** (move / restore / empty)
- Compress to archive, extract archive
- `chmod`-style permission editor
- Full-text search across the server directory
- **Properties editor** (`GET/POST .../files/properties`)
- **Pull from URL** — query a remote URL, then download into the server
- **Beautify / format** config files
- **Git integration** — status, clone, pull (`.../files/git/*`)
- Built-in **SFTP server on port 3004** — same credentials, jailed to the
  server root, permission-aware

## 5. Backups  [6 + 1 endpoints]

- Manual backup, list, download, restore, lock (protect from rotation), delete
- **Auto backups** — cron schedule + retention, per-server
  (`GET /servers/:serverId/backups/auto`), configurable in admin settings
- Admin-wide backup overview with size/date per server

## 6. Schedules  [4 endpoints]

- Cron expressions (minute/hour/day/month/weekday)
- Tasks: start, restart, stop, kill, command, backup
- Pause/resume, edit, delete, last-run status

## 7. Players & worlds  [4 + 10 endpoints]

- Online/offline player list, detected worlds
- Actions: **op / deop / kick / ban / unban / whitelist** toggles, player detail
- Worlds: list, activate, create, clone, reset, delete, download, upload,
  install a map from the marketplace, install from URL
- Record generator (addon)

## 8. Sub-users  [4 endpoints]

- Invite by username or email
- 15 granular permissions (console, power, files, backups, schedules,
  settings, subusers, players) — checkboxes mirrored in the UI

## 9. Networking & allocations  [nodeRoutes 22 + serverRoutes network 4]

- Port allocations create (single or range), delete, clear-unassigned
- **IP alias** per allocation (e.g. `mc.example.com`) — persisted on insert
- Port detail lookup, primary allocation switch, assign/unassign
- Admin **network** view: all nodes, all ports, usage per node
- **Firewall** management per node: list rules, add, delete, flush
- **Subdomains** (addon): available domains, add/remove per server, Cloudflare
  zone connect, connected domains, blocklist with import/export

## 10. Databases

- Per-server MySQL database provisioning, user + password per database
- Reset password, delete
- Export / import dumps (addon)
- Admin database hosts (add/remove), admin database browser

## 11. Server addons  [17 endpoints, 19 addon modules]

Each is independently enable/disable-able and scoped to eggs/nests:

Modpack Installer · Plugin Installer · Version Changer · Icon Changer ·
Mod Installer · World Installer · Hytale Mods Installer · Subdomain Manager ·
Rate-limit Editor · Properties Editor · Variables Editor · Startup Editor ·
Egg Changer · Egg Importer · Auto Suspend · FiveM Utils · FiveM Artifacts
Changer · Database Import/Export · Record Generator

FiveM specifics: artifact list, txAdmin activate/deactivate, cache clean.

## 12. Marketplace & content  [27 + 5 endpoints]

- **mcjars** — 22 server types (Paper, Purpur, Pufferfish, Fabric,
  Forge, NeoForge, Quilt, Mohist, Folia, Velocity, Waterfall, BungeeCord,
  Spigot, Bukkit, Vanilla, Arclight …) with version picker and one-click install
- **Modrinth** — search, project detail, version list, install / uninstall
- **CurseForge** — world search, install world, install addon
- **Spigot** — resource search, detail, versions, install
- Curated maps, installed-content list
- **playit.gg** — status, install, configure, uninstall (tunnel for servers
  behind NAT)
- **mctools** — info + data endpoints (uuid, server-icon, etc.)
- Tools: clean logs, install preset

## 13. Server templates  [61 container images]

7 Minecraft Java runtimes (Java 8→26), 12 Node.js, 8 Python, 15 LumenVM,
10 no-KVM images, plus wallpaper categories.

## 14. Administration  [overview 12 + nodes 22 + settings 8 + updates 5]

**Command center** — fleet totals, live server counts, recent activity,
network map.

**Nodes** — create/edit/delete, ping + live stats, and an 8-panel node detail
dialog covering the upstream admin view set, reimplemented in the DARKONYX UI:

| Panel | What it shows |
|---|---|
| Live stats | CPU / RAM / disk gauges, uptime, daemon version |
| Wings stats | daemon-reported counters and throughput |
| Allocations | every port on the node, IP alias, add ports (single or range), clear unassigned |
| Servers | servers hosted on this node, with quick links |
| Backups | backup files stored by this node |
| Firewall | rules table (port, protocol, allow/deny, source), add / delete / flush |
| Service | start daemon, restart daemon, reboot host — with live status |
| Logs | scrolling daemon log viewer |

Also: node update check, port detail lookup, mass-action endpoint.

**Mass server actions** — bulk suspend, unsuspend, delete, transfer (with the
option to move backups), single transfer, toggle install.

**Locations** — CRUD, country/flag, per-node assignment (4 endpoints).

**Settings** — branding studio: panel name, logo, favicon, wallpaper (bundled
presets with thumbnails, 4K gallery search, direct image/video URL or upload),
live blur + veil sliders with a preview frame that reports whether the media
actually loads, and a reset-to-default. Everything is applied to the running
page immediately and exposed before login through `/api/bootstrap`, so the
sign-in screen is branded too. Registration toggle, default language, default
theme, wallpaper library (bundled + upload + custom
categories), reset to defaults, public settings endpoint.

**Social login admin** — enable/disable providers, bulk update, per-provider
credentials (10 endpoints).

**Addons admin** — global addon toggles, egg repository browser, egg import,
Cloudflare/domain config, allowance blocklist (16 endpoints).

**Updates** — check status, list GitHub releases, run update, sync
dependencies, git status (works offline, degrades gracefully).

## 15. Daemon & infrastructure  [3 endpoints + WS]

- Daemon API on **:3003** — `GET /api/system/status` (uptime, CPU, memory,
  disk, Docker presence), `GET /api/servers`, `POST /api/servers/:id/power`
- Web console on **:3001** at `/ws/servers/:id/console`,
  admin update stream at `/ws/admin/updates`
- SFTP on **:3004**
- **Docker** orchestration (`dockerService`): container create/start/stop/kill,
  stats, log streaming; falls back to host process mode when Docker is absent
- Embedded **SQLite** database — no separate DB server needed
- Auto-suspension service (expired servers), 21 backend services in total

---

## Data integrity — nothing on screen is invented

Every number in the panel is measured or explicitly marked unmeasured. This is
enforced by `panel/test/honesty-audit.js` (31 checks), which fails the build if
fabricated data returns.

| Area | How it is measured | When it cannot be measured |
|---|---|---|
| CPU | 1-second background sampler over CPU tick deltas (`src/services/systemTelemetry.js`) | never — always a real interval sample |
| RAM | `os.totalmem()` / `os.freemem()` | n/a |
| Disk | `statfs` on the data volume | reports capacity as 0 and `measured: false` |
| Network | `/proc/net/dev` byte deltas per second | `measured: false`, speed shown as 0 B/s |
| Server CPU / RAM | `/proc/<pid>/stat` summed over the **whole process tree**, delta-sampled | `measured: false` → UI prints "not measured" |
| Server disk | recursive `du` of the server directory | 0 |
| Docker | live socket ping, real container/image lists | "Docker socket not present" — never a fake count |
| Database | real `SELECT VERSION()` + query latency | engine name, file/driver, `measured: false` |
| Port detail | real TCP connect to the port, real owner lookup | per-port throughput is `null` (the panel does not measure it) |
| Node logs | panel log file + audit trail | never fabricated boot lines |

Failures tell the truth too: an unreachable Modrinth, FiveM CDN or egg repo
returns an explicit `offline: true` error instead of a hardcoded catalogue.
Destructive host actions are refused unless `ALLOW_HOST_REBOOT=1` is set, and a
mass action that has no implementation is rejected rather than reported as
"dispatched".

## Verification

| Suite | Scope | Result |
|---|---|---|
| `panel/test/feature-audit.js` | 27 groups, live HTTP calls against a running panel | **155/155** |
| `panel/test/ui-audit.js` | jsdom SPA harness: login form, real click navigation, 28 routes, bulk actions, 8 node panels | **28/28** |
| `panel/test/honesty-audit.js` | static + live proof that no telemetry is fabricated | **31/31** |
| `panel/test/layout-audit.js` | overlay/z-index/click-target/design-system coverage | **18/18** |
| `panel/test/click-probe.js` | clicks every clickable control on all 28 routes | **0 dead controls** |
| `panel/test/page-load-audit.js` | loads the page over HTTP with the real script tags executing, then clicks the sidebar | **13/13** |
| Route parity vs upstream | regex diff of `router.*` declarations, per file | 190 upstream → 197 here (1 upstream-only route deliberately dropped, 8 local additions) |
| Backend source parity | per-directory file counts across `api, config, database, middleware, routes, services, sftp, websocket` | identical (21/21 services) |

```bash
cd panel && node src/index.js        # in one terminal
npm run test:api                     # 155 backend checks
npm run test:data                    # 31 data-integrity checks
npm run test:ui                      # 28 UI checks (needs jsdom)
npm run test:layout                  # 18 layout checks
npm run test:clicks                  # 0 dead controls across 28 routes
npm run test:page                    # real page load + real script execution
```
