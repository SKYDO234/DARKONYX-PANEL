const cron = require('node-cron');
const { query } = require('../database/db');
const runnerService = require('./runnerService');
const backupService = require('./backupService');

class ScheduleService {
  constructor() {
    this.cronJobs = new Map(); // scheduleId -> cron task
  }

  async initSchedules() {
    try {
      const schedules = await query.all('SELECT * FROM schedules WHERE is_active = 1');
      for (const sch of schedules) {
        this.registerSchedule(sch);
      }
      console.log(`⏱️ Initialized ${schedules.length} active schedules.`);
    } catch (err) {
      console.error('Failed to initialize schedules:', err.message);
    }
  }

  registerSchedule(schedule) {
    // Unregister if existing
    this.unregisterSchedule(schedule.id);

    if (!cron.validate(schedule.cron_expression)) {
      console.warn(`Invalid cron expression for schedule ${schedule.id}: ${schedule.cron_expression}`);
      return;
    }

    const task = cron.schedule(schedule.cron_expression, async () => {
      console.log(`⏱️ Executing schedule ${schedule.id} (${schedule.name}) for server ${schedule.server_id}...`);
      try {
        if (schedule.action_type === 'restart') {
          await runnerService.restartServer(schedule.server_id);
        } else if (schedule.action_type === 'start') {
          if (!runnerService.isServerRunning(schedule.server_id)) {
            await runnerService.startServer(schedule.server_id);
          }
        } else if (schedule.action_type === 'stop') {
          if (runnerService.isServerRunning(schedule.server_id)) {
            await runnerService.stopServer(schedule.server_id);
          }
        } else if (schedule.action_type === 'command') {
          if (schedule.payload && runnerService.isServerRunning(schedule.server_id)) {
            runnerService.sendCommand(schedule.server_id, schedule.payload);
          }
        } else if (schedule.action_type === 'backup') {
          await backupService.createBackup(schedule.server_id, `Scheduled Backup (${schedule.name})`);
        }

        await query.run('UPDATE schedules SET last_run_at = CURRENT_TIMESTAMP WHERE id = ?', [schedule.id]);
      } catch (err) {
        console.error(`Schedule execution error [${schedule.id}]:`, err.message);
      }
    });

    this.cronJobs.set(schedule.id, task);
  }

  unregisterSchedule(scheduleId) {
    if (this.cronJobs.has(scheduleId)) {
      const task = this.cronJobs.get(scheduleId);
      task.stop();
      this.cronJobs.delete(scheduleId);
    }
  }
}

module.exports = new ScheduleService();

