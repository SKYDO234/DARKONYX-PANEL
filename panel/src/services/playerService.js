const fs = require('fs');
const path = require('path');
const net = require('net');
const zlib = require('zlib');
const crypto = require('crypto');
const axios = require('axios');
const config = require('../config/config');
const { query } = require('../database/db');

class PlayerService {
  constructor() {
    // serverId -> Map(username.toLowerCase() -> { name, uuid, ip, joinedAt })
    this.onlinePlayers = new Map();
  }

  /**
   * Parse real-time console log chunks to track player connect/disconnect
   */
  handleLogLine(serverId, text) {
    const sId = Number(serverId);
    if (!this.onlinePlayers.has(sId)) {
      this.onlinePlayers.set(sId, new Map());
    }
    const map = this.onlinePlayers.get(sId);

    // 1. UUID & login lines:
    const uuidMatch = text.match(/UUID of player (\w+) is ([a-f0-9-]+)/i);
    if (uuidMatch) {
      const [, name, uuid] = uuidMatch;
      const key = name.toLowerCase();
      const existing = map.get(key) || { name, joinedAt: Date.now() };
      existing.uuid = uuid;
      map.set(key, existing);
    }

    const ipLoginMatch = text.match(/(\w+)\[(?:\/)?([0-9a-f.:]+)(?::\d+)?\] logged in/i);
    if (ipLoginMatch) {
      const [, name, ip] = ipLoginMatch;
      const key = name.toLowerCase();
      const existing = map.get(key) || { name, joinedAt: Date.now() };
      existing.ip = ip;
      map.set(key, existing);
    }

    const joinMatch = text.match(/(\w+) joined the game/i);
    if (joinMatch) {
      const [, name] = joinMatch;
      const key = name.toLowerCase();
      if (!map.has(key)) {
        map.set(key, { name, joinedAt: Date.now() });
      }
    }

    // 2. Disconnect lines:
    const leaveMatch1 = text.match(/(\w+)(?: \([a-f0-9-]+\))? lost connection/i);
    if (leaveMatch1) {
      const [, name] = leaveMatch1;
      map.delete(name.toLowerCase());
    }

    const leaveMatch2 = text.match(/(\w+) left the game/i);
    if (leaveMatch2) {
      const [, name] = leaveMatch2;
      map.delete(name.toLowerCase());
    }
  }

  clearOnlinePlayers(serverId) {
    this.onlinePlayers.delete(Number(serverId));
  }

  /**
   * Pure JavaScript gzip-aware NBT reader
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
        default:
          return null;
      }
    };

    try {
      const rootType = readByte();
      if (rootType !== 10) return null;
      readString(); // Skip root name
      return readTagPayload(10);
    } catch (e) {
      return null;
    }
  }

  /**
   * Native Minecraft Server List Ping (SLP) protocol handshake
   */
  async pingServer(host, port, timeout = 1500) {
    return new Promise((resolve) => {
      const socket = new net.Socket();
      let resolved = false;

      const cleanup = () => {
        if (!resolved) {
          resolved = true;
          try { socket.destroy(); } catch (e) {}
        }
      };

      socket.setTimeout(timeout);

      socket.on('connect', () => {
        try {
          const writeVarInt = (val) => {
            const bytes = [];
            while (true) {
              if ((val & 0xffffff80) === 0) {
                bytes.push(val);
                return Buffer.from(bytes);
              }
              bytes.push((val & 0x7f) | 0x80);
              val >>>= 7;
            }
          };

          const hostBuf = Buffer.from(host, 'utf8');
          const portBuf = Buffer.alloc(2);
          portBuf.writeUInt16BE(port, 0);

          const handshakePayload = Buffer.concat([
            writeVarInt(0x00),
            writeVarInt(47),
            writeVarInt(hostBuf.length),
            hostBuf,
            portBuf,
            writeVarInt(1)
          ]);
          const handshakePacket = Buffer.concat([writeVarInt(handshakePayload.length), handshakePayload]);

          const requestPayload = Buffer.from([0x00]);
          const requestPacket = Buffer.concat([writeVarInt(requestPayload.length), requestPayload]);

          socket.write(Buffer.concat([handshakePacket, requestPacket]));
        } catch (e) {
          cleanup();
          resolve(null);
        }
      });

      let dataBuffer = Buffer.alloc(0);

      socket.on('data', (chunk) => {
        dataBuffer = Buffer.concat([dataBuffer, chunk]);
        const str = dataBuffer.toString('utf8');
        const jsonStart = str.indexOf('{');
        const jsonEnd = str.lastIndexOf('}');
        if (jsonStart !== -1 && jsonEnd !== -1 && jsonEnd > jsonStart) {
          try {
            const jsonStr = str.substring(jsonStart, jsonEnd + 1);
            const parsed = JSON.parse(jsonStr);
            cleanup();
            resolve(parsed);
          } catch (e) {}
        }
      });

      socket.on('timeout', () => { cleanup(); resolve(null); });
      socket.on('error', () => { cleanup(); resolve(null); });
      socket.on('close', () => { cleanup(); resolve(null); });

      socket.connect(port, host);
    });
  }

  /**
   * Offline Player UUID calculation (Minecraft standard MD5 Version 3)
   */
  getOfflineUUID(username) {
    const hash = crypto.createHash('md5').update('OfflinePlayer:' + username).digest();
    hash[6] = (hash[6] & 0x0f) | 0x30;
    hash[8] = (hash[8] & 0x3f) | 0x80;
    const hex = hash.toString('hex');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
  }

