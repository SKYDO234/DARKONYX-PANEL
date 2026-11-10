const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('crypto').randomUUID ? { v4: require('crypto').randomUUID } : { v4: () => Math.random().toString(36).substring(2, 15) };
const config = require('../config/config');
const { query } = require('../database/db');
const { authenticate, requireAdmin, requireServerAccess } = require('../middleware/auth');
const runnerService = require('../services/runnerService');
const mcjarsService = require('../services/mcjarsService');
const dockerService = require('../services/dockerService');
const { logActivity } = require('../services/activityService');
const imagesConfig = require('../config/images');

// List Servers
router.get('/', authenticate, async (req, res) => {
  try {
    let servers = [];
    if (req.user.role === 'admin') {
      servers = await query.all(`
        SELECT s.*, u.username as owner_username, u.email as owner_email,
               u.role as owner_role, u.suspended as owner_suspended,
               a.ip, a.port, n.name as node_name
        FROM servers s
        LEFT JOIN users u ON s.user_id = u.id
        LEFT JOIN allocations a ON s.allocation_id = a.id
        LEFT JOIN nodes n ON s.node_id = n.id
        ORDER BY s.id DESC
      `);
    } else {
      // User's own servers + subuser servers
      servers = await query.all(`
        SELECT s.*, u.username as owner_username, u.email as owner_email,
               a.ip, a.port, n.name as node_name,
               sub.permissions as subuser_permissions
        FROM servers s
        LEFT JOIN users u ON s.user_id = u.id
        LEFT JOIN allocations a ON s.allocation_id = a.id
        LEFT JOIN nodes n ON s.node_id = n.id
        LEFT JOIN subusers sub ON (sub.server_id = s.id AND sub.user_id = ?)
        WHERE s.user_id = ? OR sub.id IS NOT NULL
        ORDER BY s.id DESC
      `, [req.user.id, req.user.id]);
    }

    // Attach runtime live status to servers
    const enriched = servers.map(s => {
      const isSuspended = !!s.is_suspended;
      if (isSuspended) {
        return { ...s, status: 'suspended', is_running: false };
      }
      const liveStatus = runnerService.getServerStatus(s.id);
      const effectiveStatus = (liveStatus && liveStatus !== 'offline') ? liveStatus : (s.status || 'offline');
      return {
        ...s,
        status: effectiveStatus,
        is_running: effectiveStatus === 'running'
      };
    });

    res.json({ success: true, servers: enriched });
  } catch (err) {
    console.error('List servers error:', err);
    res.status(500).json({ success: false, error: 'Failed to retrieve servers.' });
  }
});

