const cron = require('node-cron');
const fs = require('fs');
const { query } = require('../database/db');
const backupService = require('./backupService');
const { logActivity } = require('./activityService');

class AutoBackupService {
  constructor() {
    this.cronTask = null;
    this.isRunning = false;
  }

  /**
   * Initialize cron job on server startup
   */
  async initAutoBackupCron() {
    try {
      const enabled = await query.get("SELECT `value` FROM settings WHERE `key` = 'autobackups_enabled'");
      if (enabled && enabled.value === '0') {
        console.log('🛑 AutoBackups is disabled in settings.');
        return;
      }

      const runAt = await query.get("SELECT `value` FROM settings WHERE `key` = 'autobackups_run_at'");
      const timeStr = (runAt && runAt.value) ? runAt.value.trim() : '02:00';
      this.rescheduleCron(timeStr);
    } catch (err) {
      console.error('Failed to initialize AutoBackups cron:', err.message);
    }
  }

  /**
   * Reschedule node-cron task based on HH:mm string
   */
  rescheduleCron(timeStr) {
    if (this.cronTask) {
      this.cronTask.stop();
      this.cronTask = null;
    }

    const parts = (timeStr || '02:00').split(':');
    const hour = parseInt(parts[0], 10) || 0;
    const minute = parseInt(parts[1], 10) || 0;
    const cronExpr = `${minute} ${hour} * * *`;

    if (!cron.validate(cronExpr)) {
      console.warn(`[AutoBackups] Invalid cron expression generated: ${cronExpr}`);
      return;
    }

    this.cronTask = cron.schedule(cronExpr, async () => {
      console.log(`⏱️ [AutoBackups] Daily scheduled run triggered at ${new Date().toISOString()}`);
      try {
        await this.executeAutoBackups();
      } catch (err) {
        console.error('❌ [AutoBackups] Scheduled execution failed:', err.message);
      }
    });

    console.log(`⏱️ [AutoBackups] Scheduled daily automatic backups for ${timeStr} (cron: "${cronExpr}")`);
  }

  /**
   * Execute AutoBackups across all eligible servers
   */
  async executeAutoBackups(triggeredByUserId = null) {
    if (this.isRunning) {
      return { success: false, error: 'AutoBackups job is currently in progress.' };
    }

    this.isRunning = true;
    const startTime = Date.now();
    const results = {
      totalServers: 0,
      created: 0,
      failed: 0,
      pruned: 0,
      errors: []
    };

    try {
      // 1. Load settings
      const settingsRows = await query.all("SELECT `key`, `value` FROM settings WHERE `key` LIKE 'autobackups_%'");
      const settings = {};
      for (const r of settingsRows) {
        settings[r.key] = r.value;
      }

      const isEnabled = settings.autobackups_enabled !== '0';
      if (!isEnabled && !triggeredByUserId) {
        this.isRunning = false;
        return { success: false, message: 'AutoBackups is currently disabled.' };
      }

      const daysToStore = parseInt(settings.autobackups_days || '7', 10);
      const weeksToStore = parseInt(settings.autobackups_weeks || '4', 10);
      const monthsToStore = parseInt(settings.autobackups_months || '3', 10);
      const nameTemplate = settings.autobackups_name || 'Automatic Backup [DATE]';

      let excludedNodes = [];
      try {
        excludedNodes = JSON.parse(settings.autobackups_excluded_nodes || '[]');
      } catch (e) {
        excludedNodes = [];
      }

      // Format date for backup name
      const now = new Date();
      const dateStr = now.toISOString().slice(0, 10); // YYYY-MM-DD
      const backupName = nameTemplate.replace(/\[DATE\]/g, dateStr);

      // 2. Query all active servers
      const servers = await query.all('SELECT id, name, node_id FROM servers');
      results.totalServers = servers.length;

      for (const server of servers) {
        // Check if server is on an excluded node
        if (server.node_id && excludedNodes.includes(Number(server.node_id))) {
          continue;
        }

        // A. Create Automatic Backup
        try {
          await backupService.createBackup(server.id, backupName, { isAutomatic: 1 });
          results.created++;
        } catch (err) {
          results.failed++;
          results.errors.push({ serverId: server.id, serverName: server.name, error: err.message });
          console.error(`[AutoBackups] Failed to create backup for #${server.id} (${server.name}):`, err.message);
        }

        // B. Prune Expired Automatic Backups according to retention policy
        try {
          const prunedCount = await this.pruneServerBackups(server.id, {
            days: daysToStore,
            weeks: weeksToStore,
            months: monthsToStore
          });
          results.pruned += prunedCount;
        } catch (err) {
          console.error(`[AutoBackups] Retention pruning error for server #${server.id}:`, err.message);
        }
      }

      const durationSec = Math.round((Date.now() - startTime) / 1000);
      const statusSummary = `Finished in ${durationSec}s. Created: ${results.created}, Pruned: ${results.pruned}, Failed: ${results.failed}`;

      // Update settings with last run info
      const nowIso = new Date().toISOString();
      await query.run("UPDATE settings SET `value` = ? WHERE `key` = 'autobackups_last_run'", [nowIso]);
      await query.run("UPDATE settings SET `value` = ? WHERE `key` = 'autobackups_last_status'", [statusSummary]);

      if (triggeredByUserId) {
        await logActivity(triggeredByUserId, null, 'AUTOBACKUP_MANUAL_RUN', statusSummary);
      }

      console.log(`✅ [AutoBackups] Run complete: ${statusSummary}`);
      return {
        success: true,
        summary: statusSummary,
        results
      };
    } finally {
      this.isRunning = false;
    }
  }

