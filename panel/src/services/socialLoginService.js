const axios = require('axios');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('crypto').randomUUID ? { v4: require('crypto').randomUUID } : { v4: () => Math.random().toString(36).substring(2, 15) };
const config = require('../config/config');
const { query } = require('../database/db');
const { logActivity } = require('./activityService');

// Provider metadata and OAuth endpoint configurations
const PROVIDER_CONFIGS = {
  discord: {
    name: 'Discord',
    authUrl: 'https://discord.com/oauth2/authorize',
    tokenUrl: 'https://discord.com/api/oauth2/token',
    profileUrl: 'https://discord.com/api/users/@me',
    scopes: ['identify', 'email'],
    brandColor: '#5865F2',
    textColor: '#ffffff',
    icon: 'discord',
    async parseProfile(data) {
      return {
        id: data.id,
        name: data.global_name || data.username,
        email: data.email || null,
        avatar: data.avatar ? `https://cdn.discordapp.com/avatars/${data.id}/${data.avatar}.png` : null
      };
    }
  },
  github: {
    name: 'GitHub',
    authUrl: 'https://github.com/login/oauth/authorize',
    tokenUrl: 'https://github.com/login/oauth/access_token',
    profileUrl: 'https://api.github.com/user',
    scopes: ['read:user', 'user:email'],
    brandColor: '#24292e',
    textColor: '#ffffff',
    icon: 'github',
    async parseProfile(data, token) {
      let email = data.email;
      if (!email && token) {
        try {
          const emailsRes = await axios.get('https://api.github.com/user/emails', {
            headers: {
              Authorization: `Bearer ${token}`,
              'User-Agent': 'DARKONYX PANEL-OAuth'
            }
          });
          const primary = emailsRes.data.find(e => e.primary) || emailsRes.data[0];
          if (primary) email = primary.email;
        } catch (e) {}
      }
      return {
        id: String(data.id),
        name: data.name || data.login,
        email: email || null,
        avatar: data.avatar_url || null
      };
    }
  },
  google: {
    name: 'Google',
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    profileUrl: 'https://www.googleapis.com/oauth2/v3/userinfo',
    scopes: ['openid', 'profile', 'email'],
    brandColor: '#ffffff',
    textColor: '#1f2937',
    icon: 'google',
    async parseProfile(data) {
      return {
        id: data.sub,
        name: data.name || `${data.given_name || ''} ${data.family_name || ''}`.trim(),
        email: data.email || null,
        avatar: data.picture || null
      };
    }
  },
  microsoft: {
    name: 'Microsoft',
    authUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    profileUrl: 'https://graph.microsoft.com/v1.0/me',
    scopes: ['openid', 'profile', 'email', 'User.Read'],
    brandColor: '#00a4ef',
    textColor: '#ffffff',
    icon: 'microsoft',
    async parseProfile(data) {
      return {
        id: data.id,
        name: data.displayName || data.userPrincipalName,
        email: data.mail || data.userPrincipalName || null,
        avatar: null
      };
    }
  },
  gitlab: {
    name: 'GitLab',
    authUrl: 'https://gitlab.com/oauth/authorize',
    tokenUrl: 'https://gitlab.com/oauth/token',
    profileUrl: 'https://gitlab.com/api/v4/user',
    scopes: ['read_user'],
    brandColor: '#fc6d26',
    textColor: '#ffffff',
    icon: 'gitlab',
    async parseProfile(data) {
      return {
        id: String(data.id),
        name: data.name || data.username,
        email: data.email || null,
        avatar: data.avatar_url || null
      };
    }
  },
  twitch: {
    name: 'Twitch',
    authUrl: 'https://id.twitch.tv/oauth2/authorize',
    tokenUrl: 'https://id.twitch.tv/oauth2/token',
    profileUrl: 'https://api.twitch.tv/helix/users',
    scopes: ['user:read:email'],
    brandColor: '#9146ff',
    textColor: '#ffffff',
    icon: 'twitch',
    async parseProfile(data) {
      const u = (data.data && data.data[0]) || data;
      return {
        id: u.id,
        name: u.display_name || u.login,
        email: u.email || null,
        avatar: u.profile_image_url || null
      };
    }
  },
  reddit: {
    name: 'Reddit',
    authUrl: 'https://www.reddit.com/api/v1/authorize',
    tokenUrl: 'https://www.reddit.com/api/v1/access_token',
    profileUrl: 'https://oauth.reddit.com/api/v1/me',
    scopes: ['identity'],
    brandColor: '#ff4500',
    textColor: '#ffffff',
    icon: 'reddit',
    async parseProfile(data) {
      return {
        id: data.id,
        name: data.name,
        email: null,
        avatar: data.icon_img || null
      };
    }
  },
  spotify: {
    name: 'Spotify',
    authUrl: 'https://accounts.spotify.com/authorize',
    tokenUrl: 'https://accounts.spotify.com/api/token',
    profileUrl: 'https://api.spotify.com/v1/me',
    scopes: ['user-read-private', 'user-read-email'],
    brandColor: '#1db954',
    textColor: '#ffffff',
    icon: 'spotify',
    async parseProfile(data) {
      return {
        id: data.id,
        name: data.display_name || data.id,
        email: data.email || null,
        avatar: (data.images && data.images[0] && data.images[0].url) || null
      };
    }
  }
};

