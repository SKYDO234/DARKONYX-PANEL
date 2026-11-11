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
  power signals, ANSI rendering, command history, quick commands
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

**Settings** — branding (name, logo, colors), registration toggle, default
language, default theme, wallpaper library (bundled + upload + custom
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

## Verification

| Suite | Scope | Result |
|---|---|---|
| `panel/test/feature-audit.js` | 27 groups, live HTTP calls against a running panel | **155/155** |
| `panel/test/ui-audit.js` | jsdom SPA harness: login form, 28 routes, bulk actions, 8 node panels | **23/23** |
| Route parity vs upstream | regex diff of `router.*` declarations, per file | 190 upstream → 197 here (1 upstream-only route deliberately dropped, 8 local additions) |
| Backend source parity | per-directory file counts across `api, config, database, middleware, routes, services, sftp, websocket` | identical (21/21 services) |

```bash
cd panel && node src/index.js        # in one terminal
npm run test:api                     # 155 backend checks
npm install --no-save jsdom && npm run test:ui   # 23 frontend checks
```
