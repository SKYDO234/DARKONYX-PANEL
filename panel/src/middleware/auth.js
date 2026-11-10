const jwt = require('jsonwebtoken');
const config = require('../config/config');
const { query } = require('../database/db');

// Authenticate JWT Token or API Key
async function authenticate(req, res, next) {
  try {
    let token = req.headers.authorization;
    if (token && token.startsWith('Bearer ')) {
      token = token.slice(7);
    } else if (req.headers['x-api-key']) {
      token = req.headers['x-api-key'];
    } else if (req.query && req.query.token) {
      token = req.query.token;
    } else if (req.query && req.query.api_key) {
      token = req.query.api_key;
    }

    if (!token) {
      return res.status(401).json({ success: false, error: 'Authentication token missing or invalid.' });
    }

    // Check if it's an DARKONYX PANEL API Key (mpk_...)
    if (token.startsWith('mpk_')) {
      const apiKey = await query.get('SELECT * FROM api_keys WHERE key_token = ?', [token]);
      if (!apiKey) {
        return res.status(401).json({ success: false, error: 'Invalid API key.' });
      }
      query.run('UPDATE api_keys SET last_used_at = CURRENT_TIMESTAMP WHERE id = ?', [apiKey.id]).catch(() => {});
      const user = await query.get('SELECT id, uuid, username, email, role, two_factor_enabled, suspended, avatar FROM users WHERE id = ?', [apiKey.user_id]);
      if (!user) {
        return res.status(401).json({ success: false, error: 'API key owner no longer exists.' });
      }
      if (user.suspended) {
        return res.status(403).json({ success: false, error: 'Account has been suspended.' });
      }
      req.user = user;
      req.apiKey = apiKey;
      return next();
    }

    const decoded = jwt.verify(token, config.JWT_SECRET);
    const user = await query.get('SELECT id, uuid, username, email, role, two_factor_enabled, suspended, avatar FROM users WHERE id = ?', [decoded.id]);

    if (!user) {
      return res.status(401).json({ success: false, error: 'User no longer exists.' });
    }

    if (user.suspended) {
      return res.status(403).json({ success: false, error: 'Your account has been suspended by an administrator.' });
    }

    req.user = user;
    next();
  } catch (err) {
    return res.status(401).json({ success: false, error: 'Invalid or expired token.' });
  }
}

// Require Admin Role
function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ success: false, error: 'Administrator access required.' });
  }
  next();
}

// Check Server Access Permission (Owner, Admin, or Subuser)
function requireServerAccess(requiredPermission = null) {
  return async (req, res, next) => {
    try {
      const serverId = req.params.serverId || req.params.id || req.body?.serverId || req.query?.serverId;
      if (!serverId) {
        return res.status(400).json({ success: false, error: 'Server ID parameter required.' });
      }

      // Check if server exists
      const server = await query.get('SELECT * FROM servers WHERE id = ? OR uuid = ?', [serverId, serverId]);
      if (!server) {
        return res.status(404).json({ success: false, error: 'Server not found.' });
      }

      // Admins have full access
      if (req.user.role === 'admin') {
        req.server = server;
        req.isOwner = (req.user.id === server.user_id);
        req.permissions = ['*'];
        return next();
      }

      // Server Owner has full access
      if (server.user_id === req.user.id) {
        req.server = server;
        req.isOwner = true;
        req.permissions = ['*'];
        return next();
      }

      // Check Subuser access
      const subuser = await query.get('SELECT * FROM subusers WHERE server_id = ? AND user_id = ?', [server.id, req.user.id]);
      if (!subuser) {
        return res.status(403).json({ success: false, error: 'Access denied to this server.' });
      }

      let permissions = [];
      try {
        permissions = JSON.parse(subuser.permissions || '[]');
      } catch (e) {
        permissions = [];
      }

      if (requiredPermission && !permissions.includes('*') && !permissions.includes(requiredPermission)) {
        return res.status(403).json({ success: false, error: `Permission denied: Missing '${requiredPermission}' permission.` });
      }

      req.server = server;
      req.isOwner = false;
      req.permissions = permissions;
      next();
    } catch (err) {
      console.error('Server access check error:', err);
      res.status(500).json({ success: false, error: 'Server access verification failed.' });
    }
  };
}

// API Key authentication for external integrations
async function authenticateApiKey(req, res, next) {
  try {
    const apiKey = req.headers['x-api-key'] || req.headers['authorization']?.replace('Bearer ', '');
    if (!apiKey) {
      return res.status(401).json({ success: false, error: 'API Key missing.' });
    }

    const keyRecord = await query.get('SELECT * FROM api_keys WHERE key_token = ?', [apiKey]);
    if (!keyRecord) {
      return res.status(401).json({ success: false, error: 'Invalid API Key.' });
    }

    const user = await query.get('SELECT id, uuid, username, email, role, suspended FROM users WHERE id = ?', [keyRecord.user_id]);
    if (!user || user.suspended) {
      return res.status(403).json({ success: false, error: 'Account suspended or inactive.' });
    }

    // Update last used timestamp
    await query.run('UPDATE api_keys SET last_used_at = CURRENT_TIMESTAMP WHERE id = ?', [keyRecord.id]);

    req.user = user;
    req.apiKey = keyRecord;
    next();
  } catch (err) {
    res.status(500).json({ success: false, error: 'API key authentication failed.' });
  }
}

module.exports = {
  authenticate,
  requireAdmin,
  requireServerAccess,
  authenticateApiKey
};

