const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const archiver = require('archiver');
const unzipper = require('unzipper');
const axios = require('axios');
const { execSync } = require('child_process');
const config = require('../config/config');

class FileManagerService {
  getServerRoot(serverId) {
    const root = path.join(config.SERVERS_DIR, `server${serverId}`);
    if (!fs.existsSync(root)) {
      fs.mkdirSync(root, { recursive: true });
    }
    return root;
  }

  getSafePath(serverId, subPath = '') {
    const root = this.getServerRoot(serverId);
    const resolved = path.resolve(root, subPath.replace(/^[\/\\]+/, ''));
    if (!resolved.startsWith(root)) {
      throw new Error('Access denied: Path is outside server root directory.');
    }
    return resolved;
  }

  async listFiles(serverId, subPath = '') {
    const safePath = this.getSafePath(serverId, subPath);
    if (!fs.existsSync(safePath)) {
      return [];
    }

    const items = await fs.promises.readdir(safePath, { withFileTypes: true });
    const result = [];

    for (const item of items) {
      if (item.name === '.trash-bin') continue; // Hide internal trash dir from normal listing
      const fullPath = path.join(safePath, item.name);
      try {
        const stats = await fs.promises.stat(fullPath);
        result.push({
          name: item.name,
          isDirectory: item.isDirectory(),
          isFile: item.isFile(),
          isSymlink: item.isSymbolicLink(),
          size: item.isDirectory() ? 0 : stats.size,
          mode: '0' + (stats.mode & parseInt('777', 8)).toString(8),
          modifiedAt: stats.mtime,
          createdAt: stats.birthtime,
          extension: item.isDirectory() ? '' : path.extname(item.name).toLowerCase().replace('.', '')
        });
      } catch (err) {
        // Skip unreadable files
      }
    }

    // Sort: directories first, then alphabetically
    result.sort((a, b) => {
      if (a.isDirectory && !b.isDirectory) return -1;
      if (!a.isDirectory && b.isDirectory) return 1;
      return a.name.localeCompare(b.name);
    });

    return result;
  }

  async readFileContent(serverId, filePath) {
    const safePath = this.getSafePath(serverId, filePath);
    const stats = await fs.promises.stat(safePath);
    if (stats.size > 10 * 1024 * 1024) { // 10MB limit for text editor
      throw new Error('File is too large to edit in the web browser (Limit: 10MB).');
    }
    return fs.promises.readFile(safePath, 'utf8');
  }

  async writeFileContent(serverId, filePath, content) {
    const safePath = this.getSafePath(serverId, filePath);
    const parentDir = path.dirname(safePath);
    if (!fs.existsSync(parentDir)) {
      await fs.promises.mkdir(parentDir, { recursive: true });
    }
    await fs.promises.writeFile(safePath, content, 'utf8');
    return { success: true, path: filePath };
  }

  async createDirectory(serverId, dirPath) {
    const safePath = this.getSafePath(serverId, dirPath);
    if (fs.existsSync(safePath)) {
      throw new Error('Directory or file already exists.');
    }
    await fs.promises.mkdir(safePath, { recursive: true });
    return { success: true };
  }

  async renameItem(serverId, oldPath, newPath) {
    const safeOld = this.getSafePath(serverId, oldPath);
    const safeNew = this.getSafePath(serverId, newPath);
    if (!fs.existsSync(safeOld)) {
      throw new Error('Original file/directory does not exist.');
    }
    if (fs.existsSync(safeNew)) {
      throw new Error('Target destination name already exists.');
    }
    await fs.promises.rename(safeOld, safeNew);
    return { success: true };
  }

  async copyItem(serverId, sourcePath, destPath) {
    const safeSource = this.getSafePath(serverId, sourcePath);
    const safeDest = this.getSafePath(serverId, destPath);
    if (!fs.existsSync(safeSource)) {
      throw new Error('Source file or directory does not exist.');
    }
    if (fs.existsSync(safeDest)) {
      throw new Error('Destination already exists.');
    }
    await fs.promises.cp(safeSource, safeDest, { recursive: true });
    return { success: true };
  }

  async chmodItem(serverId, filePath, mode) {
    const safePath = this.getSafePath(serverId, filePath);
    if (!fs.existsSync(safePath)) {
      throw new Error('Item not found.');
    }
    const octalMode = typeof mode === 'string' ? parseInt(mode, 8) : mode;
    await fs.promises.chmod(safePath, octalMode);
    return { success: true, mode };
  }

