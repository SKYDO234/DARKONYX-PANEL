const express = require('express');
const router = express.Router({ mergeParams: true });
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

const { query } = require('../database/db');
const config = require('../config/config');
const { authenticate, requireServerAccess } = require('../middleware/auth');
const runnerService = require('../services/runnerService');
const mcjarsService = require('../services/mcjarsService');
const imagesConfig = require('../config/images');
const { logActivity } = require('../services/activityService');

/**
 * Helper: Resolve master server and current server context
 */
async function resolveMaster(serverId) {
  const server = await query.get('SELECT * FROM servers WHERE id = ?', [serverId]);
  if (!server) return null;

  if (server.parent_id) {
    const master = await query.get('SELECT * FROM servers WHERE id = ?', [server.parent_id]);
    if (master) {
      return { master, currentServer: server, isSplit: true };
    }
  }

  return { master: server, currentServer: server, isSplit: false };
}

/**
 * Helper: Calculate resource allocation pool for a master server
 */
async function calculateResources(master) {
  const splits = await query.all(
    `SELECT s.*, a.port as assigned_port, a.ip as assigned_ip 
     FROM servers s 
     LEFT JOIN allocations a ON s.allocation_id = a.id 
     WHERE s.parent_id = ? 
     ORDER BY s.id ASC`,
    [master.id]
  );

  // Settings
  let reservedCpu = 10;
  let reservedMem = 256;
  let reservedDisk = 512;
  let defaultLimit = 3;

  try {
    const sCpu = await query.get("SELECT `value` FROM settings WHERE `key` = 'splitter_reserved_cpu'");
    if (sCpu && sCpu.value) reservedCpu = parseInt(sCpu.value, 10);
    const sMem = await query.get("SELECT `value` FROM settings WHERE `key` = 'splitter_reserved_memory'");
    if (sMem && sMem.value) reservedMem = parseInt(sMem.value, 10);
    const sDisk = await query.get("SELECT `value` FROM settings WHERE `key` = 'splitter_reserved_disk'");
    if (sDisk && sDisk.value) reservedDisk = parseInt(sDisk.value, 10);
    const sLim = await query.get("SELECT `value` FROM settings WHERE `key` = 'splitter_default_limit'");
    if (sLim && sLim.value) defaultLimit = parseInt(sLim.value, 10);
  } catch (e) {}

  const splitsLimit = master.splitter_limit || defaultLimit;
  const splitsCount = splits.length;
  const splitsRemaining = Math.max(0, splitsLimit - splitsCount);

  // Used by child splits
  const usedCpu = splits.reduce((acc, s) => acc + (parseInt(s.cpu_limit, 10) || 0), 0);
  const usedMem = splits.reduce((acc, s) => acc + (parseInt(s.memory_mb, 10) || 0), 0);
  const usedDisk = splits.reduce((acc, s) => acc + (parseInt(s.disk_mb, 10) || 0), 0);

  // Total resources on master
  const totalCpu = parseInt(master.cpu_limit, 10) || 100;
  const totalMem = parseInt(master.memory_mb, 10) || 1024;
  const totalDisk = parseInt(master.disk_mb, 10) || 5120;

  // Remaining for new splits (respecting reserved master minimums)
  const remainingCpu = Math.max(0, totalCpu - reservedCpu - usedCpu);
  const remainingMem = Math.max(0, totalMem - reservedMem - usedMem);
  const remainingDisk = Math.max(0, totalDisk - reservedDisk - usedDisk);

  return {
    total: {
      cpu: totalCpu,
      memory: totalMem,
      disk: totalDisk,
      splits: splitsLimit
    },
    used: {
      cpu: usedCpu,
      memory: usedMem,
      disk: usedDisk,
      splits: splitsCount
    },
    remaining: {
      cpu: remainingCpu,
      memory: remainingMem,
      disk: remainingDisk,
      splits: splitsRemaining
    },
    reserved: {
      cpu: reservedCpu,
      memory: reservedMem,
      disk: reservedDisk
    },
    splits
  };
}

/**
 * GET / - Get Server Splitter data and pool status
 */
