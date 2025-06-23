#!/usr/bin/env node

/**
 * UniQuake Server CLI
 * 
 * Command-line interface that replicates the functionality of the browser-based server page.
 * Acts as a proxy controller for a dedicated Quake server process, communicating through
 * the master server via WebSocket.
 */

const WebSocket = require('ws');
const readline = require('readline');
const logger = require('winston');
const optimist = require('optimist');
const path = require('path');
const fs = require('fs');
const { TokenService } = require('../lib/token-service');

// Set up logging
logger.cli();
logger.level = process.env.LOG_LEVEL || 'info';

// Global variables (matching server.html structure)
let serverConnection = null;
let currentServerName = '';
let dedicatedServerInfo = null;
let rconPendingRequests = new Map();
let gameEnded = false;
let matchEndDetection = null;

// Server state tracking
const serverState = {
  registered: false,
  clients: new Map(),
  collectedFees: [],
  gameStateInterval: null,
  restartCycle: null,
  gameId: null,
  gameState: null, // Will be initialized in startGameStateTokens()
  playerScores: new Map(),
  heartbeatInterval: null,
  updateStatsInterval: null,
  tokenService: null,
  entryFee: 1, // Default entry fee
  tokenEnabled: false
};

// Latest player scores from RCON
let latestPlayerScores = {
  players: [],
  lastUpdate: null
};

// Match control settings
const MATCH_SETTINGS = {
  DURATION_MINUTES: 15,  // 15 minutes per match
  FRAG_LIMIT: 15        // 15 frags to win
};

// Match control state
const matchControl = {
  isActive: false,
  startTime: null,
  timeUpdateInterval: null,
  fragCheckInterval: null
};

// CLI state
let rl = null;
let isExiting = false;

/**
 * Parse command line arguments
 */
function parseArguments() {
  const argv = optimist
    .usage('Usage: $0 [options]')
    .describe('master', 'Master server URL')
    .default('master', 'ws://localhost:27950')
    .describe('name', 'Server name')
    .default('name', 'UniQuake Server')
    .describe('map', 'Map name')
    .default('map', 'q3dm1')
    .describe('max-players', 'Maximum players')
    .default('max-players', 16)
    .describe('no-tokens', 'Disable token system')
    .boolean('no-tokens')
    .describe('entry-fee', 'Entry fee in tokens')
    .default('entry-fee', 1)
    .describe('debug', 'Enable debug logging')
    .boolean('debug')
    .boolean('help').describe('help', 'Show this help')
    .alias('h', 'help')
    .argv;

  if (argv.help) {
    optimist.showHelp();
    process.exit(0);
  }
  
  if (argv.debug) {
    logger.level = 'debug';
  }

  return {
    masterServer: argv.master,
    serverName: argv.name,
    map: argv.map,
    maxPlayers: parseInt(argv['max-players']),
    tokenEnabled: !argv['no-tokens'],
    entryFee: parseInt(argv['entry-fee']),
    debug: argv.debug
  };
}

/**
 * Connect to master server
 */
async function connectToMasterServer(config) {
  return new Promise((resolve, reject) => {
    try {
      logger.info(`Connecting to master server at ${config.masterServer}...`);
      
      serverConnection = new WebSocket(config.masterServer);
      
      serverConnection.on('open', () => {
        logger.info('Connected to master server');
        
        // Register as a server
        const registerMsg = {
          type: 'register_server',
          serverInfo: {
            name: config.serverName,
            map: config.map,
            game: 'baseq3',
            players: 0,
            maxPlayers: config.maxPlayers,
            address: 'ws-proxy',
            tokenEnabled: config.tokenEnabled,
            entryFee: config.entryFee
          }
        };
        
        serverConnection.send(JSON.stringify(registerMsg));
        logger.debug('Sent server registration');
        
        resolve(true);
      });
      
      serverConnection.on('message', (data) => {
        try {
          const message = JSON.parse(data.toString());
          handleMasterServerMessage(message);
        } catch (err) {
          logger.error('Failed to parse message:', err.message);
          logger.debug('Raw message:', data.toString());
        }
      });
      
      serverConnection.on('close', () => {
        logger.warn('Disconnected from master server');
        
        // Clear intervals
        if (serverState.heartbeatInterval) {
          clearInterval(serverState.heartbeatInterval);
          serverState.heartbeatInterval = null;
        }
        if (serverState.gameStateInterval) {
          clearInterval(serverState.gameStateInterval);
          serverState.gameStateInterval = null;
        }
        if (serverState.updateStatsInterval) {
          clearInterval(serverState.updateStatsInterval);
          serverState.updateStatsInterval = null;
        }
        
        serverState.registered = false;
        
        // Try to reconnect after delay
        if (!isExiting) {
          setTimeout(() => connectToMasterServer(config), 5000);
        }
      });
      
      serverConnection.on('error', (err) => {
        logger.error('Master server connection error:', err.message);
        reject(err);
      });
      
    } catch (err) {
      logger.error('Failed to connect to master server:', err);
      reject(err);
    }
  });
}

/**
 * Handle messages from master server
 */
function handleMasterServerMessage(message) {
  logger.debug(`Received message: ${message.type}`);
  
  switch (message.type) {
    case 'connected':
      logger.info(`Connected to signaling server with client ID: ${message.clientId}`);
      break;
      
    case 'server_registered':
      logger.info(`Registered as game server with peer ID: ${message.peerId}`);
      serverState.registered = true;
      
      // Start heartbeats
      startHeartbeats();
      
      // Start dedicated server
      startRemoteServer();
      // Note: Game state tokens will be started in handleGameServerStarted() 
      // after we receive the gameId from the server
      break;
      
    case 'connection_request':
      handleConnectionRequest(message);
      break;
      
    case 'proxy_connection':
      handleProxyConnection(message);
      break;
      
    case 'proxy_data':
      handleProxyData(message).catch(error => {
        logger.error('Error handling proxy data:', error.message);
      });
      break;
      
    case 'client_disconnected':
      handleClientDisconnected(message);
      break;
      
    case 'game_server_started':
      handleGameServerStarted(message);
      break;
      
    case 'game_server_stopped':
      handleGameServerStopped(message);
      break;
      
    case 'rcon_response':
      handleRCONResponse(message);
      break;
      
    case 'server_updated':
      logger.info('Server info updated successfully');
      break;
      
    case 'heartbeat_ack':
      // Heartbeat acknowledged
      break;
      
    default:
      logger.debug(`Unhandled message type: ${message.type}`);
  }
}

/**
 * Start sending periodic heartbeats
 */
