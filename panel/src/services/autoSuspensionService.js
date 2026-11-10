const { query } = require('../database/db');
const runnerService = require('./runnerService');
const { logActivity } = require('./activityService');

class AutoSuspensionService {
  constructor() {
    this.interval = null;
  }

  init() {
    console.log('⏰ Initializing SAGA Auto Suspension Service...');
    // Run an immediate check on startup
    this.checkExpiredServers().catch(err => {
      console.error('Auto suspension initial check error:', err.message);
    });

    // Check every 60 seconds
    this.interval = setInterval(() => {
      this.checkExpiredServers().catch(err => {
        console.error('Auto suspension periodic check error:', err.message);
      });
    }, 60 * 1000);
  }

  async checkExpiredServers() {
    try {
      const expiredServers = await query.all(`
        SELECT id, name, expiration_date, is_suspended, status
        FROM servers
        WHERE expiration_date IS NOT NULL
          AND expiration_date <= NOW()
          AND is_suspended = 0
      `);

      if (!expiredServers || expiredServers.length === 0) {
        return;
      }

      console.log(`[AutoSuspension] Found ${expiredServers.length} expired servers to suspend.`);

      for (const server of expiredServers) {
        try {
          await this.suspendServer(server.id, `Server expired on ${server.expiration_date}`);
          console.log(`[AutoSuspension] Successfully suspended server ${server.name} (ID: ${server.id})`);
        } catch (err) {
          console.error(`[AutoSuspension] Failed to suspend server ${server.id}:`, err.message);
        }
      }
    } catch (err) {
      console.error('[AutoSuspension] checkExpiredServers error:', err.message);
    }
  }

  async suspendServer(serverId, reason = 'Automated suspension due to expiration') {
    // 1. Force stop running process or container
    try {
      if (runnerService.isServerRunning(serverId)) {
        await runnerService.stopServer(serverId);
      }
    } catch (e) {
      console.warn(`[AutoSuspension] Warning stopping server ${serverId}:`, e.message);
    }

    // 2. Mark as suspended in DB
    await query.run(`
      UPDATE servers
      SET is_suspended = 1, status = 'suspended', updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `, [serverId]);

    // 3. Broadcast status update to websockets
    try {
      runnerService.broadcast(serverId, { type: 'status', status: 'suspended' });
    } catch (e) {}

    // 4. Log activity
    logActivity(null, serverId, 'SERVER_AUTO_SUSPENDED', reason, null);

    return { success: true, message: `Server ${serverId} suspended.` };
  }

  async unsuspendServer(serverId) {
    await query.run(`
      UPDATE servers
      SET is_suspended = 0, status = 'offline', updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `, [serverId]);

    try {
      runnerService.broadcast(serverId, { type: 'status', status: 'offline' });
    } catch (e) {}
    logActivity(null, serverId, 'SERVER_UNSUSPENDED', 'Server manually unsuspended by administrator', null);

    return { success: true, message: `Server ${serverId} unsuspended.` };
  }

  async setServerExpiration(serverId, expirationDate) {
    await query.run(`
      UPDATE servers
      SET expiration_date = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `, [expirationDate, serverId]);

    // If renewed and expiration is now in the future, automatically unsuspend if it was suspended
    if (expirationDate) {
      const expTime = new Date(expirationDate).getTime();
      if (expTime > Date.now()) {
        const s = await query.get('SELECT is_suspended FROM servers WHERE id = ?', [serverId]);
        if (s && s.is_suspended) {
          await this.unsuspendServer(serverId);
        }
      }
    }

    return { success: true };
  }
}

module.exports = new AutoSuspensionService();