// Create Server (Admin Only)
router.post('/', authenticate, requireAdmin, async (req, res) => {
  try {
    let {
      name,
      description,
      server_type,
      docker_image,
      startup_cmd,
      memory_mb,
      cpu_limit,
      disk_mb,
      user_id,
      node_id,
      allocation_id,
      env_vars,
      mc_jar_type,
      mc_jar_version
    } = req.body;

    if (!name || !server_type) {
      return res.status(400).json({ success: false, error: 'Server name and server type are required.' });
    }

    const targetUserId = (req.user.role === 'admin' && user_id) ? user_id : req.user.id;
    const targetNodeId = node_id || 1;

    // Pick or allocate port
    let allocId = allocation_id;
    if (!allocId) {
      const freeAlloc = await query.get('SELECT id FROM allocations WHERE assigned = 0 AND node_id = ? LIMIT 1', [targetNodeId]);
      if (freeAlloc) {
        allocId = freeAlloc.id;
      }
    }

    // Determine default image & command if not provided
    let defaultImg = docker_image;
    let defaultCmd = startup_cmd;

    if (server_type === 'minecraft') {
      if (!defaultImg && mc_jar_version) {
        defaultImg = mcjarsService.getRecommendedJavaImage(mc_jar_version);
      }
      defaultImg = defaultImg || imagesConfig.minecraft[1].value; // Java 21
      defaultCmd = defaultCmd || 'java -Xms128M -Xmx{{SERVER_MEMORY}}M -jar server.jar nogui';
    } else if (server_type === 'nodejs') {
      defaultImg = defaultImg || imagesConfig.nodejs[5].value; // Node 20
      defaultCmd = defaultCmd || 'if [ -f package.json ]; then npm install; fi; npm start';
    } else if (server_type === 'python') {
      defaultImg = defaultImg || imagesConfig.python[1].value; // Python 3.12
      defaultCmd = defaultCmd || 'if [ -f requirements.txt ]; then pip install -r requirements.txt; fi; python3 app.py';
    } else if (server_type === 'lumenvm' || server_type === 'vm' || server_type === 'nokvm' || server_type === 'lumenvm_nokvm') {
      defaultImg = defaultImg || imagesConfig.lumenvm[0].value; // Debian 12
      defaultCmd = defaultCmd || '/start.sh';
      let parsed = {};
      try { parsed = typeof env_vars === 'string' ? JSON.parse(env_vars || '{}') : (env_vars || {}); } catch (e) {}
      const isServerNokvm = server_type === 'nokvm' || server_type === 'lumenvm_nokvm';
      const rawKvm = String(parsed.KVM || (isServerNokvm ? 'off' : 'on')).toLowerCase();
      const isKvmOff = isServerNokvm || rawKvm === 'off' || rawKvm === 'nokvm' || rawKvm === '0' || rawKvm === 'false' || parsed.NOKVM === '1' || parsed.NOKVM === 1 || parsed.NOKVM === true || parsed.NO_KVM === '1';
      const kvmVal = isKvmOff ? 'off' : (rawKvm === 'auto' ? 'auto' : 'on');
      env_vars = {
        OS_HOSTNAME: parsed.OS_HOSTNAME || 'lumenvm',
        OS_PASSWORD: parsed.OS_PASSWORD || 'admin',
        DISPLAY_MODE: parsed.DISPLAY_MODE || 'ssh',
        KVM: kvmVal,
        NOKVM: isKvmOff ? '1' : '0',
        VM_RAM_MB: parsed.VM_RAM_MB || 'auto',
        VM_DISK_GB: parsed.VM_DISK_GB || 'auto',
        IPV4_MODE: parsed.IPV4_MODE || 'open',
        PACKAGE_UPDATE: parsed.PACKAGE_UPDATE || '0',
        UEFI: parsed.UEFI || '0',
        ...parsed,
        KVM: kvmVal,
        NOKVM: isKvmOff ? '1' : '0'
      };
    }

    const serverUuid = uuidv4();

    const insertResult = await query.run(`
      INSERT INTO servers (
        uuid, name, description, user_id, node_id, allocation_id,
        server_type, docker_image, startup_cmd, memory_mb, cpu_limit,
        disk_mb, status, env_vars, jar_type, jar_version
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'offline', ?, ?, ?)
    `, [
      serverUuid,
      name,
      description || '',
      targetUserId,
      targetNodeId,
      allocId || null,
      server_type,
      defaultImg,
      defaultCmd,
      parseInt(memory_mb || 1024, 10),
      parseInt(cpu_limit || 100, 10),
      parseInt(disk_mb || 5120, 10),
      typeof env_vars === 'object' ? JSON.stringify(env_vars) : (env_vars || '{}'),
      mc_jar_type || null,
      mc_jar_version || null
    ]);

    const newServerId = insertResult.lastID;

    // Mark allocation as assigned and determine assigned port
    let assignedPort = 25565;
    if (allocId) {
      await query.run('UPDATE allocations SET server_id = ?, assigned = 1 WHERE id = ?', [newServerId, allocId]);
      try {
        const allocRow = await query.get('SELECT port FROM allocations WHERE id = ?', [allocId]);
        if (allocRow && allocRow.port) {
          assignedPort = allocRow.port;
        }
      } catch (e) {}
    }

    // Initialize server directory on disk: ./storage/servers/server<id>
    const serverDir = path.join(config.SERVERS_DIR, `server${newServerId}`);
    if (!fs.existsSync(serverDir)) {
      fs.mkdirSync(serverDir, { recursive: true });
    }

    // Seed default template files based on server type
    if (server_type === 'minecraft') {
      runnerService.syncMinecraftProperties(serverDir, assignedPort);
      
      // Auto-install jar if specified
      if (mc_jar_type && mc_jar_version) {
        mcjarsService.installJarToServer(newServerId, mc_jar_type, mc_jar_version).catch(e => console.warn('Async jar install warning:', e.message));
      }
    } else if (server_type === 'nodejs') {
      const samplePkg = {
        name: name.toLowerCase().replace(/\s+/g, '-'),
        version: '1.0.0',
        main: 'index.js',
        scripts: { start: 'node index.js' },
        dependencies: { express: '^4.21.2' }
      };
      fs.writeFileSync(path.join(serverDir, 'package.json'), JSON.stringify(samplePkg, null, 2), 'utf8');
      fs.writeFileSync(path.join(serverDir, 'index.js'), `// DARKONYX PANEL Node.js Application\nconst http = require('http');\nconst port = process.env.PORT || 3000;\n\nconst server = http.createServer((req, res) => {\n  res.writeHead(200, { 'Content-Type': 'text/plain' });\n  res.end('Hello from DARKONYX PANEL Node.js Server! Port: ' + port);\n});\n\nserver.listen(port, () => {\n  console.log('App running on port ' + port);\n});\n`, 'utf8');
    } else if (server_type === 'python') {
      fs.writeFileSync(path.join(serverDir, 'requirements.txt'), '# Add your Python dependencies here\nflask\n', 'utf8');
      fs.writeFileSync(path.join(serverDir, 'app.py'), `# DARKONYX PANEL Python Application\nimport os\nfrom http.server import HTTPServer, BaseHTTPRequestHandler\n\nport = int(os.environ.get('PORT', 5000))\n\nclass Handler(BaseHTTPRequestHandler):\n    def do_GET(self):\n        self.send_response(200)\n        self.send_header('Content-type', 'text/plain')\n        self.end_headers()\n        self.wfile.write(b'Hello from DARKONYX PANEL Python App!')\n\nprint(f"Starting Python server on port {port}...")\nhttpd = HTTPServer(('0.0.0.0', port), Handler)\nhttpd.serve_forever()\n`, 'utf8');
    } else if (server_type === 'lumenvm' || server_type === 'vm' || server_type === 'nokvm' || server_type === 'lumenvm_nokvm') {
      const vmEnv = typeof env_vars === 'object' ? env_vars : {};
      fs.writeFileSync(path.join(serverDir, 'README.txt'), `=== LumenVM Virtual Machine ===\nOS Image: ${defaultImg}\nHostname: ${vmEnv.OS_HOSTNAME || 'lumenvm'}\nAccess Mode: ${vmEnv.DISPLAY_MODE || 'ssh'}\nKVM Mode: ${vmEnv.KVM || 'on'}\nNo-KVM Software Emulation: ${vmEnv.NOKVM === '1' ? 'Active' : 'Disabled'}\nAssigned Port: ${assignedPort}\n\nQEMU virtual disk and machine storage are managed in this directory.\n`, 'utf8');
    }

    logActivity(req.user.id, newServerId, 'SERVER_CREATE', `Created server ${name} (${server_type})`, req);

    res.json({
      success: true,
      serverId: newServerId,
      uuid: serverUuid,
      message: 'Server created successfully!'
    });
  } catch (err) {
    console.error('Server creation error:', err);
    res.status(500).json({ success: false, error: `Failed to create server: ${err.message}` });
  }
});