function startHeartbeats() {
  if (serverState.heartbeatInterval) {
    clearInterval(serverState.heartbeatInterval);
  }
  
  serverState.heartbeatInterval = setInterval(() => {
    if (serverConnection && serverConnection.readyState === WebSocket.OPEN) {
      serverConnection.send(JSON.stringify({
        type: 'heartbeat',
        serverInfo: {
          name: currentServerName,
          players: serverState.clients.size,
          maxPlayers: 16
        }
      }));
    }
  }, 30000); // Every 30 seconds
}

/**
 * Start game state token broadcasts
 */
function startGameStateTokens() {
  if (serverState.gameStateInterval) {
    clearInterval(serverState.gameStateInterval);
  }
  
  // Initialize game state to match server.html exactly
  // Use the gameId that was already generated in startRemoteServer() and stored in serverState.gameId
  serverState.gameState = {
    gameId: serverState.gameId,
    frame: 0,
    timestamp: Date.now(),
    players: {},
    items: {}
  };
  
  // Create initial token after 1 second
  setTimeout(() => {
    createGameStateToken(true);
  }, 1000);
  
  // Set up periodic token broadcasts (every 10 seconds)
  serverState.gameStateInterval = setInterval(() => {
    createGameStateToken(true);
  }, 10000);
}

/**
 * Create game state token using Unicity SDK (matching server.html exactly)
 */
async function createGameStateToken(broadcast = true) {
  if (!serverState.tokenService) {
    return null;
  }

  try {
    // Only increment frame for periodic broadcasts, not for client requests
    if (broadcast) {
      serverState.gameState.frame++;
    }
    serverState.gameState.timestamp = Date.now();
    
    // Update players from connected clients (matching server.html logic)
    serverState.gameState.players = {};
    serverState.clients.forEach((client, clientId) => {
      const playerKey = client.pubkey || clientId;
      serverState.gameState.players[playerKey] = {
        id: playerKey,
        name: client.username || `Player-${clientId}`,
        connected: client.connected,
        pubkey: client.pubkey,
        clientId: clientId,
        joinTime: client.joinTime,
        lastActive: Date.now()
      };
    });
    
    logger.debug(`Creating game state token for frame ${serverState.gameState.frame} with ${Object.keys(serverState.gameState.players).length} players`);
  logger.debug(`Game state for token - GameId: "${serverState.gameState.gameId}", Frame: ${serverState.gameState.frame}`);
    
    // Create or update the token (matching server.html logic)
    // Reset token every 10 frames to prevent growth (when frame is divisible by 10)
    let token = null;
    const shouldResetToken = serverState.gameState.frame % 10 === 0;
    
    if (!serverState.tokenService.lastStateToken || shouldResetToken) {
      if (shouldResetToken) {
        logger.debug(`Resetting game state token at frame ${serverState.gameState.frame} (divisible by 10)`);
      }
      // Create fresh token (initial or reset)
      token = await serverState.tokenService.createGameStateToken(serverState.gameState);
      logger.debug(`Created ${shouldResetToken ? 'reset' : 'initial'} game state token for frame ${serverState.gameState.frame}`);
    } else {
      // Update existing token
      try {
        token = await serverState.tokenService.updateGameStateToken(
          serverState.tokenService.lastStateToken,
          serverState.gameState
        );
        logger.debug(`Updated game state token for frame ${serverState.gameState.frame}`);
      } catch (updateError) {
        // If update fails, create new token
        logger.warn(`Token update failed, creating new token: ${updateError.message}`);
        token = await serverState.tokenService.createGameStateToken(serverState.gameState);
      }
    }
    
    // Broadcast to all connected clients if requested (matching server.html)
    if (broadcast && token) {
      const tokenFlow = serverState.tokenService.TXF.exportFlow(token);
      
      const serverStateInfo = {
        playerCount: serverState.clients.size,
        itemCount: Object.keys(serverState.gameState.items).length,
        timestamp: Date.now()
      };
      
      const message = {
        type: 'game:state:token',
        tokenFlow: tokenFlow,
        frame: serverState.gameState.frame,
        serverInfo: serverStateInfo
      };
      
      logger.debug(`Broadcasting Unicity token to ${serverState.clients.size} clients: frame ${serverState.gameState.frame}`);
      logger.debug(`[Token Broadcast] GameId: "${serverState.gameState.gameId}", Frame: ${serverState.gameState.frame}`);
      broadcastToClients(message);
    }
    
    return token;
    
  } catch (error) {
    logger.error('Failed to create/update game state token:', error.message);
  }
}


/**
 * Generate hash using the same method as the client for compatibility
 * Matches the client's normalizeGameState() and TXF.getHashOf() approach
 */
function generateClientCompatibleHash(gameState) {
  // If token service is available with our overrides, use it directly
  if (serverState.tokenService && serverState.tokenService.hashGameState) {
    return serverState.tokenService.hashGameState(gameState);
  }
  
  // Otherwise use the same logic as our override
  const minimalState = {
    frame: parseInt(gameState?.frame || 0, 10),
    gameId: String(gameState?.gameId || '')
  };
  
  const serialized = JSON.stringify(minimalState);
  
  if (serverState.tokenService && serverState.tokenService.TXF) {
    return serverState.tokenService.TXF.getHashOf(serialized);
  }
  
  // Last resort fallback
  const crypto = require('crypto');
  return crypto.createHash('sha256').update(serialized).digest('hex');
}

/**
 * Start remote dedicated server
 */
async function startRemoteServer() {
  const gameId = 'game-' + Date.now();
  serverState.gameId = gameId;
  
  logger.info('Requesting dedicated server start...');
  
  const startServerMsg = {
    unicity: true,
    type: 'start_game_server',
    serverInfo: {
      name: currentServerName,
      gameId: gameId,
      map: 'q3dm1',
      maxPlayers: 16,
      private: false
    }
  };
  
  if (serverConnection && serverConnection.readyState === WebSocket.OPEN) {
    serverConnection.send(JSON.stringify(startServerMsg));
    return gameId;
  } else {
    throw new Error('Not connected to master server');
  }
}

/**
 * Handle game server started event
 */
function handleGameServerStarted(message) {
  logger.info('Dedicated server started successfully');
  logger.info(`Server ID: ${message.serverId}`);
  logger.info(`Game ID: ${message.gameId}`);
  logger.info(`Address: ${message.serverInfo.host}:${message.serverInfo.port}`);
  
  dedicatedServerInfo = {
    serverId: message.serverId,
    gameId: message.gameId,
    serverInfo: message.serverInfo
  };
  
  // Update server state with new game ID (matching server.html)
  serverState.gameId = message.gameId;
  
  // NOW start game state tokens since we have the gameId
  if (serverState.tokenEnabled && !serverState.gameStateInterval) {
    logger.info('Starting game state tokens with gameId: ' + serverState.gameId);
    startGameStateTokens();
  }
  
  // Start match control
  startMatchControl();
  
  // Start periodic statistics updates
  startStatisticsUpdates();
  
  displayStatus();
}

