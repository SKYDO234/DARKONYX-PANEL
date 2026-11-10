const axios = require('axios');
const fs = require('fs');
const path = require('path');
const config = require('../config/config');
const fileManagerService = require('./fileManagerService');

const MODRINTH_API = 'https://api.modrinth.com/v2';
const USER_AGENT = 'DARKONYX PANEL-Game-Server-Panel/1.0.0 (contact@darkonyx.local)';

const apiClient = axios.create({
  baseURL: MODRINTH_API,
  timeout: 8000,
  headers: {
    'User-Agent': USER_AGENT
  }
});

function formatBytes(bytes, decimals = 2) {
  if (!bytes || bytes === 0) return '0 Bytes';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

class MarketplaceService {
  /**
   * Search Modrinth projects (plugins, mods, datapacks)
   */
  async search({ query = '', projectType = 'plugin', loader = '', gameVersion = '', limit = 24, offset = 0, sort = 'downloads' }) {
    try {
      const facets = [];

      // Project type facet: plugin, mod, datapack
      if (projectType && projectType !== 'all') {
        facets.push([`project_type:${projectType}`]);
      }

      // Loader facet: paper, spigot, fabric, forge, neoforge, velocity, etc.
      if (loader && loader !== 'all') {
        facets.push([`categories:${loader.toLowerCase()}`]);
      }

      // Game version facet
      if (gameVersion && gameVersion !== 'all') {
        facets.push([`versions:${gameVersion}`]);
      }

      const params = {
        query: query.trim(),
        limit: Math.min(parseInt(limit, 10) || 24, 60),
        offset: parseInt(offset, 10) || 0,
        index: sort || 'downloads'
      };

      if (facets.length > 0) {
        params.facets = JSON.stringify(facets);
      }

      const res = await apiClient.get('/search', { params });
      const hits = res.data.hits || [];

      const projects = hits.map(hit => ({
        id: hit.project_id,
        slug: hit.slug,
        title: hit.title,
        description: hit.description,
        categories: hit.categories || [],
        displayCategories: hit.display_categories || [],
        projectType: hit.project_type,
        downloads: hit.downloads,
        follows: hit.follows,
        iconUrl: hit.icon_url || '/assets/darkonyx/favicon.svg',
        author: hit.author,
        latestVersion: hit.latest_version,
        versions: hit.versions || [],
        color: hit.color
      }));

      return {
        totalHits: res.data.total_hits || hits.length,
        offset: res.data.offset || 0,
        limit: res.data.limit || 24,
        projects
      };
    } catch (err) {
      console.error('Modrinth search error:', err.response?.data || err.message);
      throw new Error(`Marketplace search failed: ${err.response?.data?.description || err.message}`);
    }
  }

  /**
   * Get single project details from Modrinth
   */
  async getProjectDetails(slugOrId) {
    try {
      const res = await apiClient.get(`/project/${encodeURIComponent(slugOrId)}`);
      return res.data;
    } catch (err) {
      console.error('Modrinth getProject error:', err.message);
      throw new Error(`Failed to load project details: ${err.message}`);
    }
  }

  /**
   * Get all versions of a project, optionally filtered by game version and loader
   */
  async getProjectVersions(slugOrId, gameVersion = null, loader = null) {
    try {
      const params = {};
      if (loader && loader !== 'all') {
        params.loaders = JSON.stringify([loader.toLowerCase()]);
      }
      if (gameVersion && gameVersion !== 'all') {
        params.game_versions = JSON.stringify([gameVersion]);
      }

      const res = await apiClient.get(`/project/${encodeURIComponent(slugOrId)}/version`, { params });
      const rawVersions = res.data || [];

      return rawVersions.map(ver => {
        const primaryFile = (ver.files || []).find(f => f.primary) || (ver.files || [])[0] || null;
        return {
          id: ver.id,
          name: ver.name,
          versionNumber: ver.version_number,
          gameVersions: ver.game_versions || [],
          loaders: ver.loaders || [],
          changelog: ver.changelog,
          datePublished: ver.date_published,
          downloads: ver.downloads,
          file: primaryFile ? {
            url: primaryFile.url,
            filename: primaryFile.filename,
            size: primaryFile.size,
            sizeFormatted: formatBytes(primaryFile.size)
          } : null
        };
      }).filter(v => v.file && v.file.url);
    } catch (err) {
      console.error('Modrinth getProjectVersions error:', err.message);
      throw new Error(`Failed to fetch project versions: ${err.message}`);
    }
  }

  /**
   * List installed plugins, mods, and datapacks on a specific server
   */
  async listInstalled(serverId) {
    const serverRoot = fileManagerService.getServerRoot(serverId);
    const pDir = path.join(serverRoot, 'plugins');
    if (!fs.existsSync(pDir)) fs.mkdirSync(pDir, { recursive: true });
    const mDir = path.join(serverRoot, 'mods');
    if (!fs.existsSync(mDir)) fs.mkdirSync(mDir, { recursive: true });
    const installed = [];

    // Helper to scan a directory
    const scanDir = async (dirRel, type) => {
      const targetDir = path.join(serverRoot, dirRel);
      if (!fs.existsSync(targetDir)) return;

      try {
        const entries = await fs.promises.readdir(targetDir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isFile()) {
            const ext = path.extname(entry.name).toLowerCase();
            if (ext === '.jar' || ext === '.zip') {
              const fullPath = path.join(targetDir, entry.name);
              const stats = await fs.promises.stat(fullPath);
              installed.push({
                fileName: entry.name,
                type, // 'plugin' | 'mod' | 'datapack'
                directory: dirRel,
                size: stats.size,
                sizeFormatted: formatBytes(stats.size),
                modifiedAt: stats.mtime,
                installedAt: stats.birthtime
              });
            }
          }
        }
      } catch (e) {
        console.warn(`Could not scan ${dirRel} for server ${serverId}:`, e.message);
      }
    };

    await scanDir('plugins', 'plugin');
    await scanDir('mods', 'mod');
    await scanDir('world/datapacks', 'datapack');
    await scanDir('datapacks', 'datapack');
    await scanDir('resourcepacks', 'resourcepack');
    await scanDir('modpacks', 'modpack');

    // Sort by modification date (newest first)
    installed.sort((a, b) => new Date(b.modifiedAt) - new Date(a.modifiedAt));
    return installed;
  }

  /**
   * Install (download) a plugin, mod, or datapack to a server
   */
  async installItem(serverId, { downloadUrl, fileName, targetType = 'plugin' }) {
    if (!downloadUrl) {
      throw new Error('Download URL is required.');
    }

    const serverRoot = fileManagerService.getServerRoot(serverId);

    // Sanitize filename
    const safeFileName = path.basename(fileName || 'downloaded-addon.jar');
    if (!safeFileName || safeFileName === '.' || safeFileName === '..') {
      throw new Error('Invalid file name.');
    }

    // Determine target directory
    let targetSubDir = 'plugins';
    if (targetType === 'mod') {
      targetSubDir = 'mods';
    } else if (targetType === 'datapack') {
      // Check if world/datapacks exists, else datapacks
      if (fs.existsSync(path.join(serverRoot, 'world'))) {
        targetSubDir = 'world/datapacks';
      } else {
        targetSubDir = 'datapacks';
      }
    } else if (targetType === 'resourcepack') {
      targetSubDir = 'resourcepacks';
    } else if (targetType === 'modpack') {
      targetSubDir = 'modpacks';
    }

    const destDir = path.join(serverRoot, targetSubDir);
    if (!fs.existsSync(destDir)) {
      fs.mkdirSync(destDir, { recursive: true });
    }

    const destPath = path.join(destDir, safeFileName);

    // Stream download using axios
    const response = await axios({
      method: 'GET',
      url: downloadUrl,
      responseType: 'stream',
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
          const stats = fs.statSync(destPath);
          resolve({
            success: true,
            fileName: safeFileName,
            targetType,
            directory: targetSubDir,
            size: stats.size,
            sizeFormatted: formatBytes(stats.size),
            message: `Successfully installed ${safeFileName} to ${targetSubDir}/`
          });
        } catch (e) {
          resolve({
            success: true,
            fileName: safeFileName,
            targetType,
            directory: targetSubDir,
            message: `Successfully installed ${safeFileName} to ${targetSubDir}/`
          });
        }
      });
      writer.on('error', (err) => {
        // Cleanup partial file
        if (fs.existsSync(destPath)) {
          fs.unlinkSync(destPath);
        }
        reject(new Error(`Failed to write file: ${err.message}`));
      });
    });
  }

  /**
   * Uninstall (delete) an installed file from server
   */
  async uninstallItem(serverId, { fileName, directory = null, targetType = null }) {
    if (!fileName) {
      throw new Error('File name is required.');
    }

    const serverRoot = fileManagerService.getServerRoot(serverId);
    const safeFileName = path.basename(fileName);

    // Possible candidate directories
    let candidateDirs = [];
    if (directory) {
      candidateDirs.push(path.join(serverRoot, directory));
    }
    if (targetType === 'mod') {
      candidateDirs.push(path.join(serverRoot, 'mods'));
    } else if (targetType === 'plugin') {
      candidateDirs.push(path.join(serverRoot, 'plugins'));
    } else if (targetType === 'datapack') {
      candidateDirs.push(path.join(serverRoot, 'world/datapacks'));
      candidateDirs.push(path.join(serverRoot, 'datapacks'));
    }

    // Default search directories if not specified
    candidateDirs.push(path.join(serverRoot, 'plugins'));
    candidateDirs.push(path.join(serverRoot, 'mods'));
    candidateDirs.push(path.join(serverRoot, 'world/datapacks'));
    candidateDirs.push(path.join(serverRoot, 'datapacks'));
    candidateDirs.push(path.join(serverRoot, 'resourcepacks'));
    candidateDirs.push(path.join(serverRoot, 'modpacks'));

    let deleted = false;
    for (const dir of candidateDirs) {
      const filePath = path.join(dir, safeFileName);
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        deleted = true;
        break;
      }
    }

    if (!deleted) {
      throw new Error(`File ${safeFileName} was not found on server.`);
    }

    return {
      success: true,
      fileName: safeFileName,
      message: `Uninstalled ${safeFileName} successfully.`
    };
  }
}

module.exports = new MarketplaceService();

