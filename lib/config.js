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
    
    // SSL/TLS Configuration
    // SSL can be explicitly disabled by setting SSL_ENABLED=false
    this.sslExplicitlyDisabled = process.env.SSL_ENABLED === 'false';
    this.sslCertPath = process.env.SSL_CERT_PATH || '/etc/letsencrypt/live/' + this.hostIp + '/fullchain.pem';
    this.sslKeyPath = process.env.SSL_KEY_PATH || '/etc/letsencrypt/live/' + this.hostIp + '/privkey.pem';
    this.httpsPort = parseInt(process.env.HTTPS_PORT) || 443;
    this.httpPort = parseInt(process.env.HTTP_PORT) || 80;
    
    // SSL availability will be checked at runtime
    this._sslAvailable = null;
  }

  // Check SSL availability at runtime
  get sslAvailable() {
    if (this._sslAvailable === null) {
      // Check if SSL is explicitly disabled
      if (this.sslExplicitlyDisabled) {
        this._sslAvailable = false;
      } else {
        try {
          this._sslAvailable = fs.existsSync(this.sslCertPath) && fs.existsSync(this.sslKeyPath);
          if (this._sslAvailable) {
            console.log('SSL certificates found at:', this.sslCertPath, 'and', this.sslKeyPath);
          } else {
            console.log('SSL certificates not found or not accessible');
          }
        } catch (e) {
          console.log('Error checking SSL certificates:', e.message);
          this._sslAvailable = false;
        }
      }
    }
    return this._sslAvailable;
  }

  // Computed properties - URLs (with protocol)
  get masterServerWs() {
    return process.env.MASTER_SERVER_WS || `ws://${this.hostIp}:${this.masterPort}`;
  }
  
  get masterServerWss() {
    if (this.sslAvailable) {
      return `wss://${this.hostIp}:${this.masterPort + 1}`;
    }
    return null;
  }

  get webServerUrl() {
    if (this.sslAvailable) {
      const portStr = this.httpsPort === 443 ? '' : `:${this.httpsPort}`;
      return `https://${this.hostIp}${portStr}`;
    }
    const portStr = this.httpPort === 80 ? '' : `:${this.httpPort}`;
    return `http://${this.hostIp}${portStr}`;
  }

  get mockServerUrl() {
    // Mock server uses the same ports as web server (auto-configured based on SSL)
    return this.webServerUrl;
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
    if (this.sslAvailable) {
      console.log(`Secure Master: ${this.hostIp}:${this.masterPort + 1} (WSS: ${this.masterServerWss})`);
    }
    console.log(`Content Server: ${this.contentServerAddress}`);
    
    // Explain auto-configured ports
    if (this.sslAvailable) {
      console.log(`Web/Mock Server: ${this.webServerUrl} (auto-configured for HTTPS)`);
      console.log(`  → Using port ${this.httpsPort} with SSL certificates`);
      console.log(`  → HTTP port ${this.httpPort} redirects to HTTPS`);
    } else {
      console.log(`Web/Mock Server: ${this.webServerUrl} (auto-configured for HTTP)`);
      console.log(`  → Using standard HTTP port ${this.httpPort}`);
      console.log(`  → To enable HTTPS, install SSL certificates`);
    }
    
    console.log(`Game Server IP: ${this.gameServerIp}`);
    console.log(`Log Level: ${this.logLevel}`);
    console.log('===============================');
  }
}

module.exports = new Config();