/**
 * Handle game server stopped event
 */
function handleGameServerStopped(message) {
  logger.info('Dedicated server stopped');
  
  if (message.isRestartCycle) {
    logger.info('Server stopped for restart cycle');
  }
  
  dedicatedServerInfo = null;
  
  // Clear statistics interval
  if (serverState.updateStatsInterval) {
    clearInterval(serverState.updateStatsInterval);
    serverState.updateStatsInterval = null;
  }
  
  // Stop match control
  stopMatchControl();
  
  displayStatus();
}

/**
 * Start periodic player statistics updates
 */
function startStatisticsUpdates() {
  if (serverState.updateStatsInterval) {
    clearInterval(serverState.updateStatsInterval);
  }
  
  // Update stats every 5 seconds
  serverState.updateStatsInterval = setInterval(() => {
    updatePlayerStatistics();
  }, 5000);
  
  // Initial update
  updatePlayerStatistics();
}

/**
 * Update player statistics via RCON
 */
async function updatePlayerStatistics() {
  if (gameEnded || (serverState.restartCycle && serverState.restartCycle.active)) {
    return;
  }
  
  if (!dedicatedServerInfo) {
    logger.debug('No dedicated server running, skipping stats update');
    return;
  }
  
  try {
    // Get player status
    const statusResponse = await sendRCONCommand('status');
    if (statusResponse) {
      const parsedStatus = parsePlayerStatusFromRCON(statusResponse);
      
      // Update latest scores
      latestPlayerScores.players = parsedStatus.players;
      latestPlayerScores.lastUpdate = Date.now();
      
      // Update client scores
      for (const player of parsedStatus.players) {
        // Try to match player to connected client by name
        for (const [clientId, client] of serverState.clients) {
          if (client.username === player.name) {
            client.score = player.score;
            break;
          }
        }
      }
      
      // Display updated stats
      displayPlayerStats(parsedStatus);
    }
    
    // Get server info
    const serverInfoResponse = await sendRCONCommand('serverinfo');
    if (serverInfoResponse) {
      // Parse and display server info
      logger.debug('Server info updated');
    }
    
  } catch (error) {
    logger.error('Failed to update statistics:', error.message);
  }
}

/**
 * Send RCON command
 */
function sendRCONCommand(command) {
  return new Promise((resolve, reject) => {
    if (!serverConnection || serverConnection.readyState !== WebSocket.OPEN) {
      reject(new Error('Not connected to master server'));
      return;
    }
    
    if (!dedicatedServerInfo) {
      reject(new Error('No dedicated server running'));
      return;
    }
    
    const requestId = 'rcon-' + Date.now() + '-' + Math.random();
    
    // Set up timeout
    const timeout = setTimeout(() => {
      rconPendingRequests.delete(requestId);
      reject(new Error('RCON command timeout'));
    }, 10000);
    
    // Store pending request
    rconPendingRequests.set(requestId, {
      resolve: (response) => {
        clearTimeout(timeout);
        resolve(response);
      },
      reject: (error) => {
        clearTimeout(timeout);
        reject(error);
      }
    });
    
    // Send command
    const rconMsg = {
      type: 'rcon_command',
      requestId: requestId,
      gameId: serverState.gameId,
      command: command
    };
    
    logger.debug(`Sending RCON command: ${command}`);
    serverConnection.send(JSON.stringify(rconMsg));
  });
}

/**
 * Handle RCON response
 */
function handleRCONResponse(message) {
  const { requestId, response, error } = message;
  
  const pending = rconPendingRequests.get(requestId);
  if (pending) {
    rconPendingRequests.delete(requestId);
    
    if (error) {
      pending.reject(new Error(error));
    } else {
      // Handle both structured and raw string responses
      if (typeof response === 'object' && response.output) {
        pending.resolve(response.output);
      } else if (typeof response === 'string') {
        pending.resolve(response);
      } else {
        pending.resolve(JSON.stringify(response));
      }
    }
  }
}

/**
 * Parse player status from RCON output
 */
function parsePlayerStatusFromRCON(rconOutput) {
  const lines = rconOutput.split('\\n');
  const players = [];
  let map = '';
  
  for (const line of lines) {
    // Extract map name
    if (line.includes('map:')) {
      const mapMatch = line.match(/map:\\s*(\\S+)/);
      if (mapMatch) {
        map = mapMatch[1];
      }
    }
    
    // Parse player lines (fixed-width format)
    const playerMatch = line.match(/^\\s*(\\d+)\\s+(\\-?\\d+)\\s+(\\d+|CNCT|ZMBI)\\s+(.+?)\\s+(\\d+\\.\\d+\\.\\d+\\.\\d+:\\d+|bot)/);
    if (playerMatch) {
      const [, slot, score, ping, name, address] = playerMatch;
      
      // Clean name (remove color codes)
      const cleanName = name.replace(/\\^\\d/g, '').trim();
      
      players.push({
        slot: parseInt(slot),
        name: cleanName,
        score: parseInt(score),
        ping: ping === 'CNCT' || ping === 'ZMBI' ? ping : parseInt(ping),
        address: address,
        isBot: address === 'bot' || parseInt(ping) === 999
      });
    }
  }
  
  return {
    map: map,
    players: players,
    playerCount: players.length
  };
}

/**
 * Handle client connection request
 */
function handleConnectionRequest(message) {
  const { connectionId, clientId, identity } = message;
  
  logger.info(`Connection request from client ${clientId}`);
  
  // Check for rejoining client by pubkey
  let existingClientId = null;
  if (identity && identity.pubkey) {
    for (const [id, client] of serverState.clients) {
      if (client.pubkey === identity.pubkey) {
        existingClientId = id;
        break;
      }
    }
  }
  
  if (existingClientId) {
    // Client rejoining
    logger.info(`Client ${clientId} is rejoining (was ${existingClientId})`);
    
    // Update client info
    const client = serverState.clients.get(existingClientId);
    client.id = clientId;
    client.connectionId = connectionId;
    client.connected = true;
    
    // Move to new ID
    serverState.clients.delete(existingClientId);
    serverState.clients.set(clientId, client);
  } else {
    // New client
    const client = {
      id: clientId,
      connectionId: connectionId,
      connected: true,
      pubkey: identity ? identity.pubkey : null,
      username: identity ? identity.username : clientId,
      entryTokenReceived: false,
      score: 0
    };
    
    serverState.clients.set(clientId, client);
    logger.info(`New client connected: ${client.username}`);
  }
  
  // Accept connection
  const acceptMsg = {
    type: 'proxy_connection',
    clientId: clientId,
    connectionId: connectionId
  };
  
  serverConnection.send(JSON.stringify(acceptMsg));
  
  displayStatus();
}

/**
 * Handle proxy connection notification
 */
