# Master Server WebRTC Implementation Plan

## Overview
This document outlines the step-by-step implementation plan to build a WebRTC-based master server with integrated STUN/TURN functionality. The system will identify game servers exclusively by their peer IDs rather than IP addresses, with no backward compatibility required.

## Implementation Stages

### Stage 1: Add Required Dependencies
```
npm install wrtc node-stun-server node-turn simple-peer uuid crypto
```

### Stage 2: STUN/TURN Server Implementation
1. Create STUN server module
   - Initialize on ports 3478, 3479
   - Implement ICE candidates discovery

2. Create TURN server module
   - Set up time-limited authentication
   - Implement relay functionality on ports 49152-65535
   - Create credential management system

3. Configure for optimal WebRTC performance
   - Low latency optimizations
   - Bandwidth management
   - Connection prioritization

### Stage 3: WebRTC Signaling Core
1. Implement WebRTC signaling protocol:
   - `rtc_register`: Register as game server with peer ID
   - `rtc_request`: Request connection to specific peer
   - `rtc_offer`: SDP offer exchange
   - `rtc_answer`: SDP answer exchange
   - `rtc_ice`: ICE candidate exchange

2. Create peer connection management:
   - Generate unique peer IDs (UUID v4)
   - Track peer connection states
   - Handle connection timeouts

3. Implement signaling server:
   - WebSocket transport for signaling only
   - Route signaling messages between peers
   - Handle peer discovery

### Stage 4: Peer-Based Server Identity
1. Replace IP:Port with Peer ID
   - Use peer ID as primary server identifier
   - Store server metadata with peer ID as key
   - Implement peer ID validation

2. Create server registry:
   - Store active game servers by peer ID
   - Track server status and capabilities
   - Implement server pruning mechanism

3. Implement server discovery:
   - Send peer IDs in server list responses
   - Include WebRTC connection details
   - Optimize discovery protocol

### Stage 5: Connection Management
1. Create connection broker:
   - Match clients with game servers
   - Handle connection establishment
   - Monitor connection health

2. Implement NAT traversal:
   - Determine optimal connection strategies
   - Fallback mechanisms for difficult NATs
   - TURN relay activation when needed

3. Develop connection metrics:
   - Track successful/failed connections
   - Measure connection quality
   - Monitor TURN relay usage

### Stage 6: Security Implementation
1. Create secure credential system:
   - Time-limited TURN credentials
   - Secure token generation
   - Server authentication

2. Implement request validation:
   - Prevent connection hijacking
   - Rate limit signaling requests
   - Verify peer authenticity

## Detailed Code Implementation Plan

### 1. Create Main Server Structure
```javascript
// master-server.js
const http = require('http');
const WebSocketServer = require('ws').Server;
const StunServer = require('./stun-server');
const TurnServer = require('./turn-server');
const SignalingService = require('./signaling-service');
const ServerRegistry = require('./server-registry');
const CredentialManager = require('./credential-manager');

class MasterServer {
  constructor(config) {
    this.config = this.loadConfig(config);
    this.serverRegistry = new ServerRegistry();
    this.credentialManager = new CredentialManager(this.config);
    
    // Create HTTP server
    this.httpServer = http.createServer();
    
    // Initialize WebSocket server for signaling
    this.signalingServer = new WebSocketServer({ server: this.httpServer });
    
    // Initialize STUN server
    this.stunServer = new StunServer(this.config);
    
    // Initialize TURN server
    this.turnServer = new TurnServer(this.config, this.credentialManager);
    
    // Create signaling service
    this.signalingService = new SignalingService(
      this.signalingServer, 
      this.serverRegistry, 
      this.credentialManager
    );
  }
  
  start() {
    // Start STUN server
    this.stunServer.start();
    
    // Start TURN server
    this.turnServer.start();
    
    // Start signaling service
    this.signalingService.start();
    
    // Start HTTP server
    this.httpServer.listen(this.config.port, '0.0.0.0', () => {
      console.log(`Master server listening on port ${this.config.port}`);
    });
    
    // Start maintenance tasks
    this.startMaintenanceTasks();
  }
  
  startMaintenanceTasks() {
    // Prune inactive servers
    setInterval(() => {
      this.serverRegistry.pruneInactiveServers();
    }, this.config.pruneInterval);
    
    // Rotate TURN credentials
    setInterval(() => {
      this.credentialManager.rotateCredentials();
    }, this.config.credentialRotationInterval);
  }
  
  loadConfig(configPath) {
    // Default configuration
    const defaultConfig = {
      port: 27950,
      stunPort: 3478,
      stunPortSecondary: 3479,
      turnPort: 3478,
      turnPortRange: [49152, 65535],
      turnRealm: 'uniquake.com',
      publicIp: process.env.PUBLIC_IP || '0.0.0.0',
      pruneInterval: 350000, // 350 seconds
      credentialRotationInterval: 86400000, // 24 hours
      logLevel: 'info'
    };
    
    // Load from file if provided
    let fileConfig = {};
    if (configPath) {
      try {
        fileConfig = require(configPath);
      } catch (e) {
        console.warn('Failed to load config file:', e.message);
      }
    }
    
    return { ...defaultConfig, ...fileConfig };
  }
}

module.exports = MasterServer;
```

