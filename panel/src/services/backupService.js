const fs = require('fs');
const path = require('path');
const archiver = require('archiver');
const unzipper = require('unzipper');
const config = require('../config/config');
const { query } = require('../database/db');

class BackupService {
  async createBackup(serverId, backupName = 'Manual Backup', options = {}) {
    const sId = Number(serverId);
    const isAutomatic = options.isAutomatic ? 1 : 0;
    const serverDir = path.join(config.SERVERS_DIR, `server${sId}`);
    if (!fs.existsSync(serverDir)) {
      fs.mkdirSync(serverDir, { recursive: true });
    }

    const timestamp = Date.now();
    const fileName = `backup_${sId}_${timestamp}.zip`;
    const destPath = path.join(config.BACKUPS_DIR, fileName);

    await new Promise((resolve, reject) => {
      const output = fs.createWriteStream(destPath);
      const archive = archiver('zip', { zlib: { level: 6 } });

      output.on('close', resolve);
      archive.on('error', reject);

      archive.pipe(output);
      archive.directory(serverDir, false);
      archive.finalize();
    });

    const stats = fs.statSync(destPath);
    const fileSize = stats.size;

    const res = await query.run(
      'INSERT INTO backups (server_id, name, file_name, file_size, path, is_automatic) VALUES (?, ?, ?, ?, ?, ?)',
      [sId, backupName, fileName, fileSize, destPath, isAutomatic]
    );

    return {
      id: res.lastID,
      serverId: sId,
      name: backupName,
      fileName,
      fileSize,
      isAutomatic: isAutomatic === 1,
      createdAt: new Date().toISOString()
    };
  }

  async listBackups(serverId, filter = {}) {
    if (filter.isAutomatic !== undefined) {
      return query.all('SELECT * FROM backups WHERE server_id = ? AND is_automatic = ? ORDER BY created_at DESC', [serverId, filter.isAutomatic ? 1 : 0]);
    }
    return query.all('SELECT * FROM backups WHERE server_id = ? ORDER BY created_at DESC', [serverId]);
  }

  async restoreBackup(backupId) {
    const backup = await query.get('SELECT * FROM backups WHERE id = ?', [backupId]);
    if (!backup) {
      throw new Error('Backup not found.');
    }

    if (!fs.existsSync(backup.path)) {
      throw new Error('Backup archive file not found on disk.');
    }

    const serverDir = path.join(config.SERVERS_DIR, `server${backup.server_id}`);
    if (!fs.existsSync(serverDir)) {
      fs.mkdirSync(serverDir, { recursive: true });
    }

    // Extract over the server directory
    await new Promise((resolve, reject) => {
      fs.createReadStream(backup.path)
        .pipe(unzipper.Extract({ path: serverDir }))
        .on('close', resolve)
        .on('error', reject);
    });

    return { success: true };
  }

  async deleteBackup(backupId) {
    const backup = await query.get('SELECT * FROM backups WHERE id = ?', [backupId]);
    if (!backup) {
      throw new Error('Backup not found.');
    }
    if (backup.is_locked) {
      throw new Error('Cannot delete a locked backup. Please unlock it first.');
    }

    if (fs.existsSync(backup.path)) {
      try { fs.unlinkSync(backup.path); } catch (e) {}
    }

    await query.run('DELETE FROM backups WHERE id = ?', [backupId]);
    return { success: true };
  }

  async toggleLock(backupId) {
    const backup = await query.get('SELECT is_locked FROM backups WHERE id = ?', [backupId]);
    if (!backup) throw new Error('Backup not found.');
    const newLock = backup.is_locked ? 0 : 1;
    await query.run('UPDATE backups SET is_locked = ? WHERE id = ?', [newLock, backupId]);
    return { success: true, isLocked: newLock === 1 };
  }
}

module.exports = new BackupService();

