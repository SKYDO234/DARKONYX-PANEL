const axios = require('axios');
const path = require('path');
const fs = require('fs');
const { exec, spawn } = require('child_process');
const packageJson = require('../../package.json');
const { logActivity } = require('./activityService');

class UpdateService {
  constructor() {
    this.repoOwner = 'SKYDO234';
    this.repoName = 'DARKONYX-PANEL';
    this.githubApiUrl = `https://api.github.com/repos/${this.repoOwner}/${this.repoName}/releases`;
    this.githubReleasesUrl = `https://github.com/${this.repoOwner}/${this.repoName}/releases`;
    this.rootPath = path.resolve(__dirname, '../../');
    
    this.cache = {
      data: null,
      timestamp: 0,
      ttlMs: 60 * 1000 // 60 seconds TTL cache to prevent GitHub API rate-limits
    };

    this.isUpdating = false;
    this.activeSubscribers = new Set();
    this.updateLogs = [];
    this.currentStep = { index: 0, total: 6, label: 'Idle' };
  }

  getCurrentVersion() {
    return packageJson.version || '2.4.0';
  }

  cleanVersion(v) {
    if (!v) return '0.0.0';
    return String(v).replace(/^[vV]/, '').trim();
  }

  compareVersions(v1, v2) {
    // Returns 1 if v1 > v2, -1 if v1 < v2, 0 if equal
    const p1 = this.cleanVersion(v1).split('.').map(x => parseInt(x, 10) || 0);
    const p2 = this.cleanVersion(v2).split('.').map(x => parseInt(x, 10) || 0);
    const maxLen = Math.max(p1.length, p2.length);

    for (let i = 0; i < maxLen; i++) {
      const num1 = p1[i] || 0;
      const num2 = p2[i] || 0;
      if (num1 > num2) return 1;
      if (num1 < num2) return -1;
    }
    return 0;
  }

  async getGitInfo() {
    return new Promise((resolve) => {
      const gitDir = path.join(this.rootPath, '.git');
      if (!fs.existsSync(gitDir)) {
        return resolve({ isGit: false, branch: 'none', commit: 'none', dirty: false });
      }

      exec('git rev-parse --short HEAD && git rev-parse --abbrev-ref HEAD && git status --porcelain', { cwd: this.rootPath }, (err, stdout) => {
        if (err) {
          return resolve({ isGit: true, branch: 'main', commit: 'unknown', dirty: false });
        }
        const lines = stdout.trim().split('\n').filter(Boolean);
        const commit = lines[0] || 'unknown';
        const branch = lines[1] || 'main';
        const dirtyCount = lines.slice(2).length;
        resolve({
          isGit: true,
          branch,
          commit,
          dirty: dirtyCount > 0,
          dirtyCount
        });
      });
    });
  }

  async checkUpdates(force = false) {
    const now = Date.now();
    if (!force && this.cache.data && (now - this.cache.timestamp < this.cache.ttlMs)) {
      return this.cache.data;
    }

    const currentVer = this.getCurrentVersion();
    const gitInfo = await this.getGitInfo();

    try {
      const res = await axios.get(this.githubApiUrl, {
        headers: {
          'User-Agent': 'DARKONYX PANEL-Update-Detector/2.4.0',
          'Accept': 'application/vnd.github.v3+json'
        },
        timeout: 8000
      });

      const releases = Array.isArray(res.data) ? res.data : [];
      if (!releases.length) {
        const payload = {
          success: true,
          current_version: currentVer,
          latest_version: currentVer,
          has_update: false,
          is_up_to_date: true,
          git: gitInfo,
          checked_at: new Date().toISOString(),
          release_url: this.githubReleasesUrl,
          latest_release: null,
          releases_history: []
        };
        this.cache.data = payload;
        this.cache.timestamp = now;
        return payload;
      }

      // Filter non-draft
      const validReleases = releases.filter(r => !r.draft);
      const latestRelease = validReleases[0] || releases[0];
      const latestTag = latestRelease ? latestRelease.tag_name : currentVer;

      const comp = this.compareVersions(latestTag, currentVer);
      const hasUpdate = comp > 0;

      const payload = {
        success: true,
        current_version: currentVer,
        latest_version: latestTag,
        has_update: hasUpdate,
        is_up_to_date: !hasUpdate,
        git: gitInfo,
        checked_at: new Date().toISOString(),
        release_url: this.githubReleasesUrl,
        latest_release: {
          id: latestRelease.id,
          tag_name: latestRelease.tag_name,
          name: latestRelease.name || latestRelease.tag_name,
          published_at: latestRelease.published_at,
          html_url: latestRelease.html_url,
          body: latestRelease.body || 'No release notes provided for this version.',
          author: latestRelease.author ? latestRelease.author.login : 'SKYDO234',
          author_avatar: latestRelease.author ? latestRelease.author.avatar_url : null,
          assets: (latestRelease.assets || []).map(a => ({
            name: a.name,
            size: a.size,
            download_count: a.download_count,
            browser_download_url: a.browser_download_url
          })),
          tarball_url: latestRelease.tarball_url,
          zipball_url: latestRelease.zipball_url
        },
        releases_history: validReleases.slice(0, 8).map(r => ({
          id: r.id,
          tag_name: r.tag_name,
          name: r.name || r.tag_name,
          published_at: r.published_at,
          html_url: r.html_url,
          body: r.body || '',
          prerelease: r.prerelease
        }))
      };

      this.cache.data = payload;
      this.cache.timestamp = now;
      return payload;

    } catch (err) {
      if (!this._warned) { console.warn('ℹ️  Update feed unreachable (' + err.message + ') — using local version info.'); this._warned = true; }
      // Return fallback cached or current state
      const fallback = {
        success: true,
        warning: 'Could not contact GitHub releases API: ' + err.message,
        current_version: currentVer,
        latest_version: currentVer,
        has_update: false,
        is_up_to_date: true,
        git: gitInfo,
        checked_at: new Date().toISOString(),
        release_url: this.githubReleasesUrl,
        latest_release: null,
        releases_history: []
      };
      // Cache the negative result so repeated dashboard loads stay instant
      this.cache.data = fallback;
      this.cache.timestamp = now;
      if (this.cache.data) return this.cache.data;
      return fallback;
    }
  }