### 2. Server Registry Implementation
```javascript
// server-registry.js
const { v4: uuidv4 } = require('uuid');

class ServerRegistry {
  constructor() {
    this.servers = {}; // Indexed by peer ID
    this.lastPrune = Date.now();
  }
  
  registerServer(peerId, metadata) {
    // Generate peer ID if not provided
    const id = peerId || uuidv4();
    
    this.servers[id] = {
      peerId: id,
      metadata: metadata || {},
      lastUpdate: Date.now()
    };
    
    return id;
  }
  
  updateServer(peerId, metadata) {
    if (!this.servers[peerId]) {
      return this.registerServer(peerId, metadata);
    }
    
    this.servers[peerId].lastUpdate = Date.now();
    
    if (metadata) {
      this.servers[peerId].metadata = {
        ...this.servers[peerId].metadata,
        ...metadata
      };
    }
    
    return peerId;
  }
  
  removeServer(peerId) {
    if (this.servers[peerId]) {
      delete this.servers[peerId];
      return true;
    }
    return false;
  }
  
  getServer(peerId) {
    return this.servers[peerId];
  }
  
  getAllServers() {
    return Object.values(this.servers);
  }
  
  pruneInactiveServers(maxAge = 350000) { // 350 seconds
    const now = Date.now();
    
    Object.keys(this.servers).forEach(peerId => {
      const server = this.servers[peerId];
      if (now - server.lastUpdate > maxAge) {
        this.removeServer(peerId);
        console.log(`Server ${peerId} pruned due to inactivity`);
      }
    });
    
    this.lastPrune = now;
  }
}

module.exports = ServerRegistry;
```

### 3. STUN Server Implementation
```javascript
// stun-server.js
const stun = require('node-stun-server');

class StunServer {
  constructor(config) {
    this.config = config;
    this.server = null;
  }
  
  start() {
    this.server = stun.createServer({
      primary: {
        host: this.config.stunHost || '0.0.0.0',
        port: this.config.stunPort || 3478
      },
      secondary: {
        host: this.config.stunHostSecondary || '0.0.0.0',
        port: this.config.stunPortSecondary || 3479
      }
    });
    
    this.server.listen(() => {
      console.log(`STUN server listening on ports ${this.config.stunPort} and ${this.config.stunPortSecondary}`);
    });
  }
  
  stop() {
    if (this.server) {
      this.server.close();
      this.server = null;
    }
  }
  
  getConfig() {
    return {
      urls: [
        `stun:${this.config.publicIp}:${this.config.stunPort}`,
        `stun:${this.config.publicIp}:${this.config.stunPortSecondary}`
      ]
    };
  }
}

module.exports = StunServer;
```

### 4. TURN Server Implementation
```javascript
// turn-server.js
const turn = require('node-turn');

class TurnServer {
  constructor(config, credentialManager) {
    this.config = config;
    this.credentialManager = credentialManager;
    this.server = null;
  }
  
  start() {
    const credentials = this.credentialManager.getCurrentCredentials();
    
    this.server = new turn({
      authMech: 'long-term',
      credentials: {
        [credentials.username]: credentials.password
      },
      realm: this.config.turnRealm,
      listeningPort: this.config.turnPort,
      relayIps: [this.config.publicIp],
      relayPortRange: this.config.turnPortRange,
      logging: this.config.turnLogging || 'warning'
    });
    
    console.log(`TURN server initialized on port ${this.config.turnPort}`);
    
    // Update credentials when they change
    this.credentialManager.on('credentialsUpdated', (credentials) => {
      this.updateCredentials(credentials);
    });
  }
  
  updateCredentials(credentials) {
    if (this.server) {
      this.server.addUser(credentials.username, credentials.password);
      // Clean up old credentials if needed
    }
  }
  
  stop() {
    if (this.server) {
      this.server.stop();
      this.server = null;
    }
  }
  
  getConfig() {
    const credentials = this.credentialManager.getCurrentCredentials();
    
    return {
      urls: `turn:${this.config.publicIp}:${this.config.turnPort}`,
      username: credentials.username,
      credential: credentials.password
    };
  }
}

module.exports = TurnServer;
```