function handleProxyConnection(message) {
  const { clientId, connectionId } = message;
  logger.debug(`Proxy connection established for client ${clientId} with connection ${connectionId}`);
  
  // This message confirms that the proxy connection is active
  // The client should already be in our clients map from connection_request
  const client = serverState.clients.get(clientId);
  if (client) {
    client.connectionId = connectionId;
    logger.info(`Confirmed proxy connection for client ${client.username}`);
    
    // Send welcome message with server identity and entry fee requirements
    const welcomeMsg = {
      type: 'welcome',
      message: `Welcome to ${currentServerName}!`,
      serverInfo: {
        name: currentServerName,
        tokenEnabled: serverState.tokenEnabled,
        entryFee: serverState.entryFee,
        gameId: serverState.gameId || dedicatedServerInfo?.gameId
      },
      serverIdentity: serverState.tokenService ? serverState.tokenService.getIdentity() : null
    };
    
    sendToClient(clientId, welcomeMsg);
    logger.debug(`Sent welcome message to client ${clientId} with entry fee: ${serverState.entryFee}`);
  }
}

/**
 * Handle proxy data from client
 */
async function handleProxyData(message) {
  const { clientId, data } = message;
  let client = serverState.clients.get(clientId);
  
  if (!client) {
    logger.warn(`Received data from unknown client: ${clientId}, creating temporary entry`);
    // Create a temporary client entry
    client = {
      id: clientId,
      connectionId: 'unknown',
      connected: true,
      pubkey: null,
      username: clientId,
      entryTokenReceived: false,
      score: 0
    };
    serverState.clients.set(clientId, client);
    logger.info(`Created temporary client entry for: ${clientId}`);
    displayStatus();
    
    // Send welcome message with server identity and entry fee requirements
    const welcomeMsg = {
      type: 'welcome',
      message: `Welcome to ${currentServerName}!`,
      serverInfo: {
        name: currentServerName,
        tokenEnabled: serverState.tokenEnabled,
        entryFee: serverState.entryFee,
        gameId: serverState.gameId || dedicatedServerInfo?.gameId
      },
      serverIdentity: serverState.tokenService ? serverState.tokenService.getIdentity() : null
    };
    
    sendToClient(clientId, welcomeMsg);
    logger.debug(`Sent welcome message to new client ${clientId} with entry fee: ${serverState.entryFee}`);
  }
  
  // Handle different message types
  if (data.type === 'identity') {
    // Client identity update
    client.pubkey = data.pubkey;
    client.username = data.username;
    logger.info(`Client ${clientId} identity updated: ${data.username}`);
    displayStatus();
    
    // Determine if client needs to pay entry fee
    if (serverState.tokenEnabled && !client.entryTokenReceived) {
      // Check if this is a rejoining client who already paid
      let alreadyPaid = false;
      for (const fee of serverState.collectedFees) {
        if (fee.pubkey === client.pubkey) {
          alreadyPaid = true;
          client.entryTokenReceived = true;
          break;
        }
      }
      
      if (!alreadyPaid) {
        // Send payment requirement to client
        const paymentReq = {
          type: 'payment_requirement',
          entryFee: serverState.entryFee,
          gameId: serverState.gameId || dedicatedServerInfo?.gameId,
          serverIdentity: serverState.tokenService ? serverState.tokenService.getIdentity() : null,
          message: `Entry fee required: ${serverState.entryFee} token(s)`,
          serverInfo: {
            paymentRequired: true,
            isRejoining: false,
            entryFee: serverState.entryFee
          }
        };
        
        sendToClient(clientId, paymentReq);
        logger.info(`Sent payment requirement to ${client.username}: ${serverState.entryFee} token(s)`);
      } else {
        // Client already paid, send confirmation
        const paymentConfirm = {
          type: 'payment_requirement',
          message: 'Welcome back! Your entry fee was already paid.',
          serverInfo: {
            paymentRequired: false,
            isRejoining: true,
            entryFee: 0
          }
        };
        
        sendToClient(clientId, paymentConfirm);
        logger.info(`Client ${client.username} rejoining - entry fee already paid`);
      }
    } else if (!serverState.tokenEnabled) {
      // Tokens disabled, allow free entry
      const freeEntry = {
        type: 'payment_requirement',
        message: 'No entry fee required - tokens are disabled',
        serverInfo: {
          paymentRequired: false,
          isRejoining: false,
          entryFee: 0
        }
      };
      
      sendToClient(clientId, freeEntry);
      logger.debug(`Client ${client.username} - no payment required (tokens disabled)`);
    }
    
  } else if (data.type === 'entry_token' || data.type === 'token:entry') {
    // Entry token received (handle both message type formats)
    if (!client.entryTokenReceived) {
      logger.info(`Entry token received from ${client.username}`);
      client.entryTokenReceived = true;
      serverState.collectedFees.push({
        clientId: clientId,
        pubkey: client.pubkey,
        token: data.token || data.tokenFlow // Support both token formats
      });
      logger.info(`Total entry fees collected: ${serverState.collectedFees.length}`);
      displayStatus();
      
      // Send confirmation to client
      sendToClient(clientId, {
        type: 'payment:confirmed',
        message: 'Entry fee received. Welcome to the game!'
      });
      
      // Broadcast chat message to all clients
      const chatMsg = {
        type: 'chat',
        from: 'SERVER',
        message: `${client.username || clientId} has paid the entry fee and joined the game!`,
        timestamp: Date.now()
      };
      broadcastToClients(chatMsg);
      logger.info(`[CHAT] SERVER: ${chatMsg.message}`);
    }
    
  } else if (data.type === 'chat') {
    // Chat message
    logger.info(`[CHAT] ${client.username}: ${data.message}`);
    // Broadcast to other clients
    broadcastToClients({
      type: 'chat',
      from: client.username,
      message: data.message
    }, clientId);
    
  } else if (data.type === 'game_state_token_request' || data.type === 'request:game:state:token') {
    // Client requesting current game state token (matching server.html)
    logger.debug(`Client ${clientId} requested game state token`);
    
    try {
      // Create a fresh token if we don't have one, or use existing
      if (!serverState.tokenService.lastStateToken) {
        await createGameStateToken(false);
      }
      
      if (serverState.tokenService.lastStateToken) {
        const tokenFlow = serverState.tokenService.TXF.exportFlow(serverState.tokenService.lastStateToken);
        
        const serverStateInfo = {
          playerCount: serverState.clients.size,
          itemCount: Object.keys(serverState.gameState?.items || {}).length,
          timestamp: Date.now()
        };
        
        // Send game state token to the requesting client
        sendToClient(clientId, {
          type: 'game:state:token',
          tokenFlow: tokenFlow,
          frame: serverState.gameState?.frame || 0,
          serverInfo: serverStateInfo
        });
        
        // Also send match time info with the token
        if (matchControl.isActive && !gameEnded) {
          const remaining = getRemainingTime();
          const timeText = formatRemainingTime(remaining);
          
          // Get highest score
          let highestScore = 0;
          if (latestPlayerScores.players && latestPlayerScores.players.length > 0) {
            highestScore = Math.max(...latestPlayerScores.players.map(p => p.score || 0));
          }
          
          sendToClient(clientId, {
            type: 'server:match:time',
            remainingTime: remaining,
            remainingText: timeText,
            highestScore: highestScore,
            fragLimit: MATCH_SETTINGS.FRAG_LIMIT,
            message: `Time: ${timeText} | Score: ${highestScore}/${MATCH_SETTINGS.FRAG_LIMIT}`
          });
        }
        
        logger.debug(`Sent game state token to client ${clientId}`);
        logger.debug(`[Token Send] Sent token to ${clientId} - GameId: "${serverState.gameState?.gameId || 'unknown'}", Frame: ${serverState.gameState?.frame || 0}`);
      } else {
        logger.warn(`No state token available for client ${clientId}`);
      }
    } catch (error) {
      logger.error(`Failed to send token to client ${clientId}:`, error.message);
    }
    
  } else if (data.type === 'game_state_hash') {
    // Client sending game state hash for verification
    logger.debug(`Received game state hash from ${client.username}: frame ${data.frame || 'unknown'}`);
    
  } else if (data.type === 'identity:update') {
    // Client identity update (alternative format)
    if (data.identity) {
      client.pubkey = data.identity.pubkey;
      client.username = data.identity.username;
      logger.info(`Client ${clientId} identity updated: ${data.identity.username}`);
      displayStatus();
      
      // Determine if client needs to pay entry fee (same logic as 'identity' type)
      if (serverState.tokenEnabled && !client.entryTokenReceived) {
        // Check if this is a rejoining client who already paid
        let alreadyPaid = false;
        for (const fee of serverState.collectedFees) {
          if (fee.pubkey === client.pubkey) {
            alreadyPaid = true;
            client.entryTokenReceived = true;
            break;
          }
        }
        
        if (!alreadyPaid) {
          // Send payment requirement to client
          const paymentReq = {
            type: 'payment_requirement',
            entryFee: serverState.entryFee,
            gameId: serverState.gameId || dedicatedServerInfo?.gameId,
            serverIdentity: serverState.tokenService ? serverState.tokenService.getIdentity() : null,
            message: `Entry fee required: ${serverState.entryFee} token(s)`,
            serverInfo: {
              paymentRequired: true,
              isRejoining: false,
              entryFee: serverState.entryFee
            }
          };
          
          sendToClient(clientId, paymentReq);
          logger.info(`Sent payment requirement to ${client.username}: ${serverState.entryFee} token(s)`);
        } else {
          // Client already paid, send confirmation
          const paymentConfirm = {
            type: 'payment_requirement',
            message: 'Welcome back! Your entry fee was already paid.',
            serverInfo: {
              paymentRequired: false,
              isRejoining: true,
              entryFee: 0
            }
          };
          
          sendToClient(clientId, paymentConfirm);
          logger.info(`Client ${client.username} rejoining - entry fee already paid`);
        }
      } else if (!serverState.tokenEnabled) {
        // Tokens disabled, allow free entry
        const freeEntry = {
          type: 'payment_requirement',
          message: 'No entry fee required - tokens are disabled',
          serverInfo: {
            paymentRequired: false,
            isRejoining: false,
            entryFee: 0
          }
        };
        
        sendToClient(clientId, freeEntry);
        logger.debug(`Client ${client.username} - no payment required (tokens disabled)`);
      }
    }
    
  } else if (data.type === 'score:request' || data.type === 'scores:request') {
    // Client requesting current scores and match info
    logger.debug(`Client ${clientId} requested scores`);
    
    // Send current player scores
    if (latestPlayerScores.players && latestPlayerScores.players.length > 0) {
      sendToClient(clientId, {
        type: 'score:response',
        players: latestPlayerScores.players,
        timestamp: latestPlayerScores.lastUpdate
      });
    }
    
    // Send match time info
    if (matchControl.isActive && !gameEnded) {
      const remaining = getRemainingTime();
      const timeText = formatRemainingTime(remaining);
      
      let highestScore = 0;
      if (latestPlayerScores.players && latestPlayerScores.players.length > 0) {
        highestScore = Math.max(...latestPlayerScores.players.map(p => p.score || 0));
      }
      
      sendToClient(clientId, {
        type: 'server:match:time',
        remainingTime: remaining,
        remainingText: timeText,
        highestScore: highestScore,
        fragLimit: MATCH_SETTINGS.FRAG_LIMIT,
        message: `Time: ${timeText} | Score: ${highestScore}/${MATCH_SETTINGS.FRAG_LIMIT}`
      });
    }
    
  } else if (data.type === 'ping') {
    // Client ping - respond with pong
    sendToClient(clientId, {
      type: 'pong',
      timestamp: Date.now()
    });
    
  } else {
    // Unknown message type
    logger.debug(`Unknown message type from client ${clientId}: ${data.type}`);
  }
}

