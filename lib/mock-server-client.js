#!/usr/bin/env node

/**
 * Mock Game Server Client for testing WebRTC P2P connections
 * 
 * This script simulates a game server connecting to the master server,
 * registering itself, and accepting WebRTC connections from clients.
 */

const WebSocket = require('ws');
const readline = require('readline');

// Mock WebRTC - We'll simulate WebRTC behavior for testing
const MockRTC = {
  RTCPeerConnection: class MockRTCPeerConnection {
    constructor(config) {
      this.config = config;
      this.localDescription = null;
      this.remoteDescription = null;
      this.iceConnectionState = 'new';
      this.dataChannels = [];
      
      // Event handlers
      this.onicecandidate = null;
      this.oniceconnectionstatechange = null;
      this.ondatachannel = null;
      
      // Simulate ICE candidates after a delay
      setTimeout(() => this._generateIceCandidates(), 500);
    }
    
    // Create a data channel
    createDataChannel(label, options) {
      const channel = new MockRTC.RTCDataChannel(label, options);
      this.dataChannels.push(channel);
      return channel;
    }
    
    // Set local description
    async setLocalDescription(description) {
      this.localDescription = description;
      return Promise.resolve();
    }
    
    // Set remote description
    async setRemoteDescription(description) {
      this.remoteDescription = description;
      
      // When we have both local and remote descriptions, simulate connection
      if (this.localDescription && this.remoteDescription) {
        setTimeout(() => {
          this._simulateConnection();
        }, 1000);
        
        // Also simulate a data channel if we're answering
        if (description.type === 'offer' && this.ondatachannel) {
          const channel = new MockRTC.RTCDataChannel('game', {});
          setTimeout(() => {
            this.ondatachannel({ channel });
          }, 200);
        }
      }
      
      return Promise.resolve();
    }
    
    // Create an offer
    async createOffer() {
      return Promise.resolve({ type: 'offer', sdp: 'mock-sdp-offer-' + Date.now() });
    }
    
    // Create an answer
    async createAnswer() {
      return Promise.resolve({ type: 'answer', sdp: 'mock-sdp-answer-' + Date.now() });
    }
    
    // Add ICE candidate
    async addIceCandidate(candidate) {
      return Promise.resolve();
    }
    
    // Close the connection
    close() {
      this._updateIceConnectionState('closed');
      this.dataChannels.forEach(channel => channel._close());
    }
    
    // Generate mock ICE candidates
    _generateIceCandidates() {
      if (this.onicecandidate) {
        // Generate a few candidates
        for (let i = 0; i < 3; i++) {
          setTimeout(() => {
            this.onicecandidate({
              candidate: {
                candidate: `mock-ice-candidate-${i}`,
                sdpMid: 'data',
                sdpMLineIndex: 0
              }
            });
          }, i * 200);
        }
        
        // Signal end of candidates
        setTimeout(() => {
          this.onicecandidate({ candidate: null });
        }, 800);
      }
    }
    
    // Simulate connection state changes
    _simulateConnection() {
      this._updateIceConnectionState('checking');
      
      setTimeout(() => {
        this._updateIceConnectionState('connected');
        
        // Open all data channels
        this.dataChannels.forEach(channel => channel._open());
      }, 1500);
    }
    
    // Update ICE connection state
    _updateIceConnectionState(state) {
      this.iceConnectionState = state;
      if (this.oniceconnectionstatechange) {
        this.oniceconnectionstatechange();
      }
    }
  },
  
  RTCSessionDescription: class MockRTCSessionDescription {
    constructor(init) {
      this.type = init.type;
      this.sdp = init.sdp;
    }
  },
  
  RTCIceCandidate: class MockRTCIceCandidate {
    constructor(init) {
      this.candidate = init.candidate;
      this.sdpMid = init.sdpMid;
      this.sdpMLineIndex = init.sdpMLineIndex;
    }
  },
  
  RTCDataChannel: class MockRTCDataChannel {
    constructor(label, options) {
      this.label = label;
      this.options = options;
      this.readyState = 'connecting';
      
      // Event handlers
      this.onopen = null;
      this.onmessage = null;
      this.onclose = null;
      this.onerror = null;
    }
    
    // Send a message
    send(data) {
      console.log(`[Mock] DataChannel sent: ${data.substr ? data.substr(0, 30) + '...' : data}`);
      return true;
    }
    
    // Close the channel
    close() {
      this._close();
    }
    
    // Internal open method
    _open() {
      this.readyState = 'open';
      if (this.onopen) {
        this.onopen();
      }
    }
    
    // Internal close method
    _close() {
      this.readyState = 'closed';
      if (this.onclose) {
        this.onclose();
      }
    }
    
    // Simulate receiving a message
    _receiveMessage(data) {
      if (this.onmessage) {
        this.onmessage({ data });
      }
    }
  }
};

