/**
 * DARKONYX PANEL — compatibility & meta endpoints
 * Small read-only helpers that let the modern frontend talk to the same
 * backend surface without touching the original feature routes.
 */
const express = require('express');
const os = require('os');
const fs = require('fs');
const router = express.Router();
const config = require('../config/config');
const { query, DB_DRIVER, SQLITE_FILE } = require('../database/db');
const { authenticate } = require('../middleware/auth');
const runnerService = require('../services/runnerService');

// Panel build identity
router.get('/meta', (req, res) => {
  res.json({
    success: true,
    panel: 'DARKONYX PANEL',
    version: '1.0.0',
    engine: 'darkonyx-core',
    database: DB_DRIVER === 'mysql' ? 'MariaDB / MySQL' : 'Embedded SQLite',
    database_file: DB_DRIVER === 'mysql' ? null : SQLITE_FILE,
    node: process.version,
    platform: `${os.platform()} ${os.arch()}`,
    uptime_seconds: Math.floor(process.uptime()),
    ports: { web: config.PORT_WEB, daemon: config.PORT_API, sftp: config.PORT_SFTP }
  });
});

// Public branding bootstrap (works before login)
router.get('/bootstrap', async (req, res) => {
  try {
    const rows = await query.all('SELECT `key`, `value` FROM settings');
    const settings = {};
    for (const r of rows) settings[r.key] = r.value;
    // The wallpaper and its blur/veil are branding, not secrets: the login
    // screen has to paint them before anyone is signed in, otherwise a chosen
    // background only appears after login (or not at all).
    const allowed = ['panel_name', 'panel_logo', 'favicon_logo', 'favicon_name', 'panel_bg', 'panel_bg_type',
      'panel_bg_category', 'blur_bar', 'transparency_bar', 'theme_mode', 'registration_enabled', 'default_language'];
    const publicSettings = {};
    for (const k of allowed) if (settings[k] !== undefined) publicSettings[k] = settings[k];
    res.json({ success: true, settings: publicSettings });
  } catch (err) {
    res.json({ success: true, settings: {} });
  }
});

// Live per-server stats snapshot (single request for dashboards)
router.get('/servers/live', authenticate, async (req, res) => {
  try {
    const ids = String(req.query.ids || '').split(',').map((n) => parseInt(n, 10)).filter(Boolean);
    const out = {};
    for (const id of ids) {
      const stats = (runnerService.serverStats && runnerService.serverStats.get(id)) || {};
      out[id] = {
        status: runnerService.getServerStatus ? runnerService.getServerStatus(id) : stats.status,
        ...stats
      };
    }
    res.json({ success: true, stats: out });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Minecraft egg catalogue (jar types served by the mcjars service)
router.get('/eggs', async (req, res) => {
  try {
    const mcjarsService = require('../services/mcjarsService');
    const types = await mcjarsService.getTypes();
    // `eggs` mirrors `types` so either name works for API consumers
    res.json({ success: true, types, eggs: types });
  } catch (err) {
    res.json({ success: true, types: [], eggs: [] });
  }
});

module.exports = router;
