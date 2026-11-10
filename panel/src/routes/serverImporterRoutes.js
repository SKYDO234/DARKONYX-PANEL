const express = require('express');
const router = express.Router({ mergeParams: true });
const { authenticate, requireServerAccess } = require('../middleware/auth');
const serverImporterService = require('../services/serverImporterService');
const { query } = require('../database/db');
const { logActivity } = require('../services/activityService');

// Initialize profiles table if not exists
query.exec(`
  CREATE TABLE IF NOT EXISTS server_importer_profiles (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    name VARCHAR(191) NOT NULL,
    host VARCHAR(191) NOT NULL,
    port INT DEFAULT 22,
    mode VARCHAR(50) DEFAULT 'sftp',
    username VARCHAR(191),
    remote_path VARCHAR(255) DEFAULT '/',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_importer_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
`).catch(e => console.error('Failed to init server_importer_profiles table:', e.message));

// Test SFTP connection
router.post('/test', authenticate, requireServerAccess('settings.edit'), async (req, res) => {
  try {
    const { host, port, username, password } = req.body;
    if (!host || !username) {
      return res.status(400).json({ success: false, error: 'Host and Username are required.' });
    }

    const result = await serverImporterService.testConnection({ host, port, username, password });
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Trigger Server Import (SFTP or Direct URL Archive)
router.post('/import', authenticate, requireServerAccess('settings.edit'), async (req, res) => {
  try {
    const serverId = req.params.serverId;
    const { mode, host, port, username, password, remotePath, archiveUrl, wipeTarget } = req.body;

    logActivity(req.user.id, serverId, 'SERVER_IMPORT_STARTED', `Started import via ${mode || 'sftp'}`, req);

    if (mode === 'url') {
      if (!archiveUrl) {
        return res.status(400).json({ success: false, error: 'Archive URL is required.' });
      }
      serverImporterService.startUrlImport(serverId, { url: archiveUrl, wipeTarget: !!wipeTarget })
        .catch(e => console.error('Background URL import failed:', e.message));
    } else {
      if (!host || !username) {
        return res.status(400).json({ success: false, error: 'Host and username are required for SFTP import.' });
      }
      serverImporterService.startSftpImport(serverId, {
        host,
        port: port || 22,
        username,
        password,
        remotePath: remotePath || '/',
        wipeTarget: !!wipeTarget
      }).catch(e => console.error('Background SFTP import failed:', e.message));
    }

    res.json({ success: true, message: 'Server import initiated in background.' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Get Live Import Status & Logs
router.get('/status', authenticate, requireServerAccess('settings.view'), (req, res) => {
  const serverId = req.params.serverId;
  const job = serverImporterService.getJob(serverId);
  res.json({ success: true, job });
});

// Saved Profiles
router.get('/profiles', authenticate, async (req, res) => {
  try {
    const profiles = await query.all('SELECT * FROM server_importer_profiles WHERE user_id = ? ORDER BY id DESC', [req.user.id]);
    res.json({ success: true, profiles });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/profiles', authenticate, async (req, res) => {
  try {
    const { name, host, port, mode, username, remote_path } = req.body;
    if (!name || !host) {
      return res.status(400).json({ success: false, error: 'Profile name and Host are required.' });
    }

    const r = await query.run(`
      INSERT INTO server_importer_profiles (user_id, name, host, port, mode, username, remote_path)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `, [req.user.id, name, host, port || 22, mode || 'sftp', username || '', remote_path || '/']);

    res.json({ success: true, id: r.lastID, message: 'Profile saved successfully.' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.delete('/profiles/:profileId', authenticate, async (req, res) => {
  try {
    await query.run('DELETE FROM server_importer_profiles WHERE id = ? AND user_id = ?', [req.params.profileId, req.user.id]);
    res.json({ success: true, message: 'Profile deleted.' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
