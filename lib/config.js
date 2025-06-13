/**
 * UniQuake Configuration Manager
 * Loads configuration from environment variables with sensible defaults
 */

const path = require('path');
const fs = require('fs');

// Load .env file if it exists
const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
  const envContent = fs.readFileSync(envPath, 'utf8');
  envContent.split('\n').forEach(line => {
    const [key, value] = line.split('=');
    if (key && value && !process.env[key]) {
      // Handle variable substitution like ${HOST_IP}
      let resolvedValue = value;
      const variablePattern = /\$\{([^}]+)\}/g;
      resolvedValue = resolvedValue.replace(variablePattern, (match, varName) => {
        return process.env[varName] || match;
      });
      process.env[key] = resolvedValue;
    }
  });
}

class Config {
  constructor() {
    this.hostIp = process.env.HOST_IP || 'localhost';
    
    // Port configurations
    this.masterPort = parseInt(process.env.MASTER_PORT) || 27950;
    this.contentPort = parseInt(process.env.CONTENT_PORT) || 9000;
    this.webPort = parseInt(process.env.WEB_PORT) || 8080;
    this.mockPort = parseInt(process.env.MOCK_PORT) || 8080;
    
    // Game server configuration
    this.gameServerIp = process.env.GAME_SERVER_IP || this.hostIp;
    this.gameServerBasePort = parseInt(process.env.GAME_SERVER_BASE_PORT) || 27961;
    
    // STUN/TURN configuration
    this.stunPort = parseInt(process.env.STUN_PORT) || 3478;
    this.stunPortSecondary = parseInt(process.env.STUN_PORT_SECONDARY) || 3479;
    this.turnPort = parseInt(process.env.TURN_PORT) || 3478;
    this.turnRealm = process.env.TURN_REALM || 'uniquake.com';
    
    // Logging
    this.logLevel = process.env.LOG_LEVEL || 'info';
  }

  // Computed properties - URLs (with protocol)
  get masterServerWs() {
    return process.env.MASTER_SERVER_WS || `ws://${this.hostIp}:${this.masterPort}`;
  }

  get webServerUrl() {
    return `http://${this.hostIp}:${this.webPort}`;
  }

  get mockServerUrl() {
    return `http://${this.hostIp}:${this.mockPort}`;
  }

  // Computed properties - Host:Port combinations (no protocol)
  get masterServerAddress() {
    return `${this.hostIp}:${this.masterPort}`;
  }

  get contentServerAddress() {
    return `${this.hostIp}:${this.contentPort}`;
  }

  // Generate master config object
  getMasterConfig() {
    return {
      port: this.masterPort,
      host: "0.0.0.0",
      stunPort: this.stunPort,
      stunPortSecondary: this.stunPortSecondary,
      turnPort: this.turnPort,
      turnPortRange: [49152, 65535],
      turnRealm: this.turnRealm,
      publicIp: this.hostIp,
      publicHostname: this.hostIp,
      logLevel: this.logLevel,
      logStunRequests: false,
      turnLogLevel: "WARNING",
      pruneInterval: 7200000,
      credentialTTL: 86400,
      credentialRotationInterval: 86400000
    };
  }

  // Generate web config object
  getWebConfig() {
    return {
      content: this.contentServerAddress,      // QuakeJS expects host:port (no protocol)
      masterServer: this.masterServerAddress, // QuakeJS expects host:port (no protocol)
      useWebRTC: false
    };
  }

  // Generate content config object
  getContentConfig() {
    return {
      root: "./fresh_quakejs/base",
      port: this.contentPort
    };
  }

  // Print current configuration
  printConfig() {
    console.log('=== UniQuake Configuration ===');
    console.log(`Host IP: ${this.hostIp}`);
    console.log(`Master Server: ${this.masterServerAddress} (WS: ${this.masterServerWs})`);
    console.log(`Content Server: ${this.contentServerAddress}`);
    console.log(`Web Server: ${this.webServerUrl}`);
    console.log(`Mock Server: ${this.mockServerUrl}`);
    console.log(`Game Server IP: ${this.gameServerIp}`);
    console.log(`Log Level: ${this.logLevel}`);
    console.log('===============================');
  }
}

module.exports = new Config();