// Get Server Details
router.get('/:id', authenticate, requireServerAccess('view'), async (req, res) => {
  try {
    const serverId = req.params.id;
    const server = await query.get(`
      SELECT s.*, u.username as owner_username, u.email as owner_email,
             a.ip, a.port, n.name as node_name, n.fqdn as node_fqdn,
             n.sftp_port
      FROM servers s
      LEFT JOIN users u ON s.user_id = u.id
      LEFT JOIN allocations a ON s.allocation_id = a.id
      LEFT JOIN nodes n ON s.node_id = n.id
      WHERE s.id = ?
    `, [serverId]);

    if (!server) {
      return res.status(404).json({ success: false, error: 'Server not found.' });
    }

    const isSuspended = !!server.is_suspended;
    const liveStatus = runnerService.getServerStatus(server.id);
    server.status = isSuspended ? 'suspended' : ((liveStatus && liveStatus !== 'offline') ? liveStatus : (server.status || 'offline'));
    server.is_running = !isSuspended && (server.status === 'running');
    server.sftp_username = `${req.user.username}.${server.id}`;
    server.sftp_host = server.node_fqdn || '127.0.0.1';
    server.sftp_port = server.sftp_port || config.PORT_SFTP;

    res.json({
      success: true,
      server,
      permissions: req.permissions,
      isOwner: req.isOwner
    });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Failed to retrieve server details.' });
  }
});

