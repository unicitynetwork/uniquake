# Enhanced Master Server with STUN/TURN for WebRTC

## Overview
This document outlines how to extend the UniQuake master server to include STUN and TURN functionality for WebRTC NAT traversal, creating a complete solution without needing additional servers.

## Current Master Server Functionality
- Server registration and discovery
- Client subscription management
- WebSocket-based communication
- Server heartbeat processing

## Extended Functionality
- WebRTC signaling
- STUN (Session Traversal Utilities for NAT) services
- TURN (Traversal Using Relays around NAT) relay capabilities
- Complete NAT traversal solution

## Implementation Plan

### 1. Add STUN Server Functionality
```javascript
// Required NPM packages
const stun = require('node-stun-server');

// Initialize STUN server on master server
function initializeSTUNServer(config) {
  const stunServer = stun.createServer({
    primary: {
      host: config.stunHost || '0.0.0.0',
      port: config.stunPort || 3478
    },
    secondary: {
      host: config.stunHostSecondary || '0.0.0.0',
      port: config.stunPortSecondary || 3479
    }
  });
  
  stunServer.listen(() => {
    logger.info('STUN server listening on ports ' + 
                config.stunPort + ' and ' + config.stunPortSecondary);
  });
  
  return stunServer;
}
```

### 2. Add TURN Server Functionality
```javascript
// Required NPM packages
const turn = require('node-turn');

// Initialize TURN server for relay capabilities
function initializeTURNServer(config) {
  const turnServer = new turn({
    authMech: 'long-term',
    credentials: {
      // Generate dynamic credentials for security
      username: config.turnUsername || 'uniquake',
      password: config.turnPassword || generateSecurePassword()
    },
    realm: config.turnRealm || 'uniquake.com',
    listeningPort: config.turnPort || 3478,
    relayIps: [config.publicIp || '0.0.0.0'], // Server's public IP
    relayPortRange: [49152, 65535],
    logging: config.turnLogging || 'warning'
  });
  
  logger.info('TURN server initialized on port ' + config.turnPort);
  return turnServer;
}
```

### 3. WebRTC Signaling Service
```javascript
// Add signaling capabilities to the master server
function setupWebRTCSignaling(wss) {
  // Store peer connection information
  const peerConnections = {};
  
  // Handle signaling messages in the existing WebSocket server
  wss.on('connection', function(ws) {
    // ... existing connection code
    
    ws.on('message', function(buffer, flags) {
      // ... existing message handling
      
      // Handle WebRTC signaling messages
      if (msg.indexOf('rtc_offer') === 0) {
        handleRTCOffer(conn, msg.substr(10));
      } else if (msg.indexOf('rtc_answer') === 0) {
        handleRTCAnswer(conn, msg.substr(11));
      } else if (msg.indexOf('rtc_ice') === 0) {
        handleRTCIceCandidate(conn, msg.substr(8));
      } else if (msg.indexOf('rtc_connect') === 0) {
        handleRTCConnectRequest(conn, msg.substr(12));
      }
    });
  });
}
```

### 4. WebRTC Configuration Delivery
```javascript
// Provide WebRTC configuration to clients
function sendWebRTCConfig(conn) {
  // Send STUN/TURN server information to the client
  const rtcConfig = {
    iceServers: [
      {
        urls: `stun:${config.publicHostname}:${config.stunPort}`
      },
      {
        urls: `turn:${config.publicHostname}:${config.turnPort}`,
        username: config.turnUsername,
        credential: config.turnPassword
      }
    ]
  };
  
  logger.info(conn.addr + ':' + conn.port + ' <--- rtc_config');
  
  const buffer = formatOOB('rtc_config ' + JSON.stringify(rtcConfig));
  conn.socket.send(buffer, { binary: true });
}
```

### 5. Enhanced Server Registration
```javascript
// Update server registration to include WebRTC peer ID
function updateServer(addr, port, peerId) {
  var id = serverid(addr, port);
  var server = servers[id];
  if (!server) {
    server = servers[id] = { addr: addr, port: port };
  }
  
  // Add WebRTC peer ID if provided
  if (peerId) {
    server.peerId = peerId;
  }
  
  server.lastUpdate = Date.now();

  // Send partial update to all clients
  for (var i = 0; i < clients.length; i++) {
    sendGetServersResponse(clients[i], { id: server });
  }
}
```

### 6. Credential Management
```javascript
// Create secure, time-limited TURN credentials
function generateCredentials() {
  const username = Date.now() + ':uniquake';
  const credential = generateHMAC(username);
  
  return {
    username: username,
    credential: credential
  };
}
```

## Integration with Master Server

