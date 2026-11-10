const fs = require('fs');
const path = require('path');
const axios = require('axios');
const fileManagerService = require('./fileManagerService');

const PLAYIT_JAR_URL = 'https://github.com/playit-cloud/playit-minecraft-plugin/releases/latest/download/playit-minecraft-plugin.jar';
const USER_AGENT = 'DARKONYX PANEL-Game-Server-Panel/2.0.0 (https://github.com/SKYDO234/DARKONYX-PANEL)';

class PlayitService {
  /**
   * Get server root directory
   */
  getServerRoot(serverId) {
    return fileManagerService.getServerRoot(serverId);
  }

  /**
   * Locate installed Playit jar on the server
   */
  findPlayitJar(serverId) {
    const serverRoot = this.getServerRoot(serverId);
    const searchDirs = ['plugins', 'mods'];

    for (const dirName of searchDirs) {
      const dirPath = path.join(serverRoot, dirName);
      if (fs.existsSync(dirPath)) {
        try {
          const files = fs.readdirSync(dirPath);
          for (const file of files) {
            if (/^playit.*\.jar$/i.test(file)) {
              const fullPath = path.join(dirPath, file);
              const stats = fs.statSync(fullPath);
              return {
                fileName: file,
                directory: dirName,
                fullPath,
                size: stats.size,
                installedAt: stats.birthtime || stats.mtime
              };
            }
          }
        } catch (e) {
          console.warn(`Could not read ${dirName} for server ${serverId}:`, e.message);
        }
      }
    }

    return null;
  }

  /**
   * Locate and read playit.toml config
   */
  findPlayitConfig(serverId) {
    const serverRoot = this.getServerRoot(serverId);
    const candidates = [
      path.join(serverRoot, 'playit.toml'),
      path.join(serverRoot, 'plugins', 'playit', 'playit.toml'),
      path.join(serverRoot, 'config', 'playit.toml')
    ];

    for (const p of candidates) {
      if (fs.existsSync(p)) {
        try {
          const content = fs.readFileSync(p, 'utf-8');
          const secretMatch = content.match(/secret_key\s*=\s*["']([^"']+)["']/i);
          return {
            path: p,
            content,
            secretKey: secretMatch ? secretMatch[1] : null
          };
        } catch (e) {
          console.warn(`Could not read playit config at ${p}:`, e.message);
        }
      }
    }

    return null;
  }

  /**
   * Scan latest server log for claim link and assigned tunnel address
   */
  scanLogs(serverId) {
    const serverRoot = this.getServerRoot(serverId);
    const logPath = path.join(serverRoot, 'logs', 'latest.log');

    let claimUrl = null;
    let tunnelDomain = null;

    if (fs.existsSync(logPath)) {
      try {
        // Read the last 150KB of the log file to capture recent playit messages
        const stats = fs.statSync(logPath);
        const bufferSize = Math.min(stats.size, 150 * 1024);
        const buffer = Buffer.alloc(bufferSize);
        const fd = fs.openSync(logPath, 'r');
        fs.readSync(fd, buffer, 0, bufferSize, Math.max(0, stats.size - bufferSize));
        fs.closeSync(fd);

        const logText = buffer.toString('utf-8');

        // Regex for Playit claim URL
        const claimMatch = logText.match(/https:\/\/playit\.gg\/claim\/([a-zA-Z0-9_-]+)/i) ||
                           logText.match(/playit\.gg.*?claim.*?(https:\/\/[^\s]+)/i);
        if (claimMatch) {
          claimUrl = claimMatch[0].startsWith('http') ? claimMatch[0] : `https://${claimMatch[0]}`;
        }

        // Regex for assigned tunnel address
        const tunnelMatch = logText.match(/([a-zA-Z0-9-]+\.(?:gl\.joinmc\.link|auto\.playit\.gg|playit\.gg)(?::\d+)?)/i);
        if (tunnelMatch) {
          tunnelDomain = tunnelMatch[1];
        }
      } catch (e) {
        console.warn(`Could not scan logs for server ${serverId}:`, e.message);
      }
    }

    return { claimUrl, tunnelDomain };
  }

  /**
   * Check if native Playit system CLI is installed on host
   */
  getSystemCli() {
    try {
      const cliPath = '/usr/bin/playit';
      if (fs.existsSync(cliPath)) {
        let version = '1.0.10';
        try {
          const { execSync } = require('child_process');
          version = execSync('playit version 2>/dev/null', { encoding: 'utf-8' }).trim() || version;
        } catch (e) {}
        return {
          installed: true,
          path: cliPath,
          version
        };
      }
    } catch (e) {}
    return { installed: false, path: null, version: null };
  }

