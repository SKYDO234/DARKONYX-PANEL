const express = require('express');
const router = express.Router();
const { query } = require('../database/db');
const { authenticate, requireAdmin } = require('../middleware/auth');
const { logActivity } = require('../services/activityService');

// List Locations
router.get('/', authenticate, async (req, res) => {
  try {
    const locations = await query.all(`
      SELECT l.*, COUNT(n.id) as node_count
      FROM locations l
      LEFT JOIN nodes n ON n.location_id = l.id
      GROUP BY l.id
      ORDER BY l.id ASC
    `);
    res.json({ success: true, locations });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Create Location
router.post('/', authenticate, requireAdmin, async (req, res) => {
  try {
    const { short_code, name, description } = req.body;
    if (!short_code || !name) {
      return res.status(400).json({ success: false, error: 'Short code and name are required.' });
    }

    const existing = await query.get('SELECT id FROM locations WHERE short_code = ?', [short_code]);
    if (existing) {
      return res.status(400).json({ success: false, error: 'Location short code already exists.' });
    }

    const result = await query.run(
      'INSERT INTO locations (short_code, name, description) VALUES (?, ?, ?)',
      [short_code, name, description || '']
    );

    logActivity(req.user.id, null, 'LOCATION_CREATE', `Created location: ${name} (${short_code})`, req);

    res.json({ success: true, locationId: result.lastID, message: 'Location created successfully.' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Edit Location
router.put('/:id', authenticate, requireAdmin, async (req, res) => {
  try {
    const locationId = req.params.id;
    const { short_code, name, description } = req.body;

    await query.run(
      'UPDATE locations SET short_code = ?, name = ?, description = ? WHERE id = ?',
      [short_code, name, description || '', locationId]
    );

    logActivity(req.user.id, null, 'LOCATION_UPDATE', `Updated location ID: ${locationId}`, req);

    res.json({ success: true, message: 'Location updated.' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Delete Location
router.delete('/:id', authenticate, requireAdmin, async (req, res) => {
  try {
    const locationId = req.params.id;
    await query.run('DELETE FROM locations WHERE id = ?', [locationId]);
    logActivity(req.user.id, null, 'LOCATION_DELETE', `Deleted location ID: ${locationId}`, req);
    res.json({ success: true, message: 'Location deleted.' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;