  async getFileProperties(serverId, filePath) {
    const safePath = this.getSafePath(serverId, filePath);
    if (!fs.existsSync(safePath)) {
      throw new Error('File not found.');
    }
    const stat = await fs.promises.stat(safePath);
    const ext = path.extname(safePath).toLowerCase().replace('.', '');
    
    let sha256 = null;
    if (stat.isFile() && stat.size <= 50 * 1024 * 1024) {
      const fileBuffer = await fs.promises.readFile(safePath);
      sha256 = crypto.createHash('sha256').update(fileBuffer).digest('hex');
    }

    return {
      name: path.basename(safePath),
      path: filePath,
      size: stat.size,
      isDirectory: stat.isDirectory(),
      mode: '0' + (stat.mode & parseInt('777', 8)).toString(8),
      created: stat.birthtime,
      modified: stat.mtime,
      extension: ext,
      sha256
    };
  }

  async deleteItem(serverId, itemPath) {
    const safePath = this.getSafePath(serverId, itemPath);
    if (!fs.existsSync(safePath)) {
      throw new Error('File or directory not found.');
    }
    const root = this.getServerRoot(serverId);
    if (safePath === root) {
      throw new Error('Cannot delete the root server directory.');
    }
    const stats = await fs.promises.stat(safePath);
    if (stats.isDirectory()) {
      await fs.promises.rm(safePath, { recursive: true, force: true });
    } else {
      await fs.promises.unlink(safePath);
    }
    return { success: true };
  }

  async compressFiles(serverId, targetFiles = [], outputName = 'archive.zip') {
    const root = this.getServerRoot(serverId);
    const zipPath = path.join(root, outputName.endsWith('.zip') ? outputName : `${outputName}.zip`);

    return new Promise((resolve, reject) => {
      const output = fs.createWriteStream(zipPath);
      const archive = archiver('zip', { zlib: { level: 9 } });

      output.on('close', () => resolve({ success: true, zipFile: path.basename(zipPath), size: archive.pointer() }));
      archive.on('error', err => reject(err));

      archive.pipe(output);

      for (const item of targetFiles) {
        const itemSafe = this.getSafePath(serverId, item);
        const stat = fs.statSync(itemSafe);
        if (stat.isDirectory()) {
          archive.directory(itemSafe, path.basename(item));
        } else {
          archive.file(itemSafe, { name: path.basename(item) });
        }
      }

      archive.finalize();
    });
  }

  async extractZip(serverId, zipFilePath, destSubPath = '') {
    const safeZip = this.getSafePath(serverId, zipFilePath);
    const destPath = this.getSafePath(serverId, destSubPath);

    if (!fs.existsSync(safeZip)) {
      throw new Error('Zip file not found.');
    }

    return new Promise((resolve, reject) => {
      fs.createReadStream(safeZip)
        .pipe(unzipper.Extract({ path: destPath }))
        .on('close', () => resolve({ success: true }))
        .on('error', err => reject(err));
    });
  }

  // Search files (recursive)
  async searchFiles(serverId, query, maxResults = 100, searchContent = false) {
    const root = this.getServerRoot(serverId);
    const results = [];
    const qLower = (query || '').trim().toLowerCase();
    if (!qLower) return [];

    async function walk(currentDir, currentSub) {
      if (results.length >= maxResults) return;
      let entries = [];
      try {
        entries = await fs.promises.readdir(currentDir, { withFileTypes: true });
      } catch (e) {
        return;
      }

      for (const entry of entries) {
        if (results.length >= maxResults) break;
        if (entry.name === '.trash-bin' || entry.name === '.git' || entry.name === 'node_modules') continue;

        const fullPath = path.join(currentDir, entry.name);
        const relPath = path.join(currentSub, entry.name);
        const isMatchName = entry.name.toLowerCase().includes(qLower);

        let isMatchContent = false;
        let snippet = '';

        if (!entry.isDirectory() && searchContent) {
          try {
            const stat = await fs.promises.stat(fullPath);
            if (stat.size <= 1024 * 1024) { // 1MB limit for content search
              const content = await fs.promises.readFile(fullPath, 'utf8');
              const idx = content.toLowerCase().indexOf(qLower);
              if (idx !== -1) {
                isMatchContent = true;
                const start = Math.max(0, idx - 30);
                const end = Math.min(content.length, idx + query.length + 30);
                snippet = (start > 0 ? '...' : '') + content.substring(start, end).replace(/[\r\n]+/g, ' ') + (end < content.length ? '...' : '');
              }
            }
          } catch (e) {}
        }

        if (isMatchName || isMatchContent) {
          const stat = await fs.promises.stat(fullPath).catch(() => ({ size: 0, mtime: new Date() }));
          results.push({
            name: entry.name,
            path: relPath,
            isDirectory: entry.isDirectory(),
            size: entry.isDirectory() ? 0 : stat.size,
            modifiedAt: stat.mtime,
            snippet: snippet || null
          });
        }

        if (entry.isDirectory()) {
          await walk(fullPath, relPath);
        }
      }
    }

    await walk(root, '');
    return results;
  }

