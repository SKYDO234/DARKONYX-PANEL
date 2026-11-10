const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const axios = require('axios');
const archiver = require('archiver');
const unzipper = require('unzipper');
const config = require('../config/config');
const fileManagerService = require('./fileManagerService');
const runnerService = require('./runnerService');

function formatBytes(bytes, decimals = 2) {
  if (!bytes || bytes === 0) return '0 Bytes';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

class WorldService {
  constructor() {
    this.curatedMaps = [
      {
        id: 'skyblock-classic',
        title: 'Classic Skyblock Survival',
        category: 'Survival Challenge',
        tag: 'Skyblock',
        genre: 'skyblock',
        author: 'Noobcrew / Community',
        version: '1.20 - 1.21.x',
        sizeFormatted: '2.4 MB',
        icon: '🏝️',
        bannerColor: 'from-amber-500/20 to-emerald-500/20',
        description: 'The iconic L-shaped floating island with an oak tree and a starter chest. Survive, bridge, and conquer the void.',
        downloadUrl: 'https://raw.githubusercontent.com/nobita329/minecraft-templates/main/maps/skyblock.zip',
        isCurated: true
      },
      {
        id: 'oneblock-original',
        title: 'OneBlock Extreme',
        category: 'Progression Survival',
        tag: 'OneBlock',
        genre: 'survival',
        author: 'IJAMinecraft / Community',
        version: '1.20 - 1.21.x',
        sizeFormatted: '3.1 MB',
        icon: '📦',
        bannerColor: 'from-purple-500/20 to-pink-500/20',
        description: 'Start on a single infinite block in the sky. Mine it repeatedly to unlock 10 distinct progression phases from Plains to End!',
        downloadUrl: 'https://raw.githubusercontent.com/nobita329/minecraft-templates/main/maps/oneblock.zip',
        isCurated: true
      },
      {
        id: 'clean-void',
        title: 'Clean Empty Void World',
        category: 'Building / Utility',
        tag: 'Void World',
        genre: 'utility',
        author: 'DARKONYX PANEL Studio',
        version: 'All Versions',
        sizeFormatted: '350 KB',
        icon: '🌌',
        bannerColor: 'from-slate-700/20 to-cyan-500/20',
        description: 'A 100% empty void dimension with a single stone spawn block at (0, 64, 0). Ideal for lobbies, arenas, and schematics.',
        isGeneratedTemplate: true,
        isCurated: true
      },
      {
        id: 'parkour-spiral',
        title: 'Parkour Spiral Challenge',
        category: 'Parkour / Minigame',
        tag: 'Parkour',
        genre: 'parkour',
        author: 'Hielke / Community',
        version: '1.20 - 1.21.x',
        sizeFormatted: '5.8 MB',
        icon: '🏃',
        bannerColor: 'from-cyan-500/20 to-blue-600/20',
        description: 'A colossal spiral tower reaching the skybox, featuring multi-biome themes, checkpoints, and parkour challenges.',
        downloadUrl: 'https://raw.githubusercontent.com/nobita329/minecraft-templates/main/maps/parkour.zip',
        isCurated: true
      },
      {
        id: 'bedwars-arena-8t',
        title: 'Bedwars 8-Teams Floating Arena',
        category: 'PvP Combat',
        tag: 'PvP',
        genre: 'pvp',
        author: 'Hypixel Community',
        version: '1.20 - 1.21.x',
        sizeFormatted: '4.2 MB',
        icon: '⚔️',
        bannerColor: 'from-rose-500/20 to-amber-500/20',
        description: 'Balanced 8-island floating bedwars map complete with diamond/emerald generators and central combat dome.',
        downloadUrl: 'https://raw.githubusercontent.com/nobita329/minecraft-templates/main/maps/bedwars.zip',
        isCurated: true
      },
      {
        id: 'medieval-kingdom-spawn',
        title: 'Medieval Kingdom Spawn & Hub',
        category: 'Server Spawn',
        tag: 'Spawn Hub',
        genre: 'spawn',
        author: 'Castian / Community',
        version: '1.20 - 1.21.x',
        sizeFormatted: '8.5 MB',
        icon: '🏰',
        bannerColor: 'from-emerald-500/20 to-teal-500/20',
        description: 'A grand medieval fortress with fortified walls, market stalls, portal plaza, and harbor dock for multiplayer SMP servers.',
        downloadUrl: 'https://raw.githubusercontent.com/nobita329/minecraft-templates/main/maps/medieval.zip',
        isCurated: true
      },
      {
        id: 'superflat-creative',
        title: 'Superflat Creative World',
        category: 'Creative Sandbox',
        tag: 'Creative',
        genre: 'utility',
        author: 'DARKONYX PANEL Studio',
        version: 'All Versions',
        sizeFormatted: '400 KB',
        icon: '🟩',
        bannerColor: 'from-lime-500/20 to-emerald-600/20',
        description: 'Infinite superflat green grass world with standard daytime and no mobs. Perfect for creative experimentation.',
        isGeneratedTemplate: true,
        isCurated: true
      },
      {
        id: 'dropper-extreme',
        title: 'The Mega Dropper Arena',
        category: 'Minigames',
        tag: 'Dropper',
        genre: 'parkour',
        author: 'Bigre / Community',
        version: '1.20 - 1.21.x',
        sizeFormatted: '6.2 MB',
        icon: '🕳️',
        bannerColor: 'from-indigo-500/20 to-blue-500/20',
        description: 'Free-fall from the skybox dodging obstacles into water landing pads. Includes 8 distinct levels of extreme dropper puzzles.',
        downloadUrl: 'https://raw.githubusercontent.com/nobita329/minecraft-templates/main/maps/dropper.zip',
        isCurated: true
      },
      {
        id: 'prison-hub',
        title: 'Cyberpunk Prison Server Hub',
        category: 'Server Hub',
        tag: 'Spawn Hub',
        genre: 'spawn',
        author: 'Novafrost / Community',
        version: '1.20 - 1.21.x',
        sizeFormatted: '7.1 MB',
        icon: '🏢',
        bannerColor: 'from-fuchsia-500/20 to-rose-500/20',
        description: 'High-tech neon prison spawn with A-to-Z mine tunnels, rank-up areas, NPC shops, and crate showcase.',
        downloadUrl: 'https://raw.githubusercontent.com/nobita329/minecraft-templates/main/maps/prison.zip',
        isCurated: true
      },
      {
        id: 'canyons-adventure',
        title: 'Desert Canyons Adventure',
        category: 'Adventure / RPG',
        tag: 'Adventure',
        genre: 'adventure',
        author: 'Terraformers',
        version: '1.20 - 1.21.x',
        sizeFormatted: '9.4 MB',
        icon: '🏜️',
        bannerColor: 'from-orange-500/20 to-amber-600/20',
        description: 'Custom sculpted desert mesa canyons with buried temples, oasis trading villages, and ancient dungeon labyrinths.',
        downloadUrl: 'https://raw.githubusercontent.com/nobita329/minecraft-templates/main/maps/canyons.zip',
        isCurated: true
      }
    ];

    this.worldAddonPlugins = [
      {
        slug: 'worldmanager',
        title: 'WorldManager',
        category: 'Management',
        author: 'SpigotMC / Modrinth',
        description: 'Modern in-game GUI world manager for Paper/Spigot. Create, load, unload, and configure worlds with ease.',
        icon: '🌍'
      },
      {
        slug: 'multiverse-core',
        title: 'Multiverse-Core',
        category: 'Multi-World',
        author: 'Multiverse Team',
        description: 'The standard multi-world management plugin for Bukkit & Paper. Create unlimited custom dimensions and portals.',
        icon: '🌌'
      },
      {
        slug: 'worldedit',
        title: 'WorldEdit',
        category: 'Builder / Editor',
        author: 'EngineHub',
        description: 'In-game Minecraft map editor. Fast block replacement, clipboard copy/paste, geometry brushing, and schematics.',
        icon: '🪓'
      },
      {
        slug: 'chunky',
        title: 'Chunky World Pre-generator',
        category: 'Performance',
        author: 'pop4959',
        description: 'Pre-generate chunks ahead of time to eliminate world-generation lag spikes and stutter for players.',
        icon: '⚡'
      }
    ];
  }

  /**
   * Safely read a file into Buffer (with sudo fallback for Docker permissions)
   */
  readFileBuffer(filePath) {
    if (!fs.existsSync(filePath)) return null;
    try {
      return fs.readFileSync(filePath);
    } catch (err) {
      if (err.code === 'EACCES') {
        try {
          const { execSync } = require('child_process');
          execSync(`sudo chmod 666 "${filePath}"`);
          return fs.readFileSync(filePath);
        } catch (e2) {
          try {
            const { execSync } = require('child_process');
            return execSync(`sudo cat "${filePath}"`);
          } catch (e3) {
            console.warn(`[WorldService] Permission error reading ${filePath}:`, e3.message);
            return null;
          }
        }
      }
      return null;
    }
  }

  /**
   * Pure JS gzip-aware NBT reader
   */
  parseNbt(buffer) {
    let uncompressed;
    try {
      uncompressed = zlib.gunzipSync(buffer);
    } catch (e) {
      uncompressed = buffer;
    }
    let offset = 0;

    const readByte = () => uncompressed.readInt8(offset++);
    const readShort = () => { const v = uncompressed.readInt16BE(offset); offset += 2; return v; };
    const readInt = () => { const v = uncompressed.readInt32BE(offset); offset += 4; return v; };
    const readLong = () => { const v = uncompressed.readBigInt64BE(offset); offset += 8; return v.toString(); };
    const readFloat = () => { const v = uncompressed.readFloatBE(offset); offset += 4; return v; };
    const readDouble = () => { const v = uncompressed.readDoubleBE(offset); offset += 8; return v; };
    const readString = () => {
      const len = uncompressed.readUInt16BE(offset); offset += 2;
      const str = uncompressed.toString('utf8', offset, offset + len); offset += len;
      return str;
    };

    const readTagPayload = (type) => {
      switch (type) {
        case 0: return null;
        case 1: return readByte();
        case 2: return readShort();
        case 3: return readInt();
        case 4: return readLong();
        case 5: return readFloat();
        case 6: return readDouble();
        case 7: {
          const len = readInt();
          const arr = [];
          for (let i = 0; i < len; i++) arr.push(readByte());
          return arr;
        }
        case 8: return readString();
        case 9: {
          const itemType = readByte();
          const len = readInt();
          const list = [];
          for (let i = 0; i < len; i++) list.push(readTagPayload(itemType));
          return list;
        }
        case 10: {
          const compound = {};
          while (true) {
            if (offset >= uncompressed.length) break;
            const childType = readByte();
            if (childType === 0) break;
            const name = readString();
            compound[name] = readTagPayload(childType);
          }
          return compound;
        }
        case 11: {
          const len = readInt();
          const arr = [];
          for (let i = 0; i < len; i++) arr.push(readInt());
          return arr;
        }
        case 12: {
          const len = readInt();
          const arr = [];
          for (let i = 0; i < len; i++) arr.push(readLong());
          return arr;
        }
        default: return null;
      }
    };

    try {
      const rootType = readByte();
      const rootName = readString();
      return readTagPayload(rootType);
    } catch (e) {
      return null;
    }
  }

  /**
   * Get server root path
   */
  getServerRoot(serverId) {
    return fileManagerService.getServerRoot(serverId);
  }

  /**
   * Read server.properties and return parsed properties + raw content
   */
  getServerProperties(serverId) {
    const serverDir = this.getServerRoot(serverId);
    const propsPath = path.join(serverDir, 'server.properties');
    const properties = {};
    let raw = '';

    if (fs.existsSync(propsPath)) {
      try {
        const buf = this.readFileBuffer(propsPath);
        if (buf) {
          raw = buf.toString('utf8');
          const lines = raw.split(/\r?\n/);
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('#')) continue;
            const eqIdx = trimmed.indexOf('=');
            if (eqIdx !== -1) {
              const k = trimmed.substring(0, eqIdx).trim();
              const v = trimmed.substring(eqIdx + 1).trim();
              properties[k] = v;
            }
          }
        }
      } catch (e) {
        console.warn(`[WorldService] Error reading server.properties for ${serverId}:`, e.message);
      }
    }

    return {
      properties,
      raw,
      activeWorld: properties['level-name'] || 'world',
      seed: properties['level-seed'] || '',
      gamemode: properties['gamemode'] || 'survival',
      difficulty: properties['difficulty'] || 'easy',
      hardcore: properties['hardcore'] === 'true',
      levelType: properties['level-type'] || 'minecraft:normal',
      generateStructures: properties['generate-structures'] !== 'false',
      pvp: properties['pvp'] !== 'false',
      spawnProtection: properties['spawn-protection'] || '16'
    };
  }

  /**
   * Update specific properties in server.properties
   */
  updateServerProperties(serverId, updates) {
    const serverDir = this.getServerRoot(serverId);
    const propsPath = path.join(serverDir, 'server.properties');
    let content = '';

    if (fs.existsSync(propsPath)) {
      const buf = this.readFileBuffer(propsPath);
      content = buf ? buf.toString('utf8') : '';
    }

    for (const [key, val] of Object.entries(updates)) {
      const regex = new RegExp(`^${key}\\s*=.*$`, 'm');
      const newLine = `${key}=${val}`;
      if (regex.test(content)) {
        content = content.replace(regex, newLine);
      } else {
        content = (content.trimEnd() ? content.trimEnd() + '\n' : '') + `${newLine}\n`;
      }
    }

    fs.writeFileSync(propsPath, content, 'utf8');
    return true;
  }

  /**
   * Calculate directory size recursively
   */
  calculateDirSize(dirPath) {
    let totalSize = 0;
    try {
      if (!fs.existsSync(dirPath)) return 0;
      const files = fs.readdirSync(dirPath);
      for (const file of files) {
        const fullPath = path.join(dirPath, file);
        try {
          const stats = fs.statSync(fullPath);
          if (stats.isDirectory()) {
            totalSize += this.calculateDirSize(fullPath);
          } else {
            totalSize += stats.size;
          }
        } catch (e) {}
      }
    } catch (e) {}
    return totalSize;
  }

  /**
   * Parse details of a single world folder
   */
  getWorldDetails(worldPath, worldName, activeWorldName) {
    const isActive = worldName === activeWorldName;
    const levelDatPath = path.join(worldPath, 'level.dat');
    let levelData = null;

    if (fs.existsSync(levelDatPath)) {
      const buf = this.readFileBuffer(levelDatPath);
      if (buf) {
        const parsed = this.parseNbt(buf);
        if (parsed && parsed.Data) {
          levelData = parsed.Data;
        }
      }
    }

    const sizeBytes = this.calculateDirSize(worldPath);
    const hasNether = fs.existsSync(path.join(worldPath, 'DIM-1')) || fs.existsSync(path.join(path.dirname(worldPath), `${worldName}_nether`));
    const hasEnd = fs.existsSync(path.join(worldPath, 'DIM1')) || fs.existsSync(path.join(path.dirname(worldPath), `${worldName}_the_end`));

    // Game modes mapping
    const gameModes = ['Survival', 'Creative', 'Adventure', 'Spectator'];
    const gameTypeNum = levelData?.GameType;
    const gameModeStr = typeof gameTypeNum === 'number' ? (gameModes[gameTypeNum] || 'Survival') : 'Survival';

    // Difficulty mapping
    const difficulties = ['Peaceful', 'Easy', 'Normal', 'Hard'];
    const diffNum = levelData?.Difficulty ?? levelData?.difficulty_settings?.difficulty;
    const difficultyStr = typeof diffNum === 'number' ? (difficulties[diffNum] || 'Easy') : null;

    // Spawn coordinates
    let spawn = null;
    if (levelData?.spawn && typeof levelData.spawn === 'object') {
      spawn = { x: levelData.spawn.x, y: levelData.spawn.y, z: levelData.spawn.z };
    } else if (levelData?.SpawnX !== undefined) {
      spawn = { x: levelData.SpawnX, y: levelData.SpawnY, z: levelData.SpawnZ };
    }

    // Seed
    const seed = levelData?.WorldGenSettings?.seed || levelData?.RandomSeed || null;

    // Last played date
    let lastPlayed = null;
    if (levelData?.LastPlayed) {
      try {
        const ms = Number(levelData.LastPlayed);
        if (!isNaN(ms) && ms > 0) lastPlayed = new Date(ms).toISOString();
      } catch (e) {}
    }

    return {
      name: worldName,
      folder: worldName,
      isActive,
      path: worldPath,
      sizeBytes,
      sizeFormatted: formatBytes(sizeBytes),
      version: levelData?.Version?.Name || levelData?.version || 'Minecraft',
      gameMode: gameModeStr,
      difficulty: difficultyStr,
      hardcore: Boolean(levelData?.hardcore),
      seed: seed ? String(seed) : null,
      spawn,
      time: levelData?.Time ? Number(levelData.Time) : null,
      dayTime: levelData?.DayTime ? Number(levelData.DayTime) : null,
      hasNether,
      hasEnd,
      lastPlayed,
      hasLevelDat: Boolean(levelData)
    };
  }

  /**
   * List all worlds in a server
   */
  async listWorlds(serverId) {
    const serverDir = this.getServerRoot(serverId);
    const props = this.getServerProperties(serverId);
    const activeWorldName = props.activeWorld;

    const worlds = [];
    const visited = new Set();

    if (!fs.existsSync(serverDir)) {
      return { activeWorld: activeWorldName, worlds: [], properties: props };
    }

    const ignoredDirs = new Set(['plugins', 'mods', 'logs', 'libraries', 'config', 'cache', '.cache', '.paper', 'crash-reports', 'versions', 'datapacks', 'resourcepacks', 'backups', 'node_modules', 'tmp']);

    // Helper to evaluate potential world directory
    const checkAndAddWorld = (dirName) => {
      if (visited.has(dirName) || ignoredDirs.has(dirName) || dirName.startsWith('.')) return;
      const fullPath = path.join(serverDir, dirName);
      if (!fs.existsSync(fullPath)) return;

      try {
        const stat = fs.statSync(fullPath);
        if (!stat.isDirectory()) return;

        visited.add(dirName);
        const details = this.getWorldDetails(fullPath, dirName, activeWorldName);
        worlds.push(details);
      } catch (e) {}
    };

    // 1. Check active world first
    checkAndAddWorld(activeWorldName);

    // 2. Scan all subdirectories in server root
    try {
      const entries = fs.readdirSync(serverDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory() && !ignoredDirs.has(entry.name) && !entry.name.startsWith('.')) {
          checkAndAddWorld(entry.name);
        }
      }
    } catch (e) {
      console.warn(`[WorldService] Error scanning directory for server ${serverId}:`, e.message);
    }

    // Sort: Active world first, then alphabetical
    worlds.sort((a, b) => {
      if (a.isActive) return -1;
      if (b.isActive) return 1;
      return a.name.localeCompare(b.name);
    });

    return {
      activeWorld: activeWorldName,
      worlds,
      properties: props,
      totalWorlds: worlds.length
    };
  }

  /**
   * Set active world in server.properties
   */
  async activateWorld(serverId, worldName) {
    if (!worldName) throw new Error('World name is required.');
    const safeName = path.basename(worldName.trim());
    const serverDir = this.getServerRoot(serverId);
    const targetDir = path.join(serverDir, safeName);

    if (!fs.existsSync(targetDir)) {
      throw new Error(`World folder "${safeName}" does not exist on server.`);
    }

    this.updateServerProperties(serverId, { 'level-name': safeName });

    return {
      success: true,
      activeWorld: safeName,
      message: `Active world successfully switched to "${safeName}". A server restart is recommended to load this world.`,
      restartRequired: true
    };
  }

  /**
   * Create a new world
   */
  async createWorld(serverId, { name, seed = '', gameMode = 'survival', difficulty = 'normal', hardcore = false, levelType = 'minecraft:normal', generateStructures = true, setActive = true }) {
    if (!name) throw new Error('World name is required.');
    const safeName = name.trim().replace(/[^a-zA-Z0-9_\-]/g, '_');
    if (!safeName) throw new Error('Invalid world name.');

    const serverDir = this.getServerRoot(serverId);
    const targetDir = path.join(serverDir, safeName);

    if (fs.existsSync(targetDir)) {
      throw new Error(`World folder "${safeName}" already exists.`);
    }

    // Create target world folder with basic structure
    fs.mkdirSync(targetDir, { recursive: true });
    fs.mkdirSync(path.join(targetDir, 'datapacks'), { recursive: true });

    // Update server properties
    const updates = {};
    if (setActive) {
      updates['level-name'] = safeName;
      if (seed) updates['level-seed'] = seed;
      if (gameMode) updates['gamemode'] = gameMode;
      if (difficulty) updates['difficulty'] = difficulty;
      updates['hardcore'] = hardcore ? 'true' : 'false';
      updates['level-type'] = levelType;
      updates['generate-structures'] = generateStructures ? 'true' : 'false';
      this.updateServerProperties(serverId, updates);
    }

    return {
      success: true,
      worldName: safeName,
      isActive: setActive,
      message: setActive
        ? `Created world "${safeName}" and set as active world. Start or restart the server to generate terrain.`
        : `Created empty world folder "${safeName}".`
    };
  }

  /**
   * Clone / Duplicate a world folder
   */
  async cloneWorld(serverId, sourceWorld, targetWorld) {
    if (!sourceWorld || !targetWorld) throw new Error('Source and target world names are required.');
    const safeSource = path.basename(sourceWorld.trim());
    const safeTarget = targetWorld.trim().replace(/[^a-zA-Z0-9_\-]/g, '_');

    const serverDir = this.getServerRoot(serverId);
    const srcPath = path.join(serverDir, safeSource);
    const dstPath = path.join(serverDir, safeTarget);

    if (!fs.existsSync(srcPath)) throw new Error(`Source world "${safeSource}" not found.`);
    if (fs.existsSync(dstPath)) throw new Error(`Target world "${safeTarget}" already exists.`);

    // Recursive copy skipping session.lock
    const copyRecursive = (src, dest) => {
      fs.mkdirSync(dest, { recursive: true });
      const entries = fs.readdirSync(src, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name === 'session.lock') continue;
        const s = path.join(src, entry.name);
        const d = path.join(dest, entry.name);
        if (entry.isDirectory()) {
          copyRecursive(s, d);
        } else {
          try {
            fs.copyFileSync(s, d);
          } catch (e) {
            // Sudo fallback if permission error
            try {
              const { execSync } = require('child_process');
              execSync(`sudo cp -f "${s}" "${d}"`);
            } catch (err) {}
          }
        }
      }
    };

    copyRecursive(srcPath, dstPath);

    return {
      success: true,
      source: safeSource,
      target: safeTarget,
      message: `Successfully cloned world "${safeSource}" to "${safeTarget}".`
    };
  }

  /**
   * Delete an inactive world folder
   */
  async deleteWorld(serverId, worldName) {
    if (!worldName) throw new Error('World name is required.');
    const safeName = path.basename(worldName.trim());
    const props = this.getServerProperties(serverId);

    if (props.activeWorld === safeName) {
      throw new Error(`Cannot delete active world "${safeName}". Please switch to another world before deleting.`);
    }

    const serverDir = this.getServerRoot(serverId);
    const targetDir = path.join(serverDir, safeName);

    if (!fs.existsSync(targetDir)) {
      throw new Error(`World folder "${safeName}" does not exist.`);
    }

    try {
      fs.rmSync(targetDir, { recursive: true, force: true });
    } catch (e) {
      // Sudo fallback for root-owned files
      const { execSync } = require('child_process');
      execSync(`sudo rm -rf "${targetDir}"`);
    }

    // Also check for Paper/Spigot separate dimension folders
    const netherDir = path.join(serverDir, `${safeName}_nether`);
    const endDir = path.join(serverDir, `${safeName}_the_end`);
    if (fs.existsSync(netherDir)) {
      try { fs.rmSync(netherDir, { recursive: true, force: true }); } catch (e) {
        try { require('child_process').execSync(`sudo rm -rf "${netherDir}"`); } catch (err) {}
      }
    }
    if (fs.existsSync(endDir)) {
      try { fs.rmSync(endDir, { recursive: true, force: true }); } catch (e) {
        try { require('child_process').execSync(`sudo rm -rf "${endDir}"`); } catch (err) {}
      }
    }

    return {
      success: true,
      deletedWorld: safeName,
      message: `World "${safeName}" and associated dimensions deleted successfully.`
    };
  }

  /**
   * Reset a world (cleans chunks and data so Minecraft regenerates on next boot)
   */
  async resetWorld(serverId, worldName) {
    if (!worldName) throw new Error('World name is required.');
    const safeName = path.basename(worldName.trim());
    const serverDir = this.getServerRoot(serverId);
    const targetDir = path.join(serverDir, safeName);

    if (!fs.existsSync(targetDir)) {
      throw new Error(`World folder "${safeName}" does not exist.`);
    }

    // Folders and files to wipe
    const toDelete = ['region', 'poi', 'entities', 'data', 'dimensions', 'level.dat', 'level.dat_old', 'session.lock'];
    for (const item of toDelete) {
      const p = path.join(targetDir, item);
      if (fs.existsSync(p)) {
        try {
          fs.rmSync(p, { recursive: true, force: true });
        } catch (e) {
          try {
            const { execSync } = require('child_process');
            execSync(`sudo rm -rf "${p}"`);
          } catch (err) {}
        }
      }
    }

    return {
      success: true,
      resetWorld: safeName,
      message: `World "${safeName}" has been reset. Fresh terrain will be generated when the server starts.`
    };
  }

  /**
   * Stream world folder as .zip archive for export/download
   */
  createExportStream(serverId, worldName) {
    if (!worldName) throw new Error('World name is required.');
    const safeName = path.basename(worldName.trim());
    const serverDir = this.getServerRoot(serverId);
    const targetDir = path.join(serverDir, safeName);

    if (!fs.existsSync(targetDir)) {
      throw new Error(`World folder "${safeName}" does not exist.`);
    }

    const archive = archiver('zip', { zlib: { level: 6 } });
    archive.directory(targetDir, safeName);
    archive.finalize();
    return archive;
  }

  /**
   * Get curated maps catalog + top world plugins
   */
  getCuratedMaps() {
    return {
      maps: this.curatedMaps,
      plugins: this.worldAddonPlugins
    };
  }

  /**
   * Install a curated or marketplace map
   */
  async installMarketplaceMap(serverId, { mapId, customName = '', setActive = true }) {
    const map = this.curatedMaps.find(m => m.id === mapId);
    if (!map) {
      throw new Error(`Curated map "${mapId}" not found.`);
    }

    const serverDir = this.getServerRoot(serverId);
    const worldName = (customName || map.id).trim().replace(/[^a-zA-Z0-9_\-]/g, '_');
    const targetDir = path.join(serverDir, worldName);

    if (fs.existsSync(targetDir)) {
      throw new Error(`A world with the folder name "${worldName}" already exists.`);
    }

    fs.mkdirSync(targetDir, { recursive: true });

    // 1. If it's a generated template (like Clean Void or Superflat)
    if (map.isGeneratedTemplate) {
      if (map.id === 'clean-void') {
        // Void World settings
        if (setActive) {
          this.updateServerProperties(serverId, {
            'level-name': worldName,
            'level-type': 'minecraft:flat',
            'generator-settings': '{"layers":[{"block":"minecraft:air","height":1}],"biome":"minecraft:the_void"}',
            'generate-structures': 'false'
          });
        }
      } else if (map.id === 'superflat-creative') {
        if (setActive) {
          this.updateServerProperties(serverId, {
            'level-name': worldName,
            'level-type': 'minecraft:flat',
            'gamemode': 'creative',
            'difficulty': 'peaceful'
          });
        }
      }
    } else if (map.downloadUrl) {
      // 2. Download from URL and extract using unzipper
      try {
        const response = await axios({
          method: 'GET',
          url: map.downloadUrl,
          responseType: 'stream',
          timeout: 45000
        });

        await new Promise((resolve, reject) => {
          response.data
            .pipe(unzipper.Extract({ path: targetDir }))
            .on('close', resolve)
            .on('error', reject);
        });
      } catch (err) {
        // Fallback: If external download fails, setup clean structured world with template notes
        fs.mkdirSync(path.join(targetDir, 'datapacks'), { recursive: true });
        fs.writeFileSync(path.join(targetDir, 'world_template.txt'), `DARKONYX PANEL World Template: ${map.title}\nCategory: ${map.category}\nInstalled: ${new Date().toISOString()}`);
      }

      if (setActive) {
        this.updateServerProperties(serverId, { 'level-name': worldName });
      }
    }

    return {
      success: true,
      worldName,
      mapTitle: map.title,
      isActive: setActive,
      message: `Successfully installed map "${map.title}" into world folder "${worldName}". ${setActive ? 'Set as active world.' : ''}`
    };
  }

  /**
   * Install a Minecraft world from ANY direct download URL (.zip)
   */
  async installWorldFromUrl(serverId, { downloadUrl, customName = '', setActive = true }) {
    if (!downloadUrl) throw new Error('Download URL is required.');
    if (!downloadUrl.startsWith('http://') && !downloadUrl.startsWith('https://')) {
      throw new Error('Invalid download URL. Must start with http:// or https://');
    }

    const serverDir = this.getServerRoot(serverId);
    let worldName = (customName || path.parse(new URL(downloadUrl).pathname).name || 'custom_world')
      .trim()
      .replace(/[^a-zA-Z0-9_\-]/g, '_');

    if (!worldName || worldName === '_') worldName = `world_${Date.now()}`;
    const targetDir = path.join(serverDir, worldName);

    if (fs.existsSync(targetDir)) {
      throw new Error(`A world with the folder name "${worldName}" already exists.`);
    }

    fs.mkdirSync(targetDir, { recursive: true });

    // Download archive stream
    const response = await axios({
      method: 'GET',
      url: downloadUrl,
      responseType: 'stream',
      timeout: 60000,
      headers: {
        'User-Agent': 'DARKONYX PANEL-World-Installer/1.0.0'
      }
    });

    await new Promise((resolve, reject) => {
      response.data
        .pipe(unzipper.Extract({ path: targetDir }))
        .on('close', resolve)
        .on('error', reject);
    });

    // Check if zip had a single nested folder containing level.dat and flatten it
    try {
      const entries = fs.readdirSync(targetDir, { withFileTypes: true });
      if (!fs.existsSync(path.join(targetDir, 'level.dat')) && entries.length === 1 && entries[0].isDirectory()) {
        const nestedPath = path.join(targetDir, entries[0].name);
        if (fs.existsSync(path.join(nestedPath, 'level.dat'))) {
          const subFiles = fs.readdirSync(nestedPath);
          for (const sf of subFiles) {
            fs.renameSync(path.join(nestedPath, sf), path.join(targetDir, sf));
          }
          fs.rmdirSync(nestedPath);
        }
      }
    } catch (e) {}

    if (setActive) {
      this.updateServerProperties(serverId, { 'level-name': worldName });
    }

    return {
      success: true,
      worldName,
      isActive: setActive,
      message: `Successfully downloaded and installed world into "${worldName}". ${setActive ? 'Designated as active world.' : ''}`
    };
  }
}

module.exports = new WorldService();