### Updated Server Structure
```javascript
// Main function with integrated services
function main() {
  // Create HTTP server
  var server = http.createServer();
  
  // Load configuration
  const config = loadConfig(argv.config);
  
  // Initialize STUN server
  const stunServer = initializeSTUNServer(config);
  
  // Initialize TURN server
  const turnServer = initializeTURNServer(config);
  
  // Initialize WebSocket server (existing code)
  var wss = new WebSocketServer({ server: server });
  
  // Add WebRTC signaling capabilities
  setupWebRTCSignaling(wss);
  
  // Listen for connections (existing code)
  server.listen(config.port, '0.0.0.0', function() {
    logger.info('master server with WebRTC support is listening on port ' + 
                server.address().port);
  });
  
  // Regularly prune servers and update TURN credentials
  setInterval(function() {
    pruneServers();
    updateTURNCredentials();
  }, pruneInterval);
  
  return {
    httpServer: server,
    wsServer: wss,
    stunServer: stunServer,
    turnServer: turnServer
  };
}
```

## Browser-Only Implementation
If we want to avoid modifying Node.js code, we can implement a pure browser solution:

### 1. Client-Side WebRTC Adapter

```javascript
// WebRTC adapter that mimics WebSocket API
class WebRTCSocket {
  constructor(url, rtcConfig) {
    this.url = url;
    this.rtcConfig = rtcConfig;
    this.dataChannel = null;
    this.peerConnection = null;
    this.readyState = 0; // CONNECTING
    this.bufferedAmount = 0;
    
    // Event handlers
    this.onopen = null;
    this.onmessage = null;
    this.onclose = null;
    this.onerror = null;
    
    // Extract peer ID from URL
    this.peerId = this.extractPeerId(url);
    
    // Connect to signaling server
    this.connectToSignalingServer();
  }
  
  // Send data through data channel
  send(data) {
    if (this.dataChannel && this.dataChannel.readyState === 'open') {
      this.dataChannel.send(data);
      return true;
    }
    return false;
  }
  
  // Close connection
  close() {
    if (this.dataChannel) {
      this.dataChannel.close();
    }
    if (this.peerConnection) {
      this.peerConnection.close();
    }
    this.readyState = 3; // CLOSED
  }
  
  // Internal methods
  extractPeerId(url) {
    // Extract peer ID from WebSocket URL format
    // ws://server:port -> parse to get peer ID
    const matches = url.match(/ws:\/\/([^:]+):(\d+)/);
    return matches ? `${matches[1]}-${matches[2]}` : null;
  }
  
  connectToSignalingServer() {
    // Connect to master server for signaling
    // This uses real WebSockets
    // ...implementation details...
  }
}
```

### 2. WebSocket Override

```javascript
// Save original WebSocket
window.OriginalWebSocket = window.WebSocket;

// Override WebSocket constructor
window.WebSocket = function(url, protocols) {
  // For master server connections, use regular WebSocket
  if (url.includes('master') || !window.webrtcEnabled) {
    return new window.OriginalWebSocket(url, protocols);
  }
  
  // For game server connections, use WebRTC
  return new WebRTCSocket(url, window.webrtcConfig);
};
```

### 3. Client-Side Signaling

```javascript
// Initiate connection to master server for signaling
function initWebRTC() {
  // Connect to master server
  const signaling = new window.OriginalWebSocket('ws://masterserver:27950');
  
  signaling.onopen = function() {
    // Request WebRTC configuration
    signaling.send(formatOOB('rtc_config_request'));
    
    // Register our peer ID
    const myPeerId = generatePeerId();
    signaling.send(formatOOB('rtc_register ' + myPeerId));
  };
  
  signaling.onmessage = function(event) {
    // Handle signaling messages
    // ...implementation details...
  };
  
  // Store signaling connection
  window.signalingConnection = signaling;
}
```

## Injecting the WebRTC Solution
To deploy this without modifying server code, we can:

1. Create a browser extension that injects our WebRTC code
2. Modify the HTML template that loads ioquake3.js to include our script
3. Create a proxy that injects our code when serving the game files

## STUN/TURN Client Integration
To use public STUN/TURN servers instead of running our own:

```javascript
// WebRTC configuration with public STUN servers
window.webrtcConfig = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    // Add more public STUN servers as needed
    
    // For difficult NAT scenarios, add a free TURN service
    // or instructions for users to provide their own TURN credentials
  ]
};
```

## Limitations of Browser-Only Approach
- Relies on public STUN servers or user-provided TURN
- More difficult to debug connection issues
- May not work with all NAT configurations
- Requires client-side code injection
- May need periodic updates for browser compatibility