  /**
   * Get full Playit status for a server
   */
  getStatus(serverId) {
    const jarInfo = this.findPlayitJar(serverId);
    const configInfo = this.findPlayitConfig(serverId);
    const logInfo = this.scanLogs(serverId);
    const systemCli = this.getSystemCli();

    const isInstalled = Boolean(jarInfo);
    const hasSecretKey = Boolean(configInfo && configInfo.secretKey);

    let status = 'not_installed';
    if (isInstalled) {
      if (logInfo.tunnelDomain || hasSecretKey) {
        status = 'active';
      } else if (logInfo.claimUrl) {
        status = 'needs_claim';
      } else {
        status = 'installed';
      }
    }

    return {
      installed: isInstalled,
      status,
      jar: jarInfo,
      systemCli,
      secretKey: hasSecretKey ? (configInfo.secretKey.substring(0, 8) + '••••••••••••••••') : null,
      hasSecretKey,
      claimUrl: logInfo.claimUrl,
      tunnelDomain: logInfo.tunnelDomain,
      supportedLoaders: ['Paper', 'Purpur', 'Spigot', 'CraftBukkit', 'Velocity', 'BungeeCord', 'Fabric', 'Forge'],
      downloadUrl: PLAYIT_JAR_URL,
      version: 'latest'
    };
  }

  /**
   * Install the official Playit.gg plugin jar
   */
  async install(serverId, options = {}) {
    const serverRoot = this.getServerRoot(serverId);
    const targetDirName = options.targetType === 'mod' ? 'mods' : 'plugins';
    const destDir = path.join(serverRoot, targetDirName);

    if (!fs.existsSync(destDir)) {
      fs.mkdirSync(destDir, { recursive: true });
    }

    const destPath = path.join(destDir, 'playit-minecraft-plugin.jar');

    // Download stream from GitHub (follows redirects to latest asset)
    const response = await axios({
      method: 'GET',
      url: PLAYIT_JAR_URL,
      responseType: 'stream',
      maxRedirects: 10,
      timeout: 30000,
      headers: {
        'User-Agent': USER_AGENT
      }
    });

    const writer = fs.createWriteStream(destPath);
    response.data.pipe(writer);

    return new Promise((resolve, reject) => {
      writer.on('finish', () => {
        try {
          // If a secret key was provided during installation, write it to playit.toml
          if (options.secretKey && options.secretKey.trim()) {
            this.configure(serverId, { secretKey: options.secretKey.trim() });
          }

          const stats = fs.statSync(destPath);
          resolve({
            success: true,
            fileName: 'playit-minecraft-plugin.jar',
            directory: targetDirName,
            size: stats.size,
            message: 'Playit.gg plugin installed successfully! Start or restart your server to launch the tunnel.'
          });
        } catch (e) {
          resolve({
            success: true,
            fileName: 'playit-minecraft-plugin.jar',
            directory: targetDirName,
            message: 'Playit.gg plugin installed successfully!'
          });
        }
      });

      writer.on('error', (err) => {
        if (fs.existsSync(destPath)) {
          fs.unlinkSync(destPath);
        }
        reject(new Error(`Failed to download Playit.gg plugin: ${err.message}`));
      });
    });
  }

  /**
   * Configure Playit secret key in playit.toml
   */
  configure(serverId, { secretKey }) {
    if (!secretKey || !secretKey.trim()) {
      throw new Error('Secret key is required.');
    }

    const cleanKey = secretKey.trim();
    const serverRoot = this.getServerRoot(serverId);

    // Save in root playit.toml
    const rootConfig = path.join(serverRoot, 'playit.toml');
    const tomlContent = `# Playit.gg Tunnel Configuration
secret_key = "${cleanKey}"
`;
    fs.writeFileSync(rootConfig, tomlContent, 'utf-8');

    // Also write to plugins/playit/playit.toml if plugins/playit exists
    const pluginDir = path.join(serverRoot, 'plugins', 'playit');
    if (fs.existsSync(pluginDir)) {
      fs.writeFileSync(path.join(pluginDir, 'playit.toml'), tomlContent, 'utf-8');
    }

    return {
      success: true,
      message: 'Playit.gg secret key saved successfully! Your tunnel will connect on server startup.'
    };
  }

  /**
   * Uninstall Playit plugin and remove configs
   */
  uninstall(serverId) {
    const serverRoot = this.getServerRoot(serverId);
    let removedFiles = [];

    // Remove from plugins and mods
    for (const dirName of ['plugins', 'mods']) {
      const dirPath = path.join(serverRoot, dirName);
      if (fs.existsSync(dirPath)) {
        try {
          const files = fs.readdirSync(dirPath);
          for (const file of files) {
            if (/^playit.*\.jar$/i.test(file)) {
              fs.unlinkSync(path.join(dirPath, file));
              removedFiles.push(`${dirName}/${file}`);
            }
          }
        } catch (e) {
          console.warn(`Error scanning ${dirName}:`, e.message);
        }
      }
    }

    // Remove playit.toml if present
    const rootConfig = path.join(serverRoot, 'playit.toml');
    if (fs.existsSync(rootConfig)) {
      fs.unlinkSync(rootConfig);
      removedFiles.push('playit.toml');
    }

    return {
      success: true,
      removedFiles,
      message: `Playit.gg uninstalled successfully (${removedFiles.length} file(s) removed).`
    };
  }
}

module.exports = new PlayitService();