// Update Server (Details, Build Configuration, Startup, Expiration)
router.put('/:id', authenticate, requireServerAccess('settings.edit'), async (req, res) => {
  try {
    const serverId = req.params.id;
    const {
      name,
      description,
      docker_image,
      startup_cmd,
      memory_mb,
      cpu_limit,
      disk_mb,
      allocation_id,
      user_id,
      env_vars,
      expiration_date,
      is_suspended
    } = req.body;

    const current = req.server;

    // If changing user or build resources, require admin
    const isAdmin = req.user.role === 'admin';
    const targetUserId = (isAdmin && user_id) ? user_id : current.user_id;
    const newMemory = (isAdmin && memory_mb) ? parseInt(memory_mb, 10) : current.memory_mb;
    const newCpu = (isAdmin && cpu_limit) ? parseInt(cpu_limit, 10) : current.cpu_limit;
    const newDisk = (isAdmin && disk_mb) ? parseInt(disk_mb, 10) : current.disk_mb;
    const newExpiration = isAdmin && expiration_date !== undefined ? (expiration_date || null) : current.expiration_date;
    const newSuspended = isAdmin && is_suspended !== undefined ? (is_suspended ? 1 : 0) : (current.is_suspended ? 1 : 0);

    let newAllocId = current.allocation_id;
    if (isAdmin && allocation_id && allocation_id !== current.allocation_id) {
      // Release old allocation
      if (current.allocation_id) {
        await query.run('UPDATE allocations SET server_id = NULL, assigned = 0 WHERE id = ?', [current.allocation_id]);
      }
      // Assign new allocation
      await query.run('UPDATE allocations SET server_id = ?, assigned = 1 WHERE id = ?', [serverId, allocation_id]);
      newAllocId = allocation_id;

      // Immediately sync server.properties if Minecraft
      try {
        const allocRow = await query.get('SELECT port FROM allocations WHERE id = ?', [allocation_id]);
        if (allocRow && allocRow.port) {
          const sDir = path.join(config.SERVERS_DIR, `server${serverId}`);
          runnerService.syncMinecraftProperties(sDir, allocRow.port);
        }
      } catch (e) {}
    }

    let finalEnv = env_vars ? (typeof env_vars === 'object' ? { ...env_vars } : JSON.parse(env_vars || '{}')) : (current.env_vars ? JSON.parse(current.env_vars || '{}') : {});
    const isVmType = current.server_type === 'lumenvm' || current.server_type === 'vm' || current.server_type === 'nokvm' || current.server_type === 'lumenvm_nokvm';
    if (isVmType) {
      const isNokvmType = current.server_type === 'nokvm' || current.server_type === 'lumenvm_nokvm';
      if (isNokvmType) {
        finalEnv.KVM = 'off';
        finalEnv.NOKVM = '1';
        finalEnv.NO_KVM = '1';
      } else if (finalEnv.KVM !== undefined || finalEnv.NOKVM !== undefined) {
        const isOff = finalEnv.KVM === 'off' || finalEnv.KVM === 'nokvm' || finalEnv.NOKVM === '1' || finalEnv.NO_KVM === '1';
        finalEnv.KVM = isOff ? 'off' : ((finalEnv.KVM || '').toLowerCase() === 'auto' ? 'auto' : 'on');
        finalEnv.NOKVM = isOff ? '1' : '0';
        finalEnv.NO_KVM = isOff ? '1' : '0';
      }
    }

    await query.run(`
      UPDATE servers SET
        name = ?,
        description = ?,
        docker_image = ?,
        startup_cmd = ?,
        memory_mb = ?,
        cpu_limit = ?,
        disk_mb = ?,
        user_id = ?,
        allocation_id = ?,
        env_vars = ?,
        expiration_date = ?,
        is_suspended = ?,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `, [
      name || current.name,
      description !== undefined ? description : current.description,
      docker_image || current.docker_image,
      startup_cmd || current.startup_cmd,
      newMemory,
      newCpu,
      newDisk,
      targetUserId,
      newAllocId,
      JSON.stringify(finalEnv),
      newExpiration,
      newSuspended,
      serverId
    ]);

    if (newSuspended && runnerService.isServerRunning(serverId)) {
      await runnerService.stopServer(serverId);
    }

    logActivity(req.user.id, serverId, 'SERVER_UPDATE', 'Updated server settings/build configuration', req);

    res.json({ success: true, message: 'Server updated successfully!' });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Failed to update server.' });
  }
});