### 5. Credential Manager
```javascript
// credential-manager.js
const crypto = require('crypto');
const EventEmitter = require('events');

class CredentialManager extends EventEmitter {
  constructor(config) {
    super();
    this.config = config;
    this.hmacKey = crypto.randomBytes(32).toString('base64');
    this.credentials = this.generateCredentials();
  }
  
  generateCredentials() {
    const timestamp = Math.floor(Date.now() / 1000);
    const username = `${timestamp}:uniquake`;
    const password = this.generateHMAC(username);
    
    return { username, password, timestamp };
  }
  
  generateHMAC(data) {
    const hmac = crypto.createHmac('sha1', this.hmacKey);
    hmac.update(data);
    return hmac.digest('base64');
  }
  
  getCurrentCredentials() {
    return this.credentials;
  }
  
  rotateCredentials() {
    this.credentials = this.generateCredentials();
    this.emit('credentialsUpdated', this.credentials);
    console.log('TURN credentials rotated');
    return this.credentials;
  }
  
  getICEServerConfig() {
    return {
      iceServers: [
        { urls: `stun:${this.config.publicIp}:${this.config.stunPort}` },
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
```

### 6. WebRTC Signaling Service
```javascript
// signaling-service.js
const { formatOOB } = require('./protocol-utils');

class SignalingService {
  constructor(wsServer, serverRegistry, credentialManager) {
    this.wsServer = wsServer;
    this.serverRegistry = serverRegistry;
    this.credentialManager = credentialManager;
    this.clients = new Map(); // Map WebSocket connections to client info
    this.pendingConnections = new Map(); // Track pending WebRTC connections
  }
  
  start() {
    this.wsServer.on('connection', (ws) => {
      const clientId = this.addClient(ws);
      
      ws.on('message', (data) => {
        this.handleMessage(clientId, data);
      });
      
      ws.on('close', () => {
        this.removeClient(clientId);
      });
      
      ws.on('error', (err) => {
        console.error(`Client ${clientId} error:`, err);
        this.removeClient(clientId);
      });
    });
    
    console.log('WebRTC signaling service started');
  }
  
  addClient(ws) {
    const clientId = uuidv4();
    
    this.clients.set(clientId, {
      id: clientId,
      ws: ws,
      peerId: null,
      isServer: false
    });
    
    return clientId;
  }
  
  removeClient(clientId) {
    const client = this.clients.get(clientId);
    if (!client) return;
    
    // If this was a registered server, remove it
    if (client.isServer && client.peerId) {
      this.serverRegistry.removeServer(client.peerId);
    }
    
    this.clients.delete(clientId);
  }
  
  handleMessage(clientId, data) {
    const client = this.clients.get(clientId);
    if (!client) return;
    
    try {
      const message = JSON.parse(data);
      
      switch (message.type) {
        case 'rtc_register':
          this.handleRegister(client, message);
          break;
          
        case 'rtc_offer':
          this.handleOffer(client, message);
          break;
          
        case 'rtc_answer':
          this.handleAnswer(client, message);
          break;
          
        case 'rtc_ice':
          this.handleIceCandidate(client, message);
          break;
          
        case 'rtc_request':
          this.handleConnectionRequest(client, message);
          break;
          
        case 'get_servers':
          this.handleGetServers(client);
          break;
          
        case 'heartbeat':
          this.handleHeartbeat(client);
          break;
          
        default:
          console.warn(`Unknown message type: ${message.type}`);
      }
    } catch (err) {
      console.error('Error processing message:', err);
    }
  }
  
  handleRegister(client, message) {
    // Register as a game server
    const peerId = message.peerId || uuidv4();
    
    client.peerId = peerId;
    client.isServer = true;
    client.serverInfo = message.serverInfo || {};
    
    // Register with the server registry
    this.serverRegistry.registerServer(peerId, client.serverInfo);
    
    // Send confirmation
    this.sendToClient(client, {
      type: 'rtc_registered',
      peerId: peerId
    });
    
    console.log(`Server registered with peer ID: ${peerId}`);
  }
  
  handleOffer(client, message) {
    // Forward SDP offer to target peer
    const targetClient = this.findClientByPeerId(message.targetId);
    if (!targetClient) {
      return this.sendToClient(client, {
        type: 'rtc_error',
        error: 'Target peer not found'
      });
    }
    
    this.sendToClient(targetClient, {
      type: 'rtc_offer',
      offer: message.offer,
      sourceId: client.peerId
    });
  }
  
  handleAnswer(client, message) {
    // Forward SDP answer to target peer
    const targetClient = this.findClientByPeerId(message.targetId);
    if (!targetClient) {
      return this.sendToClient(client, {
        type: 'rtc_error',
        error: 'Target peer not found'
      });
    }
    
    this.sendToClient(targetClient, {
      type: 'rtc_answer',
      answer: message.answer,
      sourceId: client.peerId
    });
  }
  
  handleIceCandidate(client, message) {
    // Forward ICE candidate to target peer
    const targetClient = this.findClientByPeerId(message.targetId);
    if (!targetClient) {
      return;
    }
    
    this.sendToClient(targetClient, {
      type: 'rtc_ice',
      candidate: message.candidate,
      sourceId: client.peerId
    });
  }
  
  handleConnectionRequest(client, message) {
    // Client wants to connect to a game server
    const targetId = message.targetId;
    const server = this.serverRegistry.getServer(targetId);
    
    if (!server) {
      return this.sendToClient(client, {
        type: 'rtc_error',
        error: 'Server not found'
      });
    }
    
    // Find the server's client connection
    const serverClient = this.findClientByPeerId(targetId);
    if (!serverClient) {
      return this.sendToClient(client, {
        type: 'rtc_error',
        error: 'Server not connected to signaling'
      });
    }
    
    // Generate temporary connection ID
    const connectionId = uuidv4();
    
    // Store pending connection
    this.pendingConnections.set(connectionId, {
      clientId: client.id,
      serverId: serverClient.id,
      created: Date.now()
    });
    
    // Notify server about connection request
    this.sendToClient(serverClient, {
      type: 'rtc_connection_request',
      sourceId: client.peerId || 'anonymous',
      connectionId: connectionId
    });
    
    // Send ICE configuration to client
    this.sendToClient(client, {
      type: 'rtc_config',
      iceConfig: this.credentialManager.getICEServerConfig()
    });
  }
  
  handleGetServers(client) {
    // Send list of available servers
    const servers = this.serverRegistry.getAllServers();
    
    this.sendToClient(client, {
      type: 'servers_list',
      servers: servers.map(server => ({
        peerId: server.peerId,
        metadata: server.metadata
      }))
    });
  }
  
  handleHeartbeat(client) {
    if (client.isServer && client.peerId) {
      // Update server last active time
      this.serverRegistry.updateServer(client.peerId);
      
      // Send acknowledgement
      this.sendToClient(client, {
        type: 'heartbeat_ack'
      });
    }
  }
  
  findClientByPeerId(peerId) {
    for (const [id, client] of this.clients.entries()) {
      if (client.peerId === peerId) {
        return client;
      }
    }
    return null;
  }
  
  sendToClient(client, message) {
    if (client && client.ws && client.ws.readyState === 1) { // 1 = OPEN
      client.ws.send(JSON.stringify(message));
      return true;
    }
    return false;
  }
  
  // Maintenance tasks
  cleanupStaleConnections() {
    const now = Date.now();
    const timeout = 30000; // 30 seconds
    
    for (const [id, connection] of this.pendingConnections.entries()) {
      if (now - connection.created > timeout) {
        this.pendingConnections.delete(id);
      }
    }
  }
}

module.exports = SignalingService;
```

