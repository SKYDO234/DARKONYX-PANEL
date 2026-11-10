const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const config = require('../config/config');
const { query } = require('../database/db');
const { authenticate, requireAdmin } = require('../middleware/auth');
const socialLoginService = require('../services/socialLoginService');
const { logActivity } = require('../services/activityService');

// ==========================================
// 1. ADMIN SOCIAL LOGIN MANAGEMENT
// ==========================================

// Get all providers and settings
router.get('/admin/sociallogin', authenticate, requireAdmin, async (req, res) => {
  try {
    const regSetting = await query.get("SELECT `value` FROM settings WHERE `key` = 'sociallogin_allow_register'");
    const connectSetting = await query.get("SELECT `value` FROM settings WHERE `key` = 'sociallogin_allow_connecting'");

    const providers = await query.all('SELECT id, enabled, name, short_name, client_id, client_secret, created_at FROM social_providers ORDER BY id ASC');
    
    // Mask client secrets for security and format for UI
    const formattedProviders = providers.map(p => ({
      id: p.id,
      enabled: Boolean(p.enabled),
      name: p.name,
      short_name: p.short_name,
      client_id: p.client_id || '',
      has_secret: Boolean(p.client_secret && p.client_secret.length > 0)
    }));

    res.json({
      success: true,
      settings: {
        allow_register: regSetting ? regSetting.value === '1' : true,
        allow_connecting: connectSetting ? connectSetting.value === '1' : true
      },
      providers: formattedProviders,
      supported_providers: socialLoginService.getAllSupportedShortNames()
    });
  } catch (err) {
    console.error('Error fetching admin social login data:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Update global social settings (allow_register, allow_connecting)
router.patch('/admin/sociallogin/settings', authenticate, requireAdmin, async (req, res) => {
  try {
    const { allow_register, allow_connecting } = req.body;

    if (allow_register !== undefined) {
      const regVal = allow_register ? '1' : '0';
      await query.run(
        "INSERT INTO settings (`key`, `value`, `type`, `description`) VALUES ('sociallogin_allow_register', ?, 'boolean', 'Allow user registration via social OAuth providers') ON DUPLICATE KEY UPDATE `value` = VALUES(`value`)",
        [regVal]
      );
    }

    if (allow_connecting !== undefined) {
      const connectVal = allow_connecting ? '1' : '0';
      await query.run(
        "INSERT INTO settings (`key`, `value`, `type`, `description`) VALUES ('sociallogin_allow_connecting', ?, 'boolean', 'Allow connecting social account with existing email') ON DUPLICATE KEY UPDATE `value` = VALUES(`value`)",
        [connectVal]
      );
    }

    logActivity(req.user.id, null, 'ADMIN_UPDATE_SETTINGS', 'Updated social login settings', req);

    res.json({ success: true, message: 'Social settings updated successfully.' });
  } catch (err) {
    console.error('Error updating social settings:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Create or update a single provider
router.post('/admin/sociallogin/providers', authenticate, requireAdmin, async (req, res) => {
  try {
    const { short_name, name, client_id, client_secret, enabled } = req.body;
    const cleanShort = (short_name || '').toString().trim().toLowerCase();
    const cleanName = (name || '').toString().trim();

    if (!cleanShort || !cleanName) {
      return res.status(400).json({ success: false, error: 'Short name and Provider Name are required.' });
    }

    const isEnabled = enabled ? 1 : 0;
    const existing = await query.get('SELECT * FROM social_providers WHERE short_name = ?', [cleanShort]);

    if (existing) {
      const secretToSave = (client_secret !== undefined && client_secret !== '') ? client_secret : existing.client_secret;
      await query.run(
        'UPDATE social_providers SET name = ?, client_id = ?, client_secret = ?, enabled = ? WHERE id = ?',
        [cleanName, client_id || '', secretToSave, isEnabled, existing.id]
      );
    } else {
      await query.run(
        'INSERT INTO social_providers (short_name, name, client_id, client_secret, enabled) VALUES (?, ?, ?, ?, ?)',
        [cleanShort, cleanName, client_id || '', client_secret || '', isEnabled]
      );
    }

    logActivity(req.user.id, null, 'ADMIN_UPDATE_SOCIAL_PROVIDER', `Saved social provider ${cleanName} (${cleanShort})`, req);

    res.json({ success: true, message: `Social provider ${cleanName} saved successfully.` });
  } catch (err) {
    console.error('Error creating/updating social provider:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Bulk update providers (save all rows from table)
router.post('/admin/sociallogin/providers/bulk', authenticate, requireAdmin, async (req, res) => {
  try {
    const { providers } = req.body;
    if (!Array.isArray(providers)) {
      return res.status(400).json({ success: false, error: 'Providers array is required.' });
    }

    for (const p of providers) {
      const cleanShort = (p.short_name || '').toString().trim().toLowerCase();
      if (!cleanShort) continue;

      const existing = await query.get('SELECT * FROM social_providers WHERE short_name = ?', [cleanShort]);
      const isEnabled = p.enabled ? 1 : 0;
      const cleanName = (p.name || (existing ? existing.name : cleanShort)).toString().trim();
      const cleanClientId = p.client_id !== undefined ? p.client_id : (existing ? existing.client_id : '');

      if (existing) {
        // If client_secret is provided and not empty, update it. Otherwise keep existing.
        const secretToSave = (p.client_secret && p.client_secret.trim().length > 0) ? p.client_secret.trim() : existing.client_secret;
        await query.run(
          'UPDATE social_providers SET name = ?, client_id = ?, client_secret = ?, enabled = ? WHERE id = ?',
          [cleanName, cleanClientId, secretToSave, isEnabled, existing.id]
        );
      } else {
        await query.run(
          'INSERT INTO social_providers (short_name, name, client_id, client_secret, enabled) VALUES (?, ?, ?, ?, ?)',
          [cleanShort, cleanName, cleanClientId, p.client_secret || '', isEnabled]
        );
      }
    }

    logActivity(req.user.id, null, 'ADMIN_UPDATE_SOCIAL_PROVIDERS', 'Bulk updated social providers', req);

    res.json({ success: true, message: 'Social providers updated successfully.' });
  } catch (err) {
    console.error('Error bulk updating social providers:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Delete provider
router.delete('/admin/sociallogin/providers/:short_name', authenticate, requireAdmin, async (req, res) => {
  try {
    const shortName = req.params.short_name.toLowerCase();
    const existing = await query.get('SELECT * FROM social_providers WHERE short_name = ?', [shortName]);
    if (!existing) {
      return res.status(404).json({ success: false, error: 'Provider not found.' });
    }

    // Delete provider (connections will cascade delete or delete explicitly)
    await query.run('DELETE FROM social_connections WHERE provider_id = ?', [existing.id]);
    await query.run('DELETE FROM social_providers WHERE id = ?', [existing.id]);

    logActivity(req.user.id, null, 'ADMIN_DELETE_SOCIAL_PROVIDER', `Deleted social provider ${existing.name} (${shortName})`, req);

    res.json({ success: true, message: `Social provider ${existing.name} deleted.` });
  } catch (err) {
    console.error('Error deleting social provider:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ==========================================
// 2. PUBLIC & AUTHENTICATION ENDPOINTS
// ==========================================

// Get enabled providers for login / register modal
router.get('/auth/social/providers', async (req, res) => {
  try {
    const active = await query.all(
      'SELECT id, name, short_name FROM social_providers WHERE enabled = 1 AND client_id IS NOT NULL AND client_id != "" AND client_secret IS NOT NULL AND client_secret != ""'
    );

    const formatted = active.map(p => {
      const meta = socialLoginService.getProviderMeta(p.short_name);
      return {
        id: p.id,
        short_name: p.short_name,
        name: p.name || meta.name,
        icon: meta.icon,
        brandColor: meta.brandColor,
        textColor: meta.textColor
      };
    });

    res.json({ success: true, providers: formatted });
  } catch (err) {
    console.error('Error fetching public social providers:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// OAuth redirect to provider
router.get('/auth/social/redirect/:provider', async (req, res) => {
  try {
    const shortName = req.params.provider.toLowerCase();
    const provider = await query.get(
      'SELECT * FROM social_providers WHERE short_name = ? AND enabled = 1',
      [shortName]
    );

    if (!provider || !provider.client_id || !provider.client_secret) {
      return res.redirect('/?social_error=' + encodeURIComponent(`Social login provider '${shortName}' is not configured or disabled.`));
    }

    // Determine base URL from request host
    const host = req.get('host');
    const proto = req.headers['x-forwarded-proto'] || req.protocol || 'http';
    const redirectUri = `${proto}://${host}/api/auth/social/callback`;

    // Check if a connect token was passed in query to link account
    let connectUserId = null;
    if (req.query.connect_token) {
      try {
        const decoded = jwt.verify(req.query.connect_token, config.JWT_SECRET);
        connectUserId = decoded.id;
      } catch (e) {}
    }

    const statePayload = {
      provider: shortName,
      nonce: Math.random().toString(36).substring(2, 15),
      connectUserId: connectUserId
    };
    const state = Buffer.from(JSON.stringify(statePayload)).toString('base64url');

    const authUrl = socialLoginService.buildAuthUrl(provider, redirectUri, state);
    res.redirect(authUrl);
  } catch (err) {
    console.error('OAuth redirect error:', err);
    res.redirect('/?social_error=' + encodeURIComponent(err.message));
  }
});

// OAuth callback endpoint
router.get('/auth/social/callback', async (req, res) => {
  try {
    const { code, state, error, error_description } = req.query;

    if (error) {
      return res.redirect('/?social_error=' + encodeURIComponent(error_description || error || 'OAuth authentication failed.'));
    }

    if (!code) {
      return res.redirect('/?social_error=' + encodeURIComponent('Missing OAuth authorization code.'));
    }

    // Decode state
    let stateData = {};
    if (state) {
      try {
        stateData = JSON.parse(Buffer.from(state, 'base64url').toString('utf8'));
      } catch (e) {
        console.warn('Could not parse OAuth state:', e);
      }
    }

    const shortName = (stateData.provider || req.query.provider || '').toLowerCase();
    if (!shortName) {
      return res.redirect('/?social_error=' + encodeURIComponent('Unknown or missing provider in OAuth callback.'));
    }

    const provider = await query.get('SELECT * FROM social_providers WHERE short_name = ?', [shortName]);
    if (!provider) {
      return res.redirect('/?social_error=' + encodeURIComponent('Social provider configuration not found.'));
    }

    // Build redirect URI
    const host = req.get('host');
    const proto = req.headers['x-forwarded-proto'] || req.protocol || 'http';
    const redirectUri = `${proto}://${host}/api/auth/social/callback`;

    // Exchange code for user profile
    const profile = await socialLoginService.exchangeCodeForProfile(provider, code, redirectUri);

    // If this is an account link action for an already logged-in user
    if (stateData.connectUserId) {
      const linkResult = await socialLoginService.linkAccountToUser(stateData.connectUserId, provider, profile, req);
      return res.redirect('/?social_success=' + encodeURIComponent(linkResult.message));
    }

    // Standard Social Login or Registration
    const loginResult = await socialLoginService.handleSocialLoginOrRegister(provider, profile, req);

    // Redirect to root with token parameter
    res.redirect(`/?social_token=${encodeURIComponent(loginResult.token)}`);
  } catch (err) {
    console.error('OAuth callback error:', err);
    res.redirect('/?social_error=' + encodeURIComponent(err.message || 'Social authentication failed.'));
  }
});

// ==========================================
// 3. USER SOCIAL CONNECTIONS (User profile)
// ==========================================

// Get current user's active social connections
router.get('/auth/social/connections', authenticate, async (req, res) => {
  try {
    const connections = await query.all(
      `SELECT c.id, c.provider_id, c.auth_id, c.auth_name, c.created_at, p.name as provider_name, p.short_name 
       FROM social_connections c 
       JOIN social_providers p ON c.provider_id = p.id 
       WHERE c.user_id = ?`,
      [req.user.id]
    );

    res.json({ success: true, connections });
  } catch (err) {
    console.error('Error fetching user connections:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Disconnect a social provider
router.delete('/auth/social/connections/:connectionId', authenticate, async (req, res) => {
  try {
    const connectionId = req.params.connectionId;
    const conn = await query.get(
      'SELECT c.*, p.name as provider_name FROM social_connections c JOIN social_providers p ON c.provider_id = p.id WHERE c.id = ? AND c.user_id = ?',
      [connectionId, req.user.id]
    );

    if (!conn) {
      return res.status(404).json({ success: false, error: 'Connection not found or unauthorized.' });
    }

    await query.run('DELETE FROM social_connections WHERE id = ?', [connectionId]);

    logActivity(req.user.id, null, 'USER_SOCIAL_DISCONNECT', `Disconnected ${conn.provider_name} account`, req);

    res.json({ success: true, message: `Disconnected ${conn.provider_name} account.` });
  } catch (err) {
    console.error('Error disconnecting social provider:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;

