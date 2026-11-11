const express = require('express');
const router = express.Router({ mergeParams: true });
const fs = require('fs');
const path = require('path');
const config = require('../config/config');
const { query } = require('../database/db');
const { authenticate, requireServerAccess } = require('../middleware/auth');
const { logActivity } = require('../services/activityService');

// Initialize subdomains table
query.exec(`
  CREATE TABLE IF NOT EXISTS server_subdomains (
    id INT AUTO_INCREMENT PRIMARY KEY,
    server_id INT NOT NULL,
    subdomain VARCHAR(191) NOT NULL,
    domain VARCHAR(191) NOT NULL,
    full_domain VARCHAR(191) NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_subdomains_server (server_id),
    CONSTRAINT fk_subdomains_server FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
`).catch(e => console.error('Failed to init server_subdomains table:', e.message));

function parseProperties(content) {
  const lines = content.split(/\r?\n/);
  const properties = {};

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;

    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim();

    if (val.toLowerCase() === 'true') {
      properties[key] = true;
    } else if (val.toLowerCase() === 'false') {
      properties[key] = false;
    } else if (/^-?\d+$/.test(val)) {
      properties[key] = parseInt(val, 10);
    } else {
      properties[key] = val;
    }
  }
  return properties;
}

function serializeProperties(properties) {
  let header = `# Minecraft server properties (Managed by DARKONYX PANEL)\n# ${new Date().toISOString()}\n`;
  const lines = [header];

  for (const [key, val] of Object.entries(properties)) {
    lines.push(`${key}=${val}`);
  }
  return lines.join('\n');
}

// 1. Get Server.properties
router.get('/', authenticate, requireServerAccess('files.read'), async (req, res) => {
  try {
    const serverId = req.params.serverId;
    const server = await query.get('SELECT server_type FROM servers WHERE id = ?', [serverId]);
    if (server && ['lumenvm', 'vm', 'nokvm', 'lumenvm_nokvm', 'nodejs', 'python'].includes(server.server_type)) {
      return res.status(400).json({ success: false, error: 'Server properties configuration is only available for Minecraft servers.' });
    }

    const serverDir = path.join(config.SERVERS_DIR, `server${serverId}`);
    const propsPath = path.join(serverDir, 'server.properties');

    if (!fs.existsSync(propsPath)) {
      // Create default server.properties if not present
      const defaultContent = `motd=A Minecraft Server Powered by DARKONYX PANEL
server-port=25565
gamemode=survival
difficulty=easy
pvp=true
spawn-animals=true
spawn-monsters=true
online-mode=true
allow-flight=false
max-players=20
view-distance=10
simulation-distance=8
enable-command-block=false
hardcore=false
white-list=false
level-name=world
`;
      if (!fs.existsSync(serverDir)) fs.mkdirSync(serverDir, { recursive: true });
      fs.writeFileSync(propsPath, defaultContent, 'utf8');
    }

    const content = fs.readFileSync(propsPath, 'utf8');
    const properties = parseProperties(content);

    res.json({ success: true, properties, raw: content });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 2. Update Server.properties
router.put('/', authenticate, requireServerAccess('files.write'), async (req, res) => {
  try {
    const serverId = req.params.serverId;
    const { properties } = req.body;

    if (!properties || typeof properties !== 'object') {
      return res.status(400).json({ success: false, error: 'Properties payload required.' });
    }

    const serverDir = path.join(config.SERVERS_DIR, `server${serverId}`);
    const propsPath = path.join(serverDir, 'server.properties');

    if (!fs.existsSync(serverDir)) {
      fs.mkdirSync(serverDir, { recursive: true });
    }

    const serialized = serializeProperties(properties);
    fs.writeFileSync(propsPath, serialized, 'utf8');

    logActivity(req.user.id, serverId, 'SERVER_PROPERTIES_UPDATE', 'Updated server.properties via GUI', req);

    res.json({ success: true, message: 'Server properties saved successfully!' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 3. Subdomains: Get List
router.get('/subdomains', authenticate, requireServerAccess('settings.view'), async (req, res) => {
  try {
    const serverId = req.params.serverId;
    const subdomains = await query.all('SELECT * FROM server_subdomains WHERE server_id = ? ORDER BY id DESC', [serverId]);
    
    // Server allocation info for full address
    const s = await query.get(`
      SELECT s.id, a.ip, a.port FROM servers s
      LEFT JOIN allocations a ON s.allocation_id = a.id
      WHERE s.id = ?
    `, [serverId]);

    const enriched = subdomains.map(sd => ({
      ...sd,
      target_ip: s?.ip || '127.0.0.1',
      target_port: s?.port || 25565
    }));

    res.json({ success: true, subdomains: enriched });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 4. Subdomains: Create
router.post('/subdomains', authenticate, requireServerAccess('settings.edit'), async (req, res) => {
  try {
    const serverId = req.params.serverId;
    const { prefix, domain = 'darkonyx.network' } = req.body;

    if (!prefix) {
      return res.status(400).json({ success: false, error: 'Subdomain prefix is required.' });
    }

    const cleanPrefix = prefix.toLowerCase().replace(/[^a-z0-9-]/g, '');
    const fullDomain = `${cleanPrefix}.${domain}`;

    const exists = await query.get('SELECT id FROM server_subdomains WHERE full_domain = ?', [fullDomain]);
    if (exists) {
      return res.status(400).json({ success: false, error: 'This subdomain is already in use.' });
    }

    const r = await query.run(`
      INSERT INTO server_subdomains (server_id, subdomain, domain, full_domain)
      VALUES (?, ?, ?, ?)
    `, [serverId, cleanPrefix, domain, fullDomain]);

    logActivity(req.user.id, serverId, 'SUBDOMAIN_CREATE', `Created subdomain ${fullDomain}`, req);

    res.json({ success: true, id: r.lastID, full_domain: fullDomain, message: 'Subdomain created successfully.' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 5. Subdomains: Delete
router.delete('/subdomains/:subId', authenticate, requireServerAccess('settings.edit'), async (req, res) => {
  try {
    const { serverId, subId } = req.params;
    await query.run('DELETE FROM server_subdomains WHERE id = ? AND server_id = ?', [subId, serverId]);
    logActivity(req.user.id, serverId, 'SUBDOMAIN_DELETE', `Deleted subdomain ID ${subId}`, req);

    res.json({ success: true, message: 'Subdomain removed successfully.' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
