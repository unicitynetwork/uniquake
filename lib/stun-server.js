/**
 * STUN server implementation for WebRTC NAT traversal
 * Uses ministun for a lightweight STUN server implementation
 */

const Ministun = require('ministun');

class StunServer {
  /**
   * Create a new STUN server
   * @param {Object} config - Configuration options
   */
  constructor(config) {
    this.config = config;
    this.server = null;
    this.serverSecondary = null;
    
    // Default STUN server ports if not specified
    this.primaryPort = config.stunPort || 3478;
    this.secondaryPort = config.stunPortSecondary || 3479;
    
    // Host to bind to (0.0.0.0 = all interfaces)
    this.host = config.stunHost || '0.0.0.0';
    
    // Store logger for later use
    this.logger = config.logger || console;
  }
  
  /**
   * Start the STUN server
   * @returns {Promise} Resolves when server is listening
   */
  async start() {
    try {
      // Create primary STUN server
      this.server = new Ministun({
        udp4: true,
        udp6: false, // Just use IPv4 for now
        port: this.primaryPort,
        log: (msg) => this.logger.info(`STUN: ${msg}`),
        err: (msg) => this.logger.error(`STUN Error: ${msg}`),
        sw: true
      });
      
      // Start the server
      await this.server.start();
      this.logger.info(`STUN server listening on port ${this.primaryPort} (UDP)`);
      
      // Start secondary server if different port
      if (this.secondaryPort !== this.primaryPort) {
        await this.startSecondaryServer();
      }
      
      return true;
    } catch (err) {
      this.logger.error('Failed to start STUN server:', err);
      throw err;
    }
  }
  
  /**
   * Start secondary STUN server
   */
  async startSecondaryServer() {
    try {
      // Create secondary STUN server
      this.serverSecondary = new Ministun({
        udp4: true,
        udp6: false,
        port: this.secondaryPort,
        log: (msg) => this.logger.info(`STUN Secondary: ${msg}`),
        err: (msg) => this.logger.error(`STUN Secondary Error: ${msg}`),
        sw: true
      });
      
      // Start the server
      await this.serverSecondary.start();
      this.logger.info(`Secondary STUN server listening on port ${this.secondaryPort} (UDP)`);
      
      return true;
    } catch (err) {
      this.logger.warn(`Failed to start secondary STUN server: ${err.message}`);
      return false;
    }
  }
  
  /**
   * Stop the STUN server
   */
  async stop() {
    // Stop primary server
    if (this.server) {
      try {
        await this.server.stop();
        this.logger.info('STUN server stopped');
      } catch (err) {
        this.logger.error('Error stopping STUN server:', err);
      }
      this.server = null;
    }
    
    // Stop secondary server
    if (this.serverSecondary) {
      try {
        await this.serverSecondary.stop();
        this.logger.info('Secondary STUN server stopped');
      } catch (err) {
        this.logger.error('Error stopping secondary STUN server:', err);
      }
      this.serverSecondary = null;
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
   * Get STUN server configuration for ICE
   * @returns {Object} STUN server configuration
   */
  getServerConfig() {
    const publicIp = this.config.publicIp || this.host;
    
    if (publicIp === '0.0.0.0') {
      this.logger.warn('WARNING: Using 0.0.0.0 as STUN server IP. This will not work for clients. Please set a public IP.');
    }
    
    const urls = [`stun:${publicIp}:${this.primaryPort}`];
    
    // Add secondary server if on different port
    if (this.secondaryPort !== this.primaryPort) {
      urls.push(`stun:${publicIp}:${this.secondaryPort}`);
    }
    
    return { urls };
  }
}

module.exports = StunServer;