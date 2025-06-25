/**
 * WSS Proxy Server
 * Provides secure WebSocket proxy for QuakeJS dedicated servers
 * Proxies WSS connections to local WS game servers
 */

const https = require('https');
const WebSocket = require('ws');
const logger = require('winston');
const fs = require('fs');

class WSSProxy {
  /**
   * Create a WSS proxy for a game server
   * @param {Object} options - Proxy configuration
   * @param {number} options.targetPort - Target game server port
   * @param {number} options.proxyPort - Proxy server port
   * @param {string} options.sslCertPath - Path to SSL certificate
   * @param {string} options.sslKeyPath - Path to SSL private key
   * @param {string} options.gameId - Game server ID for logging
   */
  constructor(options) {
    this.targetPort = options.targetPort;
    this.proxyPort = options.proxyPort;
    this.sslCertPath = options.sslCertPath;
    this.sslKeyPath = options.sslKeyPath;
    this.gameId = options.gameId;
    this.server = null;
    this.wss = null;
    this.connections = new Map();
  }

  /**
   * Start the WSS proxy server
   */
  async start() {
    try {
      // Create HTTPS server with SSL certificates
      const httpsOptions = {
        cert: fs.readFileSync(this.sslCertPath),
        key: fs.readFileSync(this.sslKeyPath)
      };

      this.server = https.createServer(httpsOptions);
      
      // Create secure WebSocket server
      this.wss = new WebSocket.Server({ 
        server: this.server,
        perMessageDeflate: false // Disable compression for game traffic
      });

      // Handle new WSS connections
      this.wss.on('connection', (clientWs, req) => {
        const clientIp = req.socket.remoteAddress;
        logger.info(`[WSS Proxy ${this.gameId}] New secure connection from ${clientIp}`);

        // Create connection to target game server
        const targetUrl = `ws://localhost:${this.targetPort}`;
        const serverWs = new WebSocket(targetUrl, {
          perMessageDeflate: false
        });

        // Store connection pair
        const connectionId = `${clientIp}-${Date.now()}`;
        this.connections.set(connectionId, { client: clientWs, server: serverWs });

        // Handle server connection
        serverWs.on('open', () => {
          logger.debug(`[WSS Proxy ${this.gameId}] Connected to game server on port ${this.targetPort}`);
        });

        // Proxy messages from client to server
        clientWs.on('message', (data) => {
          if (serverWs.readyState === WebSocket.OPEN) {
            serverWs.send(data);
          }
        });

        // Proxy messages from server to client
        serverWs.on('message', (data) => {
          if (clientWs.readyState === WebSocket.OPEN) {
            clientWs.send(data);
          }
        });

        // Handle client disconnect
        clientWs.on('close', () => {
          logger.debug(`[WSS Proxy ${this.gameId}] Client disconnected`);
          if (serverWs.readyState === WebSocket.OPEN) {
            serverWs.close();
          }
          this.connections.delete(connectionId);
        });

        // Handle server disconnect
        serverWs.on('close', () => {
          logger.debug(`[WSS Proxy ${this.gameId}] Server connection closed`);
          if (clientWs.readyState === WebSocket.OPEN) {
            clientWs.close();
          }
          this.connections.delete(connectionId);
        });

        // Handle errors
        clientWs.on('error', (err) => {
          logger.error(`[WSS Proxy ${this.gameId}] Client error:`, err.message);
          serverWs.close();
        });

        serverWs.on('error', (err) => {
          logger.error(`[WSS Proxy ${this.gameId}] Server error:`, err.message);
          clientWs.close();
        });
      });

      // Start listening
      await new Promise((resolve, reject) => {
        this.server.listen(this.proxyPort, '0.0.0.0', (err) => {
          if (err) reject(err);
          else resolve();
        });
      });

      logger.info(`[WSS Proxy ${this.gameId}] Listening on port ${this.proxyPort} (WSS) -> ${this.targetPort} (WS)`);
      return true;
    } catch (err) {
      logger.error(`[WSS Proxy ${this.gameId}] Failed to start:`, err.message);
      throw err;
    }
  }

  /**
   * Stop the WSS proxy server
   */
  async stop() {
    logger.info(`[WSS Proxy ${this.gameId}] Stopping proxy server...`);

    // Close all active connections
    for (const [id, conn] of this.connections) {
      if (conn.client.readyState === WebSocket.OPEN) {
        conn.client.close();
      }
      if (conn.server.readyState === WebSocket.OPEN) {
        conn.server.close();
      }
    }
    this.connections.clear();

    // Close WebSocket server
    if (this.wss) {
      await new Promise((resolve) => {
        this.wss.close(() => resolve());
      });
    }

    // Close HTTPS server
    if (this.server) {
      await new Promise((resolve) => {
        this.server.close(() => resolve());
      });
    }

    logger.info(`[WSS Proxy ${this.gameId}] Stopped`);
  }

  /**
   * Get proxy server information
   */
  getInfo() {
    return {
      gameId: this.gameId,
      targetPort: this.targetPort,
      proxyPort: this.proxyPort,
      connections: this.connections.size,
      running: this.server && this.server.listening
    };
  }
}

module.exports = WSSProxy;