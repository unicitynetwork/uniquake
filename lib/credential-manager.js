/**
 * TURN server credential management for WebRTC
 */

const crypto = require('crypto');
const EventEmitter = require('events');

class CredentialManager extends EventEmitter {
  /**
   * Create a new credential manager
   * @param {Object} config - Configuration options
   */
  constructor(config) {
    super();
    this.config = config;
    
    // Generate a random HMAC key for credential signing
    this.hmacKey = this.generateSecretKey();
    
    // Current active credentials
    this.credentials = this.generateCredentials();
    
    // Previous credentials (kept for a grace period)
    this.previousCredentials = null;
    
    console.log('Credential manager initialized');
  }
  
  /**
   * Generate a secure random key
   * @returns {string} Base64 encoded key
   */
  generateSecretKey() {
    return crypto.randomBytes(32).toString('base64');
  }
  
  /**
   * Generate time-limited TURN credentials
   * @returns {Object} Credential object with username and password
   */
  generateCredentials() {
    // Username format: timestamp:uniquake
    // This allows validating expiration on the server side
    const timestamp = Math.floor(Date.now() / 1000);
    const username = `${timestamp}:uniquake`;
    
    // Generate HMAC-based password
    const password = this.generateHMAC(username);
    
    return { 
      username, 
      password, 
      timestamp,
      expires: timestamp + (this.config.credentialTTL || 86400)
    };
  }
  
  /**
   * Generate HMAC for given data
   * @param {string} data - Data to sign
   * @returns {string} Base64 HMAC signature
   */
  generateHMAC(data) {
    const hmac = crypto.createHmac('sha1', this.hmacKey);
    hmac.update(data);
    return hmac.digest('base64');
  }
  
  /**
   * Get current valid credentials
   * @returns {Object} Current credentials
   */
  getCurrentCredentials() {
    return this.credentials;
  }
  
  /**
   * Rotate credentials and emit update event
   * @returns {Object} New credentials
   */
  rotateCredentials() {
    // Save current credentials as previous before generating new ones
    this.previousCredentials = this.credentials;
    
    // Generate new credentials
    this.credentials = this.generateCredentials();
    
    // Notify listeners
    this.emit('credentialsUpdated', this.credentials);
    
    console.log('TURN credentials rotated');
    return this.credentials;
  }
  
  /**
   * Verify if credentials are valid
   * @param {string} username - Username to verify
   * @param {string} password - Password to verify
   * @returns {boolean} True if credentials are valid
   */
  verifyCredentials(username, password) {
    // Check against current credentials
    if (username === this.credentials.username && 
        password === this.credentials.password) {
      return true;
    }
    
    // Check against previous credentials if they exist
    if (this.previousCredentials &&
        username === this.previousCredentials.username && 
        password === this.previousCredentials.password) {
      return true;
    }
    
    // Check if username follows our format and isn't expired
    const parts = username.split(':');
    if (parts.length === 2) {
      const timestamp = parseInt(parts[0], 10);
      const now = Math.floor(Date.now() / 1000);
      
      // If timestamp is valid and not expired
      if (!isNaN(timestamp) && 
          now - timestamp < (this.config.credentialTTL || 86400)) {
        // Verify password using HMAC
        const expectedPassword = this.generateHMAC(username);
        return password === expectedPassword;
      }
    }
    
    return false;
  }
  
  /**
   * Get ICE server configuration for WebRTC
   * @returns {Object} ICE server config including STUN and TURN
   */
  getICEServerConfig() {
    return {
      iceServers: [
        {
          urls: `stun:${this.config.publicIp}:${this.config.stunPort}`
        },
        {
          urls: `turn:${this.config.publicIp}:${this.config.turnPort}`,
          username: this.credentials.username,
          credential: this.credentials.password
        }
      ]
    };
  }
}

module.exports = CredentialManager;