// Use the mock WebRTC classes
const { RTCPeerConnection, RTCSessionDescription, RTCIceCandidate } = MockRTC;

// Command line arguments
const argv = require('optimist')
  .usage('Usage: $0 [options]')
  .describe('master', 'Master server address')
  .default('master', 'localhost:27950')
  .describe('name', 'Server name')
  .default('name', 'MockServer')
  .describe('map', 'Map name')
  .default('map', 'q3dm17')
  .describe('game', 'Game type')
  .default('game', 'baseq3')
  .argv;

// Create readline interface for command input
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  prompt: 'server> '
});

// Server state
const serverState = {
  peerId: null,
  connections: new Map(), // Map of connectionId -> connection state
  clients: new Map(),     // Map of clientId -> client state
  signaling: null,        // WebSocket connection to master server
  heartbeatInterval: null
};

// Server info
const serverInfo = {
  name: argv.name,
  map: argv.map,
  game: argv.game,
  players: 0,
  maxPlayers: 16
};

/**
 * Connect to the master server for signaling
 */
function connectToMasterServer() {
  const masterUrl = `ws://${argv.master}`;
  console.log(`Connecting to master server at ${masterUrl}...`);
  
  serverState.signaling = new WebSocket(masterUrl);
  
  // Set up event handlers
  serverState.signaling.on('open', () => {
    console.log('Connected to master server');
    registerServer();
  });
  
  serverState.signaling.on('message', (data) => {
    try {
      const message = JSON.parse(data);
      handleSignalingMessage(message);
    } catch (err) {
      console.error('Failed to parse message:', err.message);
    }
  });
  
  serverState.signaling.on('close', () => {
    console.log('Disconnected from master server');
    clearInterval(serverState.heartbeatInterval);
    // Try to reconnect after a delay
    setTimeout(() => connectToMasterServer(), 5000);
  });
  
  serverState.signaling.on('error', (err) => {
    console.error('WebSocket error:', err.message);
  });
}

/**
 * Register as a game server with the master server
 */
function registerServer() {
  sendToMaster({
    type: 'register_server',
    serverInfo: serverInfo
  });
}

/**
 * Start sending periodic heartbeats to the master server
 */
function startHeartbeats() {
  // Clear any existing interval
  if (serverState.heartbeatInterval) {
    clearInterval(serverState.heartbeatInterval);
  }
  
  // Start a new interval
  serverState.heartbeatInterval = setInterval(() => {
    sendToMaster({
      type: 'heartbeat',
      serverInfo: serverInfo
    });
  }, 30000); // every 30 seconds
}

/**
 * Handle incoming signaling messages
 */
