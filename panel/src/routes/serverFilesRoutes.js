const express = require('express');
const router = express.Router({ mergeParams: true });
const path = require('path');
const fs = require('fs');
const fileManagerService = require('../services/fileManagerService');
const { authenticate, requireServerAccess } = require('../middleware/auth');
const { uploadServerFile } = require('../middleware/upload');
const { logActivity } = require('../services/activityService');

// List directory
router.get('/', authenticate, requireServerAccess('files.read'), async (req, res) => {
  try {
    const serverId = req.params.serverId;
    const directory = req.query.directory || '';
    const files = await fileManagerService.listFiles(serverId, directory);
    res.json({ success: true, files, directory });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Read file content
router.get('/content', authenticate, requireServerAccess('files.read'), async (req, res) => {
  try {
    const serverId = req.params.serverId;
    const filePath = req.query.file;
    if (!filePath) {
      return res.status(400).json({ success: false, error: 'File path query parameter is required.' });
    }
    const content = await fileManagerService.readFileContent(serverId, filePath);
    res.json({ success: true, content, filePath });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Download raw file
router.get('/download', authenticate, requireServerAccess('files.read'), async (req, res) => {
  try {
    const serverId = req.params.serverId;
    const filePath = req.query.file;
    if (!filePath) {
      return res.status(400).json({ success: false, error: 'File path required.' });
    }
    const safePath = fileManagerService.getSafePath(serverId, filePath);
    if (!fs.existsSync(safePath)) {
      return res.status(404).json({ success: false, error: 'File not found.' });
    }
    res.download(safePath, path.basename(safePath));
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Save file content
router.post('/content', authenticate, requireServerAccess('files.write'), async (req, res) => {
  try {
    const serverId = req.params.serverId;
    const { filePath, content } = req.body;
    if (!filePath) {
      return res.status(400).json({ success: false, error: 'filePath is required.' });
    }
    await fileManagerService.writeFileContent(serverId, filePath, content || '');
    logActivity(req.user.id, serverId, 'FILE_EDIT', `Edited file: ${filePath}`, req);
    res.json({ success: true, message: 'File saved successfully.' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Create Directory
router.post('/directory', authenticate, requireServerAccess('files.write'), async (req, res) => {
  try {
    const serverId = req.params.serverId;
    const { dirPath } = req.body;
    if (!dirPath) {
      return res.status(400).json({ success: false, error: 'dirPath is required.' });
    }
    await fileManagerService.createDirectory(serverId, dirPath);
    logActivity(req.user.id, serverId, 'FILE_MKDIR', `Created folder: ${dirPath}`, req);
    res.json({ success: true, message: 'Folder created successfully.' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Rename file/folder
router.post('/rename', authenticate, requireServerAccess('files.write'), async (req, res) => {
  try {
    const serverId = req.params.serverId;
    const { oldPath, newPath } = req.body;
    if (!oldPath || !newPath) {
      return res.status(400).json({ success: false, error: 'oldPath and newPath are required.' });
    }
    await fileManagerService.renameItem(serverId, oldPath, newPath);
    logActivity(req.user.id, serverId, 'FILE_RENAME', `Renamed ${oldPath} to ${newPath}`, req);
    res.json({ success: true, message: 'Item renamed successfully.' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Delete file/folder
router.post('/delete', authenticate, requireServerAccess('files.delete'), async (req, res) => {
  try {
    const serverId = req.params.serverId;
    const { itemPath } = req.body;
    if (!itemPath) {
      return res.status(400).json({ success: false, error: 'itemPath is required.' });
    }
    await fileManagerService.deleteItem(serverId, itemPath);
    logActivity(req.user.id, serverId, 'FILE_DELETE', `Deleted: ${itemPath}`, req);
    res.json({ success: true, message: 'Item deleted.' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Upload File
router.post('/upload', authenticate, requireServerAccess('files.write'), uploadServerFile.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'No file uploaded.' });
    }
    const serverId = req.params.serverId;
    logActivity(req.user.id, serverId, 'FILE_UPLOAD', `Uploaded: ${req.file.originalname}`, req);
    res.json({ success: true, fileName: req.file.originalname });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Compress / Zip Files
router.post('/compress', authenticate, requireServerAccess('files.write'), async (req, res) => {
  try {
    const serverId = req.params.serverId;
    const { files, outputName } = req.body;
    if (!files || !Array.isArray(files) || files.length === 0) {
      return res.status(400).json({ success: false, error: 'Files array is required.' });
    }
    const result = await fileManagerService.compressFiles(serverId, files, outputName || 'archive.zip');
    logActivity(req.user.id, serverId, 'FILE_COMPRESS', `Compressed ${files.length} items`, req);
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Extract Zip File
router.post('/extract', authenticate, requireServerAccess('files.write'), async (req, res) => {
  try {
    const serverId = req.params.serverId;
    const { zipFilePath, destPath } = req.body;
    if (!zipFilePath) {
      return res.status(400).json({ success: false, error: 'zipFilePath is required.' });
    }
    await fileManagerService.extractZip(serverId, zipFilePath, destPath || '');
    logActivity(req.user.id, serverId, 'FILE_EXTRACT', `Extracted ${zipFilePath}`, req);
    res.json({ success: true, message: 'Archive extracted successfully.' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Copy file/folder
router.post('/copy', authenticate, requireServerAccess('files.write'), async (req, res) => {
  try {
    const serverId = req.params.serverId;
    const { sourcePath, destPath } = req.body;
    if (!sourcePath || !destPath) {
      return res.status(400).json({ success: false, error: 'sourcePath and destPath are required.' });
    }
    await fileManagerService.copyItem(serverId, sourcePath, destPath);
    logActivity(req.user.id, serverId, 'FILE_COPY', `Copied ${sourcePath} to ${destPath}`, req);
    res.json({ success: true, message: 'Item copied successfully.' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// File Properties
router.get('/properties', authenticate, requireServerAccess('files.read'), async (req, res) => {
  try {
    const serverId = req.params.serverId;
    const filePath = req.query.file;
    if (!filePath) {
      return res.status(400).json({ success: false, error: 'File path required.' });
    }
    const properties = await fileManagerService.getFileProperties(serverId, filePath);
    res.json({ success: true, properties });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// File Permissions (chmod)
router.post('/permissions', authenticate, requireServerAccess('files.write'), async (req, res) => {
  try {
    const serverId = req.params.serverId;
    const targetFile = req.body.file || req.body.filePath;
    const mode = req.body.mode;
    if (!targetFile || mode === undefined) {
      return res.status(400).json({ success: false, error: 'file and mode are required.' });
    }
    const result = await fileManagerService.chmodItem(serverId, targetFile, mode);
    logActivity(req.user.id, serverId, 'FILE_CHMOD', `Changed permissions of ${targetFile} to ${mode}`, req);
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Search files
router.get('/search', authenticate, requireServerAccess('files.read'), async (req, res) => {
  try {
    const serverId = req.params.serverId;
    const query = req.query.query || '';
    const content = req.query.content === '1' || req.query.content === 'true';
    const results = await fileManagerService.searchFiles(serverId, query, 100, content);
    res.json({ success: true, results, count: results.length });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Pull from URL: query headers
router.post('/pull-url/query', authenticate, requireServerAccess('files.read'), async (req, res) => {
  try {
    const { url } = req.body;
    if (!url) return res.status(400).json({ success: false, error: 'URL required.' });
    const info = await fileManagerService.pullFromUrlQuery(url);
    res.json(info);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Pull from URL: download
router.post('/pull-url', authenticate, requireServerAccess('files.write'), async (req, res) => {
  try {
    const serverId = req.params.serverId;
    const { url, directory, filename } = req.body;
    if (!url) return res.status(400).json({ success: false, error: 'URL required.' });
    const result = await fileManagerService.pullFromUrl(serverId, url, directory || '', filename || '');
    logActivity(req.user.id, serverId, 'FILE_PULL_URL', `Downloaded from URL: ${url} -> ${result.filename}`, req);
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Code Beautifier
router.post('/beautify', authenticate, requireServerAccess('files.write'), async (req, res) => {
  try {
    const { content, filePath } = req.body;
    if (content === undefined || !filePath) {
      return res.status(400).json({ success: false, error: 'content and filePath are required.' });
    }
    const ext = path.extname(filePath);
    const beautified = fileManagerService.beautifyContent(content, ext);
    res.json({ success: true, beautified });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Trash: list
router.get('/trash', authenticate, requireServerAccess('files.read'), async (req, res) => {
  try {
    const serverId = req.params.serverId;
    const items = await fileManagerService.getTrashContents(serverId);
    res.json({ success: true, items, count: items.length });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Trash: move to trash
router.post('/move-to-trash', authenticate, requireServerAccess('files.delete'), async (req, res) => {
  try {
    const serverId = req.params.serverId;
    const { items } = req.body;
    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ success: false, error: 'items array is required.' });
    }
    const result = await fileManagerService.moveToTrash(serverId, items);
    logActivity(req.user.id, serverId, 'FILE_TRASH', `Moved ${items.length} items to trash`, req);
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Trash: restore
router.post('/restore-from-trash', authenticate, requireServerAccess('files.write'), async (req, res) => {
  try {
    const serverId = req.params.serverId;
    const { trashNames } = req.body;
    if (!trashNames || !Array.isArray(trashNames) || trashNames.length === 0) {
      return res.status(400).json({ success: false, error: 'trashNames array is required.' });
    }
    const result = await fileManagerService.restoreFromTrash(serverId, trashNames);
    logActivity(req.user.id, serverId, 'FILE_RESTORE_TRASH', `Restored ${trashNames.length} items from trash`, req);
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Trash: empty
router.post('/empty-trash', authenticate, requireServerAccess('files.delete'), async (req, res) => {
  try {
    const serverId = req.params.serverId;
    const result = await fileManagerService.emptyTrash(serverId);
    logActivity(req.user.id, serverId, 'FILE_EMPTY_TRASH', `Emptied trash bin`, req);
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Git: status
router.get('/git/status', authenticate, requireServerAccess('files.read'), async (req, res) => {
  try {
    const serverId = req.params.serverId;
    const status = await fileManagerService.gitStatus(serverId);
    res.json({ success: true, ...status });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Git: clone
router.post('/git/clone', authenticate, requireServerAccess('files.write'), async (req, res) => {
  try {
    const serverId = req.params.serverId;
    const { repoUrl, branch } = req.body;
    if (!repoUrl) return res.status(400).json({ success: false, error: 'repoUrl is required.' });
    const result = await fileManagerService.gitClone(serverId, repoUrl, branch);
    logActivity(req.user.id, serverId, 'GIT_CLONE', `Cloned ${repoUrl}`, req);
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Git: pull
router.post('/git/pull', authenticate, requireServerAccess('files.write'), async (req, res) => {
  try {
    const serverId = req.params.serverId;
    const result = await fileManagerService.gitPull(serverId);
    logActivity(req.user.id, serverId, 'GIT_PULL', `Executed git pull`, req);
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;

