const express = require('express');
const router = express.Router({ mergeParams: true });
const fs = require('fs');
const path = require('path');
const config = require('../config/config');
const { query } = require('../database/db');
const playerService = require('../services/playerService');
const { authenticate, requireServerAccess } = require('../middleware/auth');
const { logActivity } = require('../services/activityService');

// 1. Get all player data for a server (DARKONYX player manager format)
router.get('/', authenticate, requireServerAccess(), async (req, res) => {
  try {
    const serverId = req.params.serverId || req.params.id;
    const rawData = await playerService.getServerPlayersData(serverId);
    const server = await query.get('SELECT * FROM servers WHERE id = ?', [serverId]);
    const alloc = server?.allocation_id ? await query.get('SELECT ip, port FROM allocations WHERE id = ?', [server.allocation_id]) : null;

    const onlineList = rawData.onlinePlayers || [];
    const bannedList = (rawData.bannedPlayers || []).map(p => ({
      name: p.name || 'Unknown',
      uuid: p.uuid || '',
      reason: p.reason || 'Banned by operator',
      avatar: `https://mc-heads.net/avatar/${p.name || p.uuid}/48`
    }));
    const whiteList = (rawData.whitelist || []).map(p => ({
      name: p.name || 'Unknown',
      uuid: p.uuid || '',
      avatar: `https://mc-heads.net/avatar/${p.name || p.uuid}/48`
    }));
    const opsList = (rawData.ops || []).map(p => ({
      name: p.name || 'Unknown',
      uuid: p.uuid || '',
      avatar: `https://mc-heads.net/avatar/${p.name || p.uuid}/48`
    }));
    const bannedIps = (rawData.bannedIps || []).map(b => typeof b === 'string' ? { ip: b, reason: 'Banned IP' } : b);
    const allList = (rawData.allPlayers || []).map(p => ({
      name: p.name || 'Unknown',
      uuid: p.uuid || '',
      avatar: `https://mc-heads.net/avatar/${p.name || p.uuid}/48`
    }));

    const response = {
      success: true,
      ...rawData,
      info: {
        hostname: server?.name || rawData.serverName || 'Minecraft Server',
        ip: alloc?.ip || '127.0.0.1',
        port: alloc?.port || rawData.port || 25565,
        version: {
          name: server?.jar_type ? `${server.jar_type} ${server.jar_version || ''}` : 'Minecraft'
        },
        motd: {
          formatted: server?.description || 'A Minecraft Server Powered by DARKONYX PANEL'
        },
        numplayers: onlineList.length,
        maxplayers: rawData.playerCounts?.max || 20
      },
      players: {
        online: onlineList,
        banned: bannedList,
        whitelisted: whiteList,
        ops: opsList,
        banned_ips: bannedIps,
        all: allList,
        counts: {
          all: allList.length,
          banned: bannedList.length,
          whitelisted: whiteList.length,
          ops: opsList.length,
          banned_ips: bannedIps.length
        }
      }
    };

    res.json(response);
  } catch (err) {
    console.error('[serverPlayerRoutes] Fetch error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// 2. Detected Worlds Endpoint
router.get('/detected-worlds', authenticate, requireServerAccess(), async (req, res) => {
  try {
    const serverId = req.params.serverId || req.params.id;
    const serverDir = path.join(config.SERVERS_DIR, `server${serverId}`);
    let detected = [];

    if (fs.existsSync(serverDir)) {
      const entries = fs.readdirSync(serverDir, { withFileTypes: true });
      for (const ent of entries) {
        if (ent.isDirectory()) {
          const hasLevel = fs.existsSync(path.join(serverDir, ent.name, 'level.dat'));
          const hasData = fs.existsSync(path.join(serverDir, ent.name, 'playerdata'));
          if (hasLevel || hasData) {
            detected.push({ name: ent.name, has_player_data: hasData });
          }
        }
      }
    }

    if (detected.length === 0) {
      detected = [{ name: 'world', has_player_data: false }];
    }

    res.json({ success: true, worlds: detected });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 3. Get specific player details: Inventory, Statistics & Advancements
router.get('/:player/details', authenticate, requireServerAccess(), async (req, res) => {
  try {
    const serverId = req.params.serverId || req.params.id;
    const player = req.params.player;
    const details = await playerService.getPlayerDetails(serverId, player);
    res.json({ success: true, ...details });
  } catch (err) {
    console.error('[serverPlayerRoutes] Player details error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// 4. Execute DARKONYX player management action
router.post('/action', authenticate, requireServerAccess(), async (req, res) => {
  try {
    const serverId = req.params.serverId || req.params.id;
    const { action, username } = req.body;

    if (!action) {
      return res.status(400).json({ success: false, error: 'Action parameter is required.' });
    }

    // Map any alternate action names
    let normalizedAction = action;
    if (action === 'whitelist') normalizedAction = 'whitelist-add';
    if (action === 'unwhitelist') normalizedAction = 'whitelist-remove';
    if (action === 'whisper') normalizedAction = 'message';
    if (action === 'clear-inventory') normalizedAction = 'clear';

    const result = await playerService.executeAction(serverId, {
      ...req.body,
      action: normalizedAction
    });

    logActivity(
      req.user.id,
      serverId,
      'PLAYER_' + normalizedAction.toUpperCase().replace(/-/g, '_'),
      result.message || `Executed ${normalizedAction} on ${username || 'server'}`,
      req
    );

    res.json(result);
  } catch (err) {
    console.error('[serverPlayerRoutes] Action error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