function handleSignalingMessage(message) {
  console.log(`Received message: ${message.type}`);
  
  switch (message.type) {
    case 'connected':
      console.log(`Connected to signaling server with client ID: ${message.clientId}`);
      // Store ice servers if provided
      if (message.iceServers) {
        serverState.iceServers = message.iceServers;
      }
      break;
      
    case 'server_registered':
      console.log(`Registered as game server with peer ID: ${message.peerId}`);
      serverState.peerId = message.peerId;
      // Start sending heartbeats
      startHeartbeats();
      break;
      
    case 'connection_request':
      handleConnectionRequest(message);
      break;
      
    case 'offer':
      handleOffer(message);
      break;
      
    case 'answer':
      handleAnswer(message);
      break;
      
    case 'ice_candidate':
      handleIceCandidate(message);
      break;
      
    case 'heartbeat_ack':
      // Nothing to do
      break;
      
    default:
      console.log(`Unhandled message type: ${message.type}`);
      break;
  }
}

/**
 * Handle connection request from a client
 */
function handleConnectionRequest(message) {
  const { connectionId, clientId } = message;
  
  console.log(`Received connection request from client ${clientId}`);
  
  // Create a new peer connection for this client
  const peerConnection = createPeerConnection(connectionId, clientId);
  
  // Create a data channel for game communication
  const dataChannel = peerConnection.createDataChannel('game', {
    ordered: true,
    maxRetransmits: 3
  });
  
  // Set up data channel handlers
  setupDataChannel(dataChannel, clientId, connectionId);
  
  // Store connection state
  serverState.connections.set(connectionId, {
    id: connectionId,
    clientId: clientId,
    peerConnection: peerConnection,
    dataChannel: dataChannel,
    state: 'connecting'
  });
  
  // Create and send offer
  createAndSendOffer(peerConnection, clientId, connectionId);
}

/**
 * Create RTCPeerConnection for a client
 */
function createPeerConnection(connectionId, clientId) {
  const config = {
    iceServers: serverState.iceServers?.iceServers || [
      { urls: 'stun:stun.l.google.com:19302' }
    ]
  };
  
  const peerConnection = new RTCPeerConnection(config);
  
  // Handle ICE candidates
  peerConnection.onicecandidate = (event) => {
    if (event.candidate) {
      sendToMaster({
        type: 'ice_candidate',
        targetId: clientId,
        connectionId: connectionId,
        candidate: event.candidate
      });
    }
  };
  
  // Connection state changes
  peerConnection.oniceconnectionstatechange = () => {
    console.log(`ICE connection state (${clientId}): ${peerConnection.iceConnectionState}`);
    
    if (peerConnection.iceConnectionState === 'connected' || 
        peerConnection.iceConnectionState === 'completed') {
      // Connection established
      const conn = serverState.connections.get(connectionId);
      if (conn) {
        conn.state = 'connected';
        
        // Add client to our clients map if not already there
        if (!serverState.clients.has(clientId)) {
          serverState.clients.set(clientId, {
            id: clientId,
            connectionId: connectionId,
            connected: true
          });
          
          // Update player count
          serverInfo.players++;
          console.log(`Client ${clientId} connected. Players: ${serverInfo.players}`);
        }
      }
    } else if (peerConnection.iceConnectionState === 'failed' || 
               peerConnection.iceConnectionState === 'disconnected' || 
               peerConnection.iceConnectionState === 'closed') {
      // Connection failed or closed
      handleClientDisconnect(clientId, connectionId);
    }
  };
  
  return peerConnection;
}

/**
 * Set up data channel handlers
 */
function setupDataChannel(dataChannel, clientId, connectionId) {
  dataChannel.onopen = () => {
    console.log(`Data channel open for client ${clientId}`);
    
    // Send welcome message
    dataChannel.send(JSON.stringify({
      type: 'welcome',
      message: `Welcome to ${serverInfo.name}!`,
      serverInfo: serverInfo
    }));
  };
  
  dataChannel.onmessage = (event) => {
    let message;
    try {
      message = JSON.parse(event.data);
      console.log(`Received from client ${clientId}: ${message.type}`);
      
      // Handle different message types
      switch (message.type) {
        case 'chat':
          // Broadcast chat message to all clients
          broadcastMessage({
            type: 'chat',
            from: clientId,
            message: message.message
          });
          break;
          
        case 'ping':
          // Send pong response
          dataChannel.send(JSON.stringify({
            type: 'pong',
            timestamp: message.timestamp
          }));
          break;
          
        default:
          console.log(`Unhandled data channel message: ${message.type}`);
          break;
      }
    } catch (err) {
      console.log(`Received raw data from client ${clientId}: ${event.data}`);
    }
  };
  
  dataChannel.onclose = () => {
    console.log(`Data channel closed for client ${clientId}`);
    handleClientDisconnect(clientId, connectionId);
  };
  
  dataChannel.onerror = (error) => {
    console.error(`Data channel error (${clientId}):`, error);
  };
}

