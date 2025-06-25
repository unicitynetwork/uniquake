/**
 * UniQuake Master Server with WebRTC support
 * Combines signaling, STUN, TURN, and WebSocket proxy services
 * Now with support for remote dedicated game server management
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const WebSocketServer = require('ws').Server;
const _ = require('underscore');
const logger = require('winston');
const path = require('path');
const envConfig = require('./config');

// Import our components
const CredentialManager = require('./credential-manager');
const ServerRegistry = require('./server-registry');
const StunServer = require('./stun-server');
const TurnServer = require('./turn-server');
const SignalingService = require('./signaling-service');
const TransportService = require('./transport-service');
const GameServerManager = require('./game-server-manager');

// We don't need to import the QuakeMasterHandler directly
// const QuakeMasterHandler = require('./quake/master-handler');

class MasterServer {
  /**
   * Create a new master server
   * @param {string|Object} config - Configuration file path or object
   */
  constructor(config) {
    // Set up logging
    logger.cli();
    logger.level = 'debug';
    
    // Load configuration
    this.config = this.loadConfig(config);
    
    // Set logger for components
    this.config.logger = logger;
    
    // Initialize components
    this.initializeComponents();
  }
  
  /**
   * Initialize all server components
   */
  initializeComponents() {
    // Create HTTP server
    this.httpServer = http.createServer();
    
    // Create WebSocket server for signaling (HTTP)
    this.wsServer = new WebSocketServer({
      server: this.httpServer
    });
    
    // Create HTTPS server if SSL is available
    if (envConfig.sslAvailable) {
      try {
        const httpsOptions = {
          cert: fs.readFileSync(envConfig.sslCertPath),
          key: fs.readFileSync(envConfig.sslKeyPath)
        };
        this.httpsServer = https.createServer(httpsOptions);
        
        // Create secure WebSocket server for signaling (HTTPS)
        this.wssServer = new WebSocketServer({
          server: this.httpsServer
        });
        
        logger.info('HTTPS server created with SSL certificates');
      } catch (err) {
        logger.error('Failed to create HTTPS server:', err.message);
        this.httpsServer = null;
        this.wssServer = null;
      }
    } else {
      this.httpsServer = null;
      this.wssServer = null;
    }
    
    // Create credential manager
    this.credentialManager = new CredentialManager(this.config);
    
    // Create server registry
    this.serverRegistry = new ServerRegistry();
    
    // Create STUN server
    this.stunServer = new StunServer(this.config);
    
    // Create TURN server
    this.turnServer = new TurnServer(this.config, this.credentialManager);
    
    // Create transport service
    this.transportService = new TransportService(
      this.config,
      this.serverRegistry
    );
    
    // Set WebSocket servers for transport service
    this.transportService.setWebSocketServer(this.wsServer);
    if (this.wssServer) {
      this.transportService.setSecureWebSocketServer(this.wssServer);
    }
    
    // Create game server manager
    this.gameServerManager = new GameServerManager({
      dedicatedServerPath: this.config.dedicatedServerPath || path.resolve('build/ioq3ded.js'),
      basePort: this.config.gameServerBasePort || envConfig.gameServerBasePort,
      maxConcurrentServers: this.config.maxGameServers || 10,
      masterServerHost: this.config.publicHostname || envConfig.hostIp,
      masterServerPort: this.config.port || envConfig.masterPort,
      serverConfigPath: this.config.serverConfigPath || 'server.cfg',
      defaultMap: this.config.defaultMap || 'q3dm1',
      logsDirectory: this.config.logsDirectory || 'logs',
      gameServerIP: this.config.gameServerIP || envConfig.gameServerIp
    });
    
    // Create signaling service and pass game server manager for integration
    this.signalingService = new SignalingService(
      this.wsServer,
      this.serverRegistry,
      this.credentialManager,
      this.transportService,
      this // Pass reference to self
    );
    
    // Register the game server manager with the signaling service
    this.signalingService.setGameServerManager(this.gameServerManager);
    
    // Create secure signaling service if HTTPS is available
    if (this.wssServer) {
      this.secureSignalingService = new SignalingService(
        this.wssServer,
        this.serverRegistry,
        this.credentialManager,
        this.transportService,
        this // Pass reference to self
      );
      
      // Register the game server manager with the secure signaling service
      this.secureSignalingService.setGameServerManager(this.gameServerManager);
    }
  }
  
  /**
   * Load server configuration
   * @param {string|Object} config - Config file path or object
   * @returns {Object} Merged configuration
   */
  loadConfig(config) {
    // Default configuration
    const defaultConfig = {
      // Basic server config
      port: 27950,
      host: '0.0.0.0',
      
      // STUN server config
      stunPort: 3478,
      stunPortSecondary: 3479,
      stunHost: '0.0.0.0',
      
      // TURN server config
      turnPort: 3478,
      turnPortRange: [49152, 65535],
      turnRealm: 'uniquake.com',
      
      // Server info
      publicIp: process.env.PUBLIC_IP || '0.0.0.0',
      publicHostname: process.env.PUBLIC_HOSTNAME,
      
      // Security
      credentialTTL: 86400, // 24 hours in seconds
      
      // Maintenance
      pruneInterval: 7200000, // 2 hours
      credentialRotationInterval: 86400000, // 24 hours
      
      // Game server management
      dedicatedServerPath: process.env.DEDICATED_SERVER_PATH || path.resolve('build/ioq3ded.js'),
      gameServerBasePort: 27961,  // Changed from 27960 to 27961
      maxGameServers: 10,
      serverConfigPath: 'server.cfg',
      defaultMap: 'q3dm1',
      logsDirectory: 'logs',
      // IP address that game servers will use (defaults to localhost, can be overridden)
      gameServerIP: process.env.GAME_SERVER_IP || 'localhost',
      
      // Debug
      logLevel: process.env.LOG_LEVEL || 'info',
      logStunRequests: false,
      turnLogLevel: 'WARNING'
    };
    
    // Load from file or object
    let userConfig = {};
    
    if (typeof config === 'string') {
      try {
        logger.info(`Loading config from ${config}`);
        userConfig = require(path.resolve(config));
      } catch (err) {
        logger.warn(`Failed to load config file: ${err.message}`);
      }
    } else if (typeof config === 'object') {
      userConfig = config;
    }
    
    // Merge configurations
    return {...defaultConfig, ...userConfig};
  }
  
  /**
   * Start the master server
   */
  async start() {
    try {
      logger.info('Starting UniQuake master server with WebRTC support...');
      
      // Start STUN server
      await this.stunServer.start();
      
      // Start TURN server
      await this.turnServer.start();
      
      // Start transport service
      this.transportService.start();
      
      // Start signaling service
      this.signalingService.start();
      
      // Start secure signaling service if available
      if (this.secureSignalingService) {
        this.secureSignalingService.start();
      }
      
      // Start HTTP server
      await new Promise((resolve) => {
        this.httpServer.listen(this.config.port, this.config.host, () => {
          const address = this.httpServer.address();
          logger.info(`Master server (HTTP/WS) listening on ${address.address}:${address.port}`);
          resolve();
        });
      });
      
      // Start HTTPS server if available (on port + 1)
      if (this.httpsServer) {
        const httpsPort = this.config.port + 1;
        await new Promise((resolve) => {
          this.httpsServer.listen(httpsPort, this.config.host, () => {
            const address = this.httpsServer.address();
            logger.info(`Master server (HTTPS/WSS) listening on ${address.address}:${address.port}`);
            resolve();
          });
        });
      }
      
      // Start maintenance tasks
      this.startMaintenanceTasks();
      
      logger.info('Master server started successfully');
      
      return true;
    } catch (err) {
      logger.error(`Failed to start master server: ${err.message}`);
      this.stop();
      throw err;
    }
  }
  
  /**
   * Register a Quake protocol handler
   * @param {Object} quakeHandler - The Quake protocol handler
   */
  registerQuakeProtocolHandler(quakeHandler) {
    this.quakeHandler = quakeHandler;
    
    // Pass the server registry to the Quake handler for heartbeat tracking
    if (quakeHandler.setServerRegistry && this.serverRegistry) {
      quakeHandler.setServerRegistry(this.serverRegistry);
    }
    
    logger.info('Quake protocol handler registered');
  }
  
  /**
   * Stop the master server
   */
  async stop() {
    logger.info('Stopping master server...');
    
    // Clear maintenance intervals
    if (this.maintenanceInterval) {
      clearInterval(this.maintenanceInterval);
    }
    
    if (this.credentialRotationInterval) {
      clearInterval(this.credentialRotationInterval);
    }
    
    // Shutdown all game servers
    if (this.gameServerManager) {
      logger.info('Shutting down all game servers...');
      await this.gameServerManager.shutdownAllServers();
    }
    
    // Force close all WebSocket connections to ensure clean shutdown
    if (this.wsServer && this.wsServer.clients) {
      logger.info(`Forcibly closing ${this.wsServer.clients.size} WebSocket connections`);
      this.wsServer.clients.forEach(client => {
        try {
          client.terminate(); // Use terminate() instead of close() for immediate closure
        } catch (err) {
          logger.error(`Error closing WebSocket connection: ${err.message}`);
        }
      });
    }
    
    // Force close all secure WebSocket connections
    if (this.wssServer && this.wssServer.clients) {
      logger.info(`Forcibly closing ${this.wssServer.clients.size} secure WebSocket connections`);
      this.wssServer.clients.forEach(client => {
        try {
          client.terminate();
        } catch (err) {
          logger.error(`Error closing secure WebSocket connection: ${err.message}`);
        }
      });
    }
    
    // Stop TURN server
    this.turnServer.stop();
    
    // Stop STUN server
    this.stunServer.stop();
    
    // Stop HTTP/WebSocket server with a timeout to ensure it doesn't hang
    if (this.httpServer) {
      await Promise.race([
        new Promise((resolve) => {
          this.httpServer.close(() => {
            logger.info('HTTP server stopped gracefully');
            resolve();
          });
        }),
        new Promise((resolve) => {
          // Force timeout after 5 seconds
          setTimeout(() => {
            logger.warn('HTTP server stop timed out, forcing shutdown');
            resolve();
          }, 5000);
        })
      ]);
    }
    
    // Stop HTTPS/WSS server if available
    if (this.httpsServer) {
      await Promise.race([
        new Promise((resolve) => {
          this.httpsServer.close(() => {
            logger.info('HTTPS server stopped gracefully');
            resolve();
          });
        }),
        new Promise((resolve) => {
          // Force timeout after 5 seconds
          setTimeout(() => {
            logger.warn('HTTPS server stop timed out, forcing shutdown');
            resolve();
          }, 5000);
        })
      ]);
    }
    
    logger.info('Master server stopped');
  }
  
  /**
   * Start periodic maintenance tasks
   */
  startMaintenanceTasks() {
    // Server pruning
    this.maintenanceInterval = setInterval(() => {
      this.serverRegistry.pruneInactiveServers(this.config.pruneInterval);
      this.signalingService.cleanupStalePendingConnections();
      
      // Also clean up inactive game servers
      if (this.gameServerManager) {
        this.gameServerManager.cleanupInactiveServers(this.config.pruneInterval);
      }
    }, Math.min(this.config.pruneInterval / 2, 60000)); // Half the prune interval or 1 minute max
    
    // Credential rotation
    this.credentialRotationInterval = setInterval(() => {
      this.credentialManager.rotateCredentials();
    }, this.config.credentialRotationInterval);
    
    logger.info('Maintenance tasks scheduled');
  }
  
  /**
   * Get server status
   * @returns {Object} Server status
   */
  getStatus() {
    const serverCount = Object.keys(this.serverRegistry.servers).length;
    const clientCount = this.signalingService.clients.size;
    const pendingConnectionCount = this.signalingService.pendingConnections.size;
    const gameServerCount = this.gameServerManager ? this.gameServerManager.servers.size : 0;
    
    return {
      uptime: process.uptime(),
      servers: serverCount,
      clients: clientCount,
      pendingConnections: pendingConnectionCount,
      stunServer: this.stunServer.isRunning(),
      turnServer: this.turnServer.isRunning(),
      gameServers: gameServerCount
    };
  }
  
  /**
   * Start a new game server
   * @param {Object} serverInfo - Server info
   * @returns {Promise<Object>} Server instance or null if failed
   */
  async startGameServer(serverInfo) {
    if (!this.gameServerManager) {
      logger.error('Game server manager not initialized');
      return null;
    }
    
    return await this.gameServerManager.startServer(serverInfo);
  }
  
  /**
   * Stop a game server
   * @param {string} gameId - Game ID to stop
   * @returns {Promise<boolean>} Success flag
   */
  async stopGameServer(gameId) {
    if (!this.gameServerManager) {
      logger.error('Game server manager not initialized');
      return false;
    }
    
    return await this.gameServerManager.stopServer(gameId);
  }
  
  /**
   * Get game server status
   * @param {string} gameId - Game ID to check
   * @returns {Object|null} Server status or null if not found
   */
  getGameServerStatus(gameId) {
    if (!this.gameServerManager) {
      logger.error('Game server manager not initialized');
      return null;
    }
    
    return this.gameServerManager.getServerStatus(gameId);
  }
  
  /**
   * Get all game servers
   * @returns {Array} List of server status objects
   */
  getAllGameServers() {
    if (!this.gameServerManager) {
      return [];
    }
    
    return this.gameServerManager.getAllServers();
  }
  
  /**
   * Read game server logs
   * @param {string} gameId - Game ID
   * @param {number} lines - Number of lines to read (default: 100)
   * @returns {Promise<string[]>} Array of log lines
   */
  async readGameServerLogs(gameId, lines = 100) {
    if (!this.gameServerManager) {
      logger.error('Game server manager not initialized');
      return [];
    }
    
    return await this.gameServerManager.readServerLogs(gameId, lines);
  }
}

module.exports = MasterServer;