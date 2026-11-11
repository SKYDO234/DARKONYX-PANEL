const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const { WebSocketServer } = require('ws');

const config = require('./config/config');
const { initDatabase } = require('./database/db');
const { seedDatabase } = require('./database/seed');
const { setupWebSocket } = require('./websocket/consoleWs');
const scheduleService = require('./services/scheduleService');
const autoSuspensionService = require('./services/autoSuspensionService');
const sftpServer = require('./sftp/sftpServer');
const { createDaemonServer } = require('./api/daemonServer');
const { hardenRouter } = require('./middleware/safeAsync');

// Routes
const authRoutes = require('./routes/authRoutes');
const adminRoutes = require('./routes/adminRoutes');
const adminSettingsRoutes = require('./routes/adminSettingsRoutes');
const userRoutes = require('./routes/userRoutes');
const nodeRoutes = require('./routes/nodeRoutes');
const locationRoutes = require('./routes/locationRoutes');
const apiKeyRoutes = require('./routes/apiKeyRoutes');
const serverRoutes = require('./routes/serverRoutes');
const serverFilesRoutes = require('./routes/serverFilesRoutes');
const serverBackupRoutes = require('./routes/serverBackupRoutes');
const serverScheduleRoutes = require('./routes/serverScheduleRoutes');
const serverSubuserRoutes = require('./routes/serverSubuserRoutes');
const mcjarsRoutes = require('./routes/mcjarsRoutes');
const activityRoutes = require('./routes/activityRoutes');
const marketplaceRoutes = require('./routes/marketplaceRoutes');
const serverPlayerRoutes = require('./routes/serverPlayerRoutes');
const serverWorldRoutes = require('./routes/serverWorldRoutes');
const serverImporterRoutes = require('./routes/serverImporterRoutes');
const serverPropertiesRoutes = require('./routes/serverPropertiesRoutes');
const serverSplitterRoutes = require('./routes/serverSplitterRoutes');
const autoBackupRoutes = require('./routes/autoBackupRoutes');
const autoBackupService = require('./services/autoBackupService');
const socialLoginRoutes = require('./routes/socialLoginRoutes');
const adminUpdateRoutes = require('./routes/adminUpdateRoutes');
const adminAddonsRoutes = require('./routes/adminAddonsRoutes');
const serverAddonRoutes = require('./routes/serverAddonRoutes');


/**
 * Process safety nets.
 * A single bad request, a stray rejected promise or a flaky child process must
 * never be able to take the whole panel down — log it and keep serving.
 */
let crashCount = 0;
process.on('uncaughtException', (err) => {
  crashCount++;
  console.error(`⚠️  [DARKONYX] Uncaught exception #${crashCount} (panel kept alive):`, err && err.message ? err.message : err);
  if (err && err.stack) console.error(String(err.stack).split('\n').slice(0, 4).join('\n'));
  if (crashCount > 500) {
    console.error('❌ Too many exceptions — exiting so the process manager can restart cleanly.');
    process.exit(1);
  }
});
process.on('unhandledRejection', (reason) => {
  crashCount++;
  console.error(`⚠️  [DARKONYX] Unhandled rejection #${crashCount} (panel kept alive):`, reason && reason.message ? reason.message : reason);
  if (crashCount > 500) process.exit(1);
});