/**
 * Handle client disconnection
 */
function handleClientDisconnected(message) {
  const { clientId } = message;
  const client = serverState.clients.get(clientId);
  
  if (client) {
    logger.info(`Client disconnected: ${client.username}`);
    // Remove the client from the map entirely
    serverState.clients.delete(clientId);
  }
  
  displayStatus();
}

/**
 * Broadcast message to all clients
 */
function broadcastToClients(message, excludeClientId = null) {
  for (const [clientId, client] of serverState.clients) {
    if (client.connected && clientId !== excludeClientId) {
      sendToClient(clientId, message);
    }
  }
}

/**
 * Start match control
 */
function startMatchControl() {
  if (matchControl.isActive) {
    logger.warn('Match control already active');
    return;
  }
  
  logger.info(`🎮 Starting match control: ${MATCH_SETTINGS.DURATION_MINUTES} minutes, ${MATCH_SETTINGS.FRAG_LIMIT} frag limit`);
  
  matchControl.isActive = true;
  matchControl.startTime = Date.now();
  gameEnded = false;
  
  // Start periodic time updates (every 5 seconds)
  matchControl.timeUpdateInterval = setInterval(() => {
    checkMatchEnd();
    broadcastMatchTimeUpdate();
  }, 5000);
  
  // Initial broadcast
  broadcastMatchTimeUpdate();
  
  logger.info(`✅ Match control started - will end in ${MATCH_SETTINGS.DURATION_MINUTES} minutes or at ${MATCH_SETTINGS.FRAG_LIMIT} frags`);
  
  // Also update the display to show match timer
  displayStatus();
}

/**
 * Stop match control
 */
