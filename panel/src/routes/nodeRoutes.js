const express = require('express');
const router = express.Router();
const { query } = require('../database/db');
const { authenticate, requireAdmin } = require('../middleware/auth');
const { logActivity } = require('../services/activityService');
const config = require('../config/config');
const dockerService = require('../services/dockerService');
const telemetry = require('../services/systemTelemetry');
const panelVersion = require('../../package.json').version;
const os = require('os');
const fs = require('fs');
const path = require('path');

function getNodeLiveStats(node = null) {
  // 1. RAM Usage
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = Math.max(0, totalMem - freeMem);
  const memPercent = Math.min(100, Math.max(1, Math.round((usedMem / totalMem) * 100)));

  // 2. CPU Usage — one-second background sampler, so even the very first
  //    request in a fresh process reports a real interval measurement.
  const cpuPercent = telemetry.cpuPercent == null ? 0 : telemetry.cpuPercent;
  const cpus = os.cpus() || [];
  const loadAvg = os.loadavg();

  // 3. Disk usage — real statfs on the data volume. If the volume cannot be
  //    read we report the capacity this node is configured with and an
  //    explicit "not measured" marker instead of inventing numbers.
  const disk = telemetry.diskUsage(config.DATA_DIR || '/');
  let ssdTotalGb = parseFloat((disk.total_bytes / (1024 * 1024 * 1024)).toFixed(1));
  let ssdUsedGb = parseFloat((disk.used_bytes / (1024 * 1024 * 1024)).toFixed(1));
  let ssdPercent = disk.percent;
  const ssdMeasured = disk.measured;
  if (!ssdMeasured && node && node.disk_mb) ssdTotalGb = parseFloat((node.disk_mb / 1024).toFixed(1));

  // 4. Network — real /proc/net/dev deltas sampled once a second. A quiet
  //    link reports ~0 B/s; inventing throughput made the monitor untrustworthy.
  const net = telemetry.net;
  const effectiveIn = net.measured ? net.rx_bytes_sec : 0;
  const effectiveOut = net.measured ? net.tx_bytes_sec : 0;

  const formatSpeed = (b) => {
    if (b >= 1024 * 1024) return (b / (1024 * 1024)).toFixed(2) + ' MB/s';
    if (b >= 1024) return (b / 1024).toFixed(1) + ' KB/s';
    return Math.round(b) + ' B/s';
  };

  const formatTotal = (b) => {
    if (b >= 1024 * 1024 * 1024) return (b / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
    if (b >= 1024 * 1024) return (b / (1024 * 1024)).toFixed(1) + ' MB';
    return Math.round(b / 1024) + ' KB';
  };

  return {
    cpu_percent: cpuPercent,
    load_avg: (loadAvg[0] || 0).toFixed(2),
    cores: cpus.length,

    ram_used_mb: Math.round(usedMem / (1024 * 1024)),
    ram_total_mb: Math.round(totalMem / (1024 * 1024)),
    ram_percent: memPercent,

    ssd_used_gb: ssdUsedGb,
    ssd_total_gb: ssdTotalGb,
    ssd_free_gb: parseFloat(Math.max(0, ssdTotalGb - ssdUsedGb).toFixed(1)),
    ssd_percent: ssdPercent,
    ssd_measured: ssdMeasured,

    net_in_speed: formatSpeed(effectiveIn),
    net_out_speed: formatSpeed(effectiveOut),
    net_in_total: formatTotal(net.total_rx),
    net_out_total: formatTotal(net.total_tx),
    net_measured: net.measured,

    uptime_hours: (os.uptime() / 3600).toFixed(1),
    status: cpuPercent > 85 || memPercent > 85 ? 'warning' : 'optimal'
  };
}

// List Nodes (with Live Metrics for RAM, CPU, SSD, Network In/Out)
router.get('/', authenticate, requireAdmin, async (req, res) => {
  try {
    const nodes = await query.all(`
      SELECT n.*, l.name as location_name, l.short_code as location_code,
             (SELECT COUNT(*) FROM servers s WHERE s.node_id = n.id) as server_count,
             (SELECT COUNT(*) FROM allocations a WHERE a.node_id = n.id) as total_allocations,
             (SELECT COUNT(*) FROM allocations a WHERE a.node_id = n.id AND a.assigned = 1) as assigned_allocations
      FROM nodes n
      LEFT JOIN locations l ON n.location_id = l.id
      ORDER BY n.id ASC
    `);

    const enrichedNodes = nodes.map(n => ({
      ...n,
      usage: getNodeLiveStats(n)
    }));

    res.json({ success: true, nodes: enrichedNodes });
  } catch (err) {
    console.error('List nodes error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Single Node Usage Status Live Endpoint
router.get('/:id/stats', authenticate, requireAdmin, async (req, res) => {
  try {
    const node = await query.get('SELECT * FROM nodes WHERE id = ?', [req.params.id]);
    const liveStats = getNodeLiveStats(node);
    res.json({ success: true, stats: liveStats });
  } catch (err) {
    console.error('Node stats error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Create Node
router.post('/', authenticate, requireAdmin, async (req, res) => {
  try {
    const { name, fqdn, daemon_port, sftp_port, memory_mb, disk_mb, location_id } = req.body;
    if (!name || !fqdn) {
      return res.status(400).json({ success: false, error: 'Node name and FQDN/IP are required.' });
    }

    const result = await query.run(`
      INSERT INTO nodes (name, fqdn, daemon_port, sftp_port, memory_mb, disk_mb, location_id)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `, [
      name,
      fqdn,
      parseInt(daemon_port || config.PORT_API, 10),
      parseInt(sftp_port || config.PORT_SFTP, 10),
      parseInt(memory_mb || 16384, 10),
      parseInt(disk_mb || 102400, 10),
      location_id || null
    ]);

    logActivity(req.user.id, null, 'NODE_CREATE', `Created node: ${name}`, req);

    res.json({ success: true, nodeId: result.lastID, message: 'Node created successfully.' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Daemon / agent version report
router.get('/updates', authenticate, requireAdmin, async (req, res) => {
  try {
    const os = require('os');
    res.json({
      success: true,
      current_version: panelVersion,
      daemon_mode: dockerService.isAvailable ? 'docker' : 'native-process',
      docker_available: dockerService.isAvailable,
      platform: `${os.type()} ${os.release()}`,
      arch: os.arch(),
      node_runtime: process.version,
      process_uptime_seconds: Math.floor(process.uptime()),
      host_uptime_seconds: Math.floor(os.uptime())
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Mass node actions. Only actions with a real implementation are accepted —
// an endpoint that returns "dispatched" without doing anything is a lie.
router.post('/mass-action', authenticate, requireAdmin, async (req, res) => {
  try {
    const { action, app_name, node_ids } = req.body;

    if (action === 'set_app_name') {
      if (!app_name || !String(app_name).trim()) {
        return res.status(400).json({ success: false, error: 'App name cannot be empty.' });
      }
      const ids = Array.isArray(node_ids) && node_ids.length ? node_ids.map(Number) : null;
      if (ids) {
        const rows = ids.map(() => '?').join(',');
        await query.run(
          'UPDATE nodes SET name = ? WHERE id IN (' + rows + ')',
          [String(app_name).trim(), ...ids]
        );
      }
      logActivity(req.user.id, null, 'NODE_MASS_RENAME', `Renamed ${ids ? ids.length : 'all'} node(s) to "${app_name}"`, req);
      return res.json({
        success: true,
        message: ids ? `Renamed ${ids.length} node(s) to "${String(app_name).trim()}".` : 'No nodes selected — nothing changed.'
      });
    }

    return res.status(400).json({
      success: false,
      error: `Unsupported mass action "${action}". Available: set_app_name.`
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Get Node Details
router.get('/:id', authenticate, requireAdmin, async (req, res) => {
  try {
    const node = await query.get(`
      SELECT n.*, l.name as location_name, l.short_code as location_code
      FROM nodes n
      LEFT JOIN locations l ON n.location_id = l.id
      WHERE n.id = ?
    `, [req.params.id]);

    if (!node) return res.status(404).json({ success: false, error: 'Node not found.' });

    const allocations = await query.all(`
      SELECT a.*, s.name as server_name, s.uuid as server_uuid
      FROM allocations a
      LEFT JOIN servers s ON a.server_id = s.id
      WHERE a.node_id = ?
      ORDER BY a.port ASC
    `, [req.params.id]);

    const servers = await query.all('SELECT id, name, server_type, status, memory_mb FROM servers WHERE node_id = ?', [req.params.id]);

    res.json({ success: true, node, allocations, servers });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Update Node
router.put('/:id', authenticate, requireAdmin, async (req, res) => {
  try {
    const nodeId = req.params.id;
    const { name, fqdn, daemon_port, sftp_port, memory_mb, disk_mb, location_id } = req.body;

    const current = await query.get('SELECT * FROM nodes WHERE id = ?', [nodeId]);
    if (!current) {
      return res.status(404).json({ success: false, error: 'Node not found.' });
    }

    const pick = (v, fallback) => (v === undefined || v === null || v === '' ? fallback : v);

    await query.run(`
      UPDATE nodes SET
        name = ?,
        fqdn = ?,
        daemon_port = ?,
        sftp_port = ?,
        memory_mb = ?,
        disk_mb = ?,
        location_id = ?
      WHERE id = ?
    `, [
      pick(name, current.name),
      pick(fqdn, current.fqdn),
      pick(daemon_port, current.daemon_port),
      pick(sftp_port, current.sftp_port),
      pick(memory_mb, current.memory_mb),
      pick(disk_mb, current.disk_mb),
      pick(location_id, current.location_id),
      nodeId
    ]);

    logActivity(req.user.id, null, 'NODE_UPDATE', `Updated node ID: ${nodeId}`, req);

    res.json({ success: true, message: 'Node updated successfully.' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Delete Node
router.delete('/:id', authenticate, requireAdmin, async (req, res) => {
  try {
    const nodeId = req.params.id;
    const serverCount = await query.get('SELECT COUNT(id) as count FROM servers WHERE node_id = ?', [nodeId]);
    if (serverCount && serverCount.count > 0) {
      return res.status(400).json({ success: false, error: 'Cannot delete node with active servers. Reassign or delete servers first.' });
    }

    await query.run('DELETE FROM nodes WHERE id = ?', [nodeId]);
    logActivity(req.user.id, null, 'NODE_DELETE', `Deleted node ID: ${nodeId}`, req);

    res.json({ success: true, message: 'Node deleted successfully.' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Allocations: Add single or range of ports
router.post('/:id/allocations', authenticate, requireAdmin, async (req, res) => {
  try {
    const nodeId = req.params.id;
    const { ip, ports, startPort, endPort, ip_alias } = req.body;
    const targetIp = ip || '127.0.0.1';
    const targetAlias = (ip_alias || '').trim() || null;

    let portsToAdd = [];
    if (startPort && endPort) {
      const start = parseInt(startPort, 10);
      const end = parseInt(endPort, 10);
      if (start > end) {
        return res.status(400).json({ success: false, error: 'Start port must be less than or equal to end port.' });
      }
      if (end - start > 500) {
        return res.status(400).json({ success: false, error: 'Cannot create more than 500 ports in a single batch.' });
      }
      for (let p = start; p <= end; p++) {
        portsToAdd.push(p);
      }
    } else if (ports) {
      if (Array.isArray(ports)) {
        portsToAdd = ports.map(p => parseInt(p, 10));
      } else {
        portsToAdd = ports.toString().split(',').map(p => parseInt(p.trim(), 10)).filter(p => !isNaN(p));
      }
    }

    if (portsToAdd.length === 0) {
      return res.status(400).json({ success: false, error: 'Please specify port range or comma-separated ports.' });
    }

    let addedCount = 0;
    for (const p of portsToAdd) {
      const existing = await query.get('SELECT id FROM allocations WHERE node_id = ? AND ip = ? AND port = ?', [nodeId, targetIp, p]);
      if (!existing) {
        await query.run('INSERT INTO allocations (node_id, ip, port, assigned, ip_alias) VALUES (?, ?, ?, 0, ?)', [nodeId, targetIp, p, targetAlias]);
        addedCount++;
      }
    }

    logActivity(req.user.id, null, 'ALLOCATION_CREATE', `Added ${addedCount} port allocations to node ${nodeId}`, req);

    res.json({ success: true, message: `Successfully added ${addedCount} port allocations.` });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Allocations: Delete single allocation
router.delete('/:id/allocations/:allocId', authenticate, requireAdmin, async (req, res) => {
  try {
    const { id, allocId } = req.params;
    const alloc = await query.get('SELECT * FROM allocations WHERE id = ? AND node_id = ?', [allocId, id]);
    if (!alloc) return res.status(404).json({ success: false, error: 'Allocation not found.' });

    if (alloc.assigned) {
      return res.status(400).json({ success: false, error: 'Cannot delete an assigned port allocation. Unassign from server first.' });
    }

    await query.run('DELETE FROM allocations WHERE id = ?', [allocId]);
    res.json({ success: true, message: 'Port allocation deleted.' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Allocations: Clear all unassigned allocations on node
router.delete('/:id/allocations-clear-unassigned', authenticate, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const resRun = await query.run('DELETE FROM allocations WHERE node_id = ? AND assigned = 0', [id]);
    logActivity(req.user.id, null, 'ALLOCATION_CLEAR', `Cleared ${resRun.changes || 0} unassigned allocations on node ${id}`, req);
    res.json({ success: true, message: `Deleted ${resRun.changes || 0} unassigned port allocations.` });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Allocations: Set the IP alias for every allocation on an IP block
// (mirrors the per-row alias editor in the node allocation view)
router.put('/:id/allocations/alias', authenticate, requireAdmin, async (req, res) => {
  try {
    const nodeId = req.params.id;
    const { ip, ip_alias, allocId } = req.body;

    if (allocId) {
      const alloc = await query.get('SELECT * FROM allocations WHERE id = ? AND node_id = ?', [allocId, nodeId]);
      if (!alloc) return res.status(404).json({ success: false, error: 'Allocation not found.' });
      await query.run('UPDATE allocations SET ip_alias = ? WHERE id = ?', [(ip_alias || '').trim() || null, allocId]);
      return res.json({ success: true, message: 'IP alias updated.' });
    }

    if (!ip) {
      return res.status(400).json({ success: false, error: 'IP address is required.' });
    }

    const result = await query.run(
      'UPDATE allocations SET ip_alias = ? WHERE node_id = ? AND ip = ?',
      [(ip_alias || '').trim() || null, nodeId, ip]
    );

    logActivity(req.user.id, null, 'ALLOCATION_ALIAS', `Set IP alias "${ip_alias || 'none'}" on ${result.changes || 0} allocation(s)`, req);
    res.json({ success: true, message: `IP alias applied to ${result.changes || 0} allocation(s).` });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Wings Stats & Top Processes (nodes/view/wings-stats.blade.php)
router.get('/:id/wings-stats', authenticate, requireAdmin, async (req, res) => {
  try {
    const nodeId = req.params.id;
    const node = await query.get('SELECT * FROM nodes WHERE id = ?', [nodeId]);
    if (!node) return res.status(404).json({ success: false, error: 'Node not found.' });

    const liveStats = getNodeLiveStats(node);

    // Top processes via ps aux
    let topProcesses = [];
    try {
      const { execSync } = require('child_process');
      const psOut = execSync('ps aux --sort=-%cpu | head -n 11', { encoding: 'utf8', timeout: 3000 });
      const lines = psOut.trim().split('\n').slice(1);
      topProcesses = lines.map(line => {
        const parts = line.trim().split(/\s+/);
        return {
          user: parts[0] || 'root',
          pid: parts[1] || '0',
          cpu: parseFloat(parts[2]) || 0,
          mem: parseFloat(parts[3]) || 0,
          vsz: parts[4] || '0',
          rss: parts[5] || '0',
          stat: parts[7] || 'S',
          time: parts[9] || '0:00',
          command: parts.slice(10).join(' ') || 'unknown'
        };
      });
    } catch (e) {
      // `ps` unavailable: report the one process we can actually account for.
      topProcesses = [{
        user: os.userInfo().username,
        pid: String(process.pid),
        cpu: 0,
        mem: 0,
        command: 'node src/index.js (DARKONYX PANEL core)',
        note: 'ps unavailable — only the panel process is listed'
      }];
    }

    const cpus = os.cpus() || [];
    const loadAvg = os.loadavg() || [0, 0, 0];

    // Docker truth: count what is really there, and say so when it is absent.
    let dockerState = {
      available: dockerService.isAvailable,
      containers: { total: 0, running: 0, stopped: 0 },
      images: 0,
      error: dockerService.isAvailable ? null : 'Docker socket not present on this host — servers run as native processes.'
    };
    if (dockerService.isAvailable && dockerService.docker) {
      try {
        const containers = await dockerService.docker.listContainers({ all: true });
        const images = await dockerService.docker.listImages();
        const running = containers.filter((c) => c.State === 'running').length;
        dockerState.containers = { total: containers.length, running, stopped: containers.length - running };
        dockerState.images = images.length;
      } catch (dockErr) {
        dockerState.error = dockErr.message;
      }
    }

    res.json({
      success: true,
      node,
      daemon: {
        version: panelVersion,
        status: 'running',
        service: 'active (running)',
        pid: process.pid,
        mode: dockerService.isAvailable ? 'docker' : 'native-process',
        started_at: new Date(Date.now() - (os.uptime() * 1000)).toISOString(),
        process_uptime_seconds: Math.floor(process.uptime())
      },
      system: {
        os: `${os.type()} ${os.release()}`,
        kernel: os.version ? os.version() : os.release(),
        arch: os.arch(),
        uptime_seconds: Math.round(os.uptime()),
        load_avg: loadAvg.map(n => typeof n === 'number' ? n.toFixed(2) : n),
        cpu: {
          count: cpus.length,
          model: (cpus[0] && cpus[0].model) || 'unknown CPU',
          usage_percent: liveStats.cpu_percent
        },
        memory: {
          total_mb: liveStats.ram_total_mb,
          used_mb: liveStats.ram_used_mb,
          free_mb: Math.max(0, liveStats.ram_total_mb - liveStats.ram_used_mb),
          percent: liveStats.ram_percent
        },
        disk: {
          total_gb: liveStats.ssd_total_gb,
          used_gb: liveStats.ssd_used_gb,
          free_gb: liveStats.ssd_free_gb,
          percent: liveStats.ssd_percent
        }
      },
      docker: dockerState,
      stats: liveStats,
      topProcesses
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Remote node service control. There is no agent on the far side to invent,
// so this reports exactly what it can do: for the node the panel runs on it
// really restarts the panel process; for a remote node it says it is
// unsupported instead of pretending a signal was delivered.
function isLocalNode(node) {
  if (!node || !node.fqdn) return false;
  const local = ['127.0.0.1', 'localhost', '::1', os.hostname()];
  return local.includes(String(node.fqdn).toLowerCase()) || String(node.fqdn) === config.PUBLIC_IP;
}

router.post('/:id/service', authenticate, requireAdmin, async (req, res) => {
  try {
    const { action } = req.body;
    const nodeId = req.params.id;
    const node = await query.get('SELECT * FROM nodes WHERE id = ?', [nodeId]);
    if (!node) return res.status(404).json({ success: false, error: 'Node not found.' });

    const act = String(action || '').toLowerCase();
    if (!['start', 'restart', 'stop'].includes(act)) {
      return res.status(400).json({ success: false, error: `Unknown service action "${action}".` });
    }

    if (!isLocalNode(node)) {
      return res.status(409).json({
        success: false,
        error: `Node "${node.name}" is remote (${node.fqdn}). Service control needs the daemon agent running on that host; this panel cannot signal it directly.`
      });
    }

    logActivity(req.user.id, null, 'PANEL_SERVICE_ACTION', `Panel service [${act}] requested on node ${nodeId}`, req);

    if (act === 'restart' || act === 'stop') {
      // The panel runs under pm2/systemd/the sandbox supervisor; exiting is the
      // honest action and the supervisor brings it back for a restart.
      res.json({
        success: true,
        message: `Panel process ${act === 'stop' ? 'stopping' : 'restarting'} now. The page will reconnect once the supervisor brings it back.`
      });
      setTimeout(() => {
        if (act === 'stop') process.exit(0);
        else process.kill(process.pid, 'SIGTERM');
      }, 400);
      return;
    }

    return res.json({ success: true, message: 'The panel process is already running.' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Host reboot (local node only, and only when the panel can actually do it)
router.post('/:id/reboot-vps', authenticate, requireAdmin, async (req, res) => {
  try {
    const nodeId = req.params.id;
    const node = await query.get('SELECT * FROM nodes WHERE id = ?', [nodeId]);
    if (!node) return res.status(404).json({ success: false, error: 'Node not found.' });
    if (!isLocalNode(node)) {
      return res.status(409).json({ success: false, error: `Node "${node.name}" is remote — a reboot has to be issued on that host.` });
    }
    if (!config.ALLOW_HOST_REBOOT) {
      return res.status(403).json({
        success: false,
        error: 'Host reboot is disabled. Start the panel with ALLOW_HOST_REBOOT=1 to permit it (the process needs root and this is destructive).'
      });
    }
    logActivity(req.user.id, null, 'NODE_VPS_REBOOT', `Host reboot issued from node ${nodeId}`, req);
    res.json({ success: true, message: 'Host reboot issued.' });
    setTimeout(() => {
      try { require('child_process').execSync('reboot', { timeout: 5000 }); }
      catch (e) { console.error('reboot failed:', e.message); }
    }, 500);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Firewall Rules List (nodes/view/firewall.blade.php)
router.get('/:id/firewall', authenticate, requireAdmin, async (req, res) => {
  try {
    const nodeId = req.params.id;
    const rules = await query.all('SELECT * FROM node_firewall_rules WHERE node_id = ? ORDER BY id DESC', [nodeId]);
    res.json({ success: true, rules });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Add Firewall Rule
router.post('/:id/firewall/rule', authenticate, requireAdmin, async (req, res) => {
  try {
    const nodeId = req.params.id;
    const { port, protocol, action, target_ip, description } = req.body;
    if (!port) return res.status(400).json({ success: false, error: 'Port is required.' });

    const portNum = parseInt(port, 10);
    const proto = (protocol || 'tcp').toLowerCase();
    const act = (action || 'allow').toLowerCase();
    const tip = target_ip || 'any';
    const desc = description || `Rule for port ${portNum}`;

    const result = await query.run(
      'INSERT INTO node_firewall_rules (node_id, port, protocol, action, target_ip, description) VALUES (?, ?, ?, ?, ?, ?)',
      [nodeId, portNum, proto, act, tip, desc]
    );

    logActivity(req.user.id, null, 'FIREWALL_RULE_ADD', `Added firewall rule: ${act.toUpperCase()} ${proto.toUpperCase()} ${portNum} (${tip})`, req);
    res.json({ success: true, rule_id: result.lastID, message: `Firewall rule for port ${portNum} added successfully.` });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Delete Firewall Rule
router.delete('/:id/firewall/rule/:ruleId', authenticate, requireAdmin, async (req, res) => {
  try {
    const { id, ruleId } = req.params;
    await query.run('DELETE FROM node_firewall_rules WHERE id = ? AND node_id = ?', [ruleId, id]);
    logActivity(req.user.id, null, 'FIREWALL_RULE_DELETE', `Deleted firewall rule ID ${ruleId}`, req);
    res.json({ success: true, message: 'Firewall rule removed successfully.' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Flush Firewall Rules
router.post('/:id/firewall/flush', authenticate, requireAdmin, async (req, res) => {
  try {
    const nodeId = req.params.id;
    const result = await query.run('DELETE FROM node_firewall_rules WHERE node_id = ?', [nodeId]);
    logActivity(req.user.id, null, 'FIREWALL_FLUSH', `Flushed ${result.changes || 0} firewall rules on node ${nodeId}`, req);
    res.json({ success: true, message: `Successfully flushed ${result.changes || 0} firewall rules.` });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Node logs — the real panel log stream plus audit trail for this node.
router.get('/:id/logs', authenticate, requireAdmin, async (req, res) => {
  try {
    const nodeId = req.params.id;
    const filter = String(req.query.search || '').toLowerCase();
    const lines = [];

    // 1. real process log file if the supervisor/panel writes one
    for (const candidate of [path.join(config.DATA_DIR || '', 'panel.log'), path.join(__dirname, '../../logs/panel.log')]) {
      try {
        if (candidate && fs.existsSync(candidate)) {
          const raw = fs.readFileSync(candidate, 'utf8').split('\n').slice(-200);
          lines.push(...raw.filter(Boolean));
          break;
        }
      } catch (e) { /* keep looking */ }
    }

    // 2. audit trail — always available, always real
    const activities = await query.all(
      'SELECT action, details, ip_address, created_at FROM activity_logs ORDER BY id DESC LIMIT 100'
    );
    if (activities.length) {
      lines.push(`--- activity for node ${nodeId} ---`);
      for (const a of activities) {
        lines.push(`[${a.created_at}] [AUDIT] ${a.action} ${a.details || ''} (${a.ip_address || 'local'})`);
      }
    }

    // 3. process/supervisor facts
    lines.push(`--- process ---`);
    lines.push(`panel v${panelVersion} · pid ${process.pid} · uptime ${Math.floor(process.uptime())}s · node ${process.version}`);
    lines.push(`runtime mode: ${dockerService.isAvailable ? 'docker containers' : 'native processes (no docker socket)'}`);

    const filtered = filter ? lines.filter((l) => l.toLowerCase().includes(filter)) : lines;
    res.json({
      success: true,
      logs: filtered.join('\n'),
      source: 'panel log + audit trail',
      total_lines: filtered.length
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Node Backups (nodes/view/backups.blade.php)
router.get('/:id/backups', authenticate, requireAdmin, async (req, res) => {
  try {
    const nodeId = req.params.id;
    const backups = await query.all(`
      SELECT b.*, s.name as server_name
      FROM backups b
      JOIN servers s ON b.server_id = s.id
      WHERE s.node_id = ?
      ORDER BY b.id DESC
      LIMIT 50
    `, [nodeId]);

    res.json({
      success: true,
      backups,
      config: {
        storage_backend: 'Local Storage (/storage/backups)',
        retention_days: 7,
        total_backups: backups.length
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Port detail — everything the panel actually knows about this allocation.
router.get('/:id/ports/:port/detail', authenticate, requireAdmin, async (req, res) => {
  try {
    const { id, port } = req.params;
    const alloc = await query.get(
      `SELECT a.*, s.name as server_name, s.uuid as server_uuid, s.status as server_status, s.user_id
       FROM allocations a LEFT JOIN servers s ON a.server_id = s.id
       WHERE a.node_id = ? AND a.port = ?`,
      [id, port]
    );

    if (!alloc) return res.status(404).json({ success: false, error: `Port ${port} is not allocated on this node.` });

    const owner = alloc.user_id ? await query.get('SELECT username, email FROM users WHERE id = ?', [alloc.user_id]) : null;
    const listening = await new Promise((resolve) => {
      const net = require('net');
      const socket = net.connect({ host: '127.0.0.1', port: parseInt(port, 10) });
      const done = (state) => { try { socket.destroy(); } catch (e) {} resolve(state); };
      socket.setTimeout(700);
      socket.once('connect', () => done(true));
      socket.once('timeout', () => done(false));
      socket.once('error', () => done(false));
    });

    res.json({
      success: true,
      port: parseInt(port, 10),
      allocation: alloc,
      owner,
      listening,
      traffic: null,
      note: 'Per-port throughput is not measured by this panel; the figures shown elsewhere are host-wide totals.'
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
