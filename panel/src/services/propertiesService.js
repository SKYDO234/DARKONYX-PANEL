const fs = require('fs');
const path = require('path');
const fileManagerService = require('./fileManagerService');

// Minecraft server.properties schema definitions for GUI rendering
const PROPERTY_DEFINITIONS = [
  // --- General ---
  {
    key: 'motd',
    label: 'Server MOTD',
    description: 'The message displayed in the Minecraft multiplayer server list (supports color codes like §a, §b, or &).',
    category: 'general',
    type: 'string',
    default: 'A Minecraft Server powered by DARKONYX PANEL'
  },
  {
    key: 'level-name',
    label: 'Active World Name',
    description: 'The directory name of the world save to load.',
    category: 'general',
    type: 'string',
    default: 'world'
  },
  {
    key: 'max-players',
    label: 'Max Players',
    description: 'Maximum number of concurrent players allowed on the server.',
    category: 'general',
    type: 'number',
    min: 1,
    max: 1000,
    default: '20'
  },
  {
    key: 'online-mode',
    label: 'Online Mode (Authentication)',
    description: 'Whether the server verifies connecting players with Mojang authentication servers. Set to false to allow cracked/offline players.',
    category: 'general',
    type: 'boolean',
    default: 'true'
  },
  {
    key: 'white-list',
    label: 'Enforce Whitelist',
    description: 'Only allow players on the whitelist to connect.',
    category: 'general',
    type: 'boolean',
    default: 'false'
  },
  {
    key: 'enforce-whitelist',
    label: 'Kick Non-Whitelisted on Reload',
    description: 'Immediately kicks connected players if they are removed from the whitelist.',
    category: 'general',
    type: 'boolean',
    default: 'false'
  },

  // --- Gameplay ---
  {
    key: 'gamemode',
    label: 'Default Game Mode',
    description: 'Default game mode for newly connected players.',
    category: 'gameplay',
    type: 'select',
    options: [
      { value: 'survival', label: 'Survival' },
      { value: 'creative', label: 'Creative' },
      { value: 'adventure', label: 'Adventure' },
      { value: 'spectator', label: 'Spectator' }
    ],
    default: 'survival'
  },
  {
    key: 'force-gamemode',
    label: 'Force Gamemode',
    description: 'Forces players to rejoin in the default game mode.',
    category: 'gameplay',
    type: 'boolean',
    default: 'false'
  },
  {
    key: 'difficulty',
    label: 'Difficulty',
    description: 'Game difficulty setting.',
    category: 'gameplay',
    type: 'select',
    options: [
      { value: 'peaceful', label: 'Peaceful' },
      { value: 'easy', label: 'Easy' },
      { value: 'normal', label: 'Normal' },
      { value: 'hard', label: 'Hard' }
    ],
    default: 'easy'
  },
  {
    key: 'hardcore',
    label: 'Hardcore Mode',
    description: 'If set to true, players are permanently banned upon death.',
    category: 'gameplay',
    type: 'boolean',
    default: 'false'
  },
  {
    key: 'pvp',
    label: 'Player vs Player (PvP)',
    description: 'Enable combat damage between players.',
    category: 'gameplay',
    type: 'boolean',
    default: 'true'
  },
  {
    key: 'allow-flight',
    label: 'Allow Flight',
    description: 'Allows player flight in Survival mode (required for some modded jetpacks or fast transport).',
    category: 'gameplay',
    type: 'boolean',
    default: 'false'
  },
  {
    key: 'allow-nether',
    label: 'Allow Nether Dimension',
    description: 'Allows players to travel to the Nether.',
    category: 'gameplay',
    type: 'boolean',
    default: 'true'
  },
  {
    key: 'enable-command-block',
    label: 'Enable Command Blocks',
    description: 'Enables execution of command blocks in game.',
    category: 'gameplay',
    type: 'boolean',
    default: 'true'
  },

  // --- World & Spawning ---
  {
    key: 'level-seed',
    label: 'World Seed',
    description: 'The world generation seed (leave empty for random seed).',
    category: 'world',
    type: 'string',
    default: ''
  },
  {
    key: 'level-type',
    label: 'World Generator Type',
    description: 'Biome/world generator preset.',
    category: 'world',
    type: 'select',
    options: [
      { value: 'minecraft:normal', label: 'Default Normal' },
      { value: 'minecraft:flat', label: 'Superflat' },
      { value: 'minecraft:large_biomes', label: 'Large Biomes' },
      { value: 'minecraft:amplified', label: 'Amplified' },
      { value: 'buffet', label: 'Buffet' }
    ],
    default: 'minecraft:normal'
  },
  {
    key: 'generate-structures',
    label: 'Generate Structures',
    description: 'Generate villages, temples, fortresses, and dungeons.',
    category: 'world',
    type: 'boolean',
    default: 'true'
  },
  {
    key: 'spawn-monsters',
    label: 'Spawn Monsters (Hostile)',
    description: 'Whether zombies, skeletons, and other hostile mobs spawn.',
    category: 'world',
    type: 'boolean',
    default: 'true'
  },
  {
    key: 'spawn-animals',
    label: 'Spawn Animals (Passive)',
    description: 'Whether cows, sheep, and other passive animals spawn.',
    category: 'world',
    type: 'boolean',
    default: 'true'
  },
  {
    key: 'spawn-npcs',
    label: 'Spawn NPCs / Villagers',
    description: 'Whether villagers spawn in villages.',
    category: 'world',
    type: 'boolean',
    default: 'true'
  },
  {
    key: 'spawn-protection',
    label: 'Spawn Protection Radius',
    description: 'Block radius around spawn point where non-ops cannot build (0 disables).',
    category: 'world',
    type: 'number',
    min: 0,
    max: 100,
    default: '16'
  },

  // --- Performance & Networking ---
  {
    key: 'view-distance',
    label: 'View Distance (Chunks)',
    description: 'Server chunk render distance sent to players (3-32 chunks). 8-10 recommended for high FPS.',
    category: 'performance',
    type: 'slider',
    min: 3,
    max: 32,
    default: '10'
  },
  {
    key: 'simulation-distance',
    label: 'Simulation Distance (Chunks)',
    description: 'Radius of chunks around players where entities, redstone, and crops tick.',
    category: 'performance',
    type: 'slider',
    min: 3,
    max: 32,
    default: '8'
  },
  {
    key: 'max-tick-time',
    label: 'Max Watchdog Tick Time (ms)',
    description: 'Maximum milliseconds a single tick may take before server watchdog crashes (-1 disables watchdog).',
    category: 'performance',
    type: 'number',
    default: '60000'
  },
  {
    key: 'network-compression-threshold',
    label: 'Network Compression Threshold',
    description: 'Packets larger than this size in bytes will be compressed (256 recommended).',
    category: 'performance',
    type: 'number',
    default: '256'
  },
  {
    key: 'sync-chunk-writes',
    label: 'Sync Chunk Writes',
    description: 'Synchronous disk writes for chunks. Set to false to reduce disk bottleneck.',
    category: 'performance',
    type: 'boolean',
    default: 'true'
  },

  // --- Security & RCON ---
  {
    key: 'enable-rcon',
    label: 'Enable RCON Remote Console',
    description: 'Allows remote console access via RCON protocol.',
    category: 'security',
    type: 'boolean',
    default: 'false'
  },
  {
    key: 'rcon.port',
    label: 'RCON Port',
    description: 'Port for RCON connections.',
    category: 'security',
    type: 'number',
    default: '25575'
  },
  {
    key: 'rcon.password',
    label: 'RCON Password',
    description: 'Password required to connect to RCON.',
    category: 'security',
    type: 'string',
    default: ''
  },
  {
    key: 'enable-status',
    label: 'Enable Server Status Queries',
    description: 'Makes the server visible and queryable in Minecraft server lists.',
    category: 'security',
    type: 'boolean',
    default: 'true'
  },
  {
    key: 'enable-query',
    label: 'Enable GameSpy4 Query',
    description: 'Enables GameSpy4 query listener for website status widgets.',
    category: 'security',
    type: 'boolean',
    default: 'false'
  }
];