  /**
   * Prune automatic backups for a server based on Days, Weeks, Months retention
   *
   * Logic:
   * 1. Days: Keep every automatic backup within the last `days` days.
   * 2. Weeks: Keep the 1st backup of each week in the last `weeks` weeks (before the days window).
   * 3. Months: Keep the 1st backup of each month in the last `months` months (before the weeks window).
   * 4. Any automatic backup outside these windows (and NOT locked) is deleted.
   */
  async pruneServerBackups(serverId, policy) {
    const { days, weeks, months } = policy;
    const now = Date.now();
    const MS_PER_DAY = 24 * 60 * 60 * 1000;
    const MS_PER_WEEK = 7 * MS_PER_DAY;

    // Get all automatic backups for this server ordered newest to oldest
    const autoBackups = await query.all(
      'SELECT id, name, path, is_locked, created_at FROM backups WHERE server_id = ? AND is_automatic = 1 ORDER BY created_at DESC',
      [serverId]
    );

    if (!autoBackups || autoBackups.length === 0) return 0;

    // Calculate boundary timestamps
    const daysLimitMs = now - (Math.max(0, days) * MS_PER_DAY);
    const weeksLimitMs = daysLimitMs - (Math.max(0, weeks) * MS_PER_WEEK);
    const monthsLimitMs = weeksLimitMs - (Math.max(0, months) * 30 * MS_PER_DAY);

    const keepIds = new Set();
    const weekBuckets = new Map();  // weekKey -> earliest backup
    const monthBuckets = new Map(); // monthKey -> earliest backup

    for (const b of autoBackups) {
      const bTime = new Date(b.created_at).getTime();

      // Rule: Locked backups are ALWAYS preserved
      if (b.is_locked) {
        keepIds.add(b.id);
        continue;
      }

      // 1. Within Days window: keep ALL
      if (days > 0 && bTime >= daysLimitMs) {
        keepIds.add(b.id);
        continue;
      }

      // 2. Within Weeks window: keep 1st backup per week
      if (weeks > 0 && bTime >= weeksLimitMs && bTime < daysLimitMs) {
        const bDate = new Date(b.created_at);
        // Calculate year + week number
        const startOfYear = new Date(bDate.getFullYear(), 0, 1);
        const weekNum = Math.ceil((((bDate - startOfYear) / MS_PER_DAY) + startOfYear.getDay() + 1) / 7);
        const weekKey = `${bDate.getFullYear()}-W${weekNum}`;

        if (!weekBuckets.has(weekKey)) {
          weekBuckets.set(weekKey, b);
          keepIds.add(b.id);
        }
        continue;
      }

      // 3. Within Months window: keep 1st backup per month
      if (months > 0 && bTime >= monthsLimitMs && bTime < weeksLimitMs) {
        const bDate = new Date(b.created_at);
        const monthKey = `${bDate.getFullYear()}-${String(bDate.getMonth() + 1).padStart(2, '0')}`;

        if (!monthBuckets.has(monthKey)) {
          monthBuckets.set(monthKey, b);
          keepIds.add(b.id);
        }
        continue;
      }
    }

    // Delete backups that are not kept and not locked
    let deletedCount = 0;
    for (const b of autoBackups) {
      if (!keepIds.has(b.id) && !b.is_locked) {
        try {
          if (b.path && fs.existsSync(b.path)) {
            fs.unlinkSync(b.path);
          }
          await query.run('DELETE FROM backups WHERE id = ?', [b.id]);
          deletedCount++;
        } catch (err) {
          console.error(`[AutoBackups] Error deleting expired backup #${b.id}:`, err.message);
        }
      }
    }

    return deletedCount;
  }