// Full catalog of known short names supported by Blueprint Socialite
const KNOWN_SHORT_NAMES = [
  'discord', 'google', 'github', 'microsoft', 'steam', 'gitlab', 'twitch', 'reddit', 'spotify',
  'apple', 'amazon', 'dropbox', 'facebook', 'figma', 'instagram', 'linkedin', 'medium',
  'paypal', 'pinterest', 'slack', 'snapchat', 'telegram', 'tiktok', 'twitter', 'uber',
  'unsplash', 'vercel', 'wordpress'
];

class SocialLoginService {
  getProviderMeta(shortName) {
    const lower = (shortName || '').toLowerCase();
    if (PROVIDER_CONFIGS[lower]) {
      return PROVIDER_CONFIGS[lower];
    }
    return {
      name: shortName.charAt(0).toUpperCase() + shortName.slice(1),
      brandColor: '#4f46e5',
      textColor: '#ffffff',
      icon: 'share-2',
      scopes: ['openid', 'email', 'profile']
    };
  }

  getAllSupportedShortNames() {
    return KNOWN_SHORT_NAMES;
  }

  buildAuthUrl(providerRecord, redirectUri, state) {
    const shortName = providerRecord.short_name.toLowerCase();
    const config = PROVIDER_CONFIGS[shortName];
    if (!config || !config.authUrl) {
      throw new Error(`OAuth authorization URL for provider '${shortName}' is not configured.`);
    }

    const scope = config.scopes.join(' ');
    const params = new URLSearchParams({
      client_id: providerRecord.client_id,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: scope,
      state: state
    });

    return `${config.authUrl}?${params.toString()}`;
  }

