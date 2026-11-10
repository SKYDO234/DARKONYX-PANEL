const express = require('express');
const router = express.Router();
const { query } = require('../database/db');
const { authenticate, requireAdmin } = require('../middleware/auth');

// Get system activity logs (Admin) or user activity logs
router.get('/', authenticate, async (req, res) => {
  try {
    const limit = parseInt(req.query.limit || '50', 10);
    let logs = [];

    if (req.user.role === 'admin') {
      logs = await query.all(`
        SELECT a.*, u.username, u.email, s.name as server_name
        FROM activity_logs a
        LEFT JOIN users u ON a.user_id = u.id
        LEFT JOIN servers s ON a.server_id = s.id
        ORDER BY a.created_at DESC
        LIMIT ?
      `, [limit]);
    } else {
      logs = await query.all(`
        SELECT a.*, u.username, u.email, s.name as server_name
        FROM activity_logs a
        LEFT JOIN users u ON a.user_id = u.id
        LEFT JOIN servers s ON a.server_id = s.id
        WHERE a.user_id = ?
        ORDER BY a.created_at DESC
        LIMIT ?
      `, [req.user.id, limit]);
    }

    res.json({ success: true, logs });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Get server specific activity logs
router.get('/server/:serverId', authenticate, async (req, res) => {
  try {
    const serverId = req.params.serverId;
    const limit = parseInt(req.query.limit || '50', 10);

    const logs = await query.all(`
      SELECT a.*, u.username, u.email
      FROM activity_logs a
      LEFT JOIN users u ON a.user_id = u.id
      WHERE a.server_id = ?
      ORDER BY a.created_at DESC
      LIMIT ?
    `, [serverId, limit]);

    res.json({ success: true, logs });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;