function stopMatchControl() {
  if (!matchControl.isActive) {
    return;
  }
  
  logger.info('Stopping match control');
  
  if (matchControl.timeUpdateInterval) {
    clearInterval(matchControl.timeUpdateInterval);
    matchControl.timeUpdateInterval = null;
  }
  
  matchControl.isActive = false;
  matchControl.startTime = null;
}

/**
 * Get remaining time in milliseconds
 */
function getRemainingTime() {
  if (!matchControl.isActive || !matchControl.startTime) {
    return 0;
  }
  
  const elapsed = Date.now() - matchControl.startTime;
  const duration = MATCH_SETTINGS.DURATION_MINUTES * 60 * 1000;
  const remaining = Math.max(0, duration - elapsed);
  
  return remaining;
}

/**
 * Format remaining time as MM:SS
 */
function formatRemainingTime(ms) {
  const totalSeconds = Math.ceil(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

/**
 * Broadcast match time update to all clients
 */
function broadcastMatchTimeUpdate() {
  if (!matchControl.isActive || gameEnded) {
    return;
  }
  
  const remaining = getRemainingTime();
  const timeText = formatRemainingTime(remaining);
  
  // Get highest score
  let highestScore = 0;
  if (latestPlayerScores.players && latestPlayerScores.players.length > 0) {
    highestScore = Math.max(...latestPlayerScores.players.map(p => p.score || 0));
  }
  
  // Update server info with match time remaining
  if (serverConnection && serverConnection.readyState === WebSocket.OPEN && serverState.registered) {
    const updateMsg = {
      type: 'update_server',
      serverInfo: {
        matchTimeRemaining: Math.ceil(remaining / 1000), // Convert to seconds for client
        matchTimeText: timeText,
        highestScore: highestScore,
        fragLimit: MATCH_SETTINGS.FRAG_LIMIT
      }
    };
    serverConnection.send(JSON.stringify(updateMsg));
  }
  
  // Broadcast countdown update to connected clients
  const message = {
    type: 'server:match:time',
    remainingTime: remaining,
    remainingText: timeText,
    highestScore: highestScore,
    fragLimit: MATCH_SETTINGS.FRAG_LIMIT,
    message: `Time: ${timeText} | Score: ${highestScore}/${MATCH_SETTINGS.FRAG_LIMIT}`
  };
  
  logger.info(`📢 Broadcasting match time: ${timeText}, highest score: ${highestScore}/${MATCH_SETTINGS.FRAG_LIMIT}`);
  logger.debug('Match time message:', JSON.stringify(message));
  broadcastToClients(message);
}

/**
 * Check if match should end
 */
function checkMatchEnd() {
  if (!matchControl.isActive || gameEnded) {
    return;
  }
  
  // Check time limit
  const remaining = getRemainingTime();
  if (remaining <= 0) {
    logger.info('⏰ Match time limit reached!');
    handleAutomaticGameOver('timelimit');
    return;
  }
  
  // Check frag limit
  if (latestPlayerScores.players && latestPlayerScores.players.length > 0) {
    const highestScore = Math.max(...latestPlayerScores.players.map(p => p.score || 0));
    if (highestScore >= MATCH_SETTINGS.FRAG_LIMIT) {
      logger.info(`🎯 Frag limit reached! Player reached ${highestScore} frags`);
      handleAutomaticGameOver('fraglimit');
    }
  }
}

/**
 * Handle automatic game over (time or frag limit)
 */
async function handleAutomaticGameOver(reason) {
  if (gameEnded) {
    return;
  }
  
  logger.info(`🏁 Automatic game over triggered: ${reason}`);
  
  // Stop match control
  stopMatchControl();
  
  // Use existing game over logic
  await handleGameOver();
  
  // Broadcast match end to clients
  const endMessage = {
    type: 'match:end',
    reason: reason,
    reasonText: reason === 'timelimit' ? 'Time Limit Reached' : 'Frag Limit Reached',
    finalScores: latestPlayerScores.players
  };
  
  broadcastToClients(endMessage);
}

/**
 * Send message to specific client
 */
function sendToClient(clientId, message) {
  if (serverConnection && serverConnection.readyState === WebSocket.OPEN) {
    const proxyMsg = {
      type: 'proxy_data',
      clientId: clientId,
      data: message
    };
    serverConnection.send(JSON.stringify(proxyMsg));
  }
}

/**
 * Display current server status
 */
function displayStatus() {
  console.clear();
  console.log('=== UniQuake Server CLI ===\\n');
  
  console.log('Server Status:');
  console.log(`  Name: ${currentServerName}`);
  console.log(`  Registered: ${serverState.registered ? 'Yes' : 'No'}`);
  console.log(`  Master Server: ${serverConnection ? 'Connected' : 'Disconnected'}`);
  console.log(`  Dedicated Server: ${dedicatedServerInfo ? 'Running' : 'Not Running'}`);
  
  if (dedicatedServerInfo) {
    console.log(`  Game ID: ${dedicatedServerInfo.gameId}`);
    const host = dedicatedServerInfo.serverInfo.host || 'unknown';
    const port = dedicatedServerInfo.serverInfo.port || 'unknown';
    console.log(`  Address: ${host}:${port}`);
  }
  
  // Display match control status
  if (matchControl.isActive && !gameEnded) {
    console.log('\nMatch Control:');
    const remaining = getRemainingTime();
    const timeText = formatRemainingTime(remaining);
    console.log(`  Time Remaining: ${timeText}`);
    
    let highestScore = 0;
    if (latestPlayerScores.players && latestPlayerScores.players.length > 0) {
      highestScore = Math.max(...latestPlayerScores.players.map(p => p.score || 0));
    }
    console.log(`  Highest Score: ${highestScore} / ${MATCH_SETTINGS.FRAG_LIMIT}`);
  } else if (gameEnded) {
    console.log('\nMatch Control:');
    console.log('  Status: Match Ended');
  }
  
  // Count only connected clients
  let connectedCount = 0;
  for (const [clientId, client] of serverState.clients) {
    if (client.connected) {
      connectedCount++;
    }
  }
  
  console.log(`\\nConnected Clients: ${connectedCount}`);
  for (const [clientId, client] of serverState.clients) {
    if (client.connected) {
      console.log(`  - ${client.username} (${client.pubkey ? 'Authenticated' : 'Anonymous'})${client.entryTokenReceived ? ' [Paid]' : ''}`);
    }
  }
  
  console.log('\\nCommands:');
  console.log('  status - Show server status');
  console.log('  players - Show player statistics');
  console.log('  rcon <command> - Execute RCON command');
  console.log('  kick <player> - Kick a player');
  console.log('  say <message> - Send server message');
  console.log('  endmatch - End match and distribute rewards');
  console.log('  quit - Stop server and exit');
  console.log('');
}

/**
 * Display player statistics
 */
function displayPlayerStats(parsedStatus) {
  console.log('\\n=== Player Statistics ===');
  console.log(`Map: ${parsedStatus.map}`);
  console.log(`Players: ${parsedStatus.playerCount}\\n`);
  
  if (parsedStatus.players.length > 0) {
    console.log('Slot  Score  Ping  Name');
    console.log('----  -----  ----  ----');
    
    for (const player of parsedStatus.players) {
      const pingStr = player.isBot ? 'Bot' : player.ping.toString().padEnd(4);
      console.log(`${player.slot.toString().padEnd(4)}  ${player.score.toString().padEnd(5)}  ${pingStr}  ${player.name}`);
    }
  } else {
    console.log('No players connected');
  }
  
  console.log('');
}

/**
 * Handle game over
 */
async function handleGameOver() {
  logger.info('Manual game over initiated');
  
  try {
    // Get fresh scores
    await updatePlayerStatistics();
    
    // Mark game as ended
    gameEnded = true;
    
    // Broadcast game over message
    const gameOverMsg = {
      type: 'chat',
      from: 'SERVER',
      message: 'Game Over! Calculating final scores...',
      timestamp: Date.now()
    };
    broadcastToClients(gameOverMsg);
    logger.info(`[CHAT] SERVER: ${gameOverMsg.message}`);
    
    // Distribute rewards
    if (serverState.collectedFees.length > 0 && latestPlayerScores.players.length > 0) {
      logger.info('Distributing rewards to winners...');
      
      // Sort players by score
      const sortedPlayers = [...latestPlayerScores.players].sort((a, b) => b.score - a.score);
      
      // Check for ties
      const topScore = sortedPlayers[0].score;
      const winners = sortedPlayers.filter(p => p.score === topScore);
      const totalTokens = serverState.collectedFees.length * serverState.entryFee;
      
      if (winners.length === 1) {
        // Single winner
        const winner = winners[0];
        logger.info(`Winner: ${winner.name} with ${winner.score} frags`);
        
        // Broadcast winner chat message
        const winnerMsg = {
          type: 'chat',
          from: 'SERVER',
          message: `🏆 ${winner.name} wins ${totalTokens} tokens!`,
          timestamp: Date.now()
        };
        broadcastToClients(winnerMsg);
        logger.info(`[CHAT] SERVER: ${winnerMsg.message}`);
      } else {
        // Multiple winners (tie)
        const winnerNames = winners.map(w => w.name).join(', ');
        logger.info(`Tied winners: ${winnerNames} with ${topScore} frags each`);
        
        // Broadcast tie message
        const tieMsg = {
          type: 'chat',
          from: 'SERVER',
          message: `🏆 Tied winners ${winnerNames} split ${totalTokens} tokens!`,
          timestamp: Date.now()
        };
        broadcastToClients(tieMsg);
        logger.info(`[CHAT] SERVER: ${tieMsg.message}`);
      }
      
      // In a real implementation, this would use the token service
      // to distribute collected fees to the winner(s)
      logger.info(`Would distribute ${totalTokens} tokens to ${winners.length} winner(s)`);
    } else if (latestPlayerScores.players.length === 0) {
      // No players, no rewards to distribute
      logger.info('No players in game, no rewards to distribute');
    } else {
      // No entry fees collected
      logger.info('No entry fees collected, no rewards to distribute');
    }
    
    // Stop the dedicated server
    await stopServer();
    
  } catch (error) {
    logger.error('Error during game over:', error.message);
  }
}

/**
 * Stop dedicated server
 */
async function stopServer() {
  if (!dedicatedServerInfo) {
    logger.info('No dedicated server to stop');
    return;
  }
  
  logger.info('Stopping dedicated server...');
  
  const stopMsg = {
    unicity: true,
    type: 'stop_game_server',
    gameId: dedicatedServerInfo.gameId
  };
  
  if (serverConnection && serverConnection.readyState === WebSocket.OPEN) {
    serverConnection.send(JSON.stringify(stopMsg));
  }
}

/**
 * Set up readline interface for CLI commands
 */
function setupCLI() {
  rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: 'server> '
  });
  
  rl.on('line', async (line) => {
    const [command, ...args] = line.trim().split(' ');
    
    switch (command.toLowerCase()) {
      case 'status':
        displayStatus();
        break;
        
      case 'players':
        if (latestPlayerScores.players.length > 0) {
          displayPlayerStats(latestPlayerScores);
        } else {
          console.log('No player statistics available');
        }
        break;
        
      case 'rcon':
        if (args.length === 0) {
          console.log('Usage: rcon <command>');
        } else {
          try {
            const response = await sendRCONCommand(args.join(' '));
            console.log('RCON Response:\\n', response);
          } catch (error) {
            console.log('RCON Error:', error.message);
          }
        }
        break;
        
      case 'kick':
        if (args.length === 0) {
          console.log('Usage: kick <player name or slot>');
        } else {
          try {
            await sendRCONCommand(`kick ${args.join(' ')}`);
            console.log('Player kicked');
          } catch (error) {
            console.log('Kick failed:', error.message);
          }
        }
        break;
        
      case 'say':
        if (args.length === 0) {
          console.log('Usage: say <message>');
        } else {
          try {
            await sendRCONCommand(`say ${args.join(' ')}`);
          } catch (error) {
            console.log('Say failed:', error.message);
          }
        }
        break;
        
      case 'endmatch':
        await handleGameOver();
        break;
        
      case 'quit':
      case 'exit':
        await shutdown();
        break;
        
      case 'help':
        console.log('Available commands:');
        console.log('  status - Show server status');
        console.log('  players - Show player statistics');
        console.log('  rcon <command> - Execute RCON command');
        console.log('  kick <player> - Kick a player');
        console.log('  say <message> - Send server message');
        console.log('  endmatch - End match and distribute rewards');
        console.log('  quit - Stop server and exit');
        break;
        
      default:
        if (command) {
          console.log(`Unknown command: ${command}`);
        }
    }
    
    rl.prompt();
  });
  
  rl.on('close', () => {
    shutdown();
  });
}

