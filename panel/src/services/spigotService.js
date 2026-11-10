const axios = require('axios');
const fs = require('fs');
const path = require('path');
const fileManagerService = require('./fileManagerService');

const SPIGET_API = 'https://api.spiget.org/v2';
const USER_AGENT = 'DARKONYX PANEL-Game-Server-Panel/2.1.0 (https://github.com/nobita329/DARKONYX PANEL)';

const client = axios.create({
  baseURL: SPIGET_API,
  timeout: 12000,
  headers: {
    'User-Agent': USER_AGENT,
    'Accept': 'application/json'
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

class SpigotService {
  /**
   * Search SpigotMC resources via Spiget API v2
   */
  async search({ query = '', page = 0, size = 24, sort = '-downloads', gameVersion = '' }) {
    try {
      const pageNum = parseInt(page, 10) || 0;
      const limit = Math.min(parseInt(size, 10) || 24, 60);
      let res;

      if (query && query.trim()) {
        const cleanQuery = query.trim();
        res = await client.get(`/search/resources/${encodeURIComponent(cleanQuery)}`, {
          params: {
            size: limit,
            page: pageNum,
            sort: sort || '-downloads'
          }
        });
      } else {
        res = await client.get('/resources', {
          params: {
            size: limit,
            page: pageNum,
            sort: sort || '-downloads'
          }
        });
      }

      const rawItems = res.data || [];
      let items = rawItems.map(item => {
        let iconUrl = '/assets/darkonyx/favicon.svg';
        if (item.icon?.url) {
          iconUrl = item.icon.url.startsWith('http') ? item.icon.url : `https://spigotmc.org/${item.icon.url}`;
        } else if (item.icon?.data) {
          iconUrl = `data:image/png;base64,${item.icon.data}`;
        }

        const testedVersions = item.testedVersions || [];
        return {
          id: item.id,
          name: item.name,
          title: item.name,
          slug: `spigot-${item.id}`,
          tag: item.tag || '',
          description: item.tag || 'SpigotMC Community Plugin',
          downloads: item.downloads || 0,
          rating: item.rating?.average ? parseFloat(item.rating.average.toFixed(1)) : 0,
          ratingCount: item.rating?.count || 0,
          iconUrl,
          author: item.author?.id ? `Author #${item.author.id}` : 'Spigot Author',
          testedVersions,
          external: Boolean(item.external),
          externalUrl: item.file?.externalUrl || null,
          websiteUrl: `https://www.spigotmc.org/resources/${item.id}/`,
          projectType: 'plugin',
          source: 'spigotmc'
        };
      });

      if (gameVersion && gameVersion !== 'all') {
        const majorMinor = gameVersion.split('.').slice(0, 2).join('.');
        items.forEach(it => {
          it.versionMatched = (it.testedVersions || []).some(v => v === gameVersion || v === majorMinor || gameVersion.startsWith(v) || v.startsWith(majorMinor));
        });
        // Check version compatibility and sort exact/major matches first
        items.sort((a, b) => {
          if (a.versionMatched && !b.versionMatched) return -1;
          if (!a.versionMatched && b.versionMatched) return 1;
          return (b.downloads || 0) - (a.downloads || 0);
        });
      }

      return {
        success: true,
        source: 'spigotmc',
        totalHits: items.length < limit ? (pageNum * limit) + items.length : 1000,
        page: pageNum,
        limit,
        projects: items
      };
    } catch (err) {
      console.warn('[SpigotService] search error:', err.response?.data || err.message);
      return {
        success: false,
        source: 'spigotmc',
        error: err.response?.data?.message || err.message,
        projects: [],
        totalHits: 0
      };
    }
  }

  /**
   * Get single SpigotMC resource details
   */
  async getResourceDetails(id) {
    try {
      const res = await client.get(`/resources/${encodeURIComponent(id)}`);
      const item = res.data;
      if (!item) throw new Error('Resource not found.');

      let iconUrl = '/assets/darkonyx/favicon.svg';
      if (item.icon?.url) {
        iconUrl = item.icon.url.startsWith('http') ? item.icon.url : `https://spigotmc.org/${item.icon.url}`;
      } else if (item.icon?.data) {
        iconUrl = `data:image/png;base64,${item.icon.data}`;
      }

      return {
        id: item.id,
        name: item.name,
        title: item.name,
        tag: item.tag || '',
        description: item.tag || '',
        downloads: item.downloads || 0,
        rating: item.rating?.average ? parseFloat(item.rating.average.toFixed(1)) : 0,
        ratingCount: item.rating?.count || 0,
        iconUrl,
        testedVersions: item.testedVersions || [],
        releaseDate: item.releaseDate,
        updateDate: item.updateDate,
        external: Boolean(item.external),
        externalUrl: item.file?.externalUrl || null,
        file: item.file || null,
        websiteUrl: `https://www.spigotmc.org/resources/${item.id}/`,
        links: item.links || {},
        source: 'spigotmc'
      };
    } catch (err) {
      console.warn('[SpigotService] getResourceDetails error:', err.message);
      throw new Error(`Failed to load Spigot resource: ${err.message}`);
    }
  }

  /**
   * Get versions of a SpigotMC resource
   */
  async getResourceVersions(id) {
    try {
      const res = await client.get(`/resources/${encodeURIComponent(id)}/versions`, {
        params: { size: 15, sort: '-releaseDate' }
      });
      const versions = res.data || [];
      return versions.map(v => ({
        id: v.id,
        versionNumber: v.name,
        name: v.name,
        releaseDate: v.releaseDate,
        downloads: v.downloads,
        downloadUrl: `https://api.spiget.org/v2/resources/${id}/versions/${v.id}/download`,
        source: 'spigotmc'
      }));
    } catch (err) {
      console.warn('[SpigotService] getResourceVersions error:', err.message);
      return [];
    }
  }

  /**
   * Download and install a SpigotMC plugin directly to server plugins folder
   */
  async installSpigotPlugin(serverId, resourceId, customName = '') {
    const details = await this.getResourceDetails(resourceId);

    if (details.external && details.externalUrl) {
      throw new Error(`This plugin is hosted externally by the author. Please visit: ${details.externalUrl}`);
    }

    const serverRoot = fileManagerService.getServerRoot(serverId);
    const pluginsDir = path.join(serverRoot, 'plugins');
    if (!fs.existsSync(pluginsDir)) {
      fs.mkdirSync(pluginsDir, { recursive: true });
    }

    let fileName = customName;
    if (!fileName) {
      const cleanName = details.name.replace(/[^a-zA-Z0-9_\-\.]/g, '_');
      fileName = `${cleanName}.jar`;
    }
    if (!fileName.endsWith('.jar')) {
      fileName += '.jar';
    }

    const safeFileName = path.basename(fileName);
    const destPath = path.join(pluginsDir, safeFileName);
    const downloadUrl = `https://api.spiget.org/v2/resources/${resourceId}/download`;

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
            targetType: 'plugin',
            directory: 'plugins',
            size: stats.size,
            sizeFormatted: formatBytes(stats.size),
            message: `Successfully installed "${details.name}" (${safeFileName}) to plugins/`
          });
        } catch (e) {
          resolve({
            success: true,
            fileName: safeFileName,
            targetType: 'plugin',
            directory: 'plugins',
            message: `Successfully installed "${details.name}" (${safeFileName}) to plugins/`
          });
        }
      });
      writer.on('error', (err) => {
        if (fs.existsSync(destPath)) {
          fs.unlinkSync(destPath);
        }
        reject(new Error(`Failed to save plugin file: ${err.message}`));
      });
    });
  }
}

module.exports = new SpigotService();

