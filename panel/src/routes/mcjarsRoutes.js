const express = require('express');
const router = express.Router();
const mcjarsService = require('../services/mcjarsService');
const { authenticate, requireServerAccess } = require('../middleware/auth');
const { logActivity } = require('../services/activityService');
const { query } = require('../database/db');

// List all supported Minecraft jar types
router.get('/types', authenticate, async (req, res) => {
  try {
    const types = await mcjarsService.getTypes();
    res.json({ success: true, types });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Failed to fetch jar types.' });
  }
});

// List all versions for a jar type
router.get('/types/:type/versions', authenticate, async (req, res) => {
  try {
    const typeId = req.params.type;
    const versions = await mcjarsService.getVersions(typeId);
    res.json({ success: true, versions });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Failed to fetch jar versions.' });
  }
});

// Install jar to server
router.post('/install/:serverId', authenticate, requireServerAccess('files.write'), async (req, res) => {
  try {
    const serverId = req.params.serverId;
    const { type, version, build, docker_image } = req.body;

    if (!type || !version) {
      return res.status(400).json({ success: false, error: 'Jar type and version are required.' });
    }

    const targetImage = docker_image || mcjarsService.getRecommendedJavaImage(version);
    const installResult = await mcjarsService.installJarToServer(serverId, type, version, build || 'latest');

    // Update server records
    await query.run(
      'UPDATE servers SET jar_type = ?, jar_version = ?, jar_build = ?, docker_image = COALESCE(?, docker_image), updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      [type, version, build || 'latest', targetImage, serverId]
    );

    logActivity(req.user.id, serverId, 'MCJAR_INSTALL', `Installed ${type} ${version} (${targetImage})`, req);

    res.json({
      success: true,
      message: `Successfully downloaded and installed ${type} (${version}) server jar!`,
      result: installResult
    });
  } catch (err) {
    console.error('MCJar install error:', err);
    res.status(500).json({ success: false, error: `Failed to install Minecraft jar: ${err.message}` });
  }
});

module.exports = router;

