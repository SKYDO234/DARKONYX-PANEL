const express = require('express');
const cors = require('cors');
const os = require('os');
const config = require('../config/config');
const { authenticateApiKey } = require('../middleware/auth');
const { query } = require('../database/db');
const runnerService = require('../services/runnerService');
const dockerService = require('../services/dockerService');

function createDaemonServer() {
  const app = express();
  app.use(cors());
  app.use(express.json());

  // Daemon Health & System Stats
  app.get('/api/system/status', (req, res) => {
    const totalMem = Math.round(os.totalmem() / (1024 * 1024));
    const freeMem = Math.round(os.freemem() / (1024 * 1024));
    const usedMem = totalMem - freeMem;

    res.json({
      status: 'healthy',
      daemon: 'DARKONYX PANEL Daemon Engine v1.0',
      port: config.PORT_API,
      platform: os.platform(),
      arch: os.arch(),
      cpus: os.cpus().length,
      memory: {
        totalMb: totalMem,
        usedMb: usedMem,
        freeMb: freeMem,
        usagePercentage: Math.round((usedMem / totalMem) * 100)
      },
      dockerAvailable: dockerService.isAvailable
    });
  });

  // Daemon API Auth Middleware for protected endpoints
  app.use('/api', authenticateApiKey);

  // List servers
  app.get('/api/servers', async (req, res) => {
    try {
      const servers = await query.all('SELECT id, uuid, name, server_type, status, memory_mb, cpu_limit, disk_mb FROM servers');
      res.json({ success: true, servers });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // Server Power Actions
  app.post('/api/servers/:id/power', async (req, res) => {
    try {
      const { id } = req.params;
      const { action } = req.body;

      if (!['start', 'stop', 'restart', 'kill'].includes(action)) {
        return res.status(400).json({ success: false, error: 'Invalid power action.' });
      }

      let result;
      if (action === 'start') result = await runnerService.startServer(id);
      else if (action === 'stop') result = await runnerService.stopServer(id);
      else if (action === 'restart') result = await runnerService.restartServer(id);
      else if (action === 'kill') result = await runnerService.killServer(id);

      res.json({ success: true, action, result });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  return app;
}

module.exports = { createDaemonServer };

