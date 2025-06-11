/**
 * UniQuake Master Server with WebRTC support
 * Combines signaling, STUN, TURN, and WebSocket proxy services
 */

const http = require('http');
const WebSocketServer = require('ws').Server;
const _ = require('underscore');
const logger = require('winston');
const path = require('path');

// Import our components
const CredentialManager = require('./credential-manager');
const ServerRegistry = require('./server-registry');
const StunServer = require('./stun-server');
const TurnServer = require('./turn-server');
const SignalingService = require('./signaling-service');
const TransportService = require('./transport-service');

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
    
    // Create WebSocket server for signaling
    this.wsServer = new WebSocketServer({
      server: this.httpServer
    });
    
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
    
    // Set WebSocket server for transport service
    this.transportService.setWebSocketServer(this.wsServer);
    
    // Create signaling service
    this.signalingService = new SignalingService(
      this.wsServer,
      this.serverRegistry,
      this.credentialManager,
      this.transportService,
      this // Pass reference to self
    );
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
      pruneInterval: 350000, // 350 seconds
      credentialRotationInterval: 86400000, // 24 hours
      
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
      
      // Start HTTP server
      await new Promise((resolve) => {
        this.httpServer.listen(this.config.port, this.config.host, () => {
          const address = this.httpServer.address();
          logger.info(`Master server listening on ${address.address}:${address.port}`);
          resolve();
        });
      });
      
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
    
    // Stop TURN server
    this.turnServer.stop();
    
    // Stop STUN server
    this.stunServer.stop();
    
    // Stop HTTP/WebSocket server
    if (this.httpServer) {
      await new Promise((resolve) => {
        this.httpServer.close(() => {
          logger.info('HTTP server stopped');
          resolve();
        });
      });
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
    
    return {
      uptime: process.uptime(),
      servers: serverCount,
      clients: clientCount,
      pendingConnections: pendingConnectionCount,
      stunServer: this.stunServer.isRunning(),
      turnServer: this.turnServer.isRunning()
    };
  }
}

module.exports = MasterServer;