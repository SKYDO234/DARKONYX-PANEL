const axios = require('axios');
const path = require('path');
const fs = require('fs');
const unzipper = require('unzipper');
const config = require('../config/config');
const fileManagerService = require('./fileManagerService');

const CURSEFORGE_BASE_URL = config.CURSEFORGE_BASE_URL || 'https://api.curseforge.com/v1';
const MINECRAFT_GAME_ID = 432;

// CurseForge Class IDs for Minecraft
const CLASS_IDS = {
  plugins: 5,
  mods: 6,
  resourcepacks: 12,
  worlds: 17,
  modpacks: 4471,
  datapacks: 6945
};

class CurseForgeService {
  constructor() {
    this.apiKey = config.CURSEFORGE_API_KEY || '$2a$10$2LouREiMl.mx0kVBK.RlK.nloje4XS3oF8uSw809VZr07O.0A5cLq';
    this.baseUrl = config.CURSEFORGE_BASE_URL || CURSEFORGE_BASE_URL;
  }

  getClient() {
    return axios.create({
      baseURL: this.baseUrl,
      timeout: 15000,
      headers: {
        'x-api-key': this.apiKey,
        'Accept': 'application/json',
        'User-Agent': 'DARKONYX PANEL-Game-Server-Panel/1.0.0'
      }
    });
  }

  /**
   * Search CurseForge for worlds, maps, mods, or plugins
   */
  async search({ classId = 17, categoryId = null, query = '', gameVersion = '', pageSize = 20, page = null, index = 0, sortField = null, sortBy = 'relevancy', sortOrder = 'desc' } = {}) {
    try {
      const client = this.getClient();
      const resolvedClassId = CLASS_IDS[classId] || Number(classId) || 17;
      const size = Math.min(Number(pageSize) || 20, 50);

      let idx = Number(index) || 0;
      if (page && (index === null || index === undefined || index === 0)) {
        idx = (Math.max(Number(page), 1) - 1) * size;
      }

      let sf = Number(sortField);
      if (!sf && sortBy) {
        const sortMap = {
          featured: 1,
          relevancy: 2,
          popularity: 2,
          popular: 2,
          lastupdated: 3,
          latest_updated: 3,
          updated: 3,
          name: 4,
          title: 4,
          totaldownloads: 5,
          total_downloads: 5,
          downloads: 5
        };
        const key = String(sortBy).toLowerCase().replace(/[^a-z_]/g, '');
        sf = sortMap[key] || 2;
      }
      if (!sf) sf = 2;

      const params = {
        gameId: MINECRAFT_GAME_ID,
        classId: resolvedClassId,
        pageSize: size,
        index: idx,
        sortField: sf,
        sortOrder: sortOrder || 'desc'
      };

      if (categoryId && Number(categoryId)) {
        params.categoryId = Number(categoryId);
      }
      if (query && query.trim()) {
        params.searchFilter = query.trim();
      }
      if (gameVersion && gameVersion !== 'all') {
        params.gameVersion = gameVersion;
      }

      const res = await client.get('/mods/search', { params });
      const rawData = res.data?.data || [];
      const pagination = res.data?.pagination || {};

      const items = rawData.map(item => {
        const latestFile = (item.latestFiles || [])[0] || null;
        return {
          id: item.id,
          name: item.name,
          slug: item.slug,
          summary: item.summary,
          downloadCount: item.downloadCount,
          thumbsUpCount: item.thumbsUpCount,
          logoUrl: item.logo?.thumbnailUrl || item.logo?.url || '/assets/darkonyx/favicon.svg',
          authors: (item.authors || []).map(a => a.name).join(', '),
          websiteUrl: item.links?.websiteUrl || `https://www.curseforge.com/minecraft/worlds/${item.slug}`,
          categories: (item.categories || []).map(c => ({ id: c.id, name: c.name, slug: c.slug })),
          latestFile: latestFile ? {
            id: latestFile.id,
            displayName: latestFile.displayName,
            fileName: latestFile.fileName,
            downloadUrl: latestFile.downloadUrl,
            fileLength: latestFile.fileLength,
            gameVersions: latestFile.gameVersions || []
          } : null,
          source: 'curseforge'
        };
      });

      return {
        success: true,
        source: 'curseforge',
        totalHits: pagination.totalCount || items.length,
        index: pagination.index !== undefined ? pagination.index : idx,
        pageSize: pagination.pageSize || size,
        items
      };
    } catch (err) {
      console.warn('[CurseForgeService] search error:', err.response?.data || err.message);
      return {
        success: false,
        source: 'curseforge',
        error: err.response?.data?.message || err.message,
        items: [],
        totalHits: 0
      };
    }
  }

