const ssh2 = require('ssh2');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const config = require('../config/config');
const { query } = require('../database/db');

// Standard SFTP constants
const OPEN_MODE = {
  READ: 0x00000001,
  WRITE: 0x00000002,
  APPEND: 0x00000004,
  CREATE: 0x00000008,
  TRUNC: 0x00000010,
  EXCL: 0x00000020
};

const STATUS_CODE = {
  OK: 0,
  EOF: 1,
  NO_SUCH_FILE: 2,
  PERMISSION_DENIED: 3,
  FAILURE: 4,
  BAD_MESSAGE: 5,
  NO_CONNECTION: 6,
  CONNECTION_LOST: 7,
  OP_UNSUPPORTED: 8
};

// Generate or load host key
function getHostKey() {
  const keyPath = path.join(config.DATA_DIR, 'sftp_host_key');
  if (fs.existsSync(keyPath)) {
    return fs.readFileSync(keyPath);
  }

  // Generate new RSA key pair
  const { privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'pkcs1', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' }
  });

  fs.writeFileSync(keyPath, privateKey);
  return privateKey;
}

class SFTPServer {
  constructor() {
    this.server = null;
    this.port = config.PORT_SFTP;
  }

  start() {
    const hostKey = getHostKey();

    this.server = new ssh2.Server({ hostKeys: [hostKey] }, (client) => {
      let sessionUser = null;
      let sessionServer = null;
      let serverRoot = null;

      client.on('authentication', async (ctx) => {
        if (ctx.method !== 'password') {
          return ctx.reject(['password']);
        }

        try {
          const rawUsername = ctx.username; // e.g. "admin" or "admin.1" or "admin@1"
          let username = rawUsername;
          let serverIdentifier = null;

          if (rawUsername.includes('.')) {
            const parts = rawUsername.split('.');
            username = parts[0];
            serverIdentifier = parts[1];
          } else if (rawUsername.includes('@')) {
            const parts = rawUsername.split('@');
            username = parts[0];
            serverIdentifier = parts[1];
          }

          const user = await query.get('SELECT * FROM users WHERE username = ? OR email = ?', [username, username]);
          if (!user || user.suspended) {
            return ctx.reject();
          }

          const isValidPassword = await bcrypt.compare(ctx.password, user.password_hash);
          if (!isValidPassword) {
            return ctx.reject();
          }

          // If serverIdentifier provided, verify access
          let targetServer = null;
          if (serverIdentifier) {
            targetServer = await query.get('SELECT * FROM servers WHERE id = ? OR uuid LIKE ?', [serverIdentifier, `${serverIdentifier}%`]);
          } else {
            // Get first accessible server
            if (user.role === 'admin') {
              targetServer = await query.get('SELECT * FROM servers ORDER BY id ASC LIMIT 1');
            } else {
              targetServer = await query.get('SELECT * FROM servers WHERE user_id = ? ORDER BY id ASC LIMIT 1', [user.id]);
            }
          }

          if (!targetServer) {
            return ctx.reject();
          }

          // Verify user has access to server
          if (user.role !== 'admin' && targetServer.user_id !== user.id) {
            const sub = await query.get('SELECT * FROM subusers WHERE server_id = ? AND user_id = ?', [targetServer.id, user.id]);
            if (!sub) return ctx.reject();
          }

          sessionUser = user;
          sessionServer = targetServer;
          serverRoot = path.join(config.SERVERS_DIR, `server${targetServer.id}`);

          if (!fs.existsSync(serverRoot)) {
            fs.mkdirSync(serverRoot, { recursive: true });
          }

          return ctx.accept();
        } catch (err) {
          console.error('SFTP Auth Error:', err);
          return ctx.reject();
        }
      });

      client.on('ready', () => {
        client.on('session', (accept, reject) => {
          const session = accept();

          session.on('sftp', (acceptSFTP) => {
            const sftp = acceptSFTP();
            const openFiles = new Map();
            const openDirs = new Map();
            let handleCount = 0;

            const toRealPath = (reqPath) => {
              let clean = reqPath.replace(/\\/g, '/');
              if (!clean.startsWith('/')) clean = '/' + clean;
              const resolved = path.resolve(serverRoot, '.' + clean);
              if (!resolved.startsWith(serverRoot)) {
                return serverRoot;
              }
              return resolved;
            };

            sftp.on('REALPATH', (reqid, p) => {
              sftp.name(reqid, [{ filename: '/', longname: 'drwxr-xr-x 1 darkonyx darkonyx 4096 Jan 1 00:00 /', attrs: {} }]);
            });

            sftp.on('STAT', (reqid, p) => {
              const real = toRealPath(p);
              fs.stat(real, (err, stats) => {
                if (err) return sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE);
                sftp.attrs(reqid, stats);
              });
            });

            sftp.on('LSTAT', (reqid, p) => {
              const real = toRealPath(p);
              fs.lstat(real, (err, stats) => {
                if (err) return sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE);
                sftp.attrs(reqid, stats);
              });
            });

            sftp.on('OPENDIR', (reqid, p) => {
              const real = toRealPath(p);
              fs.readdir(real, (err, files) => {
                if (err) return sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE);
                const handle = Buffer.from(`dir-${++handleCount}`);
                openDirs.set(handle.toString(), { files, dir: real, sent: false });
                sftp.handle(reqid, handle);
              });
            });

            sftp.on('READDIR', (reqid, handle) => {
              const dirInfo = openDirs.get(handle.toString());
              if (!dirInfo || dirInfo.sent) {
                return sftp.status(reqid, STATUS_CODE.EOF);
              }

              const list = [];
              for (const f of dirInfo.files) {
                const full = path.join(dirInfo.dir, f);
                try {
                  const stat = fs.statSync(full);
                  list.push({
                    filename: f,
                    longname: `${stat.isDirectory() ? 'd' : '-'}rw-r--r-- 1 darkonyx darkonyx ${stat.size} ${stat.mtime.toDateString()} ${f}`,
                    attrs: stat
                  });
                } catch (e) {}
              }

              dirInfo.sent = true;
              sftp.name(reqid, list);
            });

            sftp.on('OPEN', (reqid, filename, flags, attrs) => {
              const real = toRealPath(filename);
              let nodeFlags = 'r';

              if ((flags & OPEN_MODE.WRITE) && (flags & OPEN_MODE.READ)) {
                nodeFlags = (flags & OPEN_MODE.CREATE) ? ((flags & OPEN_MODE.TRUNC) ? 'w+' : 'a+') : 'r+';
              } else if (flags & OPEN_MODE.WRITE) {
                nodeFlags = (flags & OPEN_MODE.CREATE) ? ((flags & OPEN_MODE.TRUNC) ? 'w' : 'a') : 'r+';
              }

              fs.open(real, nodeFlags, (err, fd) => {
                if (err) return sftp.status(reqid, STATUS_CODE.FAILURE);
                const handle = Buffer.from(`file-${++handleCount}`);
                openFiles.set(handle.toString(), fd);
                sftp.handle(reqid, handle);
              });
            });

            sftp.on('READ', (reqid, handle, offset, length) => {
              const fd = openFiles.get(handle.toString());
              if (fd === undefined) return sftp.status(reqid, STATUS_CODE.FAILURE);

              const buffer = Buffer.alloc(length);
              fs.read(fd, buffer, 0, length, offset, (err, bytesRead) => {
                if (err) return sftp.status(reqid, STATUS_CODE.FAILURE);
                if (bytesRead === 0) return sftp.status(reqid, STATUS_CODE.EOF);
                sftp.data(reqid, buffer.slice(0, bytesRead));
              });
            });

            sftp.on('WRITE', (reqid, handle, offset, data) => {
              const fd = openFiles.get(handle.toString());
              if (fd === undefined) return sftp.status(reqid, STATUS_CODE.FAILURE);

              fs.write(fd, data, 0, data.length, offset, (err) => {
                if (err) return sftp.status(reqid, STATUS_CODE.FAILURE);
                sftp.status(reqid, STATUS_CODE.OK);
              });
            });

            sftp.on('CLOSE', (reqid, handle) => {
              const key = handle.toString();
              if (openFiles.has(key)) {
                const fd = openFiles.get(key);
                fs.close(fd, () => {});
                openFiles.delete(key);
              }
              if (openDirs.has(key)) {
                openDirs.delete(key);
              }
              sftp.status(reqid, STATUS_CODE.OK);
            });

            sftp.on('REMOVE', (reqid, p) => {
              const real = toRealPath(p);
              fs.unlink(real, (err) => {
                if (err) return sftp.status(reqid, STATUS_CODE.FAILURE);
                sftp.status(reqid, STATUS_CODE.OK);
              });
            });

            sftp.on('RMDIR', (reqid, p) => {
              const real = toRealPath(p);
              fs.rm(real, { recursive: true, force: true }, (err) => {
                if (err) return sftp.status(reqid, STATUS_CODE.FAILURE);
                sftp.status(reqid, STATUS_CODE.OK);
              });
            });

            sftp.on('MKDIR', (reqid, p) => {
              const real = toRealPath(p);
              fs.mkdir(real, { recursive: true }, (err) => {
                if (err) return sftp.status(reqid, STATUS_CODE.FAILURE);
                sftp.status(reqid, STATUS_CODE.OK);
              });
            });

            sftp.on('RENAME', (reqid, oldPath, newPath) => {
              const realOld = toRealPath(oldPath);
              const realNew = toRealPath(newPath);
              fs.rename(realOld, realNew, (err) => {
                if (err) return sftp.status(reqid, STATUS_CODE.FAILURE);
                sftp.status(reqid, STATUS_CODE.OK);
              });
            });
          });
        });
      });
    });

    this.server.listen(this.port, '0.0.0.0', () => {
      console.log(`🔒 Embedded SFTP Server listening on port ${this.port}`);
    });
  }
}

module.exports = new SFTPServer();