class PropertiesService {
  /**
   * Get server root directory
   */
  getServerRoot(serverId) {
    return fileManagerService.getServerRoot(serverId);
  }

  /**
   * Get parsed server.properties and metadata
   */
  getProperties(serverId) {
    const serverDir = this.getServerRoot(serverId);
    const propsPath = path.join(serverDir, 'server.properties');
    const properties = {};
    let raw = '';

    // Initialize defaults from definition schema
    for (const def of PROPERTY_DEFINITIONS) {
      properties[def.key] = def.default;
    }

    if (fs.existsSync(propsPath)) {
      try {
        raw = fs.readFileSync(propsPath, 'utf8');
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
      } catch (err) {
        console.warn(`[PropertiesService] Error reading server.properties for server ${serverId}:`, err.message);
      }
    } else {
      // Build standard default template
      raw = `# Minecraft server properties generated by DARKONYX PANEL\n# ${(new Date()).toISOString()}\n`;
      for (const def of PROPERTY_DEFINITIONS) {
        raw += `${def.key}=${def.default}\n`;
      }
      try {
        fs.writeFileSync(propsPath, raw, 'utf8');
      } catch (e) {}
    }

    return {
      properties,
      raw,
      definitions: PROPERTY_DEFINITIONS,
      serverDir
    };
  }

  /**
   * Save properties updates or raw content
   */
  saveProperties(serverId, updates = {}, rawContent = null) {
    const serverDir = this.getServerRoot(serverId);
    const propsPath = path.join(serverDir, 'server.properties');

    if (typeof rawContent === 'string') {
      fs.writeFileSync(propsPath, rawContent, 'utf8');
      return this.getProperties(serverId);
    }

    let content = '';
    if (fs.existsSync(propsPath)) {
      content = fs.readFileSync(propsPath, 'utf8');
    } else {
      content = `# Minecraft server properties generated by DARKONYX PANEL\n# ${(new Date()).toISOString()}\n`;
    }

    for (const [key, val] of Object.entries(updates)) {
      if (val === undefined || val === null) continue;
      let strVal = String(val).trim();
      if (key === 'motd') {
        strVal = strVal.replace(/\r?\n/g, '\\n');
      }
      const regex = new RegExp(`^${key}\\s*=.*$`, 'm');
      const newLine = `${key}=${strVal}`;
      if (regex.test(content)) {
        content = content.replace(regex, newLine);
      } else {
        content = (content.trimEnd() ? content.trimEnd() + '\n' : '') + `${newLine}\n`;
      }
    }

    fs.writeFileSync(propsPath, content, 'utf8');
    return this.getProperties(serverId);
  }
}

module.exports = new PropertiesService();