  // Pull from URL: query headers
  async pullFromUrlQuery(url) {
    try {
      const resp = await axios.head(url, { timeout: 8000, maxRedirects: 5 });
      const size = parseInt(resp.headers['content-length'] || '0', 10);
      const contentType = resp.headers['content-type'] || 'application/octet-stream';
      let filename = '';
      const disp = resp.headers['content-disposition'];
      if (disp && disp.includes('filename=')) {
        const match = disp.match(/filename=["']?([^"';]+)["']?/);
        if (match) filename = match[1];
      }
      if (!filename) {
        try {
          const u = new URL(url);
          filename = path.basename(u.pathname) || 'downloaded_file';
        } catch (e) {
          filename = 'downloaded_file';
        }
      }
      return { success: true, size, filename, contentType };
    } catch (err) {
      let filename = 'downloaded_file';
      try {
        const u = new URL(url);
        filename = path.basename(u.pathname) || 'downloaded_file';
      } catch (e) {}
      return { success: true, size: 0, filename, contentType: 'unknown' };
    }
  }

  // Pull from URL: download
  async pullFromUrl(serverId, url, targetDir = '', customFilename = '') {
    const destDir = this.getSafePath(serverId, targetDir);
    if (!fs.existsSync(destDir)) {
      await fs.promises.mkdir(destDir, { recursive: true });
    }

    let filename = customFilename.trim();
    if (!filename) {
      try {
        const u = new URL(url);
        filename = path.basename(u.pathname) || 'file_' + Date.now();
      } catch (e) {
        filename = 'file_' + Date.now();
      }
    }

    const safeDest = path.join(destDir, filename);
    const writer = fs.createWriteStream(safeDest);

    const response = await axios({
      url,
      method: 'GET',
      responseType: 'stream',
      timeout: 300000,
      maxRedirects: 5
    });

    return new Promise((resolve, reject) => {
      response.data.pipe(writer);
      writer.on('finish', async () => {
        try {
          const stat = await fs.promises.stat(safeDest);
          resolve({ success: true, filename, size: stat.size, path: path.join(targetDir, filename) });
        } catch (e) {
          resolve({ success: true, filename, size: 0, path: path.join(targetDir, filename) });
        }
      });
      writer.on('error', err => reject(err));
    });
  }

  // Beautify / Code Formatter
  beautifyContent(content, extension) {
    const ext = (extension || '').toLowerCase().replace('.', '');
    if (ext === 'json') {
      try {
        const parsed = JSON.parse(content);
        return JSON.stringify(parsed, null, 2);
      } catch (e) {
        throw new Error('Invalid JSON: ' + e.message);
      }
    }
    if (['js', 'javascript', 'css', 'html', 'xml', 'sql', 'yml', 'yaml'].includes(ext)) {
      const lines = content.split(/\r?\n/);
      let indentLevel = 0;
      const formatted = lines.map(line => {
        let trimmed = line.trim();
        if (!trimmed) return '';
        if (trimmed.startsWith('}') || trimmed.startsWith(']') || trimmed.startsWith('</')) {
          indentLevel = Math.max(0, indentLevel - 1);
        }
        const indented = '  '.repeat(indentLevel) + trimmed;
        if ((trimmed.endsWith('{') || trimmed.endsWith('[') || (trimmed.startsWith('<') && !trimmed.startsWith('</') && trimmed.endsWith('>') && !trimmed.endsWith('/>'))) && !trimmed.includes('</')) {
          indentLevel++;
        }
        return indented;
      });
      return formatted.join('\n');
    }
    return content;
  }

  // Trash Bin Helpers
  getTrashDir(serverId) {
    const root = this.getServerRoot(serverId);
    const trash = path.join(root, '.trash-bin');
    if (!fs.existsSync(trash)) {
      fs.mkdirSync(trash, { recursive: true });
    }
    return trash;
  }

  getTrashMetaPath(serverId) {
    return path.join(this.getTrashDir(serverId), '.metadata.json');
  }

  async readTrashMetadata(serverId) {
    const metaPath = this.getTrashMetaPath(serverId);
    if (!fs.existsSync(metaPath)) return {};
    try {
      const raw = await fs.promises.readFile(metaPath, 'utf8');
      return JSON.parse(raw || '{}');
    } catch (e) {
      return {};
    }
  }

