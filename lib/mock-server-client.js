#!/usr/bin/env node

/**
 * Mock Game Server Client for testing WebRTC P2P connections
 * 
 * This script simulates a game server connecting to the master server,
 * registering itself, and accepting WebRTC connections from clients.
 */

const WebSocket = require('ws');
const readline = require('readline');

// Define a simple mock channel for direct WebSocket communication
class MockServerChannel {
  constructor(clientId) {
    this.clientId = clientId;
    this.readyState = 'connecting';
    
    // Event handlers
    this.onopen = null;
    this.onmessage = null;
    this.onclose = null;
    this.onerror = null;
  }
  
  // Send a message
  send(data) {
    console.log(`[Server] Channel sent to ${this.clientId}: ${typeof data === 'string' ? (data.substr(0, 30) + '...') : JSON.stringify(data).substr(0, 30) + '...'}`);
    return true;
  }
  
  // Close the channel
  close() {
    this._close();
  }
  
  // Set channel to open state
  open() {
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
  
  // Receive a message
  receiveMessage(data) {
    if (this.onmessage) {
      this.onmessage({ data });
    }
  }
}

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
  connections: new Map(), // Map of clientId -> channel connection
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
      
    case 'heartbeat_ack':
      // Nothing to do
      break;
      
    case 'proxy_connection':
      handleProxyConnection(message);
      break;
      
    case 'proxy_data':
      handleProxyData(message);
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
  
  // Create a new channel for this client
  const channel = new MockServerChannel(clientId);
  
  // Set up channel handlers
  setupChannel(channel, clientId);
  
  // Store connection state
  serverState.connections.set(clientId, channel);
  
  // Add client to our clients map
  serverState.clients.set(clientId, {
    id: clientId,
    connectionId: connectionId,
    connected: true
  });
  
  // Update player count
  serverInfo.players++;
  console.log(`Client ${clientId} connected. Players: ${serverInfo.players}`);
  
  // Send connection acceptance to master server
  sendToMaster({
    type: 'proxy_connection',
    clientId: clientId,
    connectionId: connectionId
  });
  
  // Set channel to open state
  channel.open();
}

/**
 * Set up channel handlers
 */
function setupChannel(channel, clientId) {
  channel.onopen = () => {
    console.log(`Channel open for client ${clientId}`);
    
    // Send welcome message
    channel.send(JSON.stringify({
      type: 'welcome',
      message: `Welcome to ${serverInfo.name}!`,
      serverInfo: serverInfo
    }));
  };
  
  channel.onmessage = (event) => {
    let message;
    try {
      console.log(`Raw channel data from client ${clientId}: ${typeof event.data} - ${event.data.substring(0, 100)}`);
      
      // Try to parse as JSON if it's a string
      if (typeof event.data === 'string') {
        message = JSON.parse(event.data);
      } else if (typeof event.data === 'object') {
        // If it's already an object, use it directly
        message = event.data;
      } else {
        throw new Error(`Unexpected data type: ${typeof event.data}`);
      }
      
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
          console.log(`Received ping from client ${clientId}, sending pong`);
          // Send pong response
          channel.send(JSON.stringify({
            type: 'pong',
            timestamp: message.timestamp
          }));
          break;
          
        default:
          console.log(`Unhandled channel message: ${message.type}`);
          break;
      }
    } catch (err) {
      console.log(`Error processing message from client ${clientId}: ${err.message}`);
      console.log(`Received raw data from client ${clientId}: ${JSON.stringify(event.data)}`);
    }
  };
  
  channel.onclose = () => {
    console.log(`Channel closed for client ${clientId}`);
    handleClientDisconnect(clientId);
  };
  
  channel.onerror = (error) => {
    console.error(`Channel error (${clientId}):`, error);
  };
}

/**
 * Handle client disconnection
 */
