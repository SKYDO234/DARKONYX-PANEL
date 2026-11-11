# 🖤 DARKONYX PANEL

<p align="center">
  <img src="assets/zk-studio.png" alt="ZK STUDIO" width="320" />
</p>

<p align="center">
  <b>Made by ZK STUDIO</b>
</p>

**Obsidian-grade Minecraft server control.** A self-hosted hosting panel for Minecraft (Paper, Purpur, Fabric, Forge, NeoForge, Vanilla, Velocity, BungeeCord…), Node.js and Python servers — with power controls, a live console, file manager, backups, schedules, players, worlds, plugins, sub-users and full node administration.

> A complete, self-contained panel: a full server **engine** (routes, services, runner, daemon API, SFTP, scheduler), an **entirely original interface** with its own design system, views, interaction model and navigation, and a zero-config database layer so it runs anywhere.

---

## ✨ Highlights

| | |
|---|---|
| **Live console** | WebSocket stream, ANSI colour, command history, quick commands, live CPU / RAM / disk gauges |
| **Power controls** | Start · Restart · Stop · Force kill, with suspend protection |
| **File manager** | Browse, create, edit, rename, delete, upload, download, backup-and-restore of any file |
| **Server software** | One-click jar installs across 16 Minecraft flavours via mcjars |
| **Backups** | Manual + scheduled snapshots, lock / restore / delete |
| **Schedules** | Cron-driven start / stop / restart / command / backup |
| **Players & worlds** | Online list with op/kick/ban, world activate / clone / reset |
| **Sub-users** | Granular per-server permissions on ~15 capabilities |
| **Marketplace** | Curated maps, Modrinth/CurseForge search, plugin & mod install |
| **Administration** | Command center, fleet view, users, nodes, network, databases, backups, settings, API keys |
| **Security** | bcrypt, JWT, TOTP 2FA, impersonation, audit log |
| **SFTP** | Built-in SFTP server on port 3004 |

---

## 🚀 Quick start

```bash
cd panel
npm install          # or: ./menu.sh install
npm start            # http://localhost:3001
```

Or use the management script:

```bash
./menu.sh            # interactive menu
./menu.sh install    # deps + database + admin user
./menu.sh start      # run under PM2 (falls back to foreground)
./menu.sh status     # runtime + port + database health
```

**Default login:** `admin` / `admin` — change it right away (Account → Change password).

Requirements: **Node.js ≥ 22.5** (the panel embeds SQLite through `node:sqlite`), or **Node 18+ with MariaDB/MySQL**.

---

## 🔌 Ports

| Service | Port |
|---|---|
| Panel web UI + REST API | `3001` |
| Daemon API (REST + WebSocket) | `3003` |
| Built-in SFTP | `3004` |
| Game servers | allocations (`25565`, `25566`, …) |

---

## 🗄️ Database

DARKONYX runs **zero-config by default**: an embedded SQLite database at `panel/data/darkonyx.sqlite3`, created automatically on first boot. The original MariaDB/MySQL dialect the engine was written against is translated on the fly (`panel/src/database/sqliteCompat.js`), so nothing else needs configuring.

Prefer a real MariaDB/MySQL server? Set `DB_DRIVER=mysql` in `panel/.env`:

```env
DB_DRIVER=mysql
DB_HOST=127.0.0.1
DB_PORT=3306
DB_USER=panel
DB_PASSWORD=•••
DB_NAME=darkonyx
```

Other useful keys: `PORT_WEB`, `PORT_API`, `PORT_SFTP`, `JWT_SECRET`, `CURSEFORGE_API_KEY`, `VM_KVM_MODE`.

---

## 🖥️ Running game servers

* **Without Docker** the panel uses its native process runner — no extra setup, perfect for a single VPS.
* **With Docker** (socket at `/var/run/docker.sock`) servers launch in isolated containers using the configured image, and Docker is detected automatically at boot.
* Minecraft servers get their jar downloaded on first start, plus `eula.txt`, `server-port` and `query.port` are synced to the assigned allocation.

Server files live in `panel/storage/servers/server<id>/`, backups in `panel/storage/backups/`.

---

## 📁 Layout

```
panel/
├── public/                 # DARKONYX frontend (original UI)
│   ├── index.html
│   ├── css/darkonyx.css    # design system (obsidian glass + aurora mesh)
│   └── js/                 # icons, core, auth, portal, server, admin, market, boot
├── src/
│   ├── index.js            # web + daemon + SFTP bootstrap
│   ├── database/           # db.js (driver switch) + sqliteCompat.js
│   ├── routes/             # auth, servers, files, backups, schedules, admin, …
│   ├── services/           # runner, backups, worlds, players, marketplace, …
│   ├── api/daemonServer.js # REST daemon
│   ├── websocket/          # console + update streams
│   └── sftp/               # embedded SFTP server
├── data/                   # sqlite database (runtime)
├── storage/                # server directories + backups (runtime)
├── test/feature-audit.js   # 147-check end-to-end API audit
├── menu.sh                 # install / start / stop / status / update
└── ecosystem.config.js     # PM2 configuration
```

---

## 🔐 SFTP

```
Host:     your-server-ip
Port:     3004
Username: <username>.<server_id>     e.g. admin.1
Password: your panel password
```

---

## ✅ Verifying a build

The panel ships an end-to-end audit that exercises every REST endpoint, the
daemon API, the embedded SFTP port and the console WebSocket with realistic
payloads. It creates its own server, cleans up after itself and can be run
repeatedly against a live instance.

```bash
cd panel
node src/index.js            # in one terminal
npm run test:api             # backend — 155 checks
npm install --no-save jsdom && npm run test:ui   # frontend — 23 checks
```

`test:ui` drives the real SPA in jsdom: it logs in through the login form,
walks all 28 routes asserting no `undefined`/`NaN`/`[object Object]` in the
rendered markup, opens the node dialog and checks all 8 panels show live data,
and clicks bulk-suspend to confirm it actually suspends the selected servers.

```
=== 155/155 checks passed ===

Per-group:
  auth          11/11 ✔     files         19/19 ✔     addons        10/10 ✔
  meta           6/6  ✔     properties     3/3  ✔     marketplace    5/5  ✔
  admin          4/4  ✔     backups        7/7  ✔     mcjars         1/1  ✔
  users          9/9  ✔     schedules      4/4  ✔     settings       2/2  ✔
  locations      4/4  ✔     players        3/3  ✔     api-keys       4/4  ✔
  nodes         19/19 ✔     worlds         7/7  ✔     activity       1/1  ✔
  servers       16/16 ✔     subusers       4/4  ✔     admin-ext      6/6  ✔
  admin-servers  4/4  ✔     network        2/2  ✔     daemon         1/1  ✔
                            databases      1/1  ✔     sftp           1/1  ✔
                                                     websocket      1/1  ✔
```

Checks that need an outside host (Modrinth search, jar downloads, the GitHub
release feed) are reported separately as `OFFLINE` and never count as failures,
so the suite is usable on a box with no outbound network.

---

## 🧭 Notes

* Fresh installs seed one node with 19 free port allocations and an `admin / admin` account.
* A failed GitHub release check (offline hosts) is cached and never blocks the dashboard.
* `public/data` (tool data) and `public/addons` (egg icons) ship with the panel.

---

<p align="center">
  <img src="assets/zk-studio.png" alt="ZK STUDIO" width="160" />
</p>

<p align="center">
  <b>Made by ZK STUDIO</b>
</p>

---

**License:** MIT © DARKONYX PANEL. Interface, design system and branding: DARKONYX.
