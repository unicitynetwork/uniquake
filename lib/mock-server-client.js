#!/usr/bin/env node

/**
 * Mock Game Server Client for testing WebRTC P2P connections
 * 
 * This script simulates a game server connecting to the master server,
 * registering itself, and accepting WebRTC connections from clients.
 */

const WebSocket = require('ws');
const readline = require('readline');
const { TokenService } = require('./token-service');

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
      // Create a proper message event object
      const event = { 
        data: data,
        type: 'message' 
      };
      
      // Call the message handler
      this.onmessage(event);
    } else {
      console.warn(`No message handler defined for channel to client ${this.clientId}`);
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
  .boolean('tokens')
  .describe('tokens', 'Enable token features')
  .default('tokens', true)
  .describe('entryfee', 'Entry fee in tokens')
  .default('entryfee', 1)
  .describe('stateinterval', 'Game state token interval in seconds')
  .default('stateinterval', 10)
  .boolean('debug')
  .describe('debug', 'Show debug messages')
  .default('debug', false)
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
  heartbeatInterval: null,
  gameStateInterval: null, // Interval for game state token broadcasting
  
  // Token-related state
  tokenService: null,    // TokenService instance
  clientTokens: new Map(), // Map of clientId -> entry tokens
  gameState: {           // Current game state for token verification
    gameId: `game-${Date.now()}`,
    frame: 0,
    timestamp: Date.now(),
    players: {}
  },
  collectedTokens: []    // Entry tokens collected from clients
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
  // Add token-related info to server info
  const serverInfoWithTokens = {
    ...serverInfo,
    tokenEnabled: !!serverState.tokenService,
    entryFee: argv.entryfee
  };
  
  // If token service is initialized, include the identity information
  if (serverState.tokenService) {
    serverInfoWithTokens.identity = serverState.tokenService.getIdentity();
  }
  
  sendToMaster({
    type: 'register_server',
    serverInfo: serverInfoWithTokens
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
      
      // Start game state token broadcasts if token service is available
      if (serverState.tokenService) {
        startGameStateTokens();
      }
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
  const { connectionId, clientId, identity } = message;
  
  console.log(`Received connection request from client ${clientId}`);
  
  // Store client identity if provided
  let clientIdentity = null;
  if (identity) {
    clientIdentity = {
      pubkey: identity.pubkey,
      username: identity.username
    };
    console.log(`Client identity: ${identity.username} (${identity.pubkey})`);
  }
  
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
    connected: true,
    pubkey: clientIdentity ? clientIdentity.pubkey : null,
    username: clientIdentity ? clientIdentity.username : clientId,
    entryTokenReceived: false
  });
  
  // Update player count
  serverInfo.players++;
  console.log(`Client ${clientId} connected. Players: ${serverInfo.players}`);
  
  // Send connection acceptance to master server
  sendToMaster({
    type: 'proxy_connection',
    clientId: clientId,
    connectionId: connectionId,
    // Include server identity for token operations
    serverIdentity: serverState.tokenService ? {
      pubkey: serverState.tokenService.getIdentity().pubkey,
      username: serverState.tokenService.getIdentity().username
    } : null
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
    const welcomeMessage = {
      type: 'welcome',
      message: `Welcome to ${serverInfo.name}!`,
      serverInfo: serverInfo,
      // Include server identity for token operations if available
      serverIdentity: serverState.tokenService ? {
        pubkey: serverState.tokenService.getIdentity().pubkey,
        username: serverState.tokenService.getIdentity().username
      } : null
    };
    
    // Send via proxy instead of directly through channel
    sendToClient(clientId, welcomeMessage);
  };
  
  channel.onmessage = (event) => {
    let message;
    try {
      // Try to parse as JSON if it's a string
      if (typeof event.data === 'string') {
        try {
          message = JSON.parse(event.data);
        } catch (parseErr) {
          console.error(`Failed to parse string as JSON from client ${clientId}: ${parseErr.message}`);
          return; // Can't proceed without valid message
        }
      } else if (typeof event.data === 'object') {
        // If it's already an object, use it directly
        message = event.data;
      } else {
        throw new Error(`Unexpected data type: ${typeof event.data}`);
      }
      
      if (!message || !message.type) {
        console.error(`Invalid message format from client ${clientId}: missing 'type' property`);
        return;
      }
      
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
          // Send pong response via proxy
          sendToClient(clientId, {
            type: 'pong',
            timestamp: message.timestamp
          });
          break;
          
        // Token-related messages
        case 'token:entry':
          handleEntryToken(clientId, message);
          break;
          
        case 'request:game:state:token':
          handleGameStateTokenRequest(clientId);
          break;
          
        default:
          debug(`Unhandled message type from client ${clientId}: ${message.type}`);
          break;
      }
    } catch (err) {
      console.error(`Error processing message from client ${clientId}: ${err.message}`);
      console.error(err.stack);
      console.error(`Received raw data from client ${clientId}: ${JSON.stringify(event.data)}`);
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
    console.log(`Client ${clientId} connected. Players: ${serverInfo.players}`);
    
    // Set channel to open state
    channel.open();
  } else {
    // Silently update connection ID
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
  
  // Get the client's channel
  const channel = serverState.connections.get(clientId);
  if (!channel) {
    console.warn(`No channel found for client ${clientId}`);
    return;
  }
  
  // Forward the message to the channel
  // We need to handle both string and object formats
  try {
    if (typeof data === 'string') {
      // If it's a string, try to parse it first in case it's a stringified JSON
      try {
        const parsedData = JSON.parse(data);
        channel.receiveMessage(parsedData);
      } catch (parseErr) {
        // If parsing fails, it's a plain string message
        channel.receiveMessage(data);
      }
    } else {
      // If it's already an object, send it directly
      channel.receiveMessage(data);
    }
  } catch (err) {
    console.error(`Failed to process data from client ${clientId}:`, err);
    console.error(err.stack);
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
  
  // Log the actual message content
  console.log(`Broadcasting message: ${JSON.stringify(message)}`);
  
  // Get all channels and send message
  serverState.clients.forEach((client, clientId) => {
    const channel = serverState.connections.get(clientId);
    if (channel && channel.readyState === 'open') {
      // Send message through the proxy
      try {
        const result = sendToClient(clientId, message);
        if (result) {
          count++;
        }
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
async function processCommand(line) {
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
      
    // Token-related commands
    case 'tokens':
      if (!serverState.tokenService) {
        console.log('Token service is not enabled');
        break;
      }
      
      try {
        const tokenStatus = serverState.tokenService.getTokenStatus();
        console.log(`
Token Status:
  Total tokens in pool: ${tokenStatus.tokens.total}
  Collected entry tokens: ${serverState.collectedTokens.length}
        `);
        
        // Show client token status
        console.log('Client Token Status:');
        
        if (serverState.clients.size === 0) {
          console.log('  No clients connected');
        } else {
          serverState.clients.forEach((client, id) => {
            console.log(`  - ${client.username || id}: ${client.entryTokenReceived ? 'Entry token received' : 'No entry token'}`);
          });
        }
      } catch (error) {
        console.error('Failed to get token status:', error.message);
      }
      break;
      
    case 'gamestate':
      if (!serverState.tokenService) {
        console.log('Token service is not enabled');
        break;
      }
      
      try {
        console.log('Creating and broadcasting game state token...');
        const token = await createGameStateToken(true);
        
        if (token) {
          console.log(`Game state token created and broadcast for frame ${serverState.gameState.frame}`);
        } else {
          console.log('Failed to create game state token');
        }
      } catch (error) {
        console.error('Failed to create game state token:', error.message);
      }
      break;
      
    case 'gameover':
      if (!serverState.tokenService) {
        console.log('Token service is not enabled');
        break;
      }
      
      const winnerId = args[1];
      if (!winnerId) {
        console.log('Please specify a client ID for the winner');
        break;
      }
      
      if (!serverState.clients.has(winnerId)) {
        console.log(`Client ${winnerId} not found`);
        break;
      }
      
      try {
        console.log(`Processing game over with winner: ${winnerId}`);
        const result = await distributeTokensToWinner(winnerId);
        
        if (result) {
          console.log('Game over processed successfully');
        } else {
          console.log('Failed to process game over');
        }
      } catch (error) {
        console.error('Error processing game over:', error.message);
      }
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
  
Token Commands:
  tokens               - Show token status
  gamestate            - Create and broadcast a game state token
  gameover <clientId>  - End game and distribute tokens to winner
  
Run with --tokens to enable token features
Run with --entryfee <amount> to set the entry fee
Run with --stateinterval <seconds> to set game state token interval
Run with --debug to show debug messages
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
  Token-enabled: ${serverState.tokenService ? 'Yes' : 'No'}
  Entry Fee: ${argv.entryfee}
  `);
  
  // Show token information if available
  if (serverState.tokenService) {
    const tokenStatus = serverState.tokenService.getTokenStatus();
    const identity = serverState.tokenService.getIdentity();
    
    console.log(`
Token Status:
  Identity: ${identity.username} (${identity.pubkey})
  Collected Tokens: ${serverState.collectedTokens.length}
  Game State Frame: ${serverState.gameState.frame}
    `);
  }
  
  console.log(`Connected Clients:`);
  
  if (serverState.clients.size === 0) {
    console.log('  No clients connected');
  } else {
    serverState.clients.forEach((client, id) => {
      // Include token status if available
      const tokenInfo = client.entryTokenReceived ? '(Entry token received)' : '(No entry token)';
      console.log(`  - ${client.username || id} ${tokenInfo}`);
    });
  }
}

/**
 * Debug logging function
 */
function debug(...args) {
  if (argv.debug) {
    console.log('[DEBUG]', ...args);
  }
}

/**
 * Initialize the token service
 */
async function initializeTokenService() {
  if (!argv.tokens) {
    console.log('Token features are disabled');
    return false;
  }
  
  try {
    // Create token service with server identity
    serverState.tokenService = new TokenService(null, serverInfo.name);
    
    // Initialize the service
    await serverState.tokenService.init();
    
    // Get identity info
    const identity = serverState.tokenService.getIdentity();
    console.log(`Token service initialized with identity: ${identity.username} (${identity.pubkey})`);
    
    // Add identity to server info for clients
    serverInfo.identity = {
      pubkey: identity.pubkey,
      username: identity.username
    };
    
    return true;
  } catch (error) {
    console.error('Failed to initialize token service:', error);
    return false;
  }
}

/**
 * Process an entry token from a client
 * @param {string} clientId - Client ID
 * @param {Object} tokenFlow - Token flow data
 * @returns {Promise<Object>} - Validation result
 */
async function validateEntryToken(clientId, tokenFlow) {
  if (!serverState.tokenService) {
    return { success: false, reason: 'Token service not enabled on server' };
  }
  
  try {
    console.log(`Validating entry token from client ${clientId}...`);
    
    // Receive and validate the token
    const result = await serverState.tokenService.receiveToken(tokenFlow);
    
    if (result.success) {
      // Store the token in the client tokens map
      serverState.clientTokens.set(clientId, result.token);
      
      // Add to collected tokens
      serverState.collectedTokens.push(result.token);
      
      console.log(`Valid entry token received from client ${clientId}`);
      return { success: true };
    } else {
      console.log(`Invalid entry token from client ${clientId}: ${result.error}`);
      return { success: false, reason: result.error };
    }
  } catch (error) {
    console.error(`Error processing entry token from client ${clientId}:`, error.message);
    return { success: false, reason: error.message };
  }
}

/**
 * Create a game state token and broadcast to all clients
 * @param {boolean} broadcast - Whether to broadcast the token to clients
 * @returns {Promise<Object>} - Created token
 */
async function createGameStateToken(broadcast = true) {
  if (!serverState.tokenService) {
    return null;
  }
  
  // Set flag to indicate update is in progress
  serverState.isUpdatingGameState = true;
  
  try {
    // Update game state timestamp and frame
    serverState.gameState.timestamp = Date.now();
    serverState.gameState.frame++;
    
    // Add current player states
    serverState.gameState.players = {};
    
    // Add basic state for each connected client
    serverState.clients.forEach((client, clientId) => {
      serverState.gameState.players[clientId] = {
        connected: client.connected,
        connectionId: client.connectionId,
        lastActive: Date.now()
      };
    });
    
    // Create a token with the game state if we don't have one yet
    // or update the existing token with the new state
    let token = null;
    
    if (!serverState.tokenService.lastStateToken) {
      console.log('Creating initial game state token...');
      token = await serverState.tokenService.createGameStateToken(serverState.gameState);
      console.log(`Created initial game state token for frame ${serverState.gameState.frame}`);
    } else {
      console.log('Updating existing game state token...');
      try {
        // Add more debug information about the token structure
        debug('Token before update:', {
          tokenId: serverState.tokenService.lastStateToken.tokenId,
          hasTransitions: !!serverState.tokenService.lastStateToken.transitions,
          transitionCount: serverState.tokenService.lastStateToken.transitions ? 
            serverState.tokenService.lastStateToken.transitions.length : 0
        });
        
        token = await serverState.tokenService.updateGameStateToken(
          serverState.tokenService.lastStateToken,
          serverState.gameState
        );
        console.log(`Updated game state token for frame ${serverState.gameState.frame}`);
        
        // Log success
        debug('Successfully updated token with ID:', token.tokenId);
      } catch (updateError) {
        // If update fails, create a new token instead
        console.warn(`Could not update token, creating a new one: ${updateError.message}`);
        token = await serverState.tokenService.createGameStateToken(serverState.gameState);
        console.log(`Created new game state token for frame ${serverState.gameState.frame} (after update failure)`);
      }
    }
    
    // The token service now manages the lastStateToken property internally
    // Just keep a reference for broadcasting
    token = serverState.tokenService.lastStateToken;
      
      debug(`Processed game state token for frame ${serverState.gameState.frame}`);
      
      // Broadcast to all clients if requested
      if (broadcast) {
        const tokenFlow = serverState.tokenService.TXF.exportFlow(token);
        
        broadcastMessage({
          type: 'game:state:token',
          tokenFlow: tokenFlow,
          frame: serverState.gameState.frame
        });
        
        debug(`Broadcast game state token to all clients`);
      }
    
    return token;
  } catch (error) {
    console.error('Failed to process game state token:', error.message);
    return null;
  } finally {
    // Clear update flag regardless of success or failure
    serverState.isUpdatingGameState = false;
  }
}

/**
 * Start periodic game state token broadcasts
 */
function startGameStateTokens() {
  // Clear existing interval
  if (serverState.gameStateInterval) {
    clearInterval(serverState.gameStateInterval);
  }
  
  // Skip if token service is not available
  if (!serverState.tokenService) {
    return;
  }
  
  console.log(`Starting game state token broadcasts every ${argv.stateinterval} seconds...`);
  
  // Create initial game state token
  // Add a short delay to ensure everything is initialized
  setTimeout(() => {
    createGameStateToken();
    
    // Set up interval for periodic updates with a slightly longer interval
    // to allow each update to complete before starting the next one
    serverState.gameStateInterval = setInterval(() => {
      // Only attempt update if last one has completed
      if (!serverState.isUpdatingGameState) {
        createGameStateToken();
      } else {
        console.log('Skipping game state update as previous update is still in progress');
      }
    }, argv.stateinterval * 1000);
  }, 2000); // 2 second delay for initial token creation
}

/**
 * Handle entry token from client
 * @param {string} clientId - Client ID
 * @param {Object} message - Token message
 */
async function handleEntryToken(clientId, message) {
  if (!serverState.tokenService) {
    console.log(`Received entry token from client ${clientId} but token service is disabled`);
    
    // Send rejection message
    sendToClient(clientId, {
      type: 'token:entry:ack',
      success: false,
      reason: 'Token service is disabled on this server'
    });
    
    return;
  }
  
  console.log(`Received entry token from client ${clientId}`);
  
  const client = serverState.clients.get(clientId);
  if (!client) {
    console.log(`Client ${clientId} not found`);
    return;
  }
  
  // Check if client already sent an entry token
  if (client.entryTokenReceived) {
    console.log(`Client ${clientId} already sent an entry token`);
    
    // Send acknowledgment
    sendToClient(clientId, {
      type: 'token:entry:ack',
      success: true,
      message: 'Entry token already received'
    });
    
    return;
  }
  
  // Validate the token
  try {
    const tokenFlow = message.tokenFlow;
    const result = await validateEntryToken(clientId, tokenFlow);
    
    if (result.success) {
      // Mark client as having sent an entry token
      client.entryTokenReceived = true;
      
      // Send acknowledgment
      sendToClient(clientId, {
        type: 'token:entry:ack',
        success: true,
        message: 'Entry token accepted'
      });
      
      // Also broadcast a message to all clients
      broadcastMessage({
        type: 'chat',
        from: 'SERVER',
        message: `${client.username || clientId} has paid the entry fee!`
      });
    } else {
      // Send rejection
      sendToClient(clientId, {
        type: 'token:entry:ack',
        success: false,
        reason: result.reason || 'Invalid token'
      });
    }
  } catch (error) {
    console.error(`Error processing entry token from client ${clientId}:`, error.message);
    
    // Send error message
    sendToClient(clientId, {
      type: 'token:entry:ack',
      success: false,
      reason: error.message
    });
  }
}

/**
 * Handle game state token request from client
 * @param {string} clientId - Client ID
 */
async function handleGameStateTokenRequest(clientId) {
  if (!serverState.tokenService) {
    console.log(`Received game state token request from client ${clientId} but token service is disabled`);
    return;
  }
  
  console.log(`Received game state token request from client ${clientId}`);
  
  try {
    // Use the existing game state token or create a new one if needed
    if (!serverState.tokenService.lastStateToken) {
      await createGameStateToken(false);
    }
    
    if (serverState.tokenService.lastStateToken) {
      // Export the token flow with all transitions
      const tokenFlow = serverState.tokenService.TXF.exportFlow(serverState.tokenService.lastStateToken);
      
      // Send to the requesting client
      sendToClient(clientId, {
        type: 'game:state:token',
        tokenFlow: tokenFlow,
        frame: serverState.gameState.frame
      });
      
      console.log(`Sent game state token to client ${clientId}`);
    } else {
      console.log(`Failed to process game state token for client ${clientId}`);
    }
  } catch (error) {
    console.error(`Error sending game state token to client ${clientId}:`, error.message);
  }
}

/**
 * Distribute collected tokens to a winner
 * @param {string} winnerId - Client ID of the winner
 * @returns {Promise<boolean>} - Success flag
 */
async function distributeTokensToWinner(winnerId) {
  if (!serverState.tokenService || !serverState.clients.has(winnerId)) {
    return false;
  }
  
  try {
    const client = serverState.clients.get(winnerId);
    
    // Ensure client is connected
    if (!client.connected) {
      console.log(`Cannot distribute tokens: Client ${winnerId} is not connected`);
      return false;
    }
    
    // Ensure we have the client's public key
    if (!client.pubkey) {
      console.log(`Cannot distribute tokens: Client ${winnerId} public key not available`);
      return false;
    }
    
    // Check if we have any tokens to distribute
    if (serverState.collectedTokens.length === 0) {
      console.log(`No tokens available to distribute to winner ${winnerId}`);
      return false;
    }
    
    console.log(`Distributing ${serverState.collectedTokens.length} tokens to winner ${winnerId}...`);
    
    // Send tokens to the winner
    const tokenFlows = await serverState.tokenService.sendTokensToRecipient(
      serverState.collectedTokens,
      client.pubkey
    );
    
    // Send the token flows to the client
    sendToClient(winnerId, {
      type: 'token:reward',
      tokenFlows: tokenFlows,
      count: tokenFlows.length
    });
    
    // Clear the collected tokens
    serverState.collectedTokens = [];
    
    console.log(`Tokens distributed to winner ${winnerId}`);
    
    // Broadcast game over message to all clients
    broadcastMessage({
      type: 'chat',
      from: 'SERVER',
      message: `Game over! ${client.username || winnerId} is the winner and received all collected tokens!`
    });
    
    return true;
  } catch (error) {
    console.error(`Failed to distribute tokens to winner ${winnerId}:`, error.message);
    return false;
  }
}

// Start server
console.log(`Starting mock game server: ${serverInfo.name}`);
initializeTokenService().then(() => {
  connectToMasterServer();
});

// Set up command line interface
rl.on('line', async (line) => {
  try {
    await processCommand(line);
  } catch (error) {
    console.error(`Error processing command: ${error.message}`);
  }
  rl.prompt();
}).on('close', () => {
  console.log('Shutting down...');
  process.exit(0);
});

console.log('Type "help" for a list of commands');
rl.prompt();