function handleClientDisconnect(clientId) {
  // Remove connection
  const channel = serverState.connections.get(clientId);
  if (channel) {
    // Close the channel
    channel.close();
    
    // Notify master server
    sendToMaster({
      type: 'proxy_client_disconnected',
      clientId: clientId
    });
    
    // Remove connection
    serverState.connections.delete(clientId);
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
 * Handle proxy connection message from master server
 */
function handleProxyConnection(message) {
  const { clientId, connectionId } = message;
  
  console.log(`Received proxy connection for client ${clientId} with connection ID: ${connectionId}`);
  
  // Create a new channel for this client if it doesn't exist already
  if (!serverState.connections.has(clientId)) {
    const channel = new MockServerChannel(clientId);
    
    // Set up channel handlers
    setupChannel(channel, clientId);
    
    // Store connection state
    serverState.connections.set(clientId, channel);
    
    // Add client to our clients map
    serverState.clients.set(clientId, {
      id: clientId,
      connectionId: connectionId,
      connected: true
    });
    
    // Update player count
    serverInfo.players++;
    console.log(`Client ${clientId} connected via proxy. Players: ${serverInfo.players}`);
    
    // Set channel to open state
    channel.open();
  } else {
    console.log(`Client ${clientId} already has a connection, updating connection ID`);
    const client = serverState.clients.get(clientId);
    if (client) {
      client.connectionId = connectionId;
    }
  }
}

/**
 * Handle proxy data from client
 */
function handleProxyData(message) {
  const { clientId, connectionId, data } = message;
  
  // If client is not in our registry, but we got data, create a connection
  if (!serverState.clients.has(clientId)) {
    console.warn(`Received proxy data from unknown client: ${clientId}`);
    
    // Create connection on-demand (this is a recovery mechanism)
    if (connectionId) {
      console.log(`Creating missing connection for client ${clientId}`);
      handleProxyConnection({
        clientId: clientId,
        connectionId: connectionId
      });
    } else {
      return;
    }
  }
  
  console.log(`Received proxy data from client ${clientId}`);
  
  // Get the client's channel
  const channel = serverState.connections.get(clientId);
  if (!channel) {
    console.warn(`No channel found for client ${clientId}`);
    return;
  }
  
  // Forward the message to the channel
  // We need to handle both string and object formats
  if (typeof data === 'string') {
    channel.receiveMessage(data);
  } else {
    try {
      // If it's an object, stringify it first
      channel.receiveMessage(JSON.stringify(data));
    } catch (err) {
      console.error(`Failed to stringify data for client ${clientId}:`, err);
    }
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
 * Send data to a client via WebSocket proxy
 * @param {string} clientId - Target client ID
 * @param {Object} data - Data to send
 * @returns {boolean} True if sent successfully
 */
function sendToClient(clientId, data) {
  if (!serverState.signaling || serverState.signaling.readyState !== WebSocket.OPEN) {
    console.warn('Cannot send data: not connected to master server');
    return false;
  }
  
  // Ensure client exists
  const client = serverState.clients.get(clientId);
  if (!client) {
    console.warn(`Cannot send data: client ${clientId} not found`);
    return false;
  }
  
  try {
    const message = {
      type: 'proxy_data',
      clientId: clientId,
      connectionId: client.connectionId || 'mock-connection',
      data: data
    };
    
    serverState.signaling.send(JSON.stringify(message));
    return true;
  } catch (err) {
    console.error(`Failed to send data to client ${clientId}:`, err);
    return false;
  }
}

/**
 * Broadcast a message to all connected clients
 */
function broadcastMessage(message) {
  let count = 0;
  
  // Convert message to JSON string once
  const jsonMessage = JSON.stringify(message);
  
  // Get all channels and send message
  serverState.clients.forEach((client, clientId) => {
    const channel = serverState.connections.get(clientId);
    if (channel && channel.readyState === 'open') {
      // Send message through the channel
      try {
        sendToClient(clientId, message);
        count++;
      } catch (err) {
        console.error(`Failed to send to client ${clientId}:`, err);
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
        const kickReason = args.slice(2).join(' ') || 'Kicked by server';
        
        // Send kick message
        sendToClient(clientId, {
          type: 'kick',
          reason: kickReason
        });
        
        // Disconnect the client
        handleClientDisconnect(clientId);
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