### 7. Protocol Utilities
```javascript
// protocol-utils.js
function formatOOB(data) {
  const str = '\xff\xff\xff\xff' + data + '\x00';
  
  const buffer = new ArrayBuffer(str.length);
  const view = new Uint8Array(buffer);
  
  for (let i = 0; i < str.length; i++) {
    view[i] = str.charCodeAt(i);
  }
  
  return buffer;
}

function stripOOB(buffer) {
  const view = new DataView(buffer);
  
  if (view.getInt32(0) !== -1) {
    return null;
  }
  
  let str = '';
  for (let i = 4; i < buffer.byteLength - 1; i++) {
    str += String.fromCharCode(view.getUint8(i));
  }
  
  return str;
}

function parseJSON(data) {
  try {
    return JSON.parse(data);
  } catch (e) {
    return null;
  }
}

module.exports = {
  formatOOB,
  stripOOB,
  parseJSON
};
```

## Startup Script
```javascript
// master.js
const MasterServer = require('./master-server');
const optimist = require('optimist');

const argv = optimist
  .describe('config', 'Configuration file path')
  .default('config', './config.json')
  .argv;

if (argv.h || argv.help) {
  optimist.showHelp();
  process.exit(0);
}

const server = new MasterServer(argv.config);
server.start();

// Handle graceful shutdown
process.on('SIGINT', () => {
  console.log('Shutting down master server...');
  server.stop();
  process.exit(0);
});
```

## Implementation Order
1. Create utility files first (protocol-utils.js)
2. Implement credential-manager.js 
3. Build server-registry.js for the new peer ID system
4. Create STUN and TURN server implementations
5. Develop the signaling service
6. Build the main master-server.js file
7. Update the master.js entry point

## Testing
- Test WebRTC signaling with browser clients
- Verify STUN server connectivity
- Test TURN relay functionality
- Measure NAT traversal success rates
- Benchmark connection establishment times