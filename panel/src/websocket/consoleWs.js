const jwt = require('jsonwebtoken');
const url = require('url');
const config = require('../config/config');
const { query } = require('../database/db');
const runnerService = require('../services/runnerService');
const updateService = require('../services/updateService');
const { logActivity } = require('../services/activityService');

function setupWebSocket(wss) {
  wss.on('connection', async (ws, req) => {
    try {
      const parsedUrl = url.parse(req.url, true);
      const pathname = parsedUrl.pathname; // e.g. /ws/servers/1/console or /ws/admin/updates
      const token = parsedUrl.query.token;

      if (!token) {
        ws.send(JSON.stringify({ type: 'error', message: 'Authentication token required.' }));
        return ws.close(4001, 'Unauthorized');
      }

      // Verify JWT
      let decoded;
      try {
        decoded = jwt.verify(token, config.JWT_SECRET);
      } catch (err) {
        ws.send(JSON.stringify({ type: 'error', message: 'Invalid or expired token.' }));
        return ws.close(4001, 'Unauthorized');
      }

      const user = await query.get('SELECT id, username, role, suspended FROM users WHERE id = ?', [decoded.id]);
      if (!user || user.suspended) {
        ws.send(JSON.stringify({ type: 'error', message: 'User suspended or invalid.' }));
        return ws.close(4003, 'Forbidden');
      }

      // Handler for System Updates Terminal: /ws/admin/updates
      if (pathname.startsWith('/ws/admin/updates')) {
        if (user.role !== 'admin') {
          ws.send(JSON.stringify({ type: 'error', message: 'Admin access required.' }));
          return ws.close(4003, 'Forbidden');
        }

        updateService.subscribeSocket(ws);

        ws.on('message', async (data) => {
          try {
            const msg = JSON.parse(data.toString());
            if (msg.action === 'start_update') {
              updateService.runUpdate({ mode: msg.mode || 'standard' }, user.id, req)
                .catch(e => console.error('WS Update error:', e.message));
            } else if (msg.action === 'sync') {
              updateService.runSyncOnly(user.id, req)
                .catch(e => console.error('WS Sync error:', e.message));
            } else if (msg.action === 'check') {
              const status = await updateService.checkUpdates(true);
              ws.send(JSON.stringify({ type: 'status', data: status }));
            }
          } catch (e) {
            ws.send(JSON.stringify({ type: 'error', message: e.message }));
          }
        });

        ws.on('close', () => {
          updateService.unsubscribeSocket(ws);
        });

        ws.on('error', () => {
          updateService.unsubscribeSocket(ws);
        });

        return;
      }

      // Match path: /ws/servers/:id/console
      const match = pathname.match(/\/ws\/servers\/(\d+)\/console/);
      if (!match) {
        ws.send(JSON.stringify({ type: 'error', message: 'Invalid WebSocket endpoint.' }));
        return ws.close(4004, 'Not Found');
      }

      const serverId = parseInt(match[1], 10);
      const server = await query.get('SELECT * FROM servers WHERE id = ?', [serverId]);
      if (!server) {
        ws.send(JSON.stringify({ type: 'error', message: 'Server not found.' }));
        return ws.close(4004, 'Server Not Found');
      }

      // Check permission
      if (user.role !== 'admin' && server.user_id !== user.id) {
        const subuser = await query.get('SELECT * FROM subusers WHERE server_id = ? AND user_id = ?', [serverId, user.id]);
        if (!subuser) {
          ws.send(JSON.stringify({ type: 'error', message: 'Access denied.' }));
          return ws.close(4003, 'Forbidden');
        }
      }

      // Attach client to runner service
      runnerService.subscribeSocket(serverId, ws);

      ws.on('message', async (data) => {
        try {
          const msg = JSON.parse(data.toString());

          if (msg.action === 'command' && msg.command) {
            runnerService.sendCommand(serverId, msg.command);
            logActivity(user.id, serverId, 'SERVER_COMMAND', msg.command);
          } else if (msg.action === 'power') {
            if (msg.signal === 'start') {
              await runnerService.startServer(serverId);
              logActivity(user.id, serverId, 'SERVER_START');
            } else if (msg.signal === 'stop') {
              await runnerService.stopServer(serverId);
              logActivity(user.id, serverId, 'SERVER_STOP');
            } else if (msg.signal === 'restart') {
              await runnerService.restartServer(serverId);
              logActivity(user.id, serverId, 'SERVER_RESTART');
            } else if (msg.signal === 'kill') {
              await runnerService.killServer(serverId);
              logActivity(user.id, serverId, 'SERVER_KILL');
            }
          }
        } catch (err) {
          ws.send(JSON.stringify({ type: 'error', message: err.message }));
        }
      });

      ws.on('close', () => {
        runnerService.unsubscribeSocket(serverId, ws);
      });

      ws.on('error', () => {
        runnerService.unsubscribeSocket(serverId, ws);
      });

    } catch (err) {
      console.error('WebSocket connection error:', err);
      ws.close(4500, 'Server Error');
    }
  });
}

module.exports = { setupWebSocket };

