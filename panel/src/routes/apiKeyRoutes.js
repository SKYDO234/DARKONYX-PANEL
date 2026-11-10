const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { query } = require('../database/db');
const { authenticate } = require('../middleware/auth');
const { logActivity } = require('../services/activityService');

// List API keys for current user
router.get('/', authenticate, async (req, res) => {
  try {
    const keys = await query.all(
      'SELECT id, key_token, description, permissions, last_used_at, created_at FROM api_keys WHERE user_id = ? ORDER BY id DESC',
      [req.user.id]
    );

    const formatted = keys.map(k => ({
      ...k,
      key_token: `${k.key_token.substring(0, 8)}...${k.key_token.substring(k.key_token.length - 4)}`,
      permissions: JSON.parse(k.permissions || '[]')
    }));

    res.json({ success: true, keys: formatted });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Create API key
router.post('/', authenticate, async (req, res) => {
  try {
    const { description, permissions } = req.body;
    const keyToken = `mpk_${crypto.randomBytes(24).toString('hex')}`;
    const perms = Array.isArray(permissions) ? permissions : ['*'];

    const result = await query.run(
      'INSERT INTO api_keys (user_id, key_token, description, permissions) VALUES (?, ?, ?, ?)',
      [req.user.id, keyToken, description || 'Default API Token', JSON.stringify(perms)]
    );

    logActivity(req.user.id, null, 'API_KEY_CREATE', `Created API token: ${description}`, req);

    res.json({
      success: true,
      key: {
        id: result.lastID,
        key_token: keyToken, // Only returned once in full!
        description: description || 'Default API Token',
        permissions: perms
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Delete API key
router.delete('/:id', authenticate, async (req, res) => {
  try {
    const keyId = req.params.id;
    await query.run('DELETE FROM api_keys WHERE id = ? AND user_id = ?', [keyId, req.user.id]);
    logActivity(req.user.id, null, 'API_KEY_DELETE', `Deleted API token ID: ${keyId}`, req);
    res.json({ success: true, message: 'API key deleted.' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;