  /**
   * Search CurseForge specifically for Minecraft Worlds / Maps (classId: 17)
   */
  async searchWorlds({ query = '', categoryId = null, gameVersion = '', pageSize = 20, page = 1, index = null, sortField = null, sortBy = 'relevancy', sortOrder = 'desc' } = {}) {
    return this.search({
      classId: CLASS_IDS.worlds,
      categoryId,
      query,
      gameVersion,
      pageSize,
      page,
      index: index !== null && index !== undefined ? index : (Math.max(Number(page) || 1, 1) - 1) * (Number(pageSize) || 20),
      sortField,
      sortBy,
      sortOrder
    });
  }

  /**
   * Get single project details from CurseForge
   */
  async getMod(modId) {
    try {
      const client = this.getClient();
      const res = await client.get(`/mods/${encodeURIComponent(modId)}`);
      return res.data?.data || null;
    } catch (err) {
      console.warn('[CurseForgeService] getMod error:', err.response?.data || err.message);
      throw new Error(`Failed to load CurseForge project: ${err.message}`);
    }
  }

  /**
   * Get project downloadable files
   */
  async getModFiles(modId, gameVersion = null) {
    try {
      const client = this.getClient();
      const params = {};
      if (gameVersion) params.gameVersion = gameVersion;
      const res = await client.get(`/mods/${encodeURIComponent(modId)}/files`, { params });
      return res.data?.data || [];
    } catch (err) {
      console.warn('[CurseForgeService] getModFiles error:', err.message);
      throw new Error(`Failed to fetch CurseForge files: ${err.message}`);
    }
  }

  /**
   * Download and install a CurseForge world directly into server
   */
  async installCurseForgeWorld(serverId, { modId, fileId, customName = '', setActive = true }) {
    const client = this.getClient();
    let downloadUrl = null;
    let fileName = 'world.zip';

    if (fileId) {
      const fileRes = await client.get(`/mods/${modId}/files/${fileId}`);
      downloadUrl = fileRes.data?.data?.downloadUrl;
      fileName = fileRes.data?.data?.fileName || fileName;
    } else {
      const mod = await this.getMod(modId);
      const primaryFile = (mod.latestFiles || [])[0];
      downloadUrl = primaryFile?.downloadUrl;
      fileName = primaryFile?.fileName || fileName;
    }

    if (!downloadUrl) {
      // CurseForge requires direct browser download for authors who opt out of API distribution
      throw new Error('This map does not allow automated direct API download by author policy. Please use "Direct URL" with the CurseForge file link.');
    }

    // Call worldService.installWorldFromUrl
    const worldService = require('./worldService');
    return worldService.installWorldFromUrl(serverId, {
      downloadUrl,
      customName,
      setActive
    });
  }

  getClassIdForType(type) {
    const map = {
      plugin: CLASS_IDS.plugins,
      plugins: CLASS_IDS.plugins,
      mod: CLASS_IDS.mods,
      mods: CLASS_IDS.mods,
      resourcepack: CLASS_IDS.resourcepacks,
      resourcepacks: CLASS_IDS.resourcepacks,
      world: CLASS_IDS.worlds,
      worlds: CLASS_IDS.worlds,
      modpack: CLASS_IDS.modpacks,
      modpacks: CLASS_IDS.modpacks,
      datapack: CLASS_IDS.datapacks,
      datapacks: CLASS_IDS.datapacks
    };
    return map[type] || CLASS_IDS.plugins;
  }

  /**
   * Download and install ANY CurseForge addon (plugin, mod, datapack, resourcepack) directly into server
   */
  async installCurseForgeAddon(serverId, { modId, fileId, targetType = 'plugin', customName = '' }) {
    const client = this.getClient();
    let downloadUrl = null;
    let fileName = customName || 'addon.jar';

    if (fileId) {
      const fileRes = await client.get(`/mods/${modId}/files/${fileId}`);
      downloadUrl = fileRes.data?.data?.downloadUrl;
      fileName = customName || fileRes.data?.data?.fileName || fileName;
    } else {
      const mod = await this.getMod(modId);
      const primaryFile = (mod.latestFiles || [])[0];
      downloadUrl = primaryFile?.downloadUrl;
      fileName = customName || primaryFile?.fileName || fileName;
    }

    if (!downloadUrl) {
      throw new Error('Direct API download is not permitted by author distribution policy. Please download from curseforge.com and upload via File Manager.');
    }

    const marketplaceService = require('./marketplaceService');
    return marketplaceService.installItem(serverId, {
      downloadUrl,
      fileName,
      targetType
    });
  }
}

module.exports = new CurseForgeService();

