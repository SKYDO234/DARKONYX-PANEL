const express = require('express');
const router = express.Router({ mergeParams: true });
const { query } = require('../database/db');
const { authenticate, requireAdmin, requireServerAccess } = require('../middleware/auth');
const autoBackupService = require('../services/autoBackupService');
const backupService = require('../services/backupService');

// -----------------------------------------------------------------------------
// Admin AutoBackups Endpoints
// -----------------------------------------------------------------------------

// Get AutoBackup Status & Settings
router.get(['/', '/admin'], authenticate, requireAdmin, async (req, res) => {
  try {
    const data = await autoBackupService.getStatus();
    res.json({ success: true, ...data });
  } catch (err) {
    console.error('Error getting AutoBackups status:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Update AutoBackup Settings
router.put(['/', '/admin'], authenticate, requireAdmin, async (req, res) => {
  try {
    const { run_at, days, weeks, months, name, excluded_nodes, enabled } = req.body;

    const updates = {};
    if (run_at !== undefined) updates.autobackups_run_at = run_at;
    if (days !== undefined) updates.autobackups_days = days;
    if (weeks !== undefined) updates.autobackups_weeks = weeks;
    if (months !== undefined) updates.autobackups_months = months;
    if (name !== undefined) updates.autobackups_name = name;
    if (excluded_nodes !== undefined) updates.autobackups_excluded_nodes = excluded_nodes;
    if (enabled !== undefined) updates.autobackups_enabled = enabled ? '1' : '0';

    const status = await autoBackupService.updateSettings(updates);
    res.json({
      success: true,
      message: 'AutoBackups settings saved successfully.',
      ...status
    });
  } catch (err) {
    console.error('Error updating AutoBackups settings:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Manually Trigger AutoBackups Run Now
router.post(['/run', '/admin/run'], authenticate, requireAdmin, async (req, res) => {
  try {
    const result = await autoBackupService.executeAutoBackups(req.user.id);
    if (!result.success) {
      return res.status(400).json(result);
    }
    res.json(result);
  } catch (err) {
    console.error('Error running AutoBackups manually:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// -----------------------------------------------------------------------------
// Client Server AutoBackups Endpoints
// -----------------------------------------------------------------------------

// List automatic backups for a specific server (by ID)
router.get('/servers/:serverId/backups/auto', authenticate, requireServerAccess('backups.read'), async (req, res) => {
  try {
    const { serverId } = req.params;
    const backups = await query.all(
      'SELECT * FROM backups WHERE server_id = ? AND is_automatic = 1 ORDER BY created_at DESC',
      [serverId]
    );

    res.json({
      success: true,
      backups: backups || []
    });
  } catch (err) {
    console.error('Error listing server automatic backups:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Blueprint compatibility route: /api/client/extensions/autobackups/servers/:uuid/backups/auto
router.get(['/client/servers/:uuid/backups/auto', '/servers/:uuid/backups/auto'], authenticate, async (req, res) => {
  try {
    const { uuid } = req.params;
    const server = await query.get('SELECT id, user_id FROM servers WHERE uuid = ?', [uuid]);
    if (!server) {
      return res.status(404).json({ success: false, error: 'Server not found.' });
    }

    if (req.user.role !== 'admin' && req.user.id !== server.user_id) {
      const sub = await query.get('SELECT id FROM subusers WHERE server_id = ? AND user_id = ?', [server.id, req.user.id]);
      if (!sub) return res.status(403).json({ success: false, error: 'Access denied.' });
    }

    const backups = await query.all(
      'SELECT * FROM backups WHERE server_id = ? AND is_automatic = 1 ORDER BY created_at DESC',
      [server.id]
    );

    res.json({
      success: true,
      backups: backups || []
    });
  } catch (err) {
    console.error('Error listing client automatic backups:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