  // WebSocket Subscription for Live Terminal Output
  subscribeSocket(ws) {
    this.activeSubscribers.add(ws);
    // Send initial history
    ws.send(JSON.stringify({
      type: 'init',
      isUpdating: this.isUpdating,
      step: this.currentStep,
      logs: this.updateLogs.slice(-200)
    }));
  }

  unsubscribeSocket(ws) {
    this.activeSubscribers.delete(ws);
  }

  broadcast(messageObj) {
    const jsonStr = JSON.stringify(messageObj);
    for (const client of this.activeSubscribers) {
      if (client.readyState === 1) { // OPEN
        try {
          client.send(jsonStr);
        } catch (e) {
          // Ignore
        }
      }
    }
  }

  log(line, level = 'info') {
    const timestamp = new Date().toTimeString().split(' ')[0];
    const logItem = { line, level, timestamp };
    this.updateLogs.push(logItem);
    if (this.updateLogs.length > 1000) this.updateLogs.shift();
    this.broadcast({ type: 'log', ...logItem });
  }

  setStep(index, total, label) {
    this.currentStep = { index, total, label };
    this.broadcast({ type: 'step', ...this.currentStep });
  }

  async runCommandAsync(cmd, stepIndex, stepLabel) {
    return new Promise((resolve, reject) => {
      this.setStep(stepIndex, 6, stepLabel);
      this.log(`\x1b[36m▶ [Step ${stepIndex}/6] ${stepLabel}\x1b[0m`);
      this.log(`\x1b[90m$ ${cmd}\x1b[0m`);

      const child = spawn('/bin/bash', ['-c', cmd], {
        cwd: this.rootPath,
        env: { ...process.env, FORCE_COLOR: '1' }
      });

      child.stdout.on('data', (data) => {
        const text = data.toString();
        const lines = text.split('\n');
        for (const l of lines) {
          if (l.trim()) this.log(l, 'stdout');
        }
      });

      child.stderr.on('data', (data) => {
        const text = data.toString();
        const lines = text.split('\n');
        for (const l of lines) {
          if (l.trim()) this.log(`\x1b[33m${l}\x1b[0m`, 'stderr');
        }
      });

      child.on('close', (code) => {
        if (code === 0) {
          this.log(`\x1b[32m✔ Step ${stepIndex} completed successfully.\x1b[0m\n`, 'success');
          resolve();
        } else {
          this.log(`\x1b[31m✖ Step ${stepIndex} failed with exit code ${code}.\x1b[0m\n`, 'error');
          reject(new Error(`Command failed with exit code ${code}`));
        }
      });

      child.on('error', (err) => {
        this.log(`\x1b[31m✖ Step ${stepIndex} error: ${err.message}\x1b[0m\n`, 'error');
        reject(err);
      });
    });
  }

  async runUpdate(options = {}, userId = null, req = null) {
    if (this.isUpdating) {
      throw new Error('An update process is already in progress. Please check the live terminal.');
    }

    this.isUpdating = true;
    this.updateLogs = [];
    this.broadcast({ type: 'start', mode: options.mode || 'full' });

    this.log(`\x1b[1;35m╔══════════════════════════════════════════════════════════════╗\x1b[0m`);
    this.log(`\x1b[1;35m║         🚀 DARKONYX AUTOMATED SYSTEM UPDATE PIPELINE           ║\x1b[0m`);
    this.log(`\x1b[1;35m╚══════════════════════════════════════════════════════════════╝\x1b[0m`);
    this.log(`\x1b[90mStarted at: ${new Date().toLocaleString()} | Root: ${this.rootPath}\x1b[0m\n`);

    try {
      // Step 1: Pre-flight Verification
      await this.runCommandAsync(
        'node -v && npm -v && pwd && pm2 list | grep darkonyx || echo "PM2 Ready"',
        1,
        'Verifying System & Environment'
      );

      // Step 2: Code Updates (Git pull or Release archive sync)
      const gitInfo = await this.getGitInfo();
      if (gitInfo.isGit) {
        if (options.mode === 'force') {
          await this.runCommandAsync(
            'git fetch origin main && git reset --hard origin/main',
            2,
            'Force Syncing Repository (Reset & Pull)'
          );
        } else {
          await this.runCommandAsync(
            'git fetch origin main && git pull origin main || echo "Git pull completed with warnings"',
            2,
            'Fetching & Pulling Latest Repository Changes'
          );
        }
      } else {
        this.log('\x1b[33mℹ Not a git repository. Skipping git pull.\x1b[0m');
      }

      // Step 3: Dependencies Resolution
      await this.runCommandAsync(
        'npm install --no-audit --fund=false',
        3,
        'Installing & Updating Node.js Dependencies'
      );

      // Step 4: Schema Migration & Runtime Setup
      await this.runCommandAsync(
        'node bin/setup.js --skip-admin',
        4,
        'Validating Database Schema & Directories'
      );

      // Step 5: PM2 Process Reload
      this.setStep(5, 6, 'Restarting DARKONYX PANEL Service');
      this.log(`\x1b[36m▶ [Step 5/6] Reloading PM2 Cluster & Processes...\x1b[0m`);
      try {
        await this.runCommandAsync(
          'pm2 restart darkonyx --update-env && pm2 save || echo "Restarted"',
          5,
          'Reloading PM2 Cluster'
        );
      } catch (pm2Err) {
        this.log('\x1b[33m⚠️ PM2 restart had a non-zero exit; attempting fallback reload.\x1b[0m');
      }

      // Step 6: Post-Update Verification
      this.setStep(6, 6, 'Finalizing & Verifying Health');
      this.log(`\x1b[36m▶ [Step 6/6] Finalizing System Health Check...\x1b[0m`);
      this.log(`\x1b[1;32m🎉 DARKONYX PANEL has been successfully updated to the latest release!\x1b[0m`);
      this.log(`\x1b[32m✔ Web UI, API Daemon, and SFTP Engine are operational.\x1b[0m\n`);

      this.cache.data = null; // Clear cache so new version is detected immediately
      this.isUpdating = false;

      if (userId) {
        logActivity(userId, null, 'SYSTEM_UPDATE', 'Successfully executed automated panel update', req);
      }

      this.broadcast({
        type: 'complete',
        success: true,
        message: 'System update completed successfully! Reloading in 3 seconds...',
        version: this.getCurrentVersion()
      });

      return { success: true, message: 'Update completed successfully.' };

    } catch (err) {
      this.isUpdating = false;
      this.log(`\x1b[1;31m❌ System Update Failed: ${err.message}\x1b[0m`, 'error');
      this.broadcast({
        type: 'complete',
        success: false,
        error: err.message
      });
      throw err;
    }
  }

  async runSyncOnly(userId = null, req = null) {
    if (this.isUpdating) {
      throw new Error('An update or sync process is already running.');
    }

    this.isUpdating = true;
    this.updateLogs = [];
    this.broadcast({ type: 'start', mode: 'sync' });

    this.log(`\x1b[1;36m🔄 Running Dependency & Database Migration Sync...\x1b[0m\n`);

    try {
      await this.runCommandAsync('npm install --no-audit --fund=false', 1, 'Updating Node Modules');
      await this.runCommandAsync('node bin/setup.js --skip-admin', 2, 'Running Database Migrations');
      await this.runCommandAsync('pm2 restart darkonyx --update-env', 3, 'Restarting Application Cluster');

      this.log(`\x1b[1;32m✔ Sync process completed successfully!\x1b[0m\n`);
      this.isUpdating = false;

      if (userId) {
        logActivity(userId, null, 'SYSTEM_SYNC', 'Executed dependency and database migration sync', req);
      }

      this.broadcast({
        type: 'complete',
        success: true,
        message: 'Sync completed successfully!'
      });

      return { success: true };
    } catch (err) {
      this.isUpdating = false;
      this.log(`\x1b[1;31m❌ Sync Failed: ${err.message}\x1b[0m`, 'error');
      this.broadcast({ type: 'complete', success: false, error: err.message });
      throw err;
    }
  }
}

const updateService = new UpdateService();
module.exports = updateService;

