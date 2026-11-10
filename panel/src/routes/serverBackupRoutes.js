const express = require('express');
const router = express.Router({ mergeParams: true });
const path = require('path');
const fs = require('fs');
const backupService = require('../services/backupService');
const { authenticate, requireServerAccess } = require('../middleware/auth');
const { logActivity } = require('../services/activityService');
const { query } = require('../database/db');

// List backups for server
router.get('/', authenticate, requireServerAccess('backups.read'), async (req, res) => {
  try {
    const serverId = req.params.serverId;
    const backups = await backupService.listBackups(serverId);
    res.json({ success: true, backups });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Create backup
router.post('/', authenticate, requireServerAccess('backups.create'), async (req, res) => {
  try {
    const serverId = req.params.serverId;
    const { name } = req.body;
    const backup = await backupService.createBackup(serverId, name || 'Manual Backup');
    logActivity(req.user.id, serverId, 'BACKUP_CREATE', `Created backup: ${backup.name}`, req);
    res.json({ success: true, backup });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Download backup
router.get('/:backupId/download', authenticate, requireServerAccess('backups.read'), async (req, res) => {
  try {
    const { serverId, backupId } = req.params;
    const backup = await query.get('SELECT * FROM backups WHERE id = ? AND server_id = ?', [backupId, serverId]);
    if (!backup || !fs.existsSync(backup.path)) {
      return res.status(404).json({ success: false, error: 'Backup archive file not found.' });
    }
    res.download(backup.path, backup.file_name);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Restore backup
router.post('/:backupId/restore', authenticate, requireServerAccess('backups.restore'), async (req, res) => {
  try {
    const { serverId, backupId } = req.params;
    await backupService.restoreBackup(backupId);
    logActivity(req.user.id, serverId, 'BACKUP_RESTORE', `Restored backup ID: ${backupId}`, req);
    res.json({ success: true, message: 'Backup restored successfully.' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Toggle backup lock
router.post('/:backupId/lock', authenticate, requireServerAccess('backups.delete'), async (req, res) => {
  try {
    const { serverId, backupId } = req.params;
    const result = await backupService.toggleLock(backupId);
    logActivity(req.user.id, serverId, 'BACKUP_LOCK', `Toggled lock for backup ID: ${backupId}`, req);
    res.json({ success: true, isLocked: result.isLocked });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Delete backup
router.delete('/:backupId', authenticate, requireServerAccess('backups.delete'), async (req, res) => {
  try {
    const { serverId, backupId } = req.params;
    await backupService.deleteBackup(backupId);
    logActivity(req.user.id, serverId, 'BACKUP_DELETE', `Deleted backup ID: ${backupId}`, req);
    res.json({ success: true, message: 'Backup deleted successfully.' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;