router.get('/', authenticate, requireServerAccess('settings.read'), async (req, res) => {
  try {
    const serverId = req.params.serverId;
    const context = await resolveMaster(serverId);
    if (!context) {
      return res.status(404).json({ success: false, error: 'Server not found.' });
    }

    const { master, currentServer, isSplit } = context;
    const pool = await calculateResources(master);

    // Attach runtime live status for child servers
    const enrichedServers = pool.splits.map(s => {
      const isRunning = runnerService.isServerRunning(s.id);
      return {
        ...s,
        status: isRunning ? 'running' : (s.status === 'starting' ? 'starting' : 'offline')
      };
    });

    res.json({
      success: true,
      master: {
        id: master.id,
        name: master.name,
        uuid: master.uuid,
        server_type: master.server_type,
        cpu_limit: master.cpu_limit,
        memory_mb: master.memory_mb,
        disk_mb: master.disk_mb,
        splitter_limit: master.splitter_limit
      },
      current_server: {
        id: currentServer.id,
        name: currentServer.name,
        uuid: currentServer.uuid,
        is_split: isSplit,
        parent_id: currentServer.parent_id
      },
      is_split: isSplit,
      resources: {
        total: pool.total,
        used: pool.used,
        remaining: pool.remaining,
        reserved: pool.reserved
      },
      servers: enrichedServers
    });
  } catch (err) {
    console.error('Server Splitter index error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /templates - Get available server types & templates for splitting
 */
router.get('/templates', authenticate, requireServerAccess('settings.read'), async (req, res) => {
  try {
    const templates = [
      {
        id: 'minecraft',
        name: 'Minecraft: Java Edition',
        icon: 'box',
        badge: 'Gaming',
        desc: 'High-performance Minecraft server (Paper, Purpur, Spigot, Vanilla)',
        defaultMemory: 1024,
        defaultCpu: 100,
        defaultDisk: 5120,
        jars: [
          { type: 'paper', name: 'Paper (Recommended for Performance & Plugins)' },
          { type: 'purpur', name: 'Purpur (Paper + Configurable Gameplay Mechanics)' },
          { type: 'spigot', name: 'Spigot (Standard Plugin Engine)' },
          { type: 'vanilla', name: 'Vanilla Minecraft (Official Mojang Server)' },
          { type: 'velocity', name: 'Velocity (Modern High-Speed Proxy)' },
          { type: 'bungeecord', name: 'BungeeCord (Multi-Server Proxy)' }
        ]
      },
      {
        id: 'nodejs',
        name: 'Node.js Application',
        icon: 'code',
        badge: 'Web / Bot',
        desc: 'Run Discord bots, Express APIs, or custom JavaScript services',
        defaultMemory: 512,
        defaultCpu: 50,
        defaultDisk: 2048
      },
      {
        id: 'python',
        name: 'Python Application',
        icon: 'terminal',
        badge: 'AI / Bot',
        desc: 'Run Python 3.12 bots, FastAPI, Flask, or data scripts',
        defaultMemory: 512,
        defaultCpu: 50,
        defaultDisk: 2048
      },
      {
        id: 'lumenvm',
        name: 'LumenVM Virtual Machine',
        icon: 'cpu',
        badge: 'Linux VM',
        desc: 'Lightweight Linux VM instance with SSH and optional NoKVM support',
        defaultMemory: 1024,
        defaultCpu: 100,
        defaultDisk: 5120
      }
    ];

    res.json({ success: true, templates });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST / - Create a split server from master server resources
 */
router.post('/', authenticate, requireServerAccess('settings.write'), async (req, res) => {
  try {
    const serverId = req.params.serverId;
    const context = await resolveMaster(serverId);
    if (!context) {
      return res.status(404).json({ success: false, error: 'Master server not found.' });
    }

    const { master } = context;
    const pool = await calculateResources(master);

    if (pool.used.splits >= pool.total.splits) {
      return res.status(400).json({
        success: false,
        error: `Cannot create more splits. Master server limit is ${pool.total.splits} split servers.`
      });
    }

    const {
      name,
      description,
      server_type,
      cpu_limit,
      memory_mb,
      disk_mb,
      mc_jar_type,
      mc_jar_version,
      sync_subusers
    } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({ success: false, error: 'Split server name is required.' });
    }

    const targetType = server_type || 'minecraft';
    const reqCpu = parseInt(cpu_limit, 10);
    const reqMem = parseInt(memory_mb, 10);
    const reqDisk = parseInt(disk_mb, 10);

    if (isNaN(reqCpu) || reqCpu < 5) {
      return res.status(400).json({ success: false, error: 'CPU must be at least 5%.' });
    }
    if (isNaN(reqMem) || reqMem < 128) {
      return res.status(400).json({ success: false, error: 'Memory must be at least 128 MB.' });
    }
    if (isNaN(reqDisk) || reqDisk < 256) {
      return res.status(400).json({ success: false, error: 'Disk must be at least 256 MB.' });
    }

    if (reqCpu > pool.remaining.cpu) {
      return res.status(400).json({
        success: false,
        error: `Requested CPU (${reqCpu}%) exceeds available pool (${pool.remaining.cpu}%).`
      });
    }
    if (reqMem > pool.remaining.memory) {
      return res.status(400).json({
        success: false,
        error: `Requested Memory (${reqMem} MB) exceeds available pool (${pool.remaining.memory} MB).`
      });
    }
    if (reqDisk > pool.remaining.disk) {
      return res.status(400).json({
        success: false,
        error: `Requested Disk (${reqDisk} MB) exceeds available pool (${pool.remaining.disk} MB).`
      });
    }

    // Pick or create port allocation on master's node
    let alloc = await query.get(
      'SELECT id, ip, port FROM allocations WHERE assigned = 0 AND node_id = ? ORDER BY port ASC LIMIT 1',
      [master.node_id]
    );

    if (!alloc) {
      // Auto-create next port allocation
      const maxAlloc = await query.get('SELECT MAX(port) as max_port FROM allocations WHERE node_id = ?', [master.node_id]);
      const nextPort = (maxAlloc && maxAlloc.max_port ? maxAlloc.max_port + 1 : 25567);
      const masterAlloc = await query.get('SELECT ip FROM allocations WHERE id = ?', [master.allocation_id]);
      const targetIp = masterAlloc ? masterAlloc.ip : '0.0.0.0';

      const createAlloc = await query.run(
        'INSERT INTO allocations (node_id, ip, port, assigned) VALUES (?, ?, ?, 0)',
        [master.node_id, targetIp, nextPort]
      );
      alloc = { id: createAlloc.lastID, ip: targetIp, port: nextPort };
    }

    // Determine Docker Image and Startup Command
    let defaultImg = '';
    let defaultCmd = '';

    if (targetType === 'minecraft') {
      defaultImg = imagesConfig.minecraft[1].value; // Java 21
      defaultCmd = 'java -Xms128M -Xmx{{SERVER_MEMORY}}M -jar server.jar nogui';
    } else if (targetType === 'nodejs') {
      defaultImg = imagesConfig.nodejs[5].value; // Node 20
      defaultCmd = 'if [ -f package.json ]; then npm install; fi; npm start';
    } else if (targetType === 'python') {
      defaultImg = imagesConfig.python[1].value; // Python 3.12
      defaultCmd = 'if [ -f requirements.txt ]; then pip install -r requirements.txt; fi; python3 app.py';
    } else if (targetType === 'lumenvm' || targetType === 'vm') {
      defaultImg = imagesConfig.lumenvm[0].value;
      defaultCmd = '/start.sh';
    } else {
      defaultImg = imagesConfig.minecraft[1].value;
      defaultCmd = 'java -Xms128M -Xmx{{SERVER_MEMORY}}M -jar server.jar nogui';
    }

    const splitUuid = uuidv4();
    const envVars = {
      SERVER_NAME: name.trim(),
      SERVER_PORT: String(alloc.port),
      SERVER_MEMORY: String(reqMem)
    };

    // Insert split server record
    const insertResult = await query.run(`
      INSERT INTO servers (
        uuid, name, description, user_id, node_id, allocation_id,
        server_type, docker_image, startup_cmd, memory_mb, cpu_limit,
        disk_mb, status, env_vars, jar_type, jar_version,
        parent_id, is_split, splitter_limit
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'offline', ?, ?, ?, ?, 1, 0)
    `, [
      splitUuid,
      name.trim(),
      description || `Split server of ${master.name}`,
      master.user_id,
      master.node_id,
      alloc.id,
      targetType,
      defaultImg,
      defaultCmd,
      reqMem,
      reqCpu,
      reqDisk,
      JSON.stringify(envVars),
      mc_jar_type || (targetType === 'minecraft' ? 'paper' : null),
      mc_jar_version || (targetType === 'minecraft' ? '1.21.4' : null),
      master.id
    ]);

    const newSplitId = insertResult.lastID;

    // Mark allocation as assigned
    await query.run('UPDATE allocations SET server_id = ?, assigned = 1 WHERE id = ?', [newSplitId, alloc.id]);

    // Initialize server directory on disk
    const serverDir = path.join(config.SERVERS_DIR, `server${newSplitId}`);
    if (!fs.existsSync(serverDir)) {
      fs.mkdirSync(serverDir, { recursive: true });
    }

    // Seed default files
    if (targetType === 'minecraft') {
      runnerService.syncMinecraftProperties(serverDir, alloc.port);
      if (mc_jar_type && mc_jar_version) {
        mcjarsService.installJarToServer(newSplitId, mc_jar_type, mc_jar_version).catch(e => console.warn('Async jar install warning:', e.message));
      }
    } else if (targetType === 'nodejs') {
      const pkg = {
        name: name.toLowerCase().replace(/[^a-z0-9]/g, '-'),
        version: '1.0.0',
        main: 'index.js',
        scripts: { start: 'node index.js' },
        dependencies: { express: '^4.18.2' }
      };
      fs.writeFileSync(path.join(serverDir, 'package.json'), JSON.stringify(pkg, null, 2));
      fs.writeFileSync(path.join(serverDir, 'index.js'), `// Split Server: ${name}\nconst http = require('http');\nconst port = process.env.PORT || ${alloc.port};\nconst server = http.createServer((req, res) => {\n  res.writeHead(200, { 'Content-Type': 'text/plain' });\n  res.end('Hello from Split Server: ${name}!\\n');\n});\nserver.listen(port, () => console.log('Listening on port ' + port));\n`);
    } else if (targetType === 'python') {
      fs.writeFileSync(path.join(serverDir, 'requirements.txt'), '# Add requirements here\n');
      fs.writeFileSync(path.join(serverDir, 'app.py'), `# Split Server: ${name}\nimport http.server\nimport socketserver\nimport os\n\nPORT = int(os.environ.get('PORT', ${alloc.port}))\nHandler = http.server.SimpleHTTPRequestHandler\nwith socketserver.TCPServer(('', PORT), Handler) as httpd:\n    print(f'Serving at port {PORT}')\n    httpd.serve_forever()\n`);
    }

    // Optionally sync subusers from master
    if (sync_subusers) {
      try {
        const masterSubusers = await query.all('SELECT user_id, permissions FROM subusers WHERE server_id = ?', [master.id]);
        for (const sub of masterSubusers) {
          await query.run(
            'INSERT INTO subusers (server_id, user_id, permissions) VALUES (?, ?, ?)',
            [newSplitId, sub.user_id, sub.permissions]
          );
        }
      } catch (e) {
        console.warn('Could not sync subusers to split server:', e);
      }
    }

    logActivity(
      req.user.id,
      master.id,
      'SERVER_SPLIT_CREATED',
      `Created child split server "${name.trim()}" (ID: ${newSplitId}) with ${reqMem}MB RAM, ${reqCpu}% CPU, ${reqDisk}MB Disk`,
      req
    );

    res.json({
      success: true,
      message: `Split server "${name.trim()}" created successfully.`,
      server: {
        id: newSplitId,
        uuid: splitUuid,
        name: name.trim(),
        server_type: targetType,
        memory_mb: reqMem,
        cpu_limit: reqCpu,
        disk_mb: reqDisk,
        port: alloc.port,
        parent_id: master.id
      }
    });
  } catch (err) {
    console.error('Create split server error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * PUT /:splitId - Resize an existing split server
 */
router.put('/:splitId', authenticate, requireServerAccess('settings.write'), async (req, res) => {
  try {
    const serverId = req.params.serverId;
    const splitId = parseInt(req.params.splitId, 10);

    const context = await resolveMaster(serverId);
    if (!context) {
      return res.status(404).json({ success: false, error: 'Master server not found.' });
    }

    const { master } = context;
    const split = await query.get('SELECT * FROM servers WHERE id = ? AND parent_id = ?', [splitId, master.id]);
    if (!split) {
      return res.status(404).json({ success: false, error: 'Split server not found under this master.' });
    }

    const { cpu_limit, memory_mb, disk_mb } = req.body;
    const newCpu = parseInt(cpu_limit, 10);
    const newMem = parseInt(memory_mb, 10);
    const newDisk = parseInt(disk_mb, 10);

    if (isNaN(newCpu) || newCpu < 5) return res.status(400).json({ success: false, error: 'CPU must be at least 5%.' });
    if (isNaN(newMem) || newMem < 128) return res.status(400).json({ success: false, error: 'Memory must be at least 128 MB.' });
    if (isNaN(newDisk) || newDisk < 256) return res.status(400).json({ success: false, error: 'Disk must be at least 256 MB.' });

    // Calculate pool without the current split's old allocations
    const otherSplits = await query.all('SELECT cpu_limit, memory_mb, disk_mb FROM servers WHERE parent_id = ? AND id != ?', [master.id, splitId]);
    const otherCpu = otherSplits.reduce((acc, s) => acc + (parseInt(s.cpu_limit, 10) || 0), 0);
    const otherMem = otherSplits.reduce((acc, s) => acc + (parseInt(s.memory_mb, 10) || 0), 0);
    const otherDisk = otherSplits.reduce((acc, s) => acc + (parseInt(s.disk_mb, 10) || 0), 0);

    let reservedCpu = 10, reservedMem = 256, reservedDisk = 512;
    try {
      const sCpu = await query.get("SELECT `value` FROM settings WHERE `key` = 'splitter_reserved_cpu'");
      if (sCpu && sCpu.value) reservedCpu = parseInt(sCpu.value, 10);
      const sMem = await query.get("SELECT `value` FROM settings WHERE `key` = 'splitter_reserved_memory'");
      if (sMem && sMem.value) reservedMem = parseInt(sMem.value, 10);
      const sDisk = await query.get("SELECT `value` FROM settings WHERE `key` = 'splitter_reserved_disk'");
      if (sDisk && sDisk.value) reservedDisk = parseInt(sDisk.value, 10);
    } catch (e) {}

    const maxAvailCpu = Math.max(0, (parseInt(master.cpu_limit, 10) || 100) - reservedCpu - otherCpu);
    const maxAvailMem = Math.max(0, (parseInt(master.memory_mb, 10) || 1024) - reservedMem - otherMem);
    const maxAvailDisk = Math.max(0, (parseInt(master.disk_mb, 10) || 5120) - reservedDisk - otherDisk);

    if (newCpu > maxAvailCpu) {
      return res.status(400).json({ success: false, error: `CPU ${newCpu}% exceeds maximum available for this split (${maxAvailCpu}%).` });
    }
    if (newMem > maxAvailMem) {
      return res.status(400).json({ success: false, error: `Memory ${newMem} MB exceeds maximum available for this split (${maxAvailMem} MB).` });
    }
    if (newDisk > maxAvailDisk) {
      return res.status(400).json({ success: false, error: `Disk ${newDisk} MB exceeds maximum available for this split (${maxAvailDisk} MB).` });
    }

    await query.run('UPDATE servers SET cpu_limit = ?, memory_mb = ?, disk_mb = ? WHERE id = ?', [newCpu, newMem, newDisk, splitId]);

    logActivity(
      req.user.id,
      master.id,
      'SERVER_SPLIT_RESIZED',
      `Resized split server #${splitId} (${split.name}) to ${newMem}MB RAM, ${newCpu}% CPU, ${newDisk}MB Disk`,
      req
    );

    res.json({
      success: true,
      message: `Split server #${splitId} resized successfully.`,
      server: { id: splitId, memory_mb: newMem, cpu_limit: newCpu, disk_mb: newDisk }
    });
  } catch (err) {
    console.error('Resize split server error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * DELETE /:splitId - Delete split server and refund resources back to master pool
 */
router.delete('/:splitId', authenticate, requireServerAccess('settings.write'), async (req, res) => {
  try {
    const serverId = req.params.serverId;
    const splitId = parseInt(req.params.splitId, 10);

    const context = await resolveMaster(serverId);
    if (!context) {
      return res.status(404).json({ success: false, error: 'Master server not found.' });
    }

    const { master } = context;
    const split = await query.get('SELECT * FROM servers WHERE id = ? AND parent_id = ?', [splitId, master.id]);
    if (!split) {
      return res.status(404).json({ success: false, error: 'Split server not found under this master.' });
    }

    // 1. Stop container if running
    try {
      if (runnerService.isServerRunning(splitId)) {
        await runnerService.stopServer(splitId);
      }
    } catch (e) {
      console.warn(`Warning stopping split server container ${splitId}:`, e.message);
    }

    // 2. Free allocation
    if (split.allocation_id) {
      await query.run('UPDATE allocations SET server_id = NULL, assigned = 0 WHERE id = ?', [split.allocation_id]);
    }

    // 3. Remove files
    const serverDir = path.join(config.SERVERS_DIR, `server${splitId}`);
    try {
      if (fs.existsSync(serverDir)) {
        fs.rmSync(serverDir, { recursive: true, force: true });
      }
    } catch (e) {
      console.warn(`Warning deleting split server folder ${serverDir}:`, e.message);
    }

    // 4. Remove associated records
    try { await query.run('DELETE FROM subusers WHERE server_id = ?', [splitId]); } catch (e) {}
    try { await query.run('DELETE FROM backups WHERE server_id = ?', [splitId]); } catch (e) {}
    try { await query.run('DELETE FROM schedules WHERE server_id = ?', [splitId]); } catch (e) {}
    try { await query.run('DELETE FROM server_databases WHERE server_id = ?', [splitId]); } catch (e) {}

    // 5. Delete server record
    await query.run('DELETE FROM servers WHERE id = ?', [splitId]);

    logActivity(
      req.user.id,
      master.id,
      'SERVER_SPLIT_DELETED',
      `Deleted split server #${splitId} (${split.name}). Refunded ${split.memory_mb}MB RAM, ${split.cpu_limit}% CPU back to master pool.`,
      req
    );

    res.json({
      success: true,
      message: `Split server "${split.name}" deleted. All allocated resources have been refunded to ${master.name}.`
    });
  } catch (err) {
    console.error('Delete split server error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /:splitId/sync-subusers - Sync subusers from master to split server
 */
router.post('/:splitId/sync-subusers', authenticate, requireServerAccess('settings.write'), async (req, res) => {
  try {
    const serverId = req.params.serverId;
    const splitId = parseInt(req.params.splitId, 10);

    const context = await resolveMaster(serverId);
    if (!context) {
      return res.status(404).json({ success: false, error: 'Master server not found.' });
    }

    const { master } = context;
    const split = await query.get('SELECT * FROM servers WHERE id = ? AND parent_id = ?', [splitId, master.id]);
    if (!split) {
      return res.status(404).json({ success: false, error: 'Split server not found under this master.' });
    }

    const masterSubusers = await query.all('SELECT user_id, permissions FROM subusers WHERE server_id = ?', [master.id]);
    let synced = 0;

    for (const sub of masterSubusers) {
      const existing = await query.get('SELECT id FROM subusers WHERE server_id = ? AND user_id = ?', [splitId, sub.user_id]);
      if (!existing) {
        await query.run('INSERT INTO subusers (server_id, user_id, permissions) VALUES (?, ?, ?)', [splitId, sub.user_id, sub.permissions]);
        synced++;
      } else {
        await query.run('UPDATE subusers SET permissions = ? WHERE id = ?', [sub.permissions, existing.id]);
        synced++;
      }
    }

    res.json({ success: true, message: `Synced ${synced} subusers to ${split.name}.` });
  } catch (err) {
    console.error('Sync subusers error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