async function bootstrap() {
  console.log('🚀 Initializing DARKONYX PANEL Core Engine...');

  // Initialize DB & Seed
  await initDatabase();
  await seedDatabase();
  require('./services/systemTelemetry').start();
  await scheduleService.initSchedules();
  await autoBackupService.initAutoBackupCron();
  autoSuspensionService.init();

  // 1. Web UI & API App (Port 3001)
  const app = express();
  const server = http.createServer(app);

  app.use(cors());
  app.use(express.json({ limit: '50mb' }));
  app.use(express.urlencoded({ extended: true, limit: '50mb' }));

  // ---- frontend build identity -------------------------------------------
  // A stale tab (old JS paired with new HTML) used to look exactly like a
  // broken panel: nothing responds to clicks. Every asset URL now carries the
  // hash of the file it points at, /api/meta exposes the same hash, and the
  // running page compares the two and reloads itself when they diverge.
  const crypto = require('crypto');
  const PUBLIC_DIR = path.join(__dirname, '../public');
  const assetHashes = new Map();
  const ASSET_FILES = ['js/icons.js', 'js/core.js', 'js/auth.js', 'js/portal.js', 'js/server.js',
    'js/admin.js', 'js/market.js', 'js/admin-extra.js', 'js/boot.js', 'css/darkonyx.css'];

  function assetHash(rel) {
    if (!assetHashes.has(rel)) {
      try {
        assetHashes.set(rel, crypto.createHash('sha1')
          .update(fs.readFileSync(path.join(PUBLIC_DIR, rel)))
          .digest('hex').slice(0, 10));
      } catch (e) { assetHashes.set(rel, '0'); }
    }
    return assetHashes.get(rel);
  }

  // index.html is the only thing that is templated: the version query string on
  // each tag guarantees a new URL whenever a file changes.
  const indexTemplate = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
  const renderIndex = () => {
    let html = indexTemplate;
    for (const rel of ASSET_FILES) {
      html = html.split(`"/${rel}"`).join(`"/${rel}?v=${assetHash(rel)}"`);
    }
    const build = ASSET_FILES.map(assetHash).join('').slice(0, 8);
    html = html.replace('</head>', `  <meta name="dkx-build" content="${build}" />\n</head>`);
    return html;
  };

  app.get(['/', '/index.html'], (req, res) => {
    res.set('Cache-Control', 'no-store, must-revalidate');
    res.type('html').send(renderIndex());
  });

  app.get('/api/build', (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({ success: true, build: ASSET_FILES.map(assetHash).join('').slice(0, 8) });
  });

  // Static Assets (DARKONYX frontend)
  app.use(express.static(PUBLIC_DIR, {
    maxAge: 0,
    etag: false,
    setHeaders: (res) => {
      res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
    }
  }));
  app.use('/uploads', express.static(path.join(__dirname, '../public/uploads')));
  app.use('/data', express.static(path.join(__dirname, '../public/data')));
  app.use('/addons', express.static(path.join(__dirname, '../public/addons')));

  // Every router gets async-safety wrapping before it is mounted
  for (const r of [
    authRoutes, adminUpdateRoutes, adminSettingsRoutes, userRoutes, nodeRoutes,
    locationRoutes, apiKeyRoutes, autoBackupRoutes, adminAddonsRoutes, adminRoutes,
    serverAddonRoutes, socialLoginRoutes, serverRoutes, serverFilesRoutes,
    serverBackupRoutes, serverScheduleRoutes, serverSubuserRoutes, serverPlayerRoutes,
    serverWorldRoutes, serverImporterRoutes, serverPropertiesRoutes, serverSplitterRoutes,
    mcjarsRoutes, activityRoutes, marketplaceRoutes
  ]) hardenRouter(r);

  // REST API Routes
  app.use('/api', require('./routes/compatRoutes'));

  app.use('/api/auth', authRoutes);
  app.use('/api/admin/updates', adminUpdateRoutes);
  app.use('/api/admin/settings', adminSettingsRoutes);
  app.use('/api/admin/users', userRoutes);
  app.use('/api/admin/nodes', nodeRoutes);
  app.use('/api/admin/locations', locationRoutes);
  app.use('/api/admin/api-keys', apiKeyRoutes);
  app.use('/api/admin/extensions/autobackups', autoBackupRoutes);
  app.use('/api/admin/autobackups', autoBackupRoutes);
  app.use('/api/admin/addons', adminAddonsRoutes);
  app.use('/api/admin/domain', adminAddonsRoutes);
  app.use('/api/admin', adminRoutes);
  app.use('/api/addons', serverAddonRoutes);
  app.use('/api/servers/:serverId/addons', serverAddonRoutes);
  app.use('/api/client/extensions/autobackups', autoBackupRoutes);
  app.use('/api', socialLoginRoutes);
  app.use('/api/servers', serverRoutes);
  app.use('/api/servers/:serverId/files', serverFilesRoutes);
  app.use('/api/servers/:serverId/backups', serverBackupRoutes);
  app.use('/api/servers/:serverId/schedules', serverScheduleRoutes);
  app.use('/api/servers/:serverId/subusers', serverSubuserRoutes);
  app.use('/api/servers/:serverId/players', serverPlayerRoutes);
  app.use('/api/servers/:serverId/worlds', serverWorldRoutes);
  app.use('/api/servers/:serverId/importer', serverImporterRoutes);
  app.use('/api/servers/:serverId/properties', serverPropertiesRoutes);
  app.use('/api/servers/:serverId/splitter', serverSplitterRoutes);
  app.use('/api/autobackups', autoBackupRoutes);
  app.use('/api', autoBackupRoutes);
  app.use('/api/mcjars', mcjarsRoutes);
  app.use('/api/activity', activityRoutes);
  app.use('/api/marketplace', marketplaceRoutes);
  app.use('/api/servers/:serverId/marketplace', marketplaceRoutes);

  // Unknown API endpoints must answer with JSON 404 (never hang the socket)
  app.use('/api', (req, res) => {
    res.status(404).json({ success: false, error: `Unknown API endpoint: ${req.method} ${req.originalUrl}` });
  });

  // Client-side application routes resolve to the DARKONYX SPA shell
  const SPA_ROUTES = ['/login', '/portal', '/server', '/admin', '/account', '/marketplace'];
  app.get(SPA_ROUTES, (req, res, next) => {
    if (/\.(js|css|svg|png|jpg|json|ico|woff2?)$/i.test(req.path)) return next();
    res.sendFile(path.join(__dirname, '../public/index.html'));
  });
  app.get(['/portal/*', '/server/*', '/admin/*'], (req, res, next) => {
    if (req.path.startsWith('/api') || req.path.startsWith('/ws')) return next();
    res.sendFile(path.join(__dirname, '../public/index.html'));
  });

  // Every other GET falls back to the SPA shell
  app.get('*', (req, res) => {
    if (req.path.startsWith('/ws')) return res.status(404).end();
    res.sendFile(path.join(__dirname, '../public/index.html'));
  });

  // JSON error handler — MUST be the last middleware so it catches every route
  app.use((err, req, res, next) => {
    console.error('[DARKONYX] Request failed:', req.method, req.originalUrl, '—', err && err.message);
    if (res.headersSent) return next(err);
    res.status(err && err.status ? err.status : 500).json({
      success: false,
      error: (err && err.message) || 'Unexpected server error.'
    });
  });

  // WebSocket Server for Console & Live Metrics
  const wss = new WebSocketServer({ server });
  setupWebSocket(wss);

  server.listen(config.PORT_WEB, '0.0.0.0', () => {
    console.log(`🌐 [Web Panel UI]    listening on http://0.0.0.0:${config.PORT_WEB}`);
  });

  // 2. Daemon API Server (Port 3003)
  const daemonApp = createDaemonServer();
  daemonApp.listen(config.PORT_API, '0.0.0.0', () => {
    console.log(`⚡ [Daemon/Panel API] listening on http://0.0.0.0:${config.PORT_API}`);
  });

  // 3. Embedded SFTP Server (Port 3004)
  sftpServer.start();

  console.log(`
╔══════════════════════════════════════════════════════╗
║               🎮 DARKONYX READY TO USE                 ║
╠══════════════════════════════════════════════════════╣
║  • Web Panel UI:    http://localhost:${config.PORT_WEB}            ║
║  • Daemon/API Port: http://localhost:${config.PORT_API}            ║
║  • SFTP Port:       sftp://localhost:${config.PORT_SFTP}            ║
║                                                      ║
║  Default Admin Credentials:                          ║
║  Username: admin                                     ║
║  Password: admin                                     ║
╚══════════════════════════════════════════════════════╝
  `);
}

bootstrap().catch((err) => {
  console.error('Fatal initialization error:', err);
  process.exit(1);
});

