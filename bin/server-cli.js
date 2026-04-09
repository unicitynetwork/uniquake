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
  gameStateInterval: null,
  restartCycle: null,
  gameId: null,
  playerScores: new Map(),
  heartbeatInterval: null,
  updateStatsInterval: null
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
  fragCheckInterval: null,
  scoreUpdateInterval: null
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
            address: 'ws-proxy'
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
  
  // Start match control
  startMatchControl();
  
  // Start periodic statistics updates
  startStatisticsUpdates();
  
  // Start player score and countdown updates even before match starts
  // This ensures clients always see the overlay (with "No Match" when inactive)
  if (!matchControl.scoreUpdateInterval) {
    matchControl.scoreUpdateInterval = setInterval(() => {
      sendPlayerScoresAndCountdown();
    }, 1000);
  }
  
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
  
  // Clear score update interval
  if (matchControl.scoreUpdateInterval) {
    clearInterval(matchControl.scoreUpdateInterval);
    matchControl.scoreUpdateInterval = null;
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
async function updatePlayerStatistics(forceUpdate = false) {
  if (!forceUpdate && (gameEnded || (serverState.restartCycle && serverState.restartCycle.active))) {
    return;
  }
  
  if (!dedicatedServerInfo) {
    logger.debug('No dedicated server running, skipping stats update');
    return;
  }
  
  try {
    // Get player status
    logger.info('Getting player status via RCON...');
    const statusResponse = await sendRCONCommand('status');
    logger.info(`RCON status raw response: ${statusResponse ? statusResponse.substring(0, 200) + '...' : 'null'}`);
    if (statusResponse) {
      const parsedStatus = parsePlayerStatusFromRCON(statusResponse);
      logger.info(`RCON status parsed: ${parsedStatus.players.length} players found`);
      logger.info(`Parsed players: ${JSON.stringify(parsedStatus.players)}`);
      
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
    } else {
      logger.warn('No response from RCON status command');
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
  // Try different line separators
  let lines = rconOutput.split('\\n');
  if (lines.length === 1) {
    // Try regular newline if escaped newline didn't work
    lines = rconOutput.split('\n');
  }
  
  logger.debug(`RCON output has ${lines.length} lines`);
  
  const players = [];
  let map = '';
  
  for (const line of lines) {
    logger.debug(`Parsing RCON line: ${line}`);
    // Extract map name
    if (line.includes('map:')) {
      const mapMatch = line.match(/map:\s*(\S+)/);
      if (mapMatch) {
        map = mapMatch[1];
      }
    }
    
    // Parse player lines (fixed-width format)
    const playerMatch = line.match(/^\s*(\d+)\s+(-?\d+)\s+(\d+|CNCT|ZMBI)\s+(.+?)\s+(\d+\.\d+\.\d+\.\d+:\d+|bot)/);
    if (playerMatch) {
      const [, slot, score, ping, name, address] = playerMatch;
      
      // Clean name (remove color codes)
      const cleanName = name.replace(/\^\d/g, '').trim();
      
      const player = {
        slot: parseInt(slot),
        name: cleanName,
        score: parseInt(score),
        ping: ping === 'CNCT' || ping === 'ZMBI' ? ping : parseInt(ping),
        address: address,
        isBot: address === 'bot' || parseInt(ping) === 999
      };
      
      logger.debug(`Parsed player: ${JSON.stringify(player)}`);
      players.push(player);
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
    
    // Send welcome message
    const welcomeMsg = {
      type: 'welcome',
      message: `Welcome to ${currentServerName}!`,
      serverInfo: {
        name: currentServerName,
        gameId: serverState.gameId || dedicatedServerInfo?.gameId
      }
    };

    sendToClient(clientId, welcomeMsg);
    logger.debug(`Sent welcome message to client ${clientId}`);
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
      score: 0
    };
    serverState.clients.set(clientId, client);
    logger.info(`Created temporary client entry for: ${clientId}`);
    displayStatus();

    // Send welcome message
    const welcomeMsg = {
      type: 'welcome',
      message: `Welcome to ${currentServerName}!`,
      serverInfo: {
        name: currentServerName,
        gameId: serverState.gameId || dedicatedServerInfo?.gameId
      }
    };

    sendToClient(clientId, welcomeMsg);
    logger.debug(`Sent welcome message to new client ${clientId}`);
  }
  
  // Handle different message types
  if (data.type === 'identity') {
    // Client identity update
    client.pubkey = data.pubkey;
    client.username = data.username;
    logger.info(`Client ${clientId} identity updated: ${data.username}`);
    displayStatus();

  } else if (data.type === 'chat') {
    // Chat message
    logger.info(`[CHAT] ${client.username}: ${data.message}`);
    // Broadcast to other clients
    broadcastToClients({
      type: 'chat',
      from: client.username,
      message: data.message
    }, clientId);

  } else if (data.type === 'identity:update') {
    // Client identity update (alternative format)
    if (data.identity) {
      client.pubkey = data.identity.pubkey;
      client.username = data.identity.username;
      logger.info(`Client ${clientId} identity updated: ${data.identity.username}`);
      displayStatus();
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
  
  // Player score and countdown updates are already running from handleGameServerStarted
  // No need to start them again here
  
  // Initial broadcasts
  broadcastMatchTimeUpdate();
  sendPlayerScoresAndCountdown();
  
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
  
  if (matchControl.scoreUpdateInterval) {
    clearInterval(matchControl.scoreUpdateInterval);
    matchControl.scoreUpdateInterval = null;
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
 * Send player scores and countdown to all clients (matches server.html format)
 */
function sendPlayerScoresAndCountdown() {
  // Always send updates, even when match is not active (for "No Match" state)
  
  // Prepare player scores array
  const playerScores = [];
  
  // Get scores from latest RCON data
  if (latestPlayerScores.players) {
    for (const player of latestPlayerScores.players) {
      playerScores.push({
        name: player.name,
        score: player.score,
        ping: player.ping,
        address: player.address
      });
    }
  }
  
  // Prepare countdown data based on match state
  let countdown;
  if (matchControl.isActive && !gameEnded) {
    // Match is active - send actual countdown
    const remaining = getRemainingTime();
    const totalSeconds = Math.ceil(remaining / 1000);
    const timeText = formatRemainingTime(remaining);
    
    countdown = {
      totalSeconds: totalSeconds,
      timeText: timeText,
      isActive: true
    };
  } else {
    // No active match
    countdown = {
      totalSeconds: 0,
      timeText: "0:00",
      isActive: false
    };
  }
  
  // Send player_score_update message to each connected client
  const updateMsg = {
    type: 'player_score_update',
    players: playerScores,
    countdown: countdown
  };
  
  // Send to all connected clients
  broadcastToClients(updateMsg);
  
  logger.debug(`Sent player score update with countdown: ${countdown.timeText} (${playerScores.length} players)`);
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
  
  // Use existing game over logic but skip match:end message (we'll send it below)
  await handleGameOver(true);
  
  // Determine winner from final scores
  let winner = null;
  if (latestPlayerScores.players && latestPlayerScores.players.length > 0) {
    // Sort by score descending
    const sortedPlayers = [...latestPlayerScores.players].sort((a, b) => b.score - a.score);
    winner = sortedPlayers[0];
  }
  
  // Broadcast match end to clients with full results
  const endMessage = {
    type: 'match:end',
    matchEndTime: Date.now(),
    matchEndReason: reason,
    reason: reason,
    reasonText: reason === 'timelimit' ? 'Time Limit Reached' : 'Frag Limit Reached',
    winner: winner,
    finalScores: latestPlayerScores.players ? [...latestPlayerScores.players].sort((a, b) => b.score - a.score) : []
  };
  
  logger.info(`📊 Final Scores:`);
  if (endMessage.finalScores.length > 0) {
    endMessage.finalScores.forEach((player, index) => {
      logger.info(`   ${index + 1}. ${player.name}: ${player.score} frags`);
    });
  } else {
    logger.info(`   No players in match`);
  }
  
  broadcastToClients(endMessage);
  
  // Give clients time to receive and display the results
  logger.info('⏳ Waiting 5 seconds for clients to display results...');
  await new Promise(resolve => setTimeout(resolve, 5000));
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
      console.log(`  - ${client.username} (${client.pubkey ? 'Authenticated' : 'Anonymous'})`);
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
 * @param {boolean} skipMatchEndMsg - Skip sending match:end message (used by handleAutomaticGameOver)
 */
async function handleGameOver(skipMatchEndMsg = false) {
  logger.info('Game over initiated');
  
  try {
    // Store current scores before attempting update
    const previousScores = latestPlayerScores.players ? [...latestPlayerScores.players] : [];
    
    // Try to get fresh scores (force update even if game was already marked as ended)
    try {
      // Add a small delay to ensure the game server has updated scores
      logger.info('Waiting 1 second for game server to update final scores...');
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      await updatePlayerStatistics(true);
      logger.info(`Updated player scores: ${latestPlayerScores.players?.length || 0} players`);
      
      // If no players found from RCON, try to build from connected clients
      if (!latestPlayerScores.players || latestPlayerScores.players.length === 0) {
        logger.warn('No players found from RCON, building from connected clients...');
        const connectedClients = [];
        for (const [clientId, client] of serverState.clients) {
          if (client.connected && client.username) {
            connectedClients.push({
              name: client.username,
              score: client.score || 0,
              ping: 0,
              slot: connectedClients.length
            });
          }
        }
        if (connectedClients.length > 0) {
          logger.info(`Built scores from ${connectedClients.length} connected clients`);
          latestPlayerScores.players = connectedClients;
          latestPlayerScores.lastUpdate = Date.now();
        }
      }
    } catch (error) {
      logger.warn('Failed to get fresh scores, using previous scores:', error.message);
      // Restore previous scores if update failed
      if (previousScores.length > 0) {
        latestPlayerScores.players = previousScores;
      }
    }
    
    // Mark game as ended
    gameEnded = true;
    
    // Send one final score update with match ended status
    const finalScoreUpdate = {
      type: 'player_score_update',
      players: latestPlayerScores.players || [],
      countdown: {
        totalSeconds: 0,
        timeText: "0:00",
        isActive: false
      },
      matchEnded: true,
      timestamp: Date.now()
    };
    broadcastToClients(finalScoreUpdate);
    logger.info('Sent final score update to all clients');
    
    // Broadcast game over message
    const gameOverMsg = {
      type: 'chat',
      from: 'SERVER',
      message: 'Game Over! Calculating final scores...',
      timestamp: Date.now()
    };
    broadcastToClients(gameOverMsg);
    logger.info(`[CHAT] SERVER: ${gameOverMsg.message}`);
    
    // Send match:end message if not called from handleAutomaticGameOver
    if (!skipMatchEndMsg) {
      logger.info(`Preparing match:end message. Player count: ${latestPlayerScores.players?.length || 0}`);
      
      // Ensure we have some player data to show
      let finalScores = latestPlayerScores.players || [];
      
      // If still no scores, create placeholder data from connected clients
      if (finalScores.length === 0) {
        logger.warn('No player scores available, creating placeholder data from connected clients');
        for (const [clientId, client] of serverState.clients) {
          if (client.connected && client.username && client.username !== clientId) {
            finalScores.push({
              name: client.username,
              score: 0,
              ping: 0,
              slot: finalScores.length
            });
          }
        }
        logger.info(`Created ${finalScores.length} placeholder entries`);
      }
      
      const matchEndMsg = {
        type: 'match:end',
        winner: finalScores.length > 0 ? 
          finalScores.reduce((prev, current) => 
            (prev.score > current.score) ? prev : current
          ) : null,
        finalScores: finalScores,
        matchEndReason: 'manual',
        reasonText: 'Match ended manually',
        matchEndTime: Date.now()
      };
      
      logger.info(`Sending match:end with ${matchEndMsg.finalScores.length} players`);
      if (matchEndMsg.finalScores.length > 0) {
        matchEndMsg.finalScores.forEach((player, index) => {
          logger.info(`  ${index + 1}. ${player.name}: ${player.score} frags`);
        });
      }
      
      logger.info(`Broadcasting match:end message to ${serverState.clients.size} clients`);
      logger.info(`Match:end message structure: ${JSON.stringify(matchEndMsg, null, 2)}`);
      
      let sentCount = 0;
      for (const [clientId, client] of serverState.clients) {
        if (client.connected) {
          logger.info(`Sending match:end to client ${clientId} (${client.username})`);
          sendToClient(clientId, matchEndMsg);
          sentCount++;
        }
      }
      
      logger.info(`Sent match:end message to ${sentCount} connected clients`);
    }
    
    // Log match results
    if (latestPlayerScores.players.length > 0) {
      // Sort players by score
      const sortedPlayers = [...latestPlayerScores.players].sort((a, b) => b.score - a.score);

      // Check for ties
      const topScore = sortedPlayers[0].score;
      const winners = sortedPlayers.filter(p => p.score === topScore);

      if (winners.length === 1) {
        const winner = winners[0];
        logger.info(`Winner: ${winner.name} with ${winner.score} frags`);

        const winnerMsg = {
          type: 'chat',
          from: 'SERVER',
          message: `${winner.name} wins the match!`,
          timestamp: Date.now()
        };
        broadcastToClients(winnerMsg);
        logger.info(`[CHAT] SERVER: ${winnerMsg.message}`);
      } else {
        const winnerNames = winners.map(w => w.name).join(', ');
        logger.info(`Tied winners: ${winnerNames} with ${topScore} frags each`);

        const tieMsg = {
          type: 'chat',
          from: 'SERVER',
          message: `Tied winners: ${winnerNames}!`,
          timestamp: Date.now()
        };
        broadcastToClients(tieMsg);
        logger.info(`[CHAT] SERVER: ${tieMsg.message}`);
      }
    } else {
      logger.info('No players in game at match end');
    }
    
    // Debug: Log the final scores being sent
    logger.info(`Final scores for match:end message:`);
    if (latestPlayerScores.players && latestPlayerScores.players.length > 0) {
      latestPlayerScores.players.forEach((player, index) => {
        logger.info(`  ${index + 1}. ${player.name}: ${player.score} frags`);
      });
    } else {
      logger.info('  No player scores available!');
    }
    
    // Stop the dedicated server
    await stopServer();
    
    // Terminate the server-cli process after match ends
    logger.info('Match completed. Shutting down server-cli...');
    logger.info('⏳ Waiting 3 seconds before shutdown...');
    setTimeout(() => {
      shutdown();
    }, 3000); // Give 3 seconds for final messages to be sent
    
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
        logger.info('Manual endmatch command received');
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

  logger.info('Starting UniQuake Server CLI...');
  logger.info(`Server Name: ${config.serverName}`);
  logger.info(`Master Server: ${config.masterServer}`);

  try {
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