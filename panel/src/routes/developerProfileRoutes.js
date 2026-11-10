const express = require('express');
const router = express.Router();

const DEVELOPER_ID = '924366651443527710';
const DISCORD_EPOCH = 1420070400000n;

// In-memory cache
let cachedProfile = null;
let lastFetchTime = 0;
const CACHE_TTL_MS = 30 * 1000; // 30 seconds

function snowflakeToDate(id) {
  try {
    const ms = Number((BigInt(id) >> 22n) + DISCORD_EPOCH);
    return new Date(ms);
  } catch (e) {
    return new Date('2021-12-25T18:23:03.000Z');
  }
}

async function fetchDeveloperProfile() {
  const now = Date.now();
  if (cachedProfile && (now - lastFetchTime) < CACHE_TTL_MS) {
    return cachedProfile;
  }

  const createdDate = snowflakeToDate(DEVELOPER_ID);
  const formattedDate = createdDate.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric'
  });

  const baseProfile = {
    id: DEVELOPER_ID,
    username: 'nobita.dev',
    global_name: 'nobita',
    pronouns: 'he/him',
    avatar: null,
    avatar_url: '/images/nobita-discord.png',
    banner: null,
    banner_url: null,
    banner_color: '#5865F2',
    accent_color: 5793266,
    status: 'online',
    about_me: 'hii I am a game devoloper / bot devoloper\njoin for - nobitahost.in\nnobitahost.in\nfounder of nobitahost.in',
    created_at: createdDate.toISOString(),
    formatted_created_at: formattedDate,
    website: 'https://nobitahost.in/',
    discord_url: `https://discord.com/users/${DEVELOPER_ID}`,
    mention: `<@${DEVELOPER_ID}>`,
    lanyard_monitored: false,
    activities: [],
    spotify: null,
    source: 'local'
  };

  // 1. Try Lanyard API
  try {
    const lanyardRes = await fetch(`https://api.lanyard.rest/v1/users/${DEVELOPER_ID}`, {
      headers: { 'User-Agent': 'DARKONYX PANEL-Live-Profile/1.0' },
      signal: AbortSignal.timeout(3000)
    });
    if (lanyardRes.ok) {
      const json = await lanyardRes.json();
      if (json && json.success && json.data) {
        const d = json.data;
        const u = d.discord_user || {};
        baseProfile.lanyard_monitored = true;
        baseProfile.status = d.discord_status || 'online';
        baseProfile.source = 'lanyard';
        if (u.username) baseProfile.username = u.username;
        if (u.global_name) baseProfile.global_name = u.global_name;
        if (u.avatar) {
          const ext = u.avatar.startsWith('a_') ? 'gif' : 'png';
          baseProfile.avatar = u.avatar;
          baseProfile.avatar_url = `https://cdn.discordapp.com/avatars/${DEVELOPER_ID}/${u.avatar}.${ext}?size=256`;
        }
        if (u.banner) {
          const ext = u.banner.startsWith('a_') ? 'gif' : 'png';
          baseProfile.banner = u.banner;
          baseProfile.banner_url = `https://cdn.discordapp.com/banners/${DEVELOPER_ID}/${u.banner}.${ext}?size=1024`;
        }
        if (u.banner_color) baseProfile.banner_color = u.banner_color;
        if (u.accent_color) baseProfile.accent_color = u.accent_color;
        baseProfile.activities = d.activities || [];
        baseProfile.spotify = d.listening_to_spotify ? d.spotify : null;
        cachedProfile = baseProfile;
        lastFetchTime = now;
        return cachedProfile;
      }
    }
  } catch (err) {
    // ignore Lanyard fetch errors
  }

  // 2. Try Discord Official API if bot token is set in env
  const botToken = process.env.DISCORD_BOT_TOKEN;
  if (botToken) {
    try {
      const discordRes = await fetch(`https://discord.com/api/v10/users/${DEVELOPER_ID}`, {
        headers: {
          Authorization: `Bot ${botToken}`,
          'User-Agent': 'DARKONYX PANEL-Live-Profile/1.0'
        },
        signal: AbortSignal.timeout(3000)
      });
      if (discordRes.ok) {
        const u = await discordRes.json();
        baseProfile.source = 'discord_api';
        if (u.username) baseProfile.username = u.username;
        if (u.global_name) baseProfile.global_name = u.global_name;
        if (u.avatar) {
          const ext = u.avatar.startsWith('a_') ? 'gif' : 'png';
          baseProfile.avatar = u.avatar;
          baseProfile.avatar_url = `https://cdn.discordapp.com/avatars/${DEVELOPER_ID}/${u.avatar}.${ext}?size=256`;
        }
        if (u.banner) {
          const ext = u.banner.startsWith('a_') ? 'gif' : 'png';
          baseProfile.banner = u.banner;
          baseProfile.banner_url = `https://cdn.discordapp.com/banners/${DEVELOPER_ID}/${u.banner}.${ext}?size=1024`;
        }
        if (u.banner_color) baseProfile.banner_color = u.banner_color;
        if (u.accent_color) baseProfile.accent_color = u.accent_color;
        cachedProfile = baseProfile;
        lastFetchTime = now;
        return cachedProfile;
      }
    } catch (err) {
      // ignore Discord API fetch errors
    }
  }

  cachedProfile = baseProfile;
  lastFetchTime = now;
  return cachedProfile;
}

router.get('/developer-discord', async (req, res) => {
  try {
    const profile = await fetchDeveloperProfile();
    res.json({
      success: true,
      profile
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

module.exports = router;