  async exchangeCodeForProfile(providerRecord, code, redirectUri) {
    const shortName = providerRecord.short_name.toLowerCase();
    const provConfig = PROVIDER_CONFIGS[shortName];
    if (!provConfig) {
      throw new Error(`Provider handler for '${shortName}' is not defined.`);
    }

    // Step 1: Exchange code for access token
    let accessToken;
    if (shortName === 'github') {
      const tokenRes = await axios.post(
        provConfig.tokenUrl,
        {
          client_id: providerRecord.client_id,
          client_secret: providerRecord.client_secret,
          code,
          redirect_uri: redirectUri
        },
        {
          headers: {
            Accept: 'application/json',
            'User-Agent': 'DARKONYX PANEL-OAuth'
          }
        }
      );
      accessToken = tokenRes.data.access_token;
      if (!accessToken) {
        throw new Error(tokenRes.data.error_description || tokenRes.data.error || 'Failed to obtain GitHub access token');
      }
    } else if (shortName === 'reddit') {
      const basicAuth = Buffer.from(`${providerRecord.client_id}:${providerRecord.client_secret}`).toString('base64');
      const tokenRes = await axios.post(
        provConfig.tokenUrl,
        new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          redirect_uri: redirectUri
        }).toString(),
        {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Authorization: `Basic ${basicAuth}`,
            'User-Agent': 'DARKONYX PANEL-OAuth'
          }
        }
      );
      accessToken = tokenRes.data.access_token;
    } else {
      // Standard OAuth2 Token POST
      const tokenParams = new URLSearchParams({
        client_id: providerRecord.client_id,
        client_secret: providerRecord.client_secret,
        code,
        grant_type: 'authorization_code',
        redirect_uri: redirectUri
      });

      const tokenRes = await axios.post(provConfig.tokenUrl, tokenParams.toString(), {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json'
        }
      });
      accessToken = tokenRes.data.access_token;
    }

    if (!accessToken) {
      throw new Error(`Failed to retrieve access token from ${providerRecord.name}`);
    }

    // Step 2: Fetch Profile
    const profileRes = await axios.get(provConfig.profileUrl, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'User-Agent': 'DARKONYX PANEL-OAuth',
        ...(shortName === 'twitch' ? { 'Client-Id': providerRecord.client_id } : {})
      }
    });

    // Step 3: Normalize profile
    const profile = await provConfig.parseProfile(profileRes.data, accessToken);
    if (!profile.id) {
      throw new Error(`Invalid profile data received from ${providerRecord.name}`);
    }

    return profile;
  }

  async handleSocialLoginOrRegister(providerRecord, profile, req = null) {
    // 1. Check if social connection already exists
    const existingConn = await query.get(
      'SELECT * FROM social_connections WHERE provider_id = ? AND auth_id = ?',
      [providerRecord.id, String(profile.id)]
    );

    if (existingConn) {
      const user = await query.get('SELECT * FROM users WHERE id = ?', [existingConn.user_id]);
      if (!user) {
        throw new Error('Associated user account was not found.');
      }
      if (user.suspended) {
        throw new Error('Your account has been suspended by an administrator.');
      }

      // Update auth_name if changed
      if (profile.name && profile.name !== existingConn.auth_name) {
        await query.run(
          'UPDATE social_connections SET auth_name = ? WHERE id = ?',
          [profile.name, existingConn.id]
        );
      }

      // Issue JWT
      const token = jwt.sign(
        { id: user.id, username: user.username, role: user.role },
        config.JWT_SECRET,
        { expiresIn: config.JWT_EXPIRES_IN }
      );

      if (req) {
        logActivity(user.id, null, 'USER_LOGIN', `Logged in via ${providerRecord.name}`, req);
      }

      return {
        token,
        user: {
          id: user.id,
          uuid: user.uuid,
          username: user.username,
          email: user.email,
          role: user.role
        }
      };
    }

    // 2. No connection exists yet: check settings
    const regSetting = await query.get("SELECT `value` FROM settings WHERE `key` = 'sociallogin_allow_register'");
    const connectSetting = await query.get("SELECT `key` FROM settings WHERE `key` = 'sociallogin_allow_connecting'");

    const allowRegister = regSetting ? regSetting.value === '1' : true;
    const allowConnecting = connectSetting ? connectSetting.value === '1' : true;

    if (!allowRegister && !allowConnecting) {
      throw new Error('Social authentication and registration are currently disabled by administrator.');
    }

    // 3. If allow_connecting is true and profile has an email, check for existing user
    if (allowConnecting && profile.email) {
      const existingUser = await query.get(
        'SELECT * FROM users WHERE LOWER(email) = LOWER(?)',
        [profile.email]
      );

      if (existingUser) {
        if (existingUser.suspended) {
          throw new Error('Associated account is suspended.');
        }

        // Link account
        await query.run(
          'INSERT INTO social_connections (user_id, provider_id, auth_id, auth_name) VALUES (?, ?, ?, ?)',
          [existingUser.id, providerRecord.id, String(profile.id), profile.name || profile.id]
        );

        if (req) {
          logActivity(existingUser.id, null, 'USER_SOCIAL_CONNECT', `Connected ${providerRecord.name} account`, req);
        }

        const token = jwt.sign(
          { id: existingUser.id, username: existingUser.username, role: existingUser.role },
          config.JWT_SECRET,
          { expiresIn: config.JWT_EXPIRES_IN }
        );

        return {
          token,
          user: {
            id: existingUser.id,
            uuid: existingUser.uuid,
            username: existingUser.username,
            email: existingUser.email,
            role: existingUser.role
          }
        };
      }
    }

    // 4. If allow_register is true, create new user
    if (!allowRegister) {
      throw new Error('No existing account found matching your social email, and new social registrations are disabled.');
    }

    // Generate unique sanitized username
    let baseUsername = (profile.name || `user_${profile.id}`)
      .toLowerCase()
      .replace(/[^a-z0-9_]/g, '')
      .substring(0, 16);
    if (baseUsername.length < 3) baseUsername = `user_${profile.id.substring(0, 8)}`;

    let chosenUsername = baseUsername;
    let counter = 1;
    while (await query.get('SELECT id FROM users WHERE LOWER(username) = LOWER(?)', [chosenUsername])) {
      chosenUsername = `${baseUsername}${counter}`;
      counter++;
    }

    // Fallback email if OAuth did not provide one
    const userEmail = profile.email || `${chosenUsername}@${providerRecord.short_name}.social`;

    const userUuid = uuidv4();
    const randomPass = uuidv4() + uuidv4();
    const passwordHash = await bcrypt.hash(randomPass, 10);

    const newUserResult = await query.run(
      'INSERT INTO users (uuid, username, email, password_hash, role, avatar) VALUES (?, ?, ?, ?, ?, ?)',
      [userUuid, chosenUsername, userEmail, passwordHash, 'user', profile.avatar || null]
    );

    const newUserId = newUserResult.lastID;

    // Create social connection
    await query.run(
      'INSERT INTO social_connections (user_id, provider_id, auth_id, auth_name) VALUES (?, ?, ?, ?)',
      [newUserId, providerRecord.id, String(profile.id), profile.name || chosenUsername]
    );

    if (req) {
      logActivity(newUserId, null, 'USER_REGISTER', `Registered account via ${providerRecord.name}`, req);
    }

    const token = jwt.sign(
      { id: newUserId, username: chosenUsername, role: 'user' },
      config.JWT_SECRET,
      { expiresIn: config.JWT_EXPIRES_IN }
    );

    return {
      token,
      user: {
        id: newUserId,
        uuid: userUuid,
        username: chosenUsername,
        email: userEmail,
        role: 'user'
      }
    };
  }

  async linkAccountToUser(userId, providerRecord, profile, req = null) {
    const existingConn = await query.get(
      'SELECT id, user_id FROM social_connections WHERE provider_id = ? AND auth_id = ?',
      [providerRecord.id, String(profile.id)]
    );

    if (existingConn) {
      if (existingConn.user_id !== userId) {
        throw new Error(`This ${providerRecord.name} account is already connected to another user account.`);
      }
      // Update name
      await query.run(
        'UPDATE social_connections SET auth_name = ? WHERE id = ?',
        [profile.name || profile.id, existingConn.id]
      );
      return { success: true, message: `Updated connection for ${providerRecord.name}` };
    }

    await query.run(
      'INSERT INTO social_connections (user_id, provider_id, auth_id, auth_name) VALUES (?, ?, ?, ?)',
      [userId, providerRecord.id, String(profile.id), profile.name || profile.id]
    );

    if (req) {
      logActivity(userId, null, 'USER_SOCIAL_CONNECT', `Connected ${providerRecord.name} account`, req);
    }

    return { success: true, message: `Successfully connected ${providerRecord.name}!` };
  }
}

module.exports = new SocialLoginService();

