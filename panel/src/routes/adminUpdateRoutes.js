const express = require('express');
const router = express.Router();
const updateService = require('../services/updateService');
const { authenticate, requireAdmin } = require('../middleware/auth');

// All update routes require Admin authentication
router.use(authenticate, requireAdmin);

// Check updates status from GitHub
router.get('/status', async (req, res) => {
  try {
    const force = req.query.force === 'true' || req.query.refresh === '1';
    const data = await updateService.checkUpdates(force);
    res.json(data);
  } catch (err) {
    console.error('Error checking updates:', err);
    res.status(500).json({
      success: false,
      error: 'Failed to check updates: ' + err.message,
      current_version: updateService.getCurrentVersion()
    });
  }
});

// Get release history from GitHub
router.get('/releases', async (req, res) => {
  try {
    const data = await updateService.checkUpdates(false);
    res.json({
      success: true,
      current_version: data.current_version,
      latest_version: data.latest_version,
      releases: data.releases_history || []
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Run full update pipeline
router.post('/run', async (req, res) => {
  try {
    const { mode } = req.body || {};
    // Trigger in background if requested, or run directly
    updateService.runUpdate({ mode: mode || 'standard' }, req.user.id, req)
      .catch(e => console.error('Background update error:', e.message));

    res.json({
      success: true,
      message: 'System update initiated. Watch live terminal for real-time progress.',
      isUpdating: true
    });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// Run dependency & migration sync
router.post('/sync-deps', async (req, res) => {
  try {
    updateService.runSyncOnly(req.user.id, req)
      .catch(e => console.error('Background sync error:', e.message));

    res.json({
      success: true,
      message: 'Dependency & database sync started.',
      isUpdating: true
    });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// Get Git repository detailed status
router.get('/git-status', async (req, res) => {
  try {
    const gitInfo = await updateService.getGitInfo();
    res.json({ success: true, git: gitInfo });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;

