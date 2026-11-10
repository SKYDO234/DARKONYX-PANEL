const express = require('express');
const router = express.Router({ mergeParams: true });
const cron = require('node-cron');
const scheduleService = require('../services/scheduleService');
const { authenticate, requireServerAccess } = require('../middleware/auth');
const { logActivity } = require('../services/activityService');
const { query } = require('../database/db');

// List schedules
router.get('/', authenticate, requireServerAccess('schedules.read'), async (req, res) => {
  try {
    const serverId = req.params.serverId;
    const schedules = await query.all('SELECT * FROM schedules WHERE server_id = ? ORDER BY id DESC', [serverId]);
    res.json({ success: true, schedules });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Create schedule
router.post('/', authenticate, requireServerAccess('schedules.create'), async (req, res) => {
  try {
    const serverId = req.params.serverId;
    const { name, cron_expression, action_type, payload } = req.body;

    if (!name || !cron_expression || !action_type) {
      return res.status(400).json({ success: false, error: 'Name, cron expression, and action type are required.' });
    }

    if (!cron.validate(cron_expression)) {
      return res.status(400).json({ success: false, error: 'Invalid standard 5-part cron expression (e.g. 0 0 * * *).' });
    }

    const result = await query.run(`
      INSERT INTO schedules (server_id, name, cron_expression, action_type, payload, is_active)
      VALUES (?, ?, ?, ?, ?, 1)
    `, [serverId, name, cron_expression, action_type, payload || '']);

    const newSchedule = await query.get('SELECT * FROM schedules WHERE id = ?', [result.lastID]);
    scheduleService.registerSchedule(newSchedule);

    logActivity(req.user.id, serverId, 'SCHEDULE_CREATE', `Created schedule: ${name}`, req);

    res.json({ success: true, schedule: newSchedule });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Update / Toggle schedule
router.put('/:scheduleId', authenticate, requireServerAccess('schedules.create'), async (req, res) => {
  try {
    const { serverId, scheduleId } = req.params;
    const { name, cron_expression, action_type, payload, is_active } = req.body;

    const current = await query.get('SELECT * FROM schedules WHERE id = ? AND server_id = ?', [scheduleId, serverId]);
    if (!current) {
      return res.status(404).json({ success: false, error: 'Schedule not found.' });
    }

    const newName = name || current.name;
    const newCron = cron_expression || current.cron_expression;
    const newAction = action_type || current.action_type;
    const newPayload = payload !== undefined ? payload : current.payload;
    const newActive = is_active !== undefined ? (is_active ? 1 : 0) : current.is_active;

    if (!cron.validate(newCron)) {
      return res.status(400).json({ success: false, error: 'Invalid cron expression.' });
    }

    await query.run(`
      UPDATE schedules SET
        name = ?,
        cron_expression = ?,
        action_type = ?,
        payload = ?,
        is_active = ?
      WHERE id = ?
    `, [newName, newCron, newAction, newPayload, newActive, scheduleId]);

    const updated = await query.get('SELECT * FROM schedules WHERE id = ?', [scheduleId]);
    if (updated.is_active) {
      scheduleService.registerSchedule(updated);
    } else {
      scheduleService.unregisterSchedule(updated.id);
    }

    logActivity(req.user.id, serverId, 'SCHEDULE_UPDATE', `Updated schedule: ${newName}`, req);

    res.json({ success: true, schedule: updated });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Delete schedule
router.delete('/:scheduleId', authenticate, requireServerAccess('schedules.delete'), async (req, res) => {
  try {
    const { serverId, scheduleId } = req.params;
    scheduleService.unregisterSchedule(parseInt(scheduleId, 10));
    await query.run('DELETE FROM schedules WHERE id = ? AND server_id = ?', [scheduleId, serverId]);

    logActivity(req.user.id, serverId, 'SCHEDULE_DELETE', `Deleted schedule ID: ${scheduleId}`, req);

    res.json({ success: true, message: 'Schedule deleted successfully.' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;

