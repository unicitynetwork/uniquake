/**
 * TURN server implementation for WebRTC NAT traversal
 * Provides relay functionality when direct connections aren't possible
 */

const turn = require('node-turn');

class TurnServer {
  /**
   * Create a new TURN server
   * @param {Object} config - Configuration options
   * @param {CredentialManager} credentialManager - Credential manager for authentication
   */
  constructor(config, credentialManager) {
    this.config = config;
    this.credentialManager = credentialManager;
    this.server = null;
    
    // Default configuration
    this.port = config.turnPort || 3478;
    this.realm = config.turnRealm || 'uniquake.com';
    this.relayPortRange = config.turnPortRange || [49152, 65535];
    
    // Get server's public IP
    this.publicIp = config.publicIp || '0.0.0.0';
    
    // Subscribe to credential updates
    if (this.credentialManager) {
      this.credentialManager.on('credentialsUpdated', (credentials) => {
        this.updateCredentials(credentials);
      });
    }
  }
  
  /**
   * Start the TURN server
   * @returns {Promise} Resolves when server is started
   */
  start() {
    return new Promise((resolve, reject) => {
      try {
        // Get current credentials
        const credentials = this.credentialManager.getCurrentCredentials();
        const credentialsObj = {};
        credentialsObj[credentials.username] = credentials.password;
        
        // Create TURN server instance
        this.server = new turn({
          // Authentication
          authMech: 'long-term',
          credentials: credentialsObj,
          realm: this.realm,
          
          // Network
          listeningPort: this.port,
          relayIps: [this.publicIp],
          relayPortRange: this.relayPortRange,
          
          // Logging
          debugLevel: this.config.turnLogLevel || 'WARNING'
        });
        
        console.log(`TURN server listening on port ${this.port}`);
        console.log(`TURN relay ports: ${this.relayPortRange[0]}-${this.relayPortRange[1]}`);
        
        resolve();
      } catch (err) {
        console.error('Failed to start TURN server:', err);
        reject(err);
      }
    });
  }
  
  /**
   * Update TURN server credentials
   * @param {Object} credentials - New credentials
   */
  updateCredentials(credentials) {
    if (!this.server) return;
    
    try {
      // Add new credential
      this.server.addUser(credentials.username, credentials.password);
      
      // Remove old credentials after a grace period
      if (this.previousCredentials) {
        setTimeout(() => {
          this.server.removeUser(this.previousCredentials.username);
        }, 5 * 60 * 1000); // 5 minute grace period
      }
      
      this.previousCredentials = credentials;
      
      console.log('TURN server credentials updated');
    } catch (err) {
      console.error('Failed to update TURN credentials:', err);
    }
  }
  
  /**
   * Stop the TURN server
   */
  stop() {
    if (this.server) {
      this.server.stop();
      this.server = null;
      console.log('TURN server stopped');
    }
  }
  
  /**
   * Check if the server is running
   * @returns {boolean} True if server is running
   */
  isRunning() {
    return this.server !== null;
  }
  
  /**
   * Get TURN server configuration for ICE
   * @returns {Object} TURN server configuration
   */
  getServerConfig() {
    const credentials = this.credentialManager.getCurrentCredentials();
    
    return {
      urls: `turn:${this.publicIp}:${this.port}`,
      username: credentials.username,
      credential: credentials.password
    };
  }
}

module.exports = TurnServer;