/**
 * Handle client disconnection
 */
function handleClientDisconnect(clientId, connectionId) {
  // Remove connection
  const conn = serverState.connections.get(connectionId);
  if (conn) {
    // Close peer connection
    if (conn.peerConnection) {
      conn.peerConnection.close();
    }
    
    // Remove connection
    serverState.connections.delete(connectionId);
  }
  
  // Remove client
  if (serverState.clients.has(clientId)) {
    serverState.clients.delete(clientId);
    
    // Update player count
    if (serverInfo.players > 0) {
      serverInfo.players--;
    }
    
    console.log(`Client ${clientId} disconnected. Players: ${serverInfo.players}`);
  }
}

/**
 * Create and send SDP offer
 */
async function createAndSendOffer(peerConnection, clientId, connectionId) {
  try {
    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);
    
    sendToMaster({
      type: 'offer',
      targetId: clientId,
      connectionId: connectionId,
      sdp: offer
    });
    
    console.log(`Sent offer to client ${clientId}`);
  } catch (err) {
    console.error('Failed to create or send offer:', err);
  }
}

/**
 * Handle incoming SDP offer
 */
async function handleOffer(message) {
  try {
    const { connectionId, sourceId, sdp } = message;
    
    console.log(`Received offer from client ${sourceId}`);
    
    // Find or create connection
    let conn = serverState.connections.get(connectionId);
    
    if (!conn) {
      // Create new connection if it doesn't exist
      const peerConnection = createPeerConnection(connectionId, sourceId);
      
      peerConnection.ondatachannel = (event) => {
        setupDataChannel(event.channel, sourceId, connectionId);
      };
      
      conn = {
        id: connectionId,
        clientId: sourceId,
        peerConnection: peerConnection,
        state: 'connecting'
      };
      
      serverState.connections.set(connectionId, conn);
    }
    
    // Apply remote description
    await conn.peerConnection.setRemoteDescription(new RTCSessionDescription(sdp));
    
    // Create answer
    const answer = await conn.peerConnection.createAnswer();
    await conn.peerConnection.setLocalDescription(answer);
    
    // Send answer
    sendToMaster({
      type: 'answer',
      targetId: sourceId,
      connectionId: connectionId,
      sdp: answer
    });
    
    console.log(`Sent answer to client ${sourceId}`);
  } catch (err) {
    console.error('Failed to handle offer:', err);
  }
}

/**
 * Handle incoming SDP answer
 */
async function handleAnswer(message) {
  try {
    const { connectionId, sourceId, sdp } = message;
    
    console.log(`Received answer from client ${sourceId}`);
    
    const conn = serverState.connections.get(connectionId);
    if (!conn) {
      console.warn(`No connection found for ID: ${connectionId}`);
      return;
    }
    
    // Apply remote description
    await conn.peerConnection.setRemoteDescription(new RTCSessionDescription(sdp));
    
    console.log(`Applied answer from client ${sourceId}`);
  } catch (err) {
    console.error('Failed to handle answer:', err);
  }
}

/**
 * Handle incoming ICE candidate
 */
async function handleIceCandidate(message) {
  try {
    const { connectionId, sourceId, candidate } = message;
    
    const conn = serverState.connections.get(connectionId);
    if (!conn) return;
    
    await conn.peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
  } catch (err) {
    console.error('Failed to add ICE candidate:', err);
  }
}

