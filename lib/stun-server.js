/**
 * STUN server implementation for WebRTC NAT traversal
 * Helps peers determine their public IP address and port
 */

const stun = require('node-stun-server');

class StunServer {
  /**
   * Create a new STUN server
   * @param {Object} config - Configuration options
   */
  constructor(config) {
    this.config = config;
    this.server = null;
    
    // Default STUN server ports if not specified
    this.primaryPort = config.stunPort || 3478;
    this.secondaryPort = config.stunPortSecondary || 3479;
    
    // Host to bind to (0.0.0.0 = all interfaces)
    this.host = config.stunHost || '0.0.0.0';
  }
  
  /**
   * Start the STUN server
   * @returns {Promise} Resolves when server is listening
   */
  start() {
    return new Promise((resolve, reject) => {
      try {
        this.server = stun.createServer({
          primary: {
            host: this.host,
            port: this.primaryPort
          },
          secondary: {
            host: this.host,
            port: this.secondaryPort
          }
        });
        
        this.server.listen(() => {
          console.log(`STUN server listening on ports ${this.primaryPort} and ${this.secondaryPort}`);
          resolve();
        });
        
        this.setupEventHandlers();
      } catch (err) {
        console.error('Failed to start STUN server:', err);
        reject(err);
      }
    });
  }
  
  /**
   * Set up event handlers for the STUN server
   */
  setupEventHandlers() {
    // Add event handlers as needed
    if (this.server.on) {
      this.server.on('error', (err) => {
        console.error('STUN server error:', err);
      });
      
      // Log binding requests if enabled
      if (this.config.logStunRequests) {
        this.server.on('bindingRequest', (rinfo) => {
          console.log(`STUN binding request from ${rinfo.address}:${rinfo.port}`);
        });
      }
    }
  }
  
  /**
   * Stop the STUN server
   */
  stop() {
    if (this.server) {
      this.server.close(() => {
        console.log('STUN server stopped');
      });
      this.server = null;
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
    return {
      urls: [
        `stun:${this.config.publicIp || this.host}:${this.primaryPort}`,
        `stun:${this.config.publicIp || this.host}:${this.secondaryPort}`
      ]
    };
  }
}

module.exports = StunServer;