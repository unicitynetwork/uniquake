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
  collectedFees: [],
  gameStateInterval: null,
  restartCycle: null,
  gameId: null,
  gameState: {
    gameId: `game-${Date.now()}`,
    frame: 0,
    timestamp: Date.now(),
    players: {},
    items: []
  },
  playerScores: new Map(),
  heartbeatInterval: null,
  updateStatsInterval: null
};

// Latest player scores from RCON
let latestPlayerScores = {
  players: [],
  lastUpdate: null
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
      
      // Start game state tokens if enabled
      if (serverState.tokenEnabled) {
        startGameStateTokens();
      }
      
      // Start dedicated server
      startRemoteServer();
      break;
      
    case 'connection_request':
      handleConnectionRequest(message);
      break;
      
    case 'proxy_data':
      handleProxyData(message);
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
  
  // Create and broadcast tokens every 10 seconds
  serverState.gameStateInterval = setInterval(() => {
    createGameStateToken(true);
  }, 10000);
}

/**
 * Create game state token
 */
async function createGameStateToken(broadcast = true) {
  // Increment frame counter
  serverState.gameState.frame++;
  serverState.gameState.timestamp = Date.now();
  
  // Update player list from connected clients
  serverState.gameState.players = {};
  for (const [clientId, client] of serverState.clients) {
    if (client.pubkey) {
      serverState.gameState.players[client.pubkey] = {
        name: client.username,
        score: client.score || 0,
        health: 100,
        armor: 0,
        weapon: 5,
        ammo: 10,
        position: { x: 0, y: 0, z: 0 },
        velocity: { x: 0, y: 0, z: 0 }
      };
    }
  }
  
  // Reset token every 10 frames to prevent growth
  const shouldResetToken = serverState.gameState.frame % 10 === 0;
  
  if (shouldResetToken) {
    logger.debug('Resetting game state token at frame', serverState.gameState.frame);
    // Create fresh token (implementation would depend on token service)
  }
  
  // Broadcast to clients if requested
  if (broadcast && serverState.clients.size > 0) {
    const tokenMessage = {
      type: 'game:state:token',
      gameId: serverState.gameId,
      frame: serverState.gameState.frame,
      timestamp: serverState.gameState.timestamp,
      token: serverState.gameState // Simplified for now
    };
    
    broadcastToClients(tokenMessage);
  }
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
 * Handle proxy data from client
 */
function handleProxyData(message) {
  const { clientId, data } = message;
  const client = serverState.clients.get(clientId);
  
  if (!client) {
    logger.warn(`Received data from unknown client: ${clientId}`);
    return;
  }
  
  // Handle different message types
  if (data.type === 'identity') {
    // Client identity update
    client.pubkey = data.pubkey;
    client.username = data.username;
    logger.info(`Client ${clientId} identity updated: ${data.username}`);
    
  } else if (data.type === 'entry_token') {
    // Entry token received
    if (!client.entryTokenReceived) {
      logger.info(`Entry token received from ${client.username}`);
      client.entryTokenReceived = true;
      serverState.collectedFees.push({
        clientId: clientId,
        pubkey: client.pubkey,
        token: data.token
      });
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
    
  } else if (data.type === 'game_state_token_request') {
    // Client requesting current game state token
    createGameStateToken(false).then(() => {
      sendToClient(clientId, {
        type: 'game:state:token',
        gameId: serverState.gameId,
        frame: serverState.gameState.frame,
        timestamp: serverState.gameState.timestamp,
        token: serverState.gameState
      });
    });
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
    client.connected = false;
    // Keep client in map for potential rejoin
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
    console.log(`  Address: ${dedicatedServerInfo.serverInfo.host}:${dedicatedServerInfo.serverInfo.port}`);
  }
  
  console.log(`\\nConnected Clients: ${serverState.clients.size}`);
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
    
    // Distribute rewards
    if (serverState.collectedFees.length > 0 && latestPlayerScores.players.length > 0) {
      logger.info('Distributing rewards to winners...');
      
      // Sort players by score
      const sortedPlayers = [...latestPlayerScores.players].sort((a, b) => b.score - a.score);
      
      // Simple winner determination (highest score)
      const winner = sortedPlayers[0];
      logger.info(`Winner: ${winner.name} with ${winner.score} frags`);
      
      // In a real implementation, this would use the token service
      // to distribute collected fees to the winner
      logger.info(`Would distribute ${serverState.collectedFees.length} entry fees to winner`);
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
  
  // Set current server name
  currentServerName = config.serverName;
  
  logger.info('Starting UniQuake Server CLI...');
  logger.info(`Server Name: ${config.serverName}`);
  logger.info(`Master Server: ${config.masterServer}`);
  logger.info(`Tokens: ${config.tokenEnabled ? 'Enabled' : 'Disabled'}`);
  
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