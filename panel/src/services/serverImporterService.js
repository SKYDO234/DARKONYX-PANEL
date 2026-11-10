const fs = require('fs');
const path = require('path');
const { Client } = require('ssh2');
const config = require('../config/config');
const { query } = require('../database/db');
const { logActivity } = require('./activityService');
const https = require('https');
const http = require('http');
const unzipper = require('unzipper');

class ServerImporterService {
  constructor() {
    this.activeJobs = new Map(); // serverId -> job status
  }

  getJob(serverId) {
    return this.activeJobs.get(parseInt(serverId, 10)) || { status: 'idle', logs: [], progress: 0 };
  }

  addLog(serverId, message) {
    const sId = parseInt(serverId, 10);
    const job = this.activeJobs.get(sId) || { status: 'running', logs: [], progress: 0 };
    const timestamp = new Date().toLocaleTimeString();
    job.logs.push(`[${timestamp}] ${message}`);
    if (job.logs.length > 200) job.logs.shift();
    this.activeJobs.set(sId, job);
  }

  // Test remote SFTP connection
  async testConnection({ host, port = 22, username, password }) {
    return new Promise((resolve) => {
      const conn = new Client();
      let settled = false;

      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          try { conn.end(); } catch (e) {}
          resolve({ success: false, error: 'Connection timed out after 10 seconds.' });
        }
      }, 10000);

      conn.on('ready', () => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          conn.end();
          resolve({ success: true, message: 'Successfully connected to remote SFTP server!' });
        }
      });

      conn.on('error', (err) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve({ success: false, error: err.message || 'Failed to connect.' });
        }
      });

      try {
        conn.connect({
          host,
          port: parseInt(port, 10) || 22,
          username,
          password,
          readyTimeout: 9000
        });
      } catch (e) {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve({ success: false, error: e.message });
        }
      }
    });
  }

  // Import via SFTP
  async startSftpImport(serverId, { host, port = 22, username, password, remotePath = '/', wipeTarget = false }) {
    const sId = parseInt(serverId, 10);
    const targetDir = path.join(config.SERVERS_DIR, `server${sId}`);

    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
    }

    if (wipeTarget) {
      this.addLog(sId, 'Wiping current server directory before import...');
      const files = fs.readdirSync(targetDir);
      for (const f of files) {
        fs.rmSync(path.join(targetDir, f), { recursive: true, force: true });
      }
    }

    this.activeJobs.set(sId, {
      status: 'transferring',
      logs: [`[${new Date().toLocaleTimeString()}] Initializing SFTP connection to ${host}:${port}...`],
      progress: 0,
      totalFiles: 0,
      transferredFiles: 0
    });

    const conn = new Client();

    return new Promise((resolve, reject) => {
      conn.on('ready', () => {
        this.addLog(sId, `SFTP authentication successful for ${username}@${host}`);
        conn.sftp(async (err, sftp) => {
          if (err) {
            this.addLog(sId, `SFTP subsystem error: ${err.message}`);
            conn.end();
            this.activeJobs.set(sId, { status: 'failed', logs: this.getJob(sId).logs, error: err.message });
            return reject(err);
          }

          try {
            this.addLog(sId, `Starting recursive transfer from remote path: ${remotePath}`);
            await this.downloadSftpRecursive(sftp, remotePath, targetDir, sId);
            this.addLog(sId, '🎉 Server import completed successfully! All files synchronized.');
            const curJob = this.getJob(sId);
            this.activeJobs.set(sId, { ...curJob, status: 'completed', progress: 100 });
            conn.end();
            resolve({ success: true });
          } catch (importErr) {
            this.addLog(sId, `Import error: ${importErr.message}`);
            conn.end();
            const curJob = this.getJob(sId);
            this.activeJobs.set(sId, { ...curJob, status: 'failed', error: importErr.message });
            reject(importErr);
          }
        });
      });

      conn.on('error', (err) => {
        this.addLog(sId, `Connection error: ${err.message}`);
        this.activeJobs.set(sId, { status: 'failed', logs: this.getJob(sId).logs, error: err.message });
        reject(err);
      });

      try {
        conn.connect({
          host,
          port: parseInt(port, 10) || 22,
          username,
          password,
          readyTimeout: 15000
        });
      } catch (e) {
        this.addLog(sId, `Connect exception: ${e.message}`);
        this.activeJobs.set(sId, { status: 'failed', logs: this.getJob(sId).logs, error: e.message });
        reject(e);
      }
    });
  }

  async downloadSftpRecursive(sftp, remoteDir, localDir, serverId) {
    return new Promise((resolve, reject) => {
      sftp.readdir(remoteDir, async (err, list) => {
        if (err) return reject(err);

        for (const item of list) {
          if (item.filename === '.' || item.filename === '..') continue;

          const remoteItemPath = path.posix.join(remoteDir, item.filename);
          const localItemPath = path.join(localDir, item.filename);

          if (item.longname && item.longname.startsWith('d')) {
            // Directory
            if (!fs.existsSync(localItemPath)) {
              fs.mkdirSync(localItemPath, { recursive: true });
            }
            await this.downloadSftpRecursive(sftp, remoteItemPath, localItemPath, serverId);
          } else {
            // File
            await new Promise((resFile, rejFile) => {
              this.addLog(serverId, `Downloading ${item.filename} (${(item.attrs.size / 1024).toFixed(1)} KB)...`);
              sftp.fastGet(remoteItemPath, localItemPath, (getErr) => {
                if (getErr) {
                  this.addLog(serverId, `Warning: Failed to fetch ${item.filename}: ${getErr.message}`);
                } else {
                  const job = this.getJob(serverId);
                  job.transferredFiles = (job.transferredFiles || 0) + 1;
                }
                resFile();
              });
            });
          }
        }
        resolve();
      });
    });
  }

  // Import from Direct Zip / Archive URL
  async startUrlImport(serverId, { url, wipeTarget = false }) {
    const sId = parseInt(serverId, 10);
    const targetDir = path.join(config.SERVERS_DIR, `server${sId}`);

    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
    }

    if (wipeTarget) {
      this.addLog(sId, 'Wiping current server directory before import...');
      const files = fs.readdirSync(targetDir);
      for (const f of files) {
        fs.rmSync(path.join(targetDir, f), { recursive: true, force: true });
      }
    }

    this.activeJobs.set(sId, {
      status: 'transferring',
      logs: [`[${new Date().toLocaleTimeString()}] Downloading archive from ${url}...`],
      progress: 0
    });

    const client = url.startsWith('https') ? https : http;

    return new Promise((resolve, reject) => {
      client.get(url, (response) => {
        if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
          // Redirect
          return this.startUrlImport(serverId, { url: response.headers.location, wipeTarget: false })
            .then(resolve).catch(reject);
        }

        if (response.statusCode !== 200) {
          const err = new Error(`HTTP ${response.statusCode}: ${response.statusMessage}`);
          this.addLog(sId, `Failed to download: ${err.message}`);
          this.activeJobs.set(sId, { status: 'failed', logs: this.getJob(sId).logs, error: err.message });
          return reject(err);
        }

        this.addLog(sId, 'Archive stream opened. Extracting files directly into server folder...');

        response.pipe(unzipper.Extract({ path: targetDir }))
          .on('close', () => {
            this.addLog(sId, '🎉 Archive extracted successfully! All files imported.');
            const curJob = this.getJob(sId);
            this.activeJobs.set(sId, { ...curJob, status: 'completed', progress: 100 });
            resolve({ success: true });
          })
          .on('error', (err) => {
            this.addLog(sId, `Extraction error: ${err.message}`);
            this.activeJobs.set(sId, { status: 'failed', logs: this.getJob(sId).logs, error: err.message });
            reject(err);
          });
      }).on('error', (err) => {
        this.addLog(sId, `Download error: ${err.message}`);
        this.activeJobs.set(sId, { status: 'failed', logs: this.getJob(sId).logs, error: err.message });
        reject(err);
      });
    });
  }
}

module.exports = new ServerImporterService();