/**
 * Graceful shutdown
 */
async function shutdown() {
  if (isExiting) return;
  isExiting = true;
  
  logger.info('Shutting down...');
  
  // Stop dedicated server
  await stopServer();
  
  // Unregister from master
  if (serverConnection && serverConnection.readyState === WebSocket.OPEN && serverState.registered) {
    serverConnection.send(JSON.stringify({
      type: 'unregister_server'
    }));
  }
  
  // Clear intervals
  if (serverState.heartbeatInterval) clearInterval(serverState.heartbeatInterval);
  if (serverState.gameStateInterval) clearInterval(serverState.gameStateInterval);
  if (serverState.updateStatsInterval) clearInterval(serverState.updateStatsInterval);
  
  // Stop match control
  stopMatchControl();
  
  // Close connections
  if (serverConnection) {
    serverConnection.close();
  }
  
  if (rl) {
    rl.close();
  }
  
  process.exit(0);
}

/**
 * Main entry point
 */
async function main() {
  const config = parseArguments();
  
  // Set current server name and config
  currentServerName = config.serverName;
  serverState.tokenEnabled = config.tokenEnabled;
  serverState.entryFee = config.entryFee;
  
  logger.info('Starting UniQuake Server CLI...');
  logger.info(`Server Name: ${config.serverName}`);
  logger.info(`Master Server: ${config.masterServer}`);
  logger.info(`Tokens: ${config.tokenEnabled ? 'Enabled' : 'Disabled'}`);
  
  try {
    // Initialize token service if tokens are enabled
    if (config.tokenEnabled) {
      logger.info('Initializing Unicity token service...');
      serverState.tokenService = new TokenService(null, `server-${currentServerName}`);
      serverState.tokenService.debugMode = config.debug;
      
      const initialized = await serverState.tokenService.init();
      if (initialized) {
        const identity = serverState.tokenService.getIdentity();
        logger.info(`Token service initialized for ${identity.username} (${identity.pubkey.substring(0, 8)}...)`);
        serverState.tokenEnabled = true;
        
        // Override BOTH hashGameState AND serializeGameState to match browser implementation exactly
        // This ensures tokens created by server CLI are identical to browser server tokens
        
        // First override serializeGameState to use minimal state (ONLY frame and gameId)
        serverState.tokenService.serializeGameState = function(gameState) {
          // EXACTLY match the browser's normalizeGameState() approach
          const minimalState = {
            frame: parseInt(gameState?.frame || 0, 10),
            gameId: String(gameState?.gameId || '')
          };
          
          // Simple JSON.stringify - no sorting needed with only 2 fields in fixed order
          const serialized = JSON.stringify(minimalState);
          
          // Log for debugging (matches browser's logging)
          if (this.debugMode) {
            logger.debug(`Serialized game state for hashing: ${serialized}`);
          }
          
          return serialized;
        };
        
        // Then override hashGameState to use TXF.getHashOf with string input
        serverState.tokenService.hashGameState = function(gameState) {
          // Use the overridden serializeGameState method
          const serialized = this.serializeGameState(gameState);
          
          // Use TXF.getHashOf() with the serialized STRING to match the browser exactly
          let hash;
          if (this.TXF) {
            // Pass the serialized JSON string, NOT an object
            hash = this.TXF.getHashOf(serialized);
            logger.debug(`[TokenService] TXF.getHashOf(${serialized}) = ${hash}`);
          } else {
            // Fallback if TXF not available (should not happen)
            const crypto = require('crypto');
            hash = crypto.createHash('sha256').update(serialized).digest('hex');
          }
          
          // Log for debugging (matches browser's logging)
          if (this.debugMode) {
            logger.debug(`Generated hash for frame ${gameState?.frame || 0}: ${hash}`);
          }
          
          // Always log the input when creating tokens to help debug
          logger.debug(`[TokenService] Hashing state - Frame: ${parseInt(gameState?.frame || 0, 10)}, GameId: "${String(gameState?.gameId || '')}", Hash: ${hash}`);
          
          return hash;
        };
        
        // ALSO override updateGameStateToken to include game_id in transaction message
        // This matches what UniQuakeTokenService does in the browser
        const originalUpdateGameStateToken = serverState.tokenService.updateGameStateToken.bind(serverState.tokenService);
        serverState.tokenService.updateGameStateToken = async function(stateToken, newState) {
          try {
            // Check if we should reset the token to prevent growth
            const currentFrame = newState.frame || 0;
            if (currentFrame > 0 && currentFrame % this.resetFrameInterval === 0) {
              logger.debug(`[TokenService] Resetting token at frame ${currentFrame} to prevent size growth`);
              return await this.resetGameStateToken(newState);
            }
            
            // Hash the new state
            const stateHash = this.hashGameState(newState);
            
            // Record state hash for performance tracking
            this.recordStateHash(currentFrame, stateHash);
            
            // Create a message with the new state hash - INCLUDING game_id like browser does!
            const message = {
              state_hash: stateHash,
              timestamp: Date.now(),
              frame: newState.frame || 0,
              game_id: newState.gameId || '', // THIS IS THE KEY DIFFERENCE!
              prev_hash: stateToken.tokenData?.state_hash
            };
            
            // Use the SDK's transaction creation
            logger.debug(`[TokenService] Creating transaction for token ${stateToken.tokenId}`);
            
            try {
              // Create a transaction to self
              const pubkeyAddr = this.TXF.generateRecipientPubkeyAddr(this.secret);
              
              // Generate data hash for the message
              const messageData = JSON.stringify(message);
              const dataHash = this.TXF.getHashOf(messageData);
              
              logger.debug(`[TokenService] Created data hash: ${dataHash.substring(0, 10)}...`);
              
              // Create transaction using SDK method with proper data hash
              const tx = await this.TXF.createTx(
                stateToken,
                pubkeyAddr,
                this.TXF.generateRandom256BitHex(), // salt
                this.secret,
                this.transport,
                dataHash, // proper data hash
                messageData // message data
              );
              
              logger.debug(`[TokenService] Transaction created, now exporting token flow with transaction`);
              
              // Export the token flow with the transaction
              const tokenFlow = this.TXF.exportFlow(stateToken, tx);
              
              // Import the token flow to get an updated token with the transaction applied
              const updatedToken = this.TXF.importFlow(tokenFlow, this.secret, null, messageData);
              
              this.debug(`[TokenService] Successfully imported updated token`);
              this.lastStateToken = updatedToken;
              this.debug(`[TokenService] Updated game state token with new state at frame ${newState.frame || 0}`);
              return updatedToken;
            } catch (txError) {
              logger.error(`[TokenService] Transaction error: ${txError.message}`);
              throw txError;
            }
          } catch (error) {
            logger.error(`[TokenService] Failed to update game state token:`, error.message);
            throw error;
          }
        };
        
        logger.debug('Overrode TokenService serialization, hash, and update methods for browser compatibility');
      } else {
        logger.warn('Token service initialization failed, continuing without tokens');
        serverState.tokenEnabled = false;
      }
    }
    
    // Connect to master server
    await connectToMasterServer(config);
    
    // Set up CLI interface
    setupCLI();
    
    // Display initial status
    displayStatus();
    
    // Start CLI prompt
    rl.prompt();
    
  } catch (error) {
    logger.error('Failed to start server:', error.message);
    process.exit(1);
  }
}

// Handle process signals
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('uncaughtException', (error) => {
  logger.error('Uncaught exception:', error);
  shutdown();
});

// Start the CLI
main();