const express = require('express');
const router = express.Router({ mergeParams: true });
const { query } = require('../database/db');
const { authenticate, requireServerAccess } = require('../middleware/auth');
const { logActivity } = require('../services/activityService');

// List subusers
router.get('/', authenticate, requireServerAccess('subusers.read'), async (req, res) => {
  try {
    const serverId = req.params.serverId;
    const subusers = await query.all(`
      SELECT s.id, s.server_id, s.user_id, s.permissions, s.created_at,
             u.username, u.email, u.avatar
      FROM subusers s
      JOIN users u ON s.user_id = u.id
      WHERE s.server_id = ?
    `, [serverId]);

    const formatted = subusers.map(sub => {
      let perms = [];
      try { perms = JSON.parse(sub.permissions); } catch (e) {}
      return { ...sub, permissions: perms };
    });

    res.json({ success: true, subusers: formatted });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Add subuser
router.post('/', authenticate, requireServerAccess('subusers.create'), async (req, res) => {
  try {
    const serverId = req.params.serverId;
    const { userIdentifier, permissions } = req.body; // email or username

    if (!userIdentifier) {
      return res.status(400).json({ success: false, error: 'User email or username is required.' });
    }

    const targetUser = await query.get('SELECT id, username, email FROM users WHERE email = ? OR username = ?', [userIdentifier, userIdentifier]);
    if (!targetUser) {
      return res.status(404).json({ success: false, error: 'User with this email or username was not found.' });
    }

    if (targetUser.id === req.server.user_id) {
      return res.status(400).json({ success: false, error: 'Owner cannot be added as a subuser.' });
    }

    const existing = await query.get('SELECT id FROM subusers WHERE server_id = ? AND user_id = ?', [serverId, targetUser.id]);
    if (existing) {
      return res.status(400).json({ success: false, error: 'User is already a subuser of this server.' });
    }

    const permsArray = Array.isArray(permissions) ? permissions : ['console.view', 'files.read'];

    const result = await query.run(
      'INSERT INTO subusers (server_id, user_id, permissions) VALUES (?, ?, ?)',
      [serverId, targetUser.id, JSON.stringify(permsArray)]
    );

    logActivity(req.user.id, serverId, 'SUBUSER_ADD', `Added subuser: ${targetUser.username}`, req);

    res.json({
      success: true,
      subuser: {
        id: result.lastID,
        serverId,
        userId: targetUser.id,
        username: targetUser.username,
        email: targetUser.email,
        permissions: permsArray
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Update subuser permissions
router.put('/:subuserId', authenticate, requireServerAccess('subusers.create'), async (req, res) => {
  try {
    const { serverId, subuserId } = req.params;
    const { permissions } = req.body;

    const permsArray = Array.isArray(permissions) ? permissions : [];
    await query.run('UPDATE subusers SET permissions = ? WHERE id = ? AND server_id = ?', [JSON.stringify(permsArray), subuserId, serverId]);

    logActivity(req.user.id, serverId, 'SUBUSER_UPDATE', `Updated permissions for subuser ID: ${subuserId}`, req);

    res.json({ success: true, message: 'Subuser permissions updated successfully.' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Remove subuser
router.delete('/:subuserId', authenticate, requireServerAccess('subusers.delete'), async (req, res) => {
  try {
    const { serverId, subuserId } = req.params;
    await query.run('DELETE FROM subusers WHERE id = ? AND server_id = ?', [subuserId, serverId]);

    logActivity(req.user.id, serverId, 'SUBUSER_DELETE', `Removed subuser ID: ${subuserId}`, req);

    res.json({ success: true, message: 'Subuser removed.' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;