// Power Action (Start, Stop, Restart, Kill)
router.post('/:id/power', authenticate, requireServerAccess('power.control'), async (req, res) => {
  try {
    const serverId = req.params.id;
    const { action } = req.body;

    if (!['start', 'stop', 'restart', 'kill'].includes(action)) {
      return res.status(400).json({ success: false, error: 'Invalid power action.' });
    }

    // Auto-suspension protection
    if ((action === 'start' || action === 'restart') && req.server.is_suspended) {
      return res.status(403).json({
        success: false,
        error: 'Cannot start server: This server is suspended due to expiration. Please renew your plan or contact an administrator.'
      });
    }

    let result;
    if (action === 'start') {
      result = await runnerService.startServer(serverId);
    } else if (action === 'stop') {
      result = await runnerService.stopServer(serverId);
    } else if (action === 'restart') {
      result = await runnerService.restartServer(serverId);
    } else if (action === 'kill') {
      result = await runnerService.killServer(serverId);
    }

    logActivity(req.user.id, serverId, `SERVER_${action.toUpperCase()}`, `Triggered ${action}`, req);

    res.json({ success: true, action, result });
  } catch (err) {
    console.error('Power action error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Admin: Quick Suspend / Unsuspend Toggle
router.post('/:id/suspend', authenticate, requireAdmin, async (req, res) => {
  try {
    const serverId = req.params.id;
    const autoSuspensionService = require('../services/autoSuspensionService');
    const server = await query.get('SELECT id, is_suspended FROM servers WHERE id = ?', [serverId]);
    if (!server) return res.status(404).json({ success: false, error: 'Server not found' });

    if (server.is_suspended) {
      await autoSuspensionService.unsuspendServer(serverId);
      res.json({ success: true, suspended: false, message: 'Server unsuspended successfully.' });
    } else {
      await autoSuspensionService.suspendServer(serverId, 'Admin manually suspended server');
      res.json({ success: true, suspended: true, message: 'Server suspended successfully.' });
    }
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Admin: Quick Extend Expiration (+7d, +30d, +90d, clear)
router.post('/:id/expiration', authenticate, requireAdmin, async (req, res) => {
  try {
    const serverId = req.params.id;
    const { days, clear, custom_date } = req.body;
    const autoSuspensionService = require('../services/autoSuspensionService');

    let newDate = null;
    if (clear) {
      newDate = null;
    } else if (custom_date) {
      newDate = new Date(custom_date).toISOString();
    } else if (days) {
      const d = new Date();
      d.setDate(d.getDate() + parseInt(days, 10));
      newDate = d.toISOString();
    }

    await autoSuspensionService.setServerExpiration(serverId, newDate);
    logActivity(req.user.id, serverId, 'SERVER_EXPIRATION_SET', `Set expiration date to ${newDate || 'Never'}`, req);

    res.json({ success: true, expiration_date: newDate, message: 'Expiration updated successfully.' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Send Console Command
router.post('/:id/command', authenticate, requireServerAccess('console.write'), async (req, res) => {
  try {
    const serverId = req.params.id;
    const { command } = req.body;

    if (!command) {
      return res.status(400).json({ success: false, error: 'Command string is required.' });
    }

    runnerService.sendCommand(serverId, command);
    logActivity(req.user.id, serverId, 'SERVER_COMMAND', command, req);

    res.json({ success: true, message: 'Command sent.' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Reinstall Server
router.post('/:id/reinstall', authenticate, requireServerAccess('settings.edit'), async (req, res) => {
  try {
    const serverId = req.params.id;
    const server = req.server;

    // Stop server if running
    if (runnerService.isServerRunning(serverId)) {
      await runnerService.stopServer(serverId);
    }

    if (server.server_type === 'minecraft' && server.jar_type && server.jar_version) {
      await mcjarsService.installJarToServer(serverId, server.jar_type, server.jar_version);
    }

    logActivity(req.user.id, serverId, 'SERVER_REINSTALL', 'Reinstalled server base files', req);

    res.json({ success: true, message: 'Server reinstalled successfully.' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Change Server Minecraft Version & Engine
router.post('/:id/change-version', authenticate, requireServerAccess('settings.edit'), async (req, res) => {
  try {
    const serverId = req.params.id;
    const server = req.server;
    const { jar_type, jar_version, jar_build, docker_image, delete_old_files } = req.body;

    if (!jar_type || !jar_version) {
      return res.status(400).json({ success: false, error: 'Jar software type and version are required.' });
    }

    // Determine target docker image if not supplied
    let targetImage = docker_image;
    if (!targetImage) {
      targetImage = mcjarsService.getRecommendedJavaImage(jar_version);
    }

    // Stop server if running
    const wasRunning = runnerService.isServerRunning(serverId);
    if (wasRunning) {
      await runnerService.stopServer(serverId);
    }

    const serverDir = path.join(config.SERVERS_DIR, `server${serverId}`);

    // If requested, clean up old jar and build caches to prevent conflicts between engines
    if (delete_old_files && fs.existsSync(serverDir)) {
      try {
        const oldJar = path.join(serverDir, 'server.jar');
        if (fs.existsSync(oldJar)) fs.unlinkSync(oldJar);

        // Remove paper/purpur cache folders if present
        const cacheFolders = ['.paper-remapped', 'cache', 'bundler', '.fabric', '.forge'];
        for (const cf of cacheFolders) {
          const cPath = path.join(serverDir, cf);
          if (fs.existsSync(cPath)) {
            fs.rmSync(cPath, { recursive: true, force: true });
          }
        }
      } catch (cleanErr) {
        console.warn('Notice: Error cleaning old cache files during version change:', cleanErr.message);
      }
    }

    // Download and install new jar
    const installResult = await mcjarsService.installJarToServer(serverId, jar_type, jar_version, jar_build || 'latest');

    // Update database record with new jar_type, jar_version, jar_build, and docker_image
    await query.run(
      `UPDATE servers 
       SET jar_type = ?, jar_version = ?, jar_build = ?, docker_image = COALESCE(?, docker_image), updated_at = CURRENT_TIMESTAMP 
       WHERE id = ?`,
      [jar_type, jar_version, jar_build || 'latest', targetImage, serverId]
    );

    logActivity(req.user.id, serverId, 'SERVER_VERSION_CHANGE', `Changed server software to ${jar_type} ${jar_version} (${targetImage})`, req);

    res.json({
      success: true,
      message: `Successfully switched server to ${jar_type} ${jar_version}!`,
      details: {
        jar_type,
        jar_version,
        docker_image: targetImage,
        wasRunning,
        installResult
      }
    });
  } catch (err) {
    console.error('Change version error:', err);
    res.status(500).json({ success: false, error: `Failed to change server version: ${err.message}` });
  }
});

// Delete Server - Only Administrators can delete servers
router.delete('/:id', authenticate, (req, res, next) => {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({
      success: false,
      error: 'Permission denied: Only administrators can delete servers. Normal users cannot delete servers.'
    });
  }
  next();
}, requireServerAccess(), async (req, res) => {
  const serverId = req.params.id;
  try {
    const server = req.server;

    // Stop server process and stats monitoring
    try {
      if (typeof runnerService.stopStatsMonitoring === 'function') {
        runnerService.stopStatsMonitoring(Number(serverId));
      }
      if (runnerService.isServerRunning(serverId)) {
        await runnerService.killServer(serverId);
      }
    } catch (procErr) {
      console.warn(`[Delete Server ${serverId}] Server stop warning:`, procErr.message);
    }

    // Clean up Docker container if available
    try {
      if (dockerService.isAvailable && dockerService.docker) {
        await dockerService.removeContainer(serverId, server.uuid);
      } else {
        // Direct container removal fallback
        const { execSync } = require('child_process');
        const containerName = `darkonyx-server-${serverId}-${(server.uuid || '').substring(0, 8)}`;
        try {
          execSync(`docker rm -f ${containerName} 2>/dev/null`);
        } catch (e) {}
      }
    } catch (dockerErr) {
      console.warn(`[Delete Server ${serverId}] Docker cleanup warning:`, dockerErr.message);
    }

    // Release all allocations associated with this server
    try {
      await query.run('UPDATE allocations SET server_id = NULL, assigned = 0 WHERE server_id = ? OR id = ?', [serverId, server.allocation_id || 0]);
    } catch (allocErr) {
      console.warn(`[Delete Server ${serverId}] Allocation release warning:`, allocErr.message);
    }

    // Remove server files on disk safely (handle root or Docker file permissions)
    const serverDir = path.join(config.SERVERS_DIR, `server${serverId}`);
    if (fs.existsSync(serverDir)) {
      try {
        fs.rmSync(serverDir, { recursive: true, force: true });
      } catch (rmErr) {
        console.warn(`[Delete Server ${serverId}] fs.rmSync warning: ${rmErr.message}. Attempting force removal...`);
        try {
          const { execSync } = require('child_process');
          execSync(`sudo rm -rf "${serverDir}" 2>/dev/null || rm -rf "${serverDir}" 2>/dev/null`);
        } catch (execErr) {
          console.error(`[Delete Server ${serverId}] Disk cleanup notice:`, execErr.message);
        }
      }
    }

    // Explicitly clean up related child tables in case of foreign key constraints
    try {
      await query.run('DELETE FROM subusers WHERE server_id = ?', [serverId]);
    } catch (e) {}
    try {
      await query.run('DELETE FROM backups WHERE server_id = ?', [serverId]);
    } catch (e) {}
    try {
      await query.run('DELETE FROM schedules WHERE server_id = ?', [serverId]);
    } catch (e) {}
    try {
      await query.run('DELETE FROM server_subdomains WHERE server_id = ?', [serverId]);
    } catch (e) {}
    try {
      await query.run('DELETE FROM server_databases WHERE server_id = ?', [serverId]);
    } catch (e) {}

    // Delete DB record
    await query.run('DELETE FROM servers WHERE id = ?', [serverId]);

    try {
      logActivity(req.user.id, serverId, 'SERVER_DELETE', `Deleted server ${server.name}`, req);
    } catch (logErr) {
      console.warn(`[Delete Server ${serverId}] Activity log notice:`, logErr.message);
    }

    res.json({ success: true, message: 'Server deleted successfully.' });
  } catch (err) {
    console.error(`[Delete Server ${serverId}] Error:`, err);
    res.status(500).json({ success: false, error: err.message || 'Failed to delete server.' });
  }
});

// ==========================================
// SERVER DATABASES MANAGEMENT
// ==========================================

// List Databases for this server
router.get('/:id/databases', authenticate, requireServerAccess('database.read'), async (req, res) => {
  try {
    const serverId = req.params.id;
    const databases = await query.all(`
      SELECT d.*, h.name as host_name, h.host, h.port as host_port
      FROM server_databases d
      LEFT JOIN database_hosts h ON d.database_host_id = h.id
      WHERE d.server_id = ?
      ORDER BY d.id DESC
    `, [serverId]);

    const hosts = await query.all('SELECT id, name, host, port FROM database_hosts ORDER BY id ASC');

    res.json({ success: true, databases, hosts });
  } catch (err) {
    console.error('List server databases error:', err);
    res.status(500).json({ success: false, error: 'Failed to retrieve databases: ' + err.message });
  }
});

// Create Database for this server
router.post('/:id/databases', authenticate, requireServerAccess('database.create'), async (req, res) => {
  try {
    const serverId = req.params.id;
    const { database_name, host_id } = req.body;

    let host = null;
    if (host_id) {
      host = await query.get('SELECT * FROM database_hosts WHERE id = ?', [host_id]);
    } else {
      host = await query.get('SELECT * FROM database_hosts ORDER BY id ASC LIMIT 1');
    }

    if (!host) {
      return res.status(400).json({ success: false, error: 'No database host is configured. Please contact the administrator.' });
    }

    const cleanName = (database_name || 'db').replace(/[^a-zA-Z0-9_]/g, '').substring(0, 16) || 'db';
    const randomSuffix = Math.random().toString(36).substring(2, 6);
    const dbName = `s${serverId}_${cleanName}_${randomSuffix}`;
    const dbUser = `u${serverId}_${Math.random().toString(36).substring(2, 7)}`;
    const crypto = require('crypto');
    const dbPassword = crypto.randomBytes(9).toString('base64').replace(/[^a-zA-Z0-9]/g, 'a').substring(0, 16);

    const mysql = require('mysql2/promise');
    let conn;
    try {
      conn = await mysql.createConnection({
        host: host.host === '127.0.0.1' || host.host === 'localhost' ? '127.0.0.1' : host.host,
        port: host.port,
        user: host.username,
        password: host.password,
        multipleStatements: true
      });
      await conn.query(`CREATE DATABASE IF NOT EXISTS \`${dbName}\`;`);
      await conn.query(`CREATE USER IF NOT EXISTS '${dbUser}'@'%' IDENTIFIED BY '${dbPassword}';`);
      await conn.query(`GRANT ALL PRIVILEGES ON \`${dbName}\`.* TO '${dbUser}'@'%';`);
      await conn.query(`FLUSH PRIVILEGES;`);
    } catch (dbErr) {
      console.error('Database provisioning error on host:', dbErr);
      return res.status(500).json({ success: false, error: `Failed to provision database on host (${host.name}): ${dbErr.message}` });
    } finally {
      if (conn) await conn.end();
    }

    const insertRes = await query.run(`
      INSERT INTO server_databases (server_id, database_host_id, database_name, username, password, remote_connections)
      VALUES (?, ?, ?, ?, ?, '%')
    `, [serverId, host.id, dbName, dbUser, dbPassword]);

    logActivity(req.user.id, serverId, 'DATABASE_CREATE', `Created database ${dbName}`, req);

    res.json({
      success: true,
      database: {
        id: insertRes.lastID,
        server_id: serverId,
        database_host_id: host.id,
        database_name: dbName,
        username: dbUser,
        password: dbPassword,
        remote_connections: '%',
        host_name: host.name,
        host: host.host,
        host_port: host.port
      }
    });
  } catch (err) {
    console.error('Create database error:', err);
    res.status(500).json({ success: false, error: 'Failed to create database: ' + err.message });
  }
});

// Reset Database User Password
router.post('/:id/databases/:dbId/reset-password', authenticate, requireServerAccess('database.update'), async (req, res) => {
  try {
    const { id: serverId, dbId } = req.params;
    const dbRecord = await query.get(`
      SELECT d.*, h.host, h.port as host_port, h.username as host_user, h.password as host_pass
      FROM server_databases d
      LEFT JOIN database_hosts h ON d.database_host_id = h.id
      WHERE d.id = ? AND d.server_id = ?
    `, [dbId, serverId]);

    if (!dbRecord) return res.status(404).json({ success: false, error: 'Database record not found.' });

    const crypto = require('crypto');
    const newPassword = crypto.randomBytes(9).toString('base64').replace(/[^a-zA-Z0-9]/g, 'a').substring(0, 16);

    const mysql = require('mysql2/promise');
    let conn;
    try {
      conn = await mysql.createConnection({
        host: dbRecord.host === '127.0.0.1' || dbRecord.host === 'localhost' ? '127.0.0.1' : dbRecord.host,
        port: dbRecord.host_port,
        user: dbRecord.host_user,
        password: dbRecord.host_pass
      });
      await conn.query(`ALTER USER '${dbRecord.username}'@'%' IDENTIFIED BY '${newPassword}';`);
      await conn.query(`FLUSH PRIVILEGES;`);
    } catch (dbErr) {
      console.error('Reset database password error on DB host:', dbErr);
      return res.status(500).json({ success: false, error: `Failed to reset password: ${dbErr.message}` });
    } finally {
      if (conn) await conn.end();
    }

    await query.run('UPDATE server_databases SET password = ? WHERE id = ?', [newPassword, dbId]);
    logActivity(req.user.id, serverId, 'DATABASE_PASSWORD_RESET', `Reset password for database ${dbRecord.database_name}`, req);

    res.json({ success: true, newPassword, message: 'Password reset successfully.' });
  } catch (err) {
    console.error('Reset password error:', err);
    res.status(500).json({ success: false, error: 'Failed to reset password: ' + err.message });
  }
});

// Delete Database
router.delete('/:id/databases/:dbId', authenticate, requireServerAccess('database.delete'), async (req, res) => {
  try {
    const { id: serverId, dbId } = req.params;
    const dbRecord = await query.get(`
      SELECT d.*, h.host, h.port as host_port, h.username as host_user, h.password as host_pass
      FROM server_databases d
      LEFT JOIN database_hosts h ON d.database_host_id = h.id
      WHERE d.id = ? AND d.server_id = ?
    `, [dbId, serverId]);

    if (!dbRecord) return res.status(404).json({ success: false, error: 'Database record not found.' });

    const mysql = require('mysql2/promise');
    let conn;
    try {
      conn = await mysql.createConnection({
        host: dbRecord.host === '127.0.0.1' || dbRecord.host === 'localhost' ? '127.0.0.1' : dbRecord.host,
        port: dbRecord.host_port,
        user: dbRecord.host_user,
        password: dbRecord.host_pass
      });
      await conn.query(`DROP DATABASE IF EXISTS \`${dbRecord.database_name}\`;`);
      await conn.query(`DROP USER IF EXISTS '${dbRecord.username}'@'%';`);
      await conn.query(`FLUSH PRIVILEGES;`);
    } catch (dbErr) {
      console.warn('Notice: Error dropping database on host:', dbErr.message);
    } finally {
      if (conn) await conn.end();
    }

    await query.run('DELETE FROM server_databases WHERE id = ?', [dbId]);
    logActivity(req.user.id, serverId, 'DATABASE_DELETE', `Deleted database ${dbRecord.database_name}`, req);

    res.json({ success: true, message: 'Database deleted successfully.' });
  } catch (err) {
    console.error('Delete database error:', err);
    res.status(500).json({ success: false, error: 'Failed to delete database: ' + err.message });
  }
});

// ==========================================
// SERVER NETWORK & PORT ALLOCATIONS
// ==========================================

// Get all server port allocations + available node ports
router.get('/:id/network', authenticate, requireServerAccess('network.read'), async (req, res) => {
  try {
    const server = req.server;
    const allocations = await query.all(`
      SELECT a.*, n.name as node_name
      FROM allocations a
      LEFT JOIN nodes n ON a.node_id = n.id
      WHERE a.server_id = ?
      ORDER BY (a.id = ?) DESC, a.port ASC
    `, [server.id, server.allocation_id || 0]);

    const available = await query.all(`
      SELECT a.*, n.name as node_name
      FROM allocations a
      LEFT JOIN nodes n ON a.node_id = n.id
      WHERE a.node_id = ? AND (a.assigned = 0 OR a.server_id IS NULL)
      ORDER BY a.port ASC
      LIMIT 50
    `, [server.node_id]);

    res.json({
      success: true,
      allocations,
      primary_allocation_id: server.allocation_id,
      available_allocations: available
    });
  } catch (err) {
    console.error('Get server network allocations error:', err);
    res.status(500).json({ success: false, error: 'Failed to retrieve allocations: ' + err.message });
  }
});

// Set an allocation as primary
router.post('/:id/network/primary', authenticate, requireServerAccess('network.update'), async (req, res) => {
  try {
    const server = req.server;
    const { allocation_id } = req.body;
    if (!allocation_id) return res.status(400).json({ success: false, error: 'Allocation ID is required.' });

    const alloc = await query.get('SELECT * FROM allocations WHERE id = ? AND server_id = ?', [allocation_id, server.id]);
    if (!alloc) return res.status(404).json({ success: false, error: 'Allocation does not belong to this server.' });

    await query.run('UPDATE servers SET allocation_id = ? WHERE id = ?', [allocation_id, server.id]);
    logActivity(req.user.id, server.id, 'NETWORK_SET_PRIMARY', `Set primary port to ${alloc.ip}:${alloc.port}`, req);

    res.json({ success: true, message: `Primary port updated to ${alloc.port}.` });
  } catch (err) {
    console.error('Set primary port error:', err);
    res.status(500).json({ success: false, error: 'Failed to set primary port: ' + err.message });
  }
});

// Assign a new allocation to server
router.post('/:id/network/assign', authenticate, requireServerAccess('network.create'), async (req, res) => {
  try {
    const server = req.server;
    const { allocation_id } = req.body;

    let alloc;
    if (allocation_id) {
      alloc = await query.get('SELECT * FROM allocations WHERE id = ? AND node_id = ? AND (assigned = 0 OR server_id IS NULL)', [allocation_id, server.node_id]);
    } else {
      alloc = await query.get('SELECT * FROM allocations WHERE node_id = ? AND (assigned = 0 OR server_id IS NULL) ORDER BY port ASC LIMIT 1', [server.node_id]);
    }

    if (!alloc) {
      return res.status(400).json({ success: false, error: 'No unassigned port allocations available on this node.' });
    }

    await query.run('UPDATE allocations SET server_id = ?, assigned = 1 WHERE id = ?', [server.id, alloc.id]);
    logActivity(req.user.id, server.id, 'NETWORK_ASSIGN_PORT', `Assigned port ${alloc.ip}:${alloc.port}`, req);

    res.json({ success: true, message: `Port ${alloc.port} assigned to server.`, allocation: alloc });
  } catch (err) {
    console.error('Assign port error:', err);
    res.status(500).json({ success: false, error: 'Failed to assign port: ' + err.message });
  }
});

// Unassign an allocation from server
router.delete('/:id/network/:allocId', authenticate, requireServerAccess('network.delete'), async (req, res) => {
  try {
    const server = req.server;
    const allocId = parseInt(req.params.allocId, 10);

    if (server.allocation_id === allocId) {
      return res.status(400).json({ success: false, error: 'Cannot unassign the primary port allocation.' });
    }

    const alloc = await query.get('SELECT * FROM allocations WHERE id = ? AND server_id = ?', [allocId, server.id]);
    if (!alloc) return res.status(404).json({ success: false, error: 'Allocation not found on this server.' });

    await query.run('UPDATE allocations SET server_id = NULL, assigned = 0 WHERE id = ?', [allocId]);
    logActivity(req.user.id, server.id, 'NETWORK_UNASSIGN_PORT', `Unassigned port ${alloc.ip}:${alloc.port}`, req);

    res.json({ success: true, message: `Port ${alloc.port} unassigned.` });
  } catch (err) {
    console.error('Unassign port error:', err);
    res.status(500).json({ success: false, error: 'Failed to unassign port: ' + err.message });
  }
});

module.exports = router;


