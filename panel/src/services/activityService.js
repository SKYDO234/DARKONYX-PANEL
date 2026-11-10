const { query } = require('../database/db');

async function logActivity(userId, serverId, action, details = '', req = null) {
  try {
    let ipAddress = '127.0.0.1';
    let userAgent = 'System / Internal';

    if (req) {
      ipAddress = req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '127.0.0.1';
      userAgent = req.headers['user-agent'] || 'Unknown';
    }

    await query.run(
      'INSERT INTO activity_logs (user_id, server_id, action, details, ip_address, user_agent) VALUES (?, ?, ?, ?, ?, ?)',
      [userId || null, serverId || null, action, typeof details === 'object' ? JSON.stringify(details) : String(details), ipAddress, userAgent]
    );
  } catch (err) {
    console.error('Failed to write activity log:', err.message);
  }
}

module.exports = { logActivity };