  async resolveUUID(serverDir, username) {
    const lowerUser = username.toLowerCase();

    const cachePath = path.join(serverDir, 'usercache.json');
    if (fs.existsSync(cachePath)) {
      try {
        const cache = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
        const found = cache.find(p => p.name && p.name.toLowerCase() === lowerUser);
        if (found && found.uuid) return found.uuid;
      } catch (e) {}
    }

    try {
      const res = await axios.get(`https://api.mojang.com/users/profiles/minecraft/${encodeURIComponent(username)}`, { timeout: 2000 });
      if (res.data && res.data.id) {
        const raw = res.data.id;
        return `${raw.slice(0, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}-${raw.slice(16, 20)}-${raw.slice(20, 32)}`;
      }
    } catch (e) {}

    return this.getOfflineUUID(username);
  }

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
            console.warn(`[PlayerService] Permission error reading ${filePath}:`, e3.message);
            return null;
          }
        }
      }
      console.warn(`[PlayerService] Read error for ${filePath}:`, err.message);
      return null;
    }
  }

  readJson(filePath, defaultValue = []) {
    if (!fs.existsSync(filePath)) return defaultValue;
    try {
      const buf = this.readFileBuffer(filePath);
      if (!buf) return defaultValue;
      const content = buf.toString('utf8').trim();
      return content ? JSON.parse(content) : defaultValue;
    } catch (e) {
      return defaultValue;
    }
  }

  writeJson(filePath, data) {
    try {
      const dir = path.dirname(filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
      try {
        const { execSync } = require('child_process');
        execSync(`sudo chmod 666 "${filePath}"`);
      } catch (e) {}
      return true;
    } catch (e) {
      console.warn(`[PlayerService] Failed to write JSON ${filePath}:`, e.message);
      return false;
    }
  }

  /**
   * Standard Minecraft Advancements Catalog Dictionary
   */
  getAdvancementsCatalog() {
    return {
      story: {
        name: 'Story',
        icon: 'book-open',
        advancements: [
          { id: 'minecraft:story/root', title: 'Minecraft', desc: 'The heart and story of the game' },
          { id: 'minecraft:story/mine_stone', title: 'Stone Age', desc: 'Mine stone with your new pickaxe' },
          { id: 'minecraft:story/upgrade_tools', title: 'Getting an Upgrade', desc: 'Construct a better pickaxe' },
          { id: 'minecraft:story/smelt_iron', title: 'Acquire Hardware', desc: 'Smelt an iron ingot' },
          { id: 'minecraft:story/obtain_armor', title: 'Suit Up', desc: 'Protect yourself with a piece of iron armor' },
          { id: 'minecraft:story/lava_bucket', title: 'Hot Stuff', desc: 'Fill a bucket with lava' },
          { id: 'minecraft:story/iron_tools', title: "Isn't It Iron Pick", desc: 'Upgrade your pickaxe' },
          { id: 'minecraft:story/deflect_arrow', title: 'Not Today, Thank You', desc: 'Deflect a projectile with a shield' },
          { id: 'minecraft:story/form_obsidian', title: 'Ice Bucket Challenge', desc: 'Obtain a block of obsidian' },
          { id: 'minecraft:story/mine_diamond', title: 'Diamonds!', desc: 'Acquire diamonds' },
          { id: 'minecraft:story/enter_the_nether', title: 'We Need to Go Deeper', desc: 'Build, light and enter a Nether Portal' },
          { id: 'minecraft:story/shiny_gear', title: 'Cover Me with Diamonds', desc: 'Diamond armor saves lives' },
          { id: 'minecraft:story/enchant_item', title: 'Enchanter', desc: 'Enchant an item at an Enchanting Table' },
          { id: 'minecraft:story/cure_zombie_villager', title: 'Zombie Doctor', desc: 'Weaken and cure a Zombie Villager' },
          { id: 'minecraft:story/follow_ender_eye', title: 'Eye Spy', desc: 'Follow an Eye of Ender' },
          { id: 'minecraft:story/enter_the_end', title: 'The End?', desc: 'Enter the End Portal' }
        ]
      },
      nether: {
        name: 'Nether',
        icon: 'flame',
        advancements: [
          { id: 'minecraft:nether/root', title: 'Nether', desc: 'Bring summer clothes' },
          { id: 'minecraft:nether/fast_travel', title: 'Subspace Bubble', desc: 'Use the Nether to travel 7 km in the Overworld' },
          { id: 'minecraft:nether/find_fortress', title: 'A Terrible Fortress', desc: 'Break your way into a Nether Fortress' },
          { id: 'minecraft:nether/return_to_sender', title: 'Return to Sender', desc: 'Destroy a Ghast with a fireball' },
          { id: 'minecraft:nether/obtain_blaze_rod', title: 'Into Fire', desc: 'Relieve a Blaze of its rod' },
          { id: 'minecraft:nether/brew_potion', title: 'Local Brewery', desc: 'Brew a potion' },
          { id: 'minecraft:nether/obtain_ancient_debris', title: 'Hidden in the Depths', desc: 'Obtain Ancient Debris' },
          { id: 'minecraft:nether/netherite_armor', title: 'Cover Me in Debris', desc: 'Get a full suit of Netherite armor' },
          { id: 'minecraft:nether/get_wither_skull', title: 'Spooky Scary Skeleton', desc: "Obtain a Wither Skeleton's skull" },
          { id: 'minecraft:nether/summon_wither', title: 'Withering Heights', desc: 'Summon the Wither' },
          { id: 'minecraft:nether/all_potions', title: 'A Furious Cocktail', desc: 'Have every potion effect applied at once' },
          { id: 'minecraft:nether/explore_nether', title: 'Hot Tourist Destinations', desc: 'Explore all Nether biomes' },
          { id: 'minecraft:nether/ride_strider', title: 'This Boat Has Legs', desc: 'Ride a Strider with a Warped Fungus' },
          { id: 'minecraft:nether/find_bastion', title: 'Those Were the Days', desc: 'Enter a Bastion Remnant' },
          { id: 'minecraft:nether/loot_bastion', title: 'War Pigs', desc: 'Loot a chest in a Bastion Remnant' }
        ]
      },
      end: {
        name: 'The End',
        icon: 'orbit',
        advancements: [
          { id: 'minecraft:end/root', title: 'The End', desc: 'Or the beginning?' },
          { id: 'minecraft:end/kill_dragon', title: 'Free the End', desc: 'Good luck' },
          { id: 'minecraft:end/dragon_egg', title: 'The Next Generation', desc: 'Hold the Dragon Egg' },
          { id: 'minecraft:end/enter_end_gateway', title: 'Remote Getaway', desc: 'Escape the island' },
          { id: 'minecraft:end/respawn_dragon', title: 'The End... Again...', desc: 'Respawn the Ender Dragon' },
          { id: 'minecraft:end/dragon_breath', title: 'You Need a Mint', desc: "Collect dragon's breath in a bottle" },
          { id: 'minecraft:end/find_end_city', title: 'The City at the End of the Game', desc: 'Go on in, what could happen?' },
          { id: 'minecraft:end/elytra', title: "Sky's the Limit", desc: 'Find an Elytra' },
          { id: 'minecraft:end/levitate', title: 'Great View From Up Here', desc: 'Levitate up 50 blocks from Shulker attacks' }
        ]
      },
      adventure: {
        name: 'Adventure',
        icon: 'compass',
        advancements: [
          { id: 'minecraft:adventure/root', title: 'Adventure', desc: 'Adventure, exploration and combat' },
          { id: 'minecraft:adventure/voluntary_exile', title: 'Voluntary Exile', desc: 'Kill a raid captain' },
          { id: 'minecraft:adventure/hero_of_the_village', title: 'Hero of the Village', desc: 'Successfully defend a village from a raid' },
          { id: 'minecraft:adventure/ol_betsy', title: "Ol' Betsy", desc: 'Shoot a Crossbow' },
          { id: 'minecraft:adventure/sleep_in_bed', title: 'Sweet Dreams', desc: 'Sleep in a bed to change respawn point' },
          { id: 'minecraft:adventure/shoot_arrow', title: 'Take Aim', desc: 'Shoot something with an arrow' },
          { id: 'minecraft:adventure/kill_a_mob', title: 'Monster Hunter', desc: 'Kill any hostile monster' },
          { id: 'minecraft:adventure/kill_all_mobs', title: 'Monsters Hunted', desc: 'Kill one of every hostile monster' },
          { id: 'minecraft:adventure/trade', title: 'What a Deal!', desc: 'Successfully trade with a Villager' },
          { id: 'minecraft:adventure/adventuring_time', title: 'Adventuring Time', desc: 'Discover every biome' },
          { id: 'minecraft:adventure/totem_of_undying', title: 'Postmortal', desc: 'Use a Totem of Undying to cheat death' },
          { id: 'minecraft:adventure/sniper_duel', title: 'Sniper Duel', desc: 'Kill a Skeleton from at least 50 meters away' },
          { id: 'minecraft:adventure/bullseye', title: 'Bullseye', desc: 'Hit the bullseye of a Target block' }
        ]
      },
      husbandry: {
        name: 'Husbandry',
        icon: 'wheat',
        advancements: [
          { id: 'minecraft:husbandry/root', title: 'Husbandry', desc: 'The world is full of friends and food' },
          { id: 'minecraft:husbandry/breed_an_animal', title: 'The Parrots and the Bats', desc: 'Breed two animals together' },
          { id: 'minecraft:husbandry/tame_an_animal', title: 'Best Friends Forever', desc: 'Tame an animal' },
          { id: 'minecraft:husbandry/plant_seed', title: 'A Seedy Place', desc: 'Plant a seed and watch it grow' },
          { id: 'minecraft:husbandry/balanced_diet', title: 'A Balanced Diet', desc: 'Eat everything that is edible' },
          { id: 'minecraft:husbandry/break_diamond_hoe', title: 'Serious Dedication', desc: 'Completely use up a diamond hoe' },
          { id: 'minecraft:husbandry/tactical_fishing', title: 'Tactical Fishing', desc: 'Catch a fish without a rod' },
          { id: 'minecraft:husbandry/allay_drop_item_in_note_block', title: 'Birthday Song', desc: 'Have an Allay drop a cake at a Note Block' }
        ]
      }
    };
  }

  /**
   * Fetch all player data for server overview
   */
  async getServerPlayersData(serverId) {
    const sId = Number(serverId);
    const server = await query.get(
      `SELECT s.*, a.port FROM servers s
       LEFT JOIN allocations a ON s.allocation_id = a.id
       WHERE s.id = ?`,
      [sId]
    );

    if (!server) {
      throw new Error(`Server ${sId} not found.`);
    }

    const serverDir = path.join(config.SERVERS_DIR, `server${sId}`);
    const runnerService = require('./runnerService');
    const isRunning = runnerService.isServerRunning(sId);

    const ops = this.readJson(path.join(serverDir, 'ops.json'), []);
    const whitelist = this.readJson(path.join(serverDir, 'whitelist.json'), []);
    const bannedPlayers = this.readJson(path.join(serverDir, 'banned-players.json'), []);
    const bannedIps = this.readJson(path.join(serverDir, 'banned-ips.json'), []);
    const usercache = this.readJson(path.join(serverDir, 'usercache.json'), []);

    let whitelistEnabled = false;
    const propsPath = path.join(serverDir, 'server.properties');
    if (fs.existsSync(propsPath)) {
      const propsContent = fs.readFileSync(propsPath, 'utf8');
      const wlMatch = propsContent.match(/^white-list\s*=\s*(true|false)/m);
      if (wlMatch && wlMatch[1] === 'true') {
        whitelistEnabled = true;
      }
    }

    const liveMap = this.onlinePlayers.get(sId) || new Map();
    let onlineList = Array.from(liveMap.values());
    let pingInfo = null;

    if (isRunning) {
      const targetPort = server.port || 25565;
      pingInfo = await this.pingServer('127.0.0.1', targetPort);

      if (pingInfo && pingInfo.players && Array.isArray(pingInfo.players.sample)) {
        for (const samplePlayer of pingInfo.players.sample) {
          const key = samplePlayer.name.toLowerCase();
          if (!liveMap.has(key)) {
            const entry = {
              name: samplePlayer.name,
              uuid: samplePlayer.id,
              joinedAt: Date.now()
            };
            liveMap.set(key, entry);
            onlineList.push(entry);
          } else {
            const entry = liveMap.get(key);
            if (!entry.uuid && samplePlayer.id) entry.uuid = samplePlayer.id;
          }
        }
      }
    } else {
      onlineList = [];
    }

    return {
      serverId: sId,
      serverName: server.name,
      serverType: server.server_type,
      serverRunning: isRunning,
      port: server.port || 25565,
      onlinePlayers: onlineList,
      playerCounts: {
        online: pingInfo?.players?.online ?? onlineList.length,
        max: pingInfo?.players?.max ?? (server.max_players || 20)
      },
      ops,
      whitelist,
      whitelistEnabled,
      bannedPlayers,
      bannedIps,
      allPlayers: usercache
    };
  }

  /**
   * Fetch complete player profile: Inventory, Statistics & Advancements
   */
  async getPlayerDetails(serverId, targetPlayer) {
    const sId = Number(serverId);
    const server = await query.get(
      `SELECT s.*, a.port FROM servers s
       LEFT JOIN allocations a ON s.allocation_id = a.id
       WHERE s.id = ?`,
      [sId]
    );
    if (!server) throw new Error(`Server ${sId} not found.`);

    const serverDir = path.join(config.SERVERS_DIR, `server${sId}`);

    let uuid = '';
    let username = targetPlayer;
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(targetPlayer)) {
      uuid = targetPlayer.toLowerCase();
      const usercache = this.readJson(path.join(serverDir, 'usercache.json'), []);
      const found = usercache.find(p => p.uuid && p.uuid.toLowerCase() === uuid);
      if (found) username = found.name;
    } else {
      uuid = await this.resolveUUID(serverDir, targetPlayer);
    }

    let levelName = 'world';
    const propsPath = path.join(serverDir, 'server.properties');
    if (fs.existsSync(propsPath)) {
      const props = fs.readFileSync(propsPath, 'utf8');
      const match = props.match(/^level-name\s*=\s*(.*)$/m);
      if (match && match[1].trim()) levelName = match[1].trim();
    }

    let worldDir = path.join(serverDir, levelName);
    if (!fs.existsSync(worldDir)) {
      worldDir = path.join(serverDir, 'world');
    }

    const runnerService = require('./runnerService');
    const isRunning = runnerService.isServerRunning(sId);

    // Determine online status
    let isOnline = false;
    if (this.onlinePlayers.get(sId) && this.onlinePlayers.get(sId).has(username.toLowerCase())) {
      isOnline = true;
    } else if (isRunning) {
      const buffer = runnerService.getBuffer(sId) || '';
      const lines = buffer.split('\n');
      for (let i = lines.length - 1; i >= Math.max(0, lines.length - 100); i--) {
        const line = lines[i];
        if (line.includes(`${username} joined the game`) || line.includes(`UUID of player ${username} is`)) {
          isOnline = true;
          break;
        }
        if (line.includes(`${username} lost connection`) || line.includes(`${username} left the game`)) {
          isOnline = false;
          break;
        }
      }
    }

    // 1. INVENTORY & PLAYERDATA
    const inventoryData = {
      loaded: false,
      health: 20,
      maxHealth: 20,
      foodLevel: 20,
      xpLevel: 0,
      xpProgress: 0,
      score: 0,
      pos: [0, 80, 0],
      dimension: 'minecraft:overworld',
      gameType: 'survival',
      armor: {
        helmet: null,
        chestplate: null,
        leggings: null,
        boots: null
      },
      offhand: null,
      hotbar: Array(9).fill(null),
      main: Array(27).fill(null),
      enderChest: Array(27).fill(null)
    };

    const datCandidates = [
      path.join(worldDir, 'playerdata', `${uuid}.dat`),
      path.join(serverDir, 'world', 'playerdata', `${uuid}.dat`),
      path.join(worldDir, 'players', 'data', `${uuid}.dat`),
      path.join(worldDir, 'players', `${uuid}.dat`)
    ];

    const datPath = datCandidates.find(p => fs.existsSync(p));
    if (datPath) {
      try {
        const buf = this.readFileBuffer(datPath);
        const nbt = buf ? this.parseNbt(buf) : null;
        if (nbt) {
          inventoryData.loaded = true;
          inventoryData.health = Math.round(nbt.Health || 20);
          inventoryData.foodLevel = nbt.foodLevel ?? 20;
          inventoryData.xpLevel = nbt.XpLevel ?? 0;
          inventoryData.xpProgress = Math.round((nbt.XpP || 0) * 100);
          inventoryData.score = nbt.Score ?? 0;
          inventoryData.dimension = nbt.Dimension || 'minecraft:overworld';
          if (Array.isArray(nbt.Pos) && nbt.Pos.length >= 3) {
            inventoryData.pos = nbt.Pos.map(v => Math.round(Number(v) * 10) / 10);
          }
          const typeMap = { 0: 'survival', 1: 'creative', 2: 'adventure', 3: 'spectator' };
          inventoryData.gameType = typeMap[nbt.playerGameType] || 'survival';

          const formatItem = (item) => {
            if (!item || !item.id) return null;
            const cleanId = String(item.id).replace(/^minecraft:/, '');
            const count = item.count || item.Count || 1;
            const displayName = cleanId.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
            const iconUrl = `https://raw.githubusercontent.com/PrismarineJS/minecraft-assets/master/data/1.20.4/items/${cleanId}.png`;
            return {
              id: item.id,
              cleanId,
              name: displayName,
              count,
              slot: item.Slot,
              iconUrl
            };
          };

          if (Array.isArray(nbt.Inventory)) {
            for (const item of nbt.Inventory) {
              const formatted = formatItem(item);
              const slot = item.Slot;
              if (slot === 103) inventoryData.armor.helmet = formatted;
              else if (slot === 102) inventoryData.armor.chestplate = formatted;
              else if (slot === 101) inventoryData.armor.leggings = formatted;
              else if (slot === 100) inventoryData.armor.boots = formatted;
              else if (slot === -106) inventoryData.offhand = formatted;
              else if (slot >= 0 && slot <= 8) inventoryData.hotbar[slot] = formatted;
              else if (slot >= 9 && slot <= 35) inventoryData.main[slot - 9] = formatted;
            }
          }

          if (Array.isArray(nbt.EnderItems)) {
            for (const item of nbt.EnderItems) {
              const formatted = formatItem(item);
              const slot = item.Slot;
              if (slot >= 0 && slot < 27) {
                inventoryData.enderChest[slot] = formatted;
              }
            }
          }
        }
      } catch (e) {
        console.warn(`[PlayerService] Error parsing playerdata for ${username}:`, e.message);
      }
    }

    // 2. STATISTICS
    const statsData = {
      loaded: false,
      playTimeHours: 0,
      playTimeFormatted: '0m',
      deaths: 0,
      mobKills: 0,
      playerKills: 0,
      distanceWalkedKm: 0,
      distanceFlownKm: 0,
      jumps: 0,
      damageDealt: 0,
      damageTaken: 0,
      mined: [],
      killed: [],
      used: [],
      crafted: []
    };

    const statsCandidates = [
      path.join(worldDir, 'stats', `${uuid}.json`),
      path.join(serverDir, 'world', 'stats', `${uuid}.json`)
    ];
    const statsPath = statsCandidates.find(p => fs.existsSync(p));
    if (statsPath) {
      try {
        const statsJson = this.readJson(statsPath, {});
        const stats = statsJson.stats || {};
        const custom = stats['minecraft:custom'] || {};

        statsData.loaded = true;
        const playTicks = custom['minecraft:play_time'] || custom['minecraft:total_world_time'] || 0;
        const playSeconds = Math.floor(playTicks / 20);
        const hours = Math.floor(playSeconds / 3600);
        const minutes = Math.floor((playSeconds % 3600) / 60);
        statsData.playTimeHours = hours;
        statsData.playTimeFormatted = hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;

        statsData.deaths = custom['minecraft:deaths'] || 0;
        statsData.mobKills = custom['minecraft:mob_kills'] || 0;
        statsData.playerKills = custom['minecraft:player_kills'] || 0;
        statsData.jumps = custom['minecraft:jump'] || 0;
        statsData.damageDealt = Math.round((custom['minecraft:damage_dealt'] || 0) / 10);
        statsData.damageTaken = Math.round((custom['minecraft:damage_taken'] || 0) / 10);

        const walkCm = custom['minecraft:walk_one_cm'] || 0;
        statsData.distanceWalkedKm = Math.round((walkCm / 100000) * 100) / 100;

        const flyCm = custom['minecraft:fly_one_cm'] || 0;
        statsData.distanceFlownKm = Math.round((flyCm / 100000) * 100) / 100;

        const mapCategory = (dict) => {
          if (!dict || typeof dict !== 'object') return [];
          return Object.entries(dict)
            .map(([rawId, count]) => {
              const cleanId = rawId.replace(/^minecraft:/, '');
              const name = cleanId.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
              const iconUrl = `https://raw.githubusercontent.com/PrismarineJS/minecraft-assets/master/data/1.20.4/items/${cleanId}.png`;
              return { id: rawId, cleanId, name, count, iconUrl };
            })
            .sort((a, b) => b.count - a.count);
        };

        statsData.mined = mapCategory(stats['minecraft:mined']);
        statsData.killed = mapCategory(stats['minecraft:killed']);
        statsData.used = mapCategory(stats['minecraft:used']);
        statsData.crafted = mapCategory(stats['minecraft:crafted']);
      } catch (e) {
        console.warn(`[PlayerService] Error parsing stats for ${username}:`, e.message);
      }
    }

    // 3. ADVANCEMENTS
    const advancementsCatalog = this.getAdvancementsCatalog();
    let completedAdvancements = {};
    const advCandidates = [
      path.join(worldDir, 'advancements', `${uuid}.json`),
      path.join(serverDir, 'world', 'advancements', `${uuid}.json`)
    ];
    const advPath = advCandidates.find(p => fs.existsSync(p));
    if (advPath) {
      try {
        const advJson = this.readJson(advPath, {});
        completedAdvancements = advJson || {};
      } catch (e) {
        console.warn(`[PlayerService] Error reading advancements for ${username}:`, e.message);
      }
    }

    let totalCompleted = 0;
    const categoriesData = {};

    for (const [catKey, catObj] of Object.entries(advancementsCatalog)) {
      let catCompleted = 0;
      const list = catObj.advancements.map(adv => {
        const userAdv = completedAdvancements[adv.id];
        const isDone = Boolean(userAdv && userAdv.done);
        if (isDone) {
          catCompleted++;
          totalCompleted++;
        }
        return {
          ...adv,
          done: isDone,
          completedCriteria: userAdv ? Object.keys(userAdv.criteria || {}) : []
        };
      });

      categoriesData[catKey] = {
        name: catObj.name,
        icon: catObj.icon,
        total: list.length,
        completed: catCompleted,
        percentage: list.length > 0 ? Math.round((catCompleted / list.length) * 100) : 0,
        advancements: list
      };
    }

    const totalCatalog = Object.values(advancementsCatalog).reduce((acc, c) => acc + c.advancements.length, 0);

    const onlineInfo = (this.onlinePlayers.get(sId) && this.onlinePlayers.get(sId).get(username.toLowerCase())) || null;

    return {
      serverId: sId,
      player: {
        name: username,
        uuid,
        isOnline,
        joinedAt: onlineInfo?.joinedAt || null,
        ip: onlineInfo?.ip || null
      },
      inventory: inventoryData,
      stats: statsData,
      advancements: {
        total: totalCatalog,
        completed: totalCompleted,
        percentage: totalCatalog > 0 ? Math.round((totalCompleted / totalCatalog) * 100) : 0,
        categories: categoriesData
      }
    };
  }

  /**
   * Execute player management action
   */
  async executeAction(serverId, actionData) {
    const sId = Number(serverId);
    const server = await query.get(
      `SELECT s.*, a.port FROM servers s
       LEFT JOIN allocations a ON s.allocation_id = a.id
       WHERE s.id = ?`,
      [sId]
    );

    if (!server) {
      throw new Error(`Server ${sId} not found.`);
    }

    const serverDir = path.join(config.SERVERS_DIR, `server${sId}`);
    const runnerService = require('./runnerService');
    const isRunning = runnerService.isServerRunning(sId);

    const { action, username, reason, level, ip, gamemode, item, amount, target, message, advancement } = actionData;
    const cleanUser = (username || '').trim();
    const cleanIp = (ip || '').trim();

    const runCmd = (cmd) => {
      if (isRunning) {
        try {
          runnerService.sendCommand(sId, cmd);
        } catch (e) {
          console.warn(`[PlayerService] Failed to send command "${cmd}":`, e.message);
        }
      }
    };

    switch (action) {
      case 'kick': {
        if (!cleanUser) throw new Error('Username is required to kick.');
        const kickMsg = reason ? ` "${reason}"` : ' "Kicked by an administrator"';
        runCmd(`kick ${cleanUser}${kickMsg}`);
        
        if (this.onlinePlayers.has(sId)) {
          this.onlinePlayers.get(sId).delete(cleanUser.toLowerCase());
        }
        return { success: true, message: `Kicked player ${cleanUser}` };
      }

      case 'ban': {
        if (!cleanUser) throw new Error('Username is required to ban.');
        const banReason = reason || 'Banned by an operator.';
        runCmd(`ban ${cleanUser} ${banReason}`);

        const bannedPath = path.join(serverDir, 'banned-players.json');
        const bannedList = this.readJson(bannedPath, []);
        const uuid = await this.resolveUUID(serverDir, cleanUser);

        const existingIdx = bannedList.findIndex(p => (p.name && p.name.toLowerCase() === cleanUser.toLowerCase()) || p.uuid === uuid);
        const banEntry = {
          uuid,
          name: cleanUser,
          created: new Date().toISOString().replace('T', ' ').substring(0, 19) + ' +0000',
          source: '(Server)',
          expires: 'forever',
          reason: banReason
        };

        if (existingIdx !== -1) {
          bannedList[existingIdx] = banEntry;
        } else {
          bannedList.push(banEntry);
        }
        this.writeJson(bannedPath, bannedList);

        if (this.onlinePlayers.has(sId)) {
          this.onlinePlayers.get(sId).delete(cleanUser.toLowerCase());
        }
        return { success: true, message: `Banned player ${cleanUser}` };
      }

      case 'unban': {
        if (!cleanUser) throw new Error('Username is required to unban.');
        runCmd(`pardon ${cleanUser}`);

        const bannedPath = path.join(serverDir, 'banned-players.json');
        let bannedList = this.readJson(bannedPath, []);
        bannedList = bannedList.filter(p => p.name && p.name.toLowerCase() !== cleanUser.toLowerCase());
        this.writeJson(bannedPath, bannedList);

        return { success: true, message: `Unbanned player ${cleanUser}` };
      }

      case 'ban-ip': {
        const targetIp = cleanIp || cleanUser;
        if (!targetIp) throw new Error('IP address or username is required to IP-ban.');
        const banReason = reason || 'Banned by an operator.';
        runCmd(`ban-ip ${targetIp} ${banReason}`);

        const bannedIpPath = path.join(serverDir, 'banned-ips.json');
        const bannedIpList = this.readJson(bannedIpPath, []);
        const ipEntry = {
          ip: targetIp,
          created: new Date().toISOString().replace('T', ' ').substring(0, 19) + ' +0000',
          source: '(Server)',
          expires: 'forever',
          reason: banReason
        };

        const existingIdx = bannedIpList.findIndex(p => p.ip === targetIp);
        if (existingIdx !== -1) {
          bannedIpList[existingIdx] = ipEntry;
        } else {
          bannedIpList.push(ipEntry);
        }
        this.writeJson(bannedIpPath, bannedIpList);

        return { success: true, message: `Banned IP ${targetIp}` };
      }

      case 'unban-ip': {
        const targetIp = cleanIp || cleanUser;
        if (!targetIp) throw new Error('IP address is required to unban.');
        runCmd(`pardon-ip ${targetIp}`);

        const bannedIpPath = path.join(serverDir, 'banned-ips.json');
        let bannedIpList = this.readJson(bannedIpPath, []);
        bannedIpList = bannedIpList.filter(p => p.ip !== targetIp);
        this.writeJson(bannedIpPath, bannedIpList);

        return { success: true, message: `Unbanned IP ${targetIp}` };
      }

      case 'op': {
        if (!cleanUser) throw new Error('Username is required.');
        runCmd(`op ${cleanUser}`);

        const opLevel = parseInt(level, 10) || 4;
        const opsPath = path.join(serverDir, 'ops.json');
        const opsList = this.readJson(opsPath, []);
        const uuid = await this.resolveUUID(serverDir, cleanUser);

        const existingIdx = opsList.findIndex(p => (p.name && p.name.toLowerCase() === cleanUser.toLowerCase()) || p.uuid === uuid);
        const opEntry = {
          uuid,
          name: cleanUser,
          level: opLevel,
          bypassesPlayerLimit: false
        };

        if (existingIdx !== -1) {
          opsList[existingIdx] = opEntry;
        } else {
          opsList.push(opEntry);
        }
        this.writeJson(opsPath, opsList);

        return { success: true, message: `Promoted ${cleanUser} to Server Operator (Level ${opLevel})` };
      }

      case 'deop': {
        if (!cleanUser) throw new Error('Username is required.');
        runCmd(`deop ${cleanUser}`);

        const opsPath = path.join(serverDir, 'ops.json');
        let opsList = this.readJson(opsPath, []);
        opsList = opsList.filter(p => p.name && p.name.toLowerCase() !== cleanUser.toLowerCase());
        this.writeJson(opsPath, opsList);

        return { success: true, message: `Demoted ${cleanUser} (Operator removed)` };
      }

      case 'whitelist-add': {
        if (!cleanUser) throw new Error('Username is required to whitelist.');
        runCmd(`whitelist add ${cleanUser}`);

        const wlPath = path.join(serverDir, 'whitelist.json');
        const wlList = this.readJson(wlPath, []);
        const uuid = await this.resolveUUID(serverDir, cleanUser);

        if (!wlList.some(p => (p.name && p.name.toLowerCase() === cleanUser.toLowerCase()) || p.uuid === uuid)) {
          wlList.push({ uuid, name: cleanUser });
          this.writeJson(wlPath, wlList);
        }

        return { success: true, message: `Added ${cleanUser} to Whitelist` };
      }

      case 'whitelist-remove': {
        if (!cleanUser) throw new Error('Username is required to remove from whitelist.');
        runCmd(`whitelist remove ${cleanUser}`);

        const wlPath = path.join(serverDir, 'whitelist.json');
        let wlList = this.readJson(wlPath, []);
        wlList = wlList.filter(p => p.name && p.name.toLowerCase() !== cleanUser.toLowerCase());
        this.writeJson(wlPath, wlList);

        return { success: true, message: `Removed ${cleanUser} from Whitelist` };
      }

      case 'whitelist-toggle': {
        const enabled = Boolean(actionData.enabled);
        runCmd(enabled ? 'whitelist on' : 'whitelist off');

        const propsPath = path.join(serverDir, 'server.properties');
        if (fs.existsSync(propsPath)) {
          let content = fs.readFileSync(propsPath, 'utf8');
          if (/^white-list\s*=/m.test(content)) {
            content = content.replace(/^white-list\s*=.*$/m, `white-list=${enabled}`);
          } else {
            content = (content.trimEnd() ? content.trimEnd() + '\n' : '') + `white-list=${enabled}\n`;
          }
          fs.writeFileSync(propsPath, content, 'utf8');
        }

        return { success: true, message: `Whitelist ${enabled ? 'Enabled' : 'Disabled'}` };
      }

      case 'gamemode': {
        if (!cleanUser) throw new Error('Username is required.');
        const mode = gamemode || 'survival';
        runCmd(`gamemode ${mode} ${cleanUser}`);
        return { success: true, message: `Set gamemode for ${cleanUser} to ${mode}` };
      }

      case 'kill': {
        if (!cleanUser) throw new Error('Username is required.');
        runCmd(`kill ${cleanUser}`);
        return { success: true, message: `Killed player ${cleanUser}` };
      }

      case 'teleport': {
        if (!cleanUser || !target) throw new Error('Player and destination target required.');
        runCmd(`tp ${cleanUser} ${target}`);
        return { success: true, message: `Teleported ${cleanUser} to ${target}` };
      }

      case 'give': {
        if (!cleanUser || !item) throw new Error('Player and item required.');
        const count = parseInt(amount, 10) || 1;
        runCmd(`give ${cleanUser} ${item} ${count}`);
        return { success: true, message: `Gave ${cleanUser} ${count}x ${item}` };
      }

      case 'message': {
        if (!cleanUser || !message) throw new Error('Player and message content required.');
        runCmd(`tell ${cleanUser} ${message}`);
        return { success: true, message: `Sent message to ${cleanUser}` };
      }

      case 'clear': {
        if (!cleanUser) throw new Error('Username is required.');
        runCmd(`clear ${cleanUser}`);
        return { success: true, message: `Cleared inventory of ${cleanUser}` };
      }

      case 'advancement-grant': {
        if (!cleanUser) throw new Error('Username is required.');
        const adv = advancement || 'everything';
        if (adv === 'everything') {
          runCmd(`advancement grant ${cleanUser} everything`);
        } else {
          runCmd(`advancement grant ${cleanUser} only ${adv}`);
        }
        return { success: true, message: `Granted advancement ${adv} to ${cleanUser}` };
      }

      case 'advancement-revoke': {
        if (!cleanUser) throw new Error('Username is required.');
        const adv = advancement || 'everything';
        if (adv === 'everything') {
          runCmd(`advancement revoke ${cleanUser} everything`);
        } else {
          runCmd(`advancement revoke ${cleanUser} only ${adv}`);
        }
        return { success: true, message: `Revoked advancement ${adv} from ${cleanUser}` };
      }

      case 'set-xp': {
        if (!cleanUser) throw new Error('Username is required.');
        const mode = actionData.mode || 'set';
        const amount = parseInt(actionData.level ?? actionData.amount, 10) || 0;
        if (mode === 'add') {
          runCmd(`xp add ${cleanUser} ${amount} levels`);
          return { success: true, message: `Added ${amount} XP levels to ${cleanUser}` };
        } else if (mode === 'points') {
          runCmd(`xp set ${cleanUser} ${amount} points`);
          return { success: true, message: `Set ${cleanUser}'s XP points to ${amount}` };
        } else {
          runCmd(`xp set ${cleanUser} ${amount} levels`);
          return { success: true, message: `Set XP level of ${cleanUser} to ${amount}` };
        }
      }

      case 'heal': {
        if (!cleanUser) throw new Error('Username is required.');
        runCmd(`effect give ${cleanUser} instant_health 1 255`);
        runCmd(`effect give ${cleanUser} saturation 1 255`);
        return { success: true, message: `Fully healed and fed ${cleanUser}` };
      }

      case 'feed': {
        if (!cleanUser) throw new Error('Username is required.');
        runCmd(`effect give ${cleanUser} saturation 1 255`);
        return { success: true, message: `Fed ${cleanUser}` };
      }

      case 'custom-health': {
        if (!cleanUser) throw new Error('Username is required.');
        const hp = parseInt(actionData.health || actionData.amount, 10) || 20;
        if (hp > 20) {
          runCmd(`attribute ${cleanUser} max_health base set ${hp}`);
          runCmd(`attribute ${cleanUser} generic.max_health base set ${hp}`);
          runCmd(`effect give ${cleanUser} instant_health 1 255`);
          return { success: true, message: `Set ${cleanUser}'s Max Health to ${hp} HP (${hp / 2} hearts)` };
        } else if (hp <= 0) {
          runCmd(`kill ${cleanUser}`);
          return { success: true, message: `Eliminated ${cleanUser}` };
        } else {
          runCmd(`attribute ${cleanUser} max_health base set 20`);
          runCmd(`attribute ${cleanUser} generic.max_health base set 20`);
          runCmd(`effect give ${cleanUser} instant_health 1 255`);
          const diff = 20 - hp;
          if (diff > 0) {
            runCmd(`damage ${cleanUser} ${diff}`);
          }
          return { success: true, message: `Set ${cleanUser}'s Health to ${hp} HP (${hp / 2} hearts)` };
        }
      }

      case 'custom-food': {
        if (!cleanUser) throw new Error('Username is required.');
        const food = parseInt(actionData.food || actionData.amount, 10) || 20;
        if (food <= 0) {
          runCmd(`effect give ${cleanUser} hunger 10 255`);
          return { success: true, message: `Set ${cleanUser}'s hunger to 0 (starving)` };
        } else {
          runCmd(`effect give ${cleanUser} saturation 1 ${Math.min(255, Math.max(1, Math.floor(food / 2)))}`);
          return { success: true, message: `Set ${cleanUser}'s food level to ${food} / 20` };
        }
      }

      case 'potion-effect': {
        if (!cleanUser) throw new Error('Username is required.');
        const eff = (actionData.effect || 'speed').replace(/^minecraft:/, '');
        const dur = parseInt(actionData.duration, 10) || 60;
        const amp = parseInt(actionData.amplifier, 10) || 0;
        const hidePart = actionData.hideParticles ? ' true' : '';
        runCmd(`effect give ${cleanUser} ${eff} ${dur} ${amp}${hidePart}`);
        return { success: true, message: `Applied effect ${eff} Lv.${amp + 1} (${dur}s) to ${cleanUser}` };
      }

      case 'clear-effects': {
        if (!cleanUser) throw new Error('Username is required.');
        runCmd(`effect clear ${cleanUser}`);
        return { success: true, message: `Cleared all potion effects from ${cleanUser}` };
      }

      case 'custom-command': {
        if (!actionData.command) throw new Error('Command is required.');
        const uuid = await this.resolveUUID(serverDir, cleanUser);
        let cmd = actionData.command.trim();
        if (cmd.startsWith('/')) cmd = cmd.substring(1);
        cmd = cmd
          .replace(/{player}/gi, cleanUser)
          .replace(/{username}/gi, cleanUser)
          .replace(/{uuid}/gi, uuid);
        runCmd(cmd);
        return { success: true, message: `Executed command: /${cmd}` };
      }

      default:
        throw new Error(`Unknown player action: ${action}`);
    }
  }
}

module.exports = new PlayerService();