  /**
   * Get AutoBackups status, settings, and statistics
   */
  async getStatus() {
    const settingsRows = await query.all("SELECT `key`, `value` FROM settings WHERE `key` LIKE 'autobackups_%'");
    const settings = {};
    for (const r of settingsRows) {
      settings[r.key] = r.value;
    }

    const stats = await query.get(
      'SELECT COUNT(id) as total_count, COALESCE(SUM(file_size), 0) as total_size FROM backups WHERE is_automatic = 1'
    );

    const eligibleServers = await query.get('SELECT COUNT(id) as c FROM servers');
    const nodes = await query.all('SELECT id, name FROM nodes ORDER BY name ASC');

    return {
      settings: {
        enabled: settings.autobackups_enabled !== '0',
        run_at: settings.autobackups_run_at || '02:00',
        days: parseInt(settings.autobackups_days || '7', 10),
        weeks: parseInt(settings.autobackups_weeks || '4', 10),
        months: parseInt(settings.autobackups_months || '3', 10),
        name: settings.autobackups_name || 'Automatic Backup [DATE]',
        excluded_nodes: JSON.parse(settings.autobackups_excluded_nodes || '[]'),
        last_run: settings.autobackups_last_run || null,
        last_status: settings.autobackups_last_status || 'Idle'
      },
      stats: {
        total_backups: stats ? stats.total_count : 0,
        total_bytes: stats ? stats.total_size : 0,
        eligible_servers: eligibleServers ? eligibleServers.c : 0
      },
      nodes: nodes || [],
      is_running: this.isRunning
    };
  }

  /**
   * Update settings and reschedule cron if needed
   */
  async updateSettings(updates) {
    const allowed = [
      'autobackups_enabled',
      'autobackups_run_at',
      'autobackups_days',
      'autobackups_weeks',
      'autobackups_months',
      'autobackups_name',
      'autobackups_excluded_nodes'
    ];

    for (const [k, v] of Object.entries(updates)) {
      if (allowed.includes(k)) {
        const valStr = typeof v === 'object' ? JSON.stringify(v) : String(v);
        await query.run(
          'INSERT INTO settings (`key`, `value`, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP) ON DUPLICATE KEY UPDATE `value` = VALUES(`value`), updated_at = CURRENT_TIMESTAMP',
          [k, valStr]
        );
      }
    }

    // If run_at or enabled changed, reschedule
    if (updates.autobackups_run_at || updates.autobackups_enabled !== undefined) {
      const isEnabled = updates.autobackups_enabled !== undefined
        ? updates.autobackups_enabled !== '0' && updates.autobackups_enabled !== false
        : true;

      if (!isEnabled) {
        if (this.cronTask) {
          this.cronTask.stop();
          this.cronTask = null;
        }
      } else {
        const timeStr = updates.autobackups_run_at || '02:00';
        this.rescheduleCron(timeStr);
      }
    }

    return this.getStatus();
  }
}

module.exports = new AutoBackupService();
