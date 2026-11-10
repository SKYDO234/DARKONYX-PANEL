const express = require('express');
const router = express.Router({ mergeParams: true });
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const unzipper = require('unzipper');
const config = require('../config/config');
const worldService = require('../services/worldService');
const { authenticate, requireServerAccess } = require('../middleware/auth');
const { logActivity } = require('../services/activityService');

// Multer upload config for world zip imports
const worldUploadStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const tmpDir = path.join(config.UPLOADS_DIR, 'tmp_worlds');
    if (!fs.existsSync(tmpDir)) {
      fs.mkdirSync(tmpDir, { recursive: true });
    }
    cb(null, tmpDir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `world-upload-${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`);
  }
});

const uploadWorldZip = multer({
  storage: worldUploadStorage,
  limits: { fileSize: 1024 * 1024 * 1024 } // 1GB limit for large world saves
});

// 1. List all worlds & active world details
router.get('/', authenticate, requireServerAccess('files.read'), async (req, res) => {
  try {
    const serverId = req.server?.id || req.params.serverId;
    const result = await worldService.listWorlds(serverId);
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('[serverWorldRoutes] listWorlds error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// 2. Set Active World (updates server.properties level-name)
router.post('/activate', authenticate, requireServerAccess('files.write'), async (req, res) => {
  try {
    const serverId = req.server?.id || req.params.serverId;
    const { worldName } = req.body;
    if (!worldName) {
      return res.status(400).json({ success: false, error: 'worldName is required.' });
    }

    const result = await worldService.activateWorld(serverId, worldName);
    logActivity(req.user.id, serverId, 'WORLD_ACTIVATE', `Activated world "${worldName}"`, req);
    res.json(result);
  } catch (err) {
    console.error('[serverWorldRoutes] activateWorld error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// 3. Create a new world
router.post('/create', authenticate, requireServerAccess('files.write'), async (req, res) => {
  try {
    const serverId = req.server?.id || req.params.serverId;
    const { name, seed, gameMode, difficulty, hardcore, levelType, generateStructures, setActive } = req.body;

    if (!name) {
      return res.status(400).json({ success: false, error: 'World name is required.' });
    }

    const result = await worldService.createWorld(serverId, {
      name,
      seed,
      gameMode,
      difficulty,
      hardcore,
      levelType,
      generateStructures,
      setActive: setActive !== false
    });

    logActivity(req.user.id, serverId, 'WORLD_CREATE', `Created world "${name}"`, req);
    res.json(result);
  } catch (err) {
    console.error('[serverWorldRoutes] createWorld error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// 4. Clone an existing world
router.post('/clone', authenticate, requireServerAccess('files.write'), async (req, res) => {
  try {
    const serverId = req.server?.id || req.params.serverId;
    const { sourceWorld, targetWorld } = req.body;

    if (!sourceWorld || !targetWorld) {
      return res.status(400).json({ success: false, error: 'sourceWorld and targetWorld are required.' });
    }

    const result = await worldService.cloneWorld(serverId, sourceWorld, targetWorld);
    logActivity(req.user.id, serverId, 'WORLD_CLONE', `Cloned world "${sourceWorld}" to "${targetWorld}"`, req);
    res.json(result);
  } catch (err) {
    console.error('[serverWorldRoutes] cloneWorld error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// 5. Delete an inactive world
router.post('/delete', authenticate, requireServerAccess('files.write'), async (req, res) => {
  try {
    const serverId = req.server?.id || req.params.serverId;
    const { worldName } = req.body;

    if (!worldName) {
      return res.status(400).json({ success: false, error: 'worldName is required.' });
    }

    const result = await worldService.deleteWorld(serverId, worldName);
    logActivity(req.user.id, serverId, 'WORLD_DELETE', `Deleted world "${worldName}"`, req);
    res.json(result);
  } catch (err) {
    console.error('[serverWorldRoutes] deleteWorld error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// 6. Reset a world (deletes chunks and entity data to regenerate)
router.post('/reset', authenticate, requireServerAccess('files.write'), async (req, res) => {
  try {
    const serverId = req.server?.id || req.params.serverId;
    const { worldName } = req.body;

    if (!worldName) {
      return res.status(400).json({ success: false, error: 'worldName is required.' });
    }

    const result = await worldService.resetWorld(serverId, worldName);
    logActivity(req.user.id, serverId, 'WORLD_RESET', `Reset world "${worldName}"`, req);
    res.json(result);
  } catch (err) {
    console.error('[serverWorldRoutes] resetWorld error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// 7. Download world as .zip archive
router.get('/:worldName/download', authenticate, requireServerAccess('files.read'), async (req, res) => {
  try {
    const serverId = req.server?.id || req.params.serverId;
    const { worldName } = req.params;
    const safeName = path.basename(worldName.trim());

    res.attachment(`${safeName}_${Date.now()}.zip`);
    const archive = worldService.createExportStream(serverId, safeName);
    archive.pipe(res);
  } catch (err) {
    console.error('[serverWorldRoutes] download error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// 8. Import / Upload world .zip archive
router.post('/upload', authenticate, requireServerAccess('files.write'), uploadWorldZip.single('file'), async (req, res) => {
  try {
    const serverId = req.server?.id || req.params.serverId;
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'No .zip file uploaded.' });
    }

    let worldName = req.body.worldName;
    if (!worldName) {
      worldName = path.parse(req.file.originalname).name.replace(/[^a-zA-Z0-9_\-]/g, '_');
    }
    worldName = worldName.trim().replace(/[^a-zA-Z0-9_\-]/g, '_');

    const serverDir = worldService.getServerRoot(serverId);
    const destDir = path.join(serverDir, worldName);

    if (fs.existsSync(destDir)) {
      // Remove temp file
      if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
      return res.status(400).json({ success: false, error: `World folder "${worldName}" already exists.` });
    }

    fs.mkdirSync(destDir, { recursive: true });

    // Extract archive into destDir
    await new Promise((resolve, reject) => {
      fs.createReadStream(req.file.path)
        .pipe(unzipper.Extract({ path: destDir }))
        .on('close', resolve)
        .on('error', reject);
    });

    // Cleanup temp zip
    if (fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }

    // Check if zip had a nested folder that contains level.dat
    // If so, flatten if level.dat is in a subfolder
    const entries = fs.readdirSync(destDir, { withFileTypes: true });
    if (!fs.existsSync(path.join(destDir, 'level.dat')) && entries.length === 1 && entries[0].isDirectory()) {
      const nestedPath = path.join(destDir, entries[0].name);
      if (fs.existsSync(path.join(nestedPath, 'level.dat'))) {
        const subFiles = fs.readdirSync(nestedPath);
        for (const sf of subFiles) {
          fs.renameSync(path.join(nestedPath, sf), path.join(destDir, sf));
        }
        fs.rmdirSync(nestedPath);
      }
    }

    const setActive = req.body.setActive === 'true' || req.body.setActive === true;
    if (setActive) {
      worldService.updateServerProperties(serverId, { 'level-name': worldName });
    }

    logActivity(req.user.id, serverId, 'WORLD_IMPORT', `Imported world "${worldName}"`, req);

    res.json({
      success: true,
      worldName,
      isActive: setActive,
      message: `Successfully imported world "${worldName}". ${setActive ? 'Set as active world.' : ''}`
    });
  } catch (err) {
    if (req.file && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
    console.error('[serverWorldRoutes] upload error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// 9. 1-Click install map from Marketplace
router.post('/install-map', authenticate, requireServerAccess('files.write'), async (req, res) => {
  try {
    const serverId = req.server?.id || req.params.serverId;
    const { mapId, customName, setActive } = req.body;

    if (!mapId) {
      return res.status(400).json({ success: false, error: 'mapId is required.' });
    }

    const result = await worldService.installMarketplaceMap(serverId, {
      mapId,
      customName,
      setActive: setActive !== false
    });

    logActivity(req.user.id, serverId, 'MAP_INSTALL', `Installed marketplace map "${result.mapTitle}" as "${result.worldName}"`, req);
    res.json(result);
  } catch (err) {
    console.error('[serverWorldRoutes] install-map error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// 10. Install world from ANY direct download URL (.zip)
router.post('/install-url', authenticate, requireServerAccess('files.write'), async (req, res) => {
  try {
    const serverId = req.server?.id || req.params.serverId;
    const { downloadUrl, customName, setActive } = req.body;

    if (!downloadUrl) {
      return res.status(400).json({ success: false, error: 'downloadUrl is required.' });
    }

    const result = await worldService.installWorldFromUrl(serverId, {
      downloadUrl,
      customName,
      setActive: setActive !== false
    });

    logActivity(req.user.id, serverId, 'WORLD_INSTALL_URL', `Installed world from URL as "${result.worldName}"`, req);
    res.json(result);
  } catch (err) {
    console.error('[serverWorldRoutes] install-url error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