  async writeTrashMetadata(serverId, data) {
    const metaPath = this.getTrashMetaPath(serverId);
    await fs.promises.writeFile(metaPath, JSON.stringify(data, null, 2), 'utf8');
  }

  async getTrashContents(serverId) {
    const trashDir = this.getTrashDir(serverId);
    const meta = await this.readTrashMetadata(serverId);
    const items = [];

    for (const [trashName, info] of Object.entries(meta)) {
      const itemPath = path.join(trashDir, trashName);
      if (fs.existsSync(itemPath)) {
        items.push({
          trashName,
          originalPath: info.originalPath,
          originalName: info.originalName || path.basename(info.originalPath),
          size: info.size || 0,
          deletedAt: info.deletedAt,
          isDirectory: !!info.isDirectory
        });
      }
    }

    items.sort((a, b) => new Date(b.deletedAt) - new Date(a.deletedAt));
    return items;
  }

  async moveToTrash(serverId, itemPaths = []) {
    const trashDir = this.getTrashDir(serverId);
    const meta = await this.readTrashMetadata(serverId);
    const moved = [];

    for (const relPath of itemPaths) {
      const safePath = this.getSafePath(serverId, relPath);
      if (!fs.existsSync(safePath)) continue;
      if (safePath === this.getServerRoot(serverId) || safePath === trashDir) continue;

      const stat = await fs.promises.stat(safePath);
      const isDir = stat.isDirectory();
      const base = path.basename(safePath);
      const rand = crypto.randomBytes(4).toString('hex');
      const trashName = `${base}_${Date.now()}_${rand}`;
      const dest = path.join(trashDir, trashName);

      await fs.promises.rename(safePath, dest);
      meta[trashName] = {
        originalPath: relPath,
        originalName: base,
        size: isDir ? 0 : stat.size,
        deletedAt: new Date().toISOString(),
        isDirectory: isDir
      };
      moved.push(relPath);
    }

    await this.writeTrashMetadata(serverId, meta);
    return { success: true, count: moved.length, moved };
  }

  async restoreFromTrash(serverId, trashNames = []) {
    const trashDir = this.getTrashDir(serverId);
    const meta = await this.readTrashMetadata(serverId);
    const restored = [];

    for (const trashName of trashNames) {
      const info = meta[trashName];
      if (!info) continue;
      const source = path.join(trashDir, trashName);
      if (!fs.existsSync(source)) continue;

      const safeDest = this.getSafePath(serverId, info.originalPath);
      const parent = path.dirname(safeDest);
      if (!fs.existsSync(parent)) {
        await fs.promises.mkdir(parent, { recursive: true });
      }

      await fs.promises.rename(source, safeDest);
      delete meta[trashName];
      restored.push(info.originalPath);
    }

    await this.writeTrashMetadata(serverId, meta);
    return { success: true, count: restored.length, restored };
  }

  async emptyTrash(serverId) {
    const trashDir = this.getTrashDir(serverId);
    const entries = await fs.promises.readdir(trashDir);
    for (const item of entries) {
      await fs.promises.rm(path.join(trashDir, item), { recursive: true, force: true });
    }
    await this.writeTrashMetadata(serverId, {});
    return { success: true };
  }

  // Git operations
  async gitStatus(serverId) {
    const root = this.getServerRoot(serverId);
    const isGit = fs.existsSync(path.join(root, '.git'));
    if (!isGit) {
      return { isGit: false, branch: null, files: [] };
    }
    try {
      const branch = execSync('git rev-parse --abbrev-ref HEAD', { cwd: root, encoding: 'utf8' }).trim();
      const statusOut = execSync('git status --porcelain', { cwd: root, encoding: 'utf8' }).trim();
      const files = statusOut ? statusOut.split('\n').filter(Boolean).map(l => ({ status: l.substring(0, 2).trim(), file: l.substring(3).trim() })) : [];
      return { isGit: true, branch, files };
    } catch (e) {
      return { isGit: true, branch: 'unknown', files: [], error: e.message };
    }
  }

  async gitClone(serverId, repoUrl, branch = 'main') {
    const root = this.getServerRoot(serverId);
    const branchFlag = branch ? `-b ${branch}` : '';
    execSync(`git clone ${branchFlag} "${repoUrl}" .`, { cwd: root, encoding: 'utf8', timeout: 120000 });
    return { success: true };
  }

  async gitPull(serverId) {
    const root = this.getServerRoot(serverId);
    const out = execSync('git pull', { cwd: root, encoding: 'utf8', timeout: 60000 });
    return { success: true, output: out };
  }
}

module.exports = new FileManagerService();