/**
 * Send a message to the master server
 */
function sendToMaster(message) {
  if (!serverState.signaling || serverState.signaling.readyState !== WebSocket.OPEN) {
    console.warn('Cannot send message: not connected to master server');
    return false;
  }
  
  try {
    serverState.signaling.send(JSON.stringify(message));
    return true;
  } catch (err) {
    console.error('Failed to send message to master server:', err);
    return false;
  }
}

/**
 * Broadcast a message to all connected clients
 */
function broadcastMessage(message) {
  let count = 0;
  
  serverState.connections.forEach((conn) => {
    if (conn.dataChannel && conn.dataChannel.readyState === 'open') {
      try {
        conn.dataChannel.send(JSON.stringify(message));
        count++;
      } catch (err) {
        console.error(`Failed to send to client ${conn.clientId}:`, err);
      }
    }
  });
  
  console.log(`Broadcast message to ${count} clients`);
}

/**
 * Process command line input
 */
function processCommand(line) {
  const args = line.trim().split(' ');
  const command = args[0].toLowerCase();
  
  switch (command) {
    case 'help':
      showHelp();
      break;
      
    case 'status':
      showStatus();
      break;
      
    case 'broadcast':
      const message = args.slice(1).join(' ');
      broadcastMessage({
        type: 'chat',
        from: 'SERVER',
        message: message
      });
      console.log(`Broadcast message: ${message}`);
      break;
      
    case 'kick':
      const clientId = args[1];
      if (clientId && serverState.clients.has(clientId)) {
        const client = serverState.clients.get(clientId);
        const conn = serverState.connections.get(client.connectionId);
        
        if (conn && conn.dataChannel) {
          conn.dataChannel.send(JSON.stringify({
            type: 'kick',
            reason: args.slice(2).join(' ') || 'Kicked by server'
          }));
        }
        
        handleClientDisconnect(clientId, client.connectionId);
        console.log(`Kicked client ${clientId}`);
      } else {
        console.log(`Client ${clientId} not found`);
      }
      break;
      
    case 'map':
      serverInfo.map = args[1] || serverInfo.map;
      console.log(`Set map to ${serverInfo.map}`);
      break;
      
    case 'name':
      serverInfo.name = args.slice(1).join(' ') || serverInfo.name;
      console.log(`Set server name to ${serverInfo.name}`);
      break;
      
    case 'quit':
    case 'exit':
      console.log('Shutting down...');
      process.exit(0);
      break;
      
    default:
      if (command) {
        console.log(`Unknown command: ${command}`);
        showHelp();
      }
      break;
  }
}

/**
 * Show help text
 */
function showHelp() {
  console.log(`
Commands:
  help                 - Show this help text
  status               - Show server status
  broadcast <message>  - Broadcast a message to all clients
  kick <clientId>      - Kick a client
  map <mapname>        - Change the current map
  name <servername>    - Change the server name
  quit                 - Exit the server
  `);
}

/**
 * Show server status
 */
function showStatus() {
  console.log(`
Server Status:
  Name: ${serverInfo.name}
  Peer ID: ${serverState.peerId || 'Not registered'}
  Map: ${serverInfo.map}
  Game: ${serverInfo.game}
  Players: ${serverInfo.players}/${serverInfo.maxPlayers}
  
Connected Clients:`);

  if (serverState.clients.size === 0) {
    console.log('  No clients connected');
  } else {
    serverState.clients.forEach((client, id) => {
      console.log(`  - ${id}`);
    });
  }
}

// Start server
console.log(`Starting mock game server: ${serverInfo.name}`);
connectToMasterServer();

// Set up command line interface
rl.on('line', (line) => {
  processCommand(line);
  rl.prompt();
}).on('close', () => {
  console.log('Shutting down...');
  process.exit(0);
});

console.log('Type "help" for a list of commands');
rl.prompt();