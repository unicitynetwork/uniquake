/**
 * Game Server Manager
 * Handles spawning and managing dedicated game server processes
 */

const childProcess = require('child_process');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const logger = require('winston');
const pty = require('node-pty');
const WSSProxy = require('./wss-proxy');
const envConfig = require('./config');

class GameServerManager {
  /**
   * Create a new game server manager
   * @param {Object} config - Configuration object
   * @param {string} config.dedicatedServerPath - Path to the dedicated server executable
   * @param {number} config.basePort - Base port number for dedicated servers
   * @param {number} config.maxConcurrentServers - Maximum number of concurrent servers
   * @param {string} config.masterServerHost - Host of the master server
   * @param {number} config.masterServerPort - Port of the master server
   */
  constructor(config = {}) {
    this.config = {
      dedicatedServerPath: config.dedicatedServerPath || path.resolve('build/ioq3ded.js'),
      basePort: config.basePort || 27961,  // Changed from 27960 to 27961
      maxConcurrentServers: config.maxConcurrentServers || 10,
      masterServerHost: config.masterServerHost || 'localhost',
      masterServerPort: config.masterServerPort || 27950,
      serverConfigPath: config.serverConfigPath || 'server.cfg',
      defaultMap: config.defaultMap || 'q3dm1',
      logsDirectory: config.logsDirectory || 'logs',
      gameServerIP: config.gameServerIP || 'localhost',  // IP address for game servers
      contentServerUrl: config.contentServerUrl || 'http://localhost:9000'  // Local content server URL
    };

    // Ensure logs directory exists
    if (!fs.existsSync(this.config.logsDirectory)) {
      fs.mkdirSync(this.config.logsDirectory, { recursive: true });
    }

    // Map gameId -> server instance data
    this.servers = new Map();

    // Track used ports
    this.usedPorts = new Set();

    logger.info('Game Server Manager initialized');
  }

  /**
   * Start a new dedicated server
   * @param {Object} serverInfo - Server info object
   * @param {string} serverInfo.name - Server name
   * @param {string} serverInfo.gameId - Unique game ID
   * @param {string} serverInfo.map - Map name
   * @param {number} serverInfo.maxPlayers - Maximum players
   * @param {boolean} serverInfo.private - Whether the server is private
   * @returns {Object} Server info or null if failed
   */
  async startServer(serverInfo) {
    // Validate input
    const gameId = serverInfo.gameId || uuidv4();
    
    // Check if we already have this game ID
    if (this.servers.has(gameId)) {
      logger.warn(`Attempted to start server with existing gameId: ${gameId}`);
      return null;
    }

    // Check if we've reached the maximum number of servers
    if (this.servers.size >= this.config.maxConcurrentServers) {
      logger.warn('Maximum number of concurrent servers reached');
      return null;
    }

    // Assign a port
    const port = this.getAvailablePort();
    if (!port) {
      logger.error('No available ports for new server');
      return null;
    }

    const serverName = serverInfo.name || `Server_${gameId.substring(0, 8)}`;
    const mapName = serverInfo.map || this.config.defaultMap;
    const maxPlayers = serverInfo.maxPlayers || 16;

    // Create log file path
    const logPath = path.join(this.config.logsDirectory, `${gameId}.log`);
    const logStream = fs.createWriteStream(logPath, { flags: 'a' });

    // Use the dedicated server from fresh_quakejs directly
    const freshQuakeJsPath = path.resolve(process.cwd(), 'fresh_quakejs');
    
    // Build command line arguments with local content server configuration
    const args = [
      // Use the build/ioq3ded.js from fresh_quakejs
      'build/ioq3ded.js',
      '+set', 'fs_game', 'baseq3',
      '+set', 'dedicated', '2',
      '+set', 'net_port', port.toString(),
      '+set', 'net_ip', this.config.gameServerIP,
      '+set', 'com_introplayed', '1', // Skip intro
      '+set', 'ttycon', '1', // Try to force TTY console mode
      '+set', 'com_basegame', 'baseq3', // Ensure base game is set
      '+set', 'sv_master1', '', // Disable external master server reporting
      '+set', 'com_hunkmegs', '128', // Allocate enough memory
      '+set', 'fs_cdn', this.config.gameServerIP + ':' + (this.config.contentServerUrl.split(':')[2] || '9000'), // Use local content server
      '+exec', this.config.serverConfigPath
    ];

    logger.info(`Starting game server with command: node ${args.join(' ')}`);
    logger.info(`Launching dedicated server from ${freshQuakeJsPath} to use its dependencies`);

    try {
      
      // Use node-pty to spawn the server with a real TTY
      const serverProcess = pty.spawn('node', args, {
        name: 'xterm-color',
        cols: 80,
        rows: 30,
        cwd: freshQuakeJsPath,
        env: {
          ...process.env,
          TERM: 'xterm-256color',
          FORCE_COLOR: '1'
        }
      });

      // Create WSS proxy if SSL is available
      let proxyPort = null;
      let wssProxy = null;
      
      if (envConfig.sslAvailable) {
        proxyPort = port + 1000; // Proxy ports are game port + 1000
        wssProxy = new WSSProxy({
          targetPort: port,
          targetHost: this.config.gameServerIP,
          proxyPort: proxyPort,
          sslCertPath: envConfig.sslCertPath,
          sslKeyPath: envConfig.sslKeyPath,
          gameId: gameId
        });
        
        try {
          await wssProxy.start();
          logger.info(`[Game ${gameId}] WSS proxy started on port ${proxyPort}`);
        } catch (err) {
          logger.error(`[Game ${gameId}] Failed to start WSS proxy:`, err.message);
          wssProxy = null;
          proxyPort = null;
        }
      }

      // Add server to tracking
      const serverInstance = {
        gameId,
        process: serverProcess,
        port,
        proxyPort, // WSS proxy port if available
        wssProxy, // WSS proxy instance
        serverInfo: {
          name: serverName,
          address: `${this.config.gameServerIP}:${port}`,
          proxyAddress: proxyPort ? `${this.config.gameServerIP}:${proxyPort}` : null,
          map: mapName,
          maxPlayers,
          private: !!serverInfo.private
        },
        logPath,
        logStream,
        startTime: Date.now(),
        lastActivity: Date.now(),
        players: [],
        state: 'starting',
        // RCON functionality
        rcon: {
          pendingCommands: new Map(), // requestId -> {resolve, reject, timestamp}
          commandId: 0,
          commandQueue: [], // Queue of commands waiting to be sent
          isProcessingQueue: false, // Flag to prevent concurrent queue processing
          continuousParsing: true, // Enable continuous parsing of server output
          lastStatusUpdate: 0,
          lineBuffer: [] // Buffer for accumulating lines
        },
        // Cached player data
        playerCache: {
          players: new Map(), // playerName -> player data
          lastUpdate: 0,
          ttl: 30000 // 30 seconds TTL
        }
      };

      this.servers.set(gameId, serverInstance);
      this.usedPorts.add(port);

      // Set up event handlers for node-pty
      serverProcess.onExit((exitCode) => {
        this.handleServerExit(gameId, exitCode.exitCode, exitCode.signal);
      });
      
      // Set up RCON parsing (which includes continuous parsing and logging)
      this.setupRCONParsingTTY(serverProcess, gameId);

      // Wait a bit for the server to start up
      await new Promise(resolve => setTimeout(resolve, 1000));

      logger.info(`Game server ${gameId} started on port ${port}`);
      
      // Update server state
      serverInstance.state = 'running';
      this.servers.set(gameId, serverInstance);

      // Start periodic status polling for this server
      this.startStatusPolling(gameId);

      return serverInstance;
    } catch (error) {
      logger.error(`Failed to start game server: ${error.message}`);
      this.releasePort(port);
      return null;
    }
  }

  /**
   * Stop a running server
   * @param {string} gameId - Game ID to stop
   * @returns {boolean} Success flag
   */
  async stopServer(gameId) {
    const server = this.servers.get(gameId);
    if (!server) {
      logger.warn(`Attempted to stop non-existent server: ${gameId}`);
      return false;
    }

    logger.info(`Stopping game server ${gameId}...`);

    try {
      // Kill the server process (node-pty)
      if (server.process) {
        server.process.kill();
        
        // Wait for the process to exit
        await new Promise(resolve => {
          // If the process doesn't exit within 5 seconds, force kill it
          const timeout = setTimeout(() => {
            try {
              server.process.kill('SIGKILL');
              logger.warn(`Force killed server process ${gameId}`);
            } catch (err) {
              // Process may have already exited
            }
            resolve();
          }, 5000);

          server.process.onExit(() => {
            clearTimeout(timeout);
            resolve();
          });
        });
      }

      // Stop WSS proxy if it exists
      if (server.wssProxy) {
        try {
          await server.wssProxy.stop();
          logger.info(`[Game ${gameId}] WSS proxy stopped`);
        } catch (err) {
          logger.error(`[Game ${gameId}] Error stopping WSS proxy:`, err.message);
        }
      }

      // Stop status polling
      this.stopStatusPolling(gameId);
      
      // Clear any pending RCON commands
      if (server.rcon && server.rcon.commandQueue) {
        server.rcon.commandQueue.forEach(item => {
          item.reject(new Error('Server is stopping'));
        });
        server.rcon.commandQueue = [];
      }
      
      // Clean up resources
      this.releasePort(server.port);
      
      if (server.logStream) {
        server.logStream.end();
      }

      this.servers.delete(gameId);
      logger.info(`Game server ${gameId} stopped`);
      
      return true;
    } catch (error) {
      logger.error(`Failed to stop game server ${gameId}: ${error.message}`);
      
      // Still remove from our tracking even if there was an error
      this.servers.delete(gameId);
      this.releasePort(server.port);
      
      return false;
    }
  }

  /**
   * Get the status of a running server
   * @param {string} gameId - Game ID to check
   * @returns {Object|null} Server status or null if not found
   */
  getServerStatus(gameId) {
    const server = this.servers.get(gameId);
    if (!server) return null;

    return {
      gameId: server.gameId,
      address: server.serverInfo.address,
      name: server.serverInfo.name,
      map: server.serverInfo.map,
      players: server.players.length,
      maxPlayers: server.serverInfo.maxPlayers,
      uptime: Math.floor((Date.now() - server.startTime) / 1000),
      state: server.state
    };
  }

  /**
   * Get all running servers
   * @returns {Array} List of server status objects
   */
  getAllServers() {
    const result = [];
    
    for (const [gameId, server] of this.servers.entries()) {
      result.push(this.getServerStatus(gameId));
    }
    
    return result;
  }

  /**
   * Terminate a server by its peer ID
   * @param {string} peerId - Peer ID of the server to terminate
   * @returns {Promise<boolean>} True if server was found and terminated
   */
  async terminateServerByPeerId(peerId) {
    // Find the server with the matching peer ID
    for (const [gameId, server] of this.servers.entries()) {
      if (server.peerId === peerId) {
        logger.info(`Terminating server ${gameId} with peer ID ${peerId} due to inactivity`);
        return await this.stopServer(gameId);
      }
    }
    
    logger.warn(`No server found with peer ID ${peerId} for termination`);
    return false;
  }

  /**
   * Associate a peer ID with a game server
   * @param {string} gameId - Game ID
   * @param {string} peerId - Peer ID from the signaling service
   * @returns {boolean} True if successful
   */
  setPeerIdForServer(gameId, peerId) {
    const server = this.servers.get(gameId);
    if (!server) {
      logger.warn(`Cannot set peer ID for non-existent server ${gameId}`);
      return false;
    }
    
    server.peerId = peerId;
    logger.info(`Associated peer ID ${peerId} with game server ${gameId}`);
    return true;
  }

  /**
   * Handle server process exit
   * @param {string} gameId - Game ID
   * @param {number} code - Exit code
   * @param {string} signal - Signal that caused exit
   * @private
   */
  handleServerExit(gameId, code, signal) {
    logger.info(`Game server ${gameId} exited with code ${code}, signal: ${signal}`);
    
    const server = this.servers.get(gameId);
    if (!server) return;

    // Update server state
    server.state = 'stopped';
    server.exitCode = code;
    server.exitSignal = signal;
    
    // Clean up resources after a short delay
    setTimeout(() => {
      this.cleanupServer(gameId);
    }, 5000);
  }

  /**
   * Clean up server resources
   * @param {string} gameId - Game ID
   * @private
   */
  cleanupServer(gameId) {
    const server = this.servers.get(gameId);
    if (!server) return;

    logger.info(`Cleaning up resources for game server ${gameId}`);

    // Close log stream
    if (server.logStream) {
      server.logStream.end();
    }

    // Release port
    this.releasePort(server.port);

    // Remove from tracking
    this.servers.delete(gameId);
  }

  /**
   * Parse server output to update status
   * @param {string} gameId - Game ID
   * @param {string} output - Server output
   * @private
   */
  parseServerOutput(gameId, output) {
    const server = this.servers.get(gameId);
    if (!server) return;

    // Update last activity
    server.lastActivity = Date.now();

    // Check for player count info - this is a simplified example
    const playerMatch = output.match(/(\d+) players/i);
    if (playerMatch) {
      const count = parseInt(playerMatch[1]);
      // Update player count in server info
      server.players = Array(count).fill({ dummy: true });
    }

    // Check for map change
    const mapMatch = output.match(/Loading map: (\w+)/i);
    if (mapMatch) {
      server.serverInfo.map = mapMatch[1];
    }

    // Look for player joins/leaves - this would need to be adapted to the actual server output format
    if (output.includes('connected')) {
      // Example: parse player name and add to player list
      // This is a placeholder - actual parsing depends on server output format
    }

    if (output.includes('disconnected')) {
      // Example: parse player name and remove from player list
      // This is a placeholder - actual parsing depends on server output format
    }
  }

  /**
   * Get an available port for a new server
   * @returns {number|null} Available port or null if none available
   * @private
   */
  getAvailablePort() {
    const basePort = this.config.basePort;
    
    for (let i = 0; i < this.config.maxConcurrentServers; i++) {
      const port = basePort + i;
      if (!this.usedPorts.has(port)) {
        return port;
      }
    }
    
    return null; // No available ports
  }

  /**
   * Release a port when server is stopped
   * @param {number} port - Port to release
   * @private
   */
  releasePort(port) {
    this.usedPorts.delete(port);
  }

  /**
   * Cleanup disconnected player from cache
   * @param {string} gameId - Game ID
   * @param {number} clientSlot - Client slot number
   */
  cleanupDisconnectedPlayer(gameId, clientSlot) {
    const server = this.servers.get(gameId);
    if (!server) return;
    
    // Find and remove player with matching client slot
    for (const [playerName, playerData] of server.playerCache.players.entries()) {
      if (playerData.clientSlot === clientSlot) {
        server.playerCache.players.delete(playerName);
        logger.info(`[CONTINUOUS] Removed disconnected player: ${playerName}`);
        break;
      }
    }
  }

  /**
   * Start periodic status polling for a server
   * @param {string} gameId - Game ID
   */
  startStatusPolling(gameId) {
    const server = this.servers.get(gameId);
    if (!server) return;
    
    // Clear any existing polling interval
    if (server.statusPollingInterval) {
      clearInterval(server.statusPollingInterval);
    }
    
    // Send initial status command to populate cache
    this.sendStatusCommand(gameId);
    
    // Poll status every 15 seconds to keep cache fresh
    server.statusPollingInterval = setInterval(() => {
      try {
        // Only poll if server is running
        if (server.state !== 'running') {
          clearInterval(server.statusPollingInterval);
          return;
        }
        
        logger.info(`[STATUS POLL] Triggering status command for server ${gameId}`);
        
        // Just send the status command - continuous parsing will update cache
        this.sendStatusCommand(gameId);
        
      } catch (error) {
        logger.warn(`[STATUS POLL] Failed to send status command for ${gameId}: ${error.message}`);
      }
    }, 15000); // Every 15 seconds
  }
  
  /**
   * Send status command without waiting for response
   * @param {string} gameId - Game ID
   */
  async sendStatusCommand(gameId) {
    const server = this.servers.get(gameId);
    if (!server || !server.process) return;
    
    try {
      // Send status command directly to TTY
      server.process.write('status\r');
      logger.debug(`[STATUS POLL] Sent status command to ${gameId}`);
    } catch (error) {
      logger.error(`[STATUS POLL] Failed to send status command: ${error.message}`);
    }
  }
  
  /**
   * Stop status polling for a server
   * @param {string} gameId - Game ID
   */
  stopStatusPolling(gameId) {
    const server = this.servers.get(gameId);
    if (server && server.statusPollingInterval) {
      clearInterval(server.statusPollingInterval);
      server.statusPollingInterval = null;
    }
  }

  /**
   * Shutdown all servers
   * @returns {Promise<boolean>} Success flag
   */
  async shutdownAllServers() {
    logger.info(`Shutting down all game servers (${this.servers.size} active)...`);
    
    const promises = [];
    
    for (const gameId of this.servers.keys()) {
      promises.push(this.stopServer(gameId));
    }
    
    await Promise.all(promises);
    
    return true;
  }

  /**
   * Read recent log lines from a server
   * @param {string} gameId - Game ID
   * @param {number} lines - Number of lines to read (default: 100)
   * @returns {Promise<string[]>} Array of log lines
   */
  async readServerLogs(gameId, lines = 100) {
    const server = this.servers.get(gameId);
    if (!server || !server.logPath) {
      return [];
    }

    try {
      // Check if log file exists
      if (!fs.existsSync(server.logPath)) {
        return [];
      }

      // Read the log file
      const content = await fs.promises.readFile(server.logPath, 'utf8');
      const allLines = content.split('\n');
      
      // Get the last N lines
      return allLines.slice(-lines);
    } catch (error) {
      logger.error(`Failed to read logs for server ${gameId}: ${error.message}`);
      return [];
    }
  }

  /**
   * Update last activity for a server (called when game state tokens are received)
   * @param {string} peerId - Server peer ID
   * @returns {boolean} True if successful
   */
  updateServerActivity(peerId) {
    // Find the server with the matching peer ID
    for (const [gameId, server] of this.servers.entries()) {
      if (server.peerId === peerId) {
        server.lastActivity = Date.now();
        return true;
      }
    }
    return false;
  }

  /**
   * Clean up inactive servers
   * @param {number} timeout - Inactivity timeout in milliseconds (default: 2 hours)
   */
  cleanupInactiveServers(timeout = 2 * 60 * 60 * 1000) { // Default 2 hours
    const now = Date.now();
    
    for (const [gameId, server] of this.servers.entries()) {
      if (now - server.lastActivity > timeout) {
        logger.info(`[SESSION TIMEOUT] Stopping server ${gameId} after ${Math.floor(timeout/60000)} minutes of inactivity`);
        this.stopServer(gameId);
      }
    }
  }

  /**
   * Set up RCON response parsing from server stdout
   * @param {ChildProcess} serverProcess - Server process
   * @param {string} gameId - Game ID
   */
  setupRCONParsing(serverProcess, gameId) {
    let buffer = '';
    
    serverProcess.stdout.on('data', (data) => {
      buffer += data.toString();
      
      // Process complete lines
      const lines = buffer.split('\n');
      buffer = lines.pop(); // Keep incomplete line in buffer
      
      for (const line of lines) {
        this.processRCONResponse(gameId, line);
      }
    });
  }

  /**
   * Set up RCON response parsing from TTY output
   * @param {IPty} serverProcess - TTY server process
   * @param {string} gameId - Game ID
   */
  setupRCONParsingTTY(serverProcess, gameId) {
    let buffer = '';
    const server = this.servers.get(gameId);
    if (!server) return;
    
    // Initialize RCON state tracking
    server.rcon.currentCommand = null;
    server.rcon.commandStartTime = null;
    server.rcon.responseBuffer = [];
    server.rcon.awaitingResponse = false;
    
    serverProcess.onData((data) => {
      // Write to log first
      if (server.logStream) {
        server.logStream.write(data);
      }
      
      const rawData = data.toString();
      buffer += rawData;
      
      // Process complete lines
      const lines = buffer.split('\n');
      buffer = lines.pop(); // Keep incomplete line in buffer
      
      for (const line of lines) {
        if (line.trim()) {
          // Debug log to see what lines we're getting
          if (line.includes('Player_') || line.includes('num score ping')) {
            // Show raw line with escape sequences visible
            const rawLine = line.replace(/[\x00-\x1F\x7F]/g, (char) => '\\x' + char.charCodeAt(0).toString(16).padStart(2, '0'));
            logger.debug(`[TTY] Raw line: "${rawLine}"`);
            logger.debug(`[TTY] Processing line: "${line}"`);
          }
          
          // Process all lines for continuous parsing
          this.processContinuousServerOutput(gameId, line);
          
          // Also process for RCON responses if awaiting
          if (server.rcon.awaitingResponse) {
            this.processRCONResponseLine(gameId, line);
          }
        }
      }
    });
  }
  
  /**
   * Process continuous server output for player data extraction
   * @param {string} gameId - Game ID
   * @param {string} line - Output line
   */
  processContinuousServerOutput(gameId, line) {
    const server = this.servers.get(gameId);
    if (!server) return;
    
    // Clean the line
    let cleanedLine = this.cleanServerOutputLine(line);
    if (!cleanedLine) return;
    
    // Update last activity
    server.lastActivity = Date.now();
    
    // Initialize parsing state if not exists
    if (!server.parsingState) {
      server.parsingState = {
        inPlayerTable: false,
        headerSeen: false,
        separatorSeen: false
      };
    }
    
    // Check for player table header
    if (cleanedLine.includes('num score ping name') && cleanedLine.includes('lastmsg address')) {
      logger.debug(`[CONTINUOUS] Player table header detected`);
      server.parsingState.inPlayerTable = true;
      server.parsingState.headerSeen = true;
      server.parsingState.separatorSeen = false;
      return;
    }
    
    // Check for separator line (dashes)
    if (server.parsingState.headerSeen && !server.parsingState.separatorSeen && cleanedLine.match(/^-+\s+-+\s+-+/)) {
      logger.debug(`[CONTINUOUS] Player table separator detected`);
      server.parsingState.separatorSeen = true;
      return;
    }
    
    // If we're in the player table and past the separator
    if (server.parsingState.inPlayerTable && server.parsingState.separatorSeen) {
      // Check for empty line (end of table)
      if (cleanedLine.length === 0) {
        logger.debug(`[CONTINUOUS] End of player table detected`);
        server.parsingState.inPlayerTable = false;
        server.parsingState.headerSeen = false;
        server.parsingState.separatorSeen = false;
        return;
      }
      
      // Try simplified parsing - just extract score and name
      // Look for pattern: digits (slot) digits (score) ... Player_XXX
      const simpleMatch = cleanedLine.match(/^\s*(\d+)\s+(-?\d+)\s+\d+\s+(\S+)/);
      if (simpleMatch) {
        const [, slotStr, scoreStr, nameRaw] = simpleMatch;
        
        // Clean up the name
        const name = nameRaw.replace(/\^./g, ''); // Remove color codes
        
        // Only process if name looks like a player name
        if (name && (name.startsWith('Player_') || name.match(/^\w+/))) {
          const playerData = {
            clientSlot: parseInt(slotStr),
            score: parseInt(scoreStr),
            name: name,
            timestamp: Date.now()
          };
          
          // Update player cache with minimal data
          server.playerCache.players.set(playerData.name, playerData);
          server.playerCache.lastUpdate = Date.now();
          
          logger.info(`[CONTINUOUS] Found player: ${playerData.name} (score: ${playerData.score})`);
        }
      } else {
        // Try even simpler pattern for corrupted lines
        // Look for any occurrence of "Player_XXX" and try to find score before it
        const playerMatch = cleanedLine.match(/(\d+)\s+(Player_\w+)/i);
        if (playerMatch) {
          const [, scoreStr, nameRaw] = playerMatch;
          const name = nameRaw.replace(/\^./g, '');
          
          const playerData = {
            clientSlot: 0, // Unknown slot
            score: parseInt(scoreStr),
            name: name,
            timestamp: Date.now()
          };
          
          server.playerCache.players.set(playerData.name, playerData);
          server.playerCache.lastUpdate = Date.now();
          
          logger.info(`[CONTINUOUS] Found player (fallback): ${playerData.name} (score: ${playerData.score})`);
        } else {
          logger.debug(`[CONTINUOUS] Could not parse player from line: "${cleanedLine}"`);
        }
      }
    }
    
    // Check for player connect/disconnect messages
    if (cleanedLine.includes('ClientConnect:')) {
      const connectMatch = cleanedLine.match(/ClientConnect:\s*(\d+)/);
      if (connectMatch) {
        logger.info(`[CONTINUOUS] Player connected to slot ${connectMatch[1]}`);
      }
    } else if (cleanedLine.includes('ClientDisconnect:')) {
      const disconnectMatch = cleanedLine.match(/ClientDisconnect:\s*(\d+)/);
      if (disconnectMatch) {
        logger.info(`[CONTINUOUS] Player disconnected from slot ${disconnectMatch[1]}`);
        // Remove disconnected players after a delay
        setTimeout(() => this.cleanupDisconnectedPlayer(gameId, parseInt(disconnectMatch[1])), 5000);
      }
    }
    
    // Check for map changes
    if (cleanedLine.startsWith('map:')) {
      const mapMatch = cleanedLine.match(/^map:\s*(\S+)/);
      if (mapMatch) {
        server.serverInfo.map = mapMatch[1];
        logger.info(`[CONTINUOUS] Map changed to: ${mapMatch[1]}`);
      }
    }
  }

  /**
   * Clean server output line by removing progress indicators
   * @param {string} line - Raw line from server
   * @returns {string} Cleaned line
   */
  cleanServerOutputLine(line) {
    // First, handle the raw line to preserve data before control char removal
    let workingLine = line;
    
    // Remove progress indicators (] and backspace sequences) from the beginning
    // Handle patterns like "]\b \b]\b \b" which are terminal cursor movements
    workingLine = workingLine.replace(/^(\]\x08\s*\x08)+/g, '');
    workingLine = workingLine.replace(/^\]+/g, '');
    
    // Remove ANSI escape sequences
    workingLine = workingLine.replace(/\x1b\[[0-9;]*m/g, ''); // Color codes
    workingLine = workingLine.replace(/\x1b\[[0-9;]*[A-Za-z]/g, ''); // Other sequences
    
    // Remove backspace characters and their effects
    while (workingLine.includes('\x08')) {
      // Replace "char\b " with empty (backspace overwrites previous char)
      workingLine = workingLine.replace(/.\x08\s/g, '');
      // Replace remaining backspaces
      workingLine = workingLine.replace(/\x08/g, '');
    }
    
    // Replace other control characters with spaces, but preserve structure
    workingLine = workingLine.replace(/[\x00-\x1F\x7F]/g, (char) => {
      // Keep newlines and tabs
      if (char === '\n' || char === '\t') return char;
      return ' ';
    });
    
    // Normalize multiple spaces to single space
    workingLine = workingLine.replace(/\s+/g, ' ');
    
    // Remove quotes that might corrupt the data
    workingLine = workingLine.replace(/"/g, '');
    
    // Final trim
    return workingLine.trim();
  }

  /**
   * Process a single line of RCON output with state tracking
   * @param {string} gameId - Game ID
   * @param {string} line - Output line
   */
  processRCONResponseLine(gameId, line) {
    const server = this.servers.get(gameId);
    if (!server) return;
    
    // For now, just log that we received a response line
    // The actual data extraction is handled by processContinuousServerOutput
    const cleanedLine = this.cleanServerOutputLine(line);
    if (cleanedLine && server.rcon.awaitingResponse) {
      logger.debug(`[RCON] Response line for ${server.rcon.currentCommand}: ${cleanedLine.substring(0, 50)}...`);
    }
  }

  /**
   * Process RCON response from server output
   * @param {string} gameId - Game ID
   * @param {string} line - Output line
   */
  processRCONResponse(gameId, line) {
    const server = this.servers.get(gameId);
    if (!server) return;
    
    // DEBUG: Log when we process a line
    if (line.includes('status') || line.includes('map:') || line.includes('num score ping')) {
      logger.info(`[RCON DEBUG] Processing line: "${line}"`);
    }

    // Check for command responses and resolve pending commands
    // For now, we'll use a simple approach - any output after sending a command
    // gets captured as the response. A more sophisticated approach would be needed
    // for concurrent commands.
    
    // Update last activity
    server.lastActivity = Date.now();
    
    // Store recent output for RCON responses
    if (!server.rcon.recentOutput) {
      server.rcon.recentOutput = [];
    }
    
    // Clean the line by removing progress indicators and extracting the actual content
    // Handle lines like "] ] ] ] ] ]status" by extracting everything after the last ]
    let cleanedLine = line;
    const lastBracketIndex = line.lastIndexOf(']');
    if (lastBracketIndex !== -1 && lastBracketIndex < line.length - 1) {
      cleanedLine = line.substring(lastBracketIndex + 1).trim();
    } else {
      cleanedLine = line.trim();
    }
    
    server.rcon.recentOutput.push({
      timestamp: Date.now(),
      line: cleanedLine
    });
    
    // Keep only last 50 lines
    if (server.rcon.recentOutput.length > 50) {
      server.rcon.recentOutput.shift();
    }
  }

  /**
   * Send RCON command to a server (legacy method for compatibility)
   * @param {string} gameId - Game ID
   * @param {string} command - Command to send
   * @returns {Promise<string>} Command response
   */
  async sendRCONCommand(gameId, command) {
    const server = this.servers.get(gameId);
    if (!server) {
      throw new Error(`Server ${gameId} not found`);
    }

    if (!server.process) {
      throw new Error(`Server ${gameId} does not have a process available`);
    }

    // For node-pty, check if the process is still alive
    if (server.process.exitCode !== undefined) {
      throw new Error(`Server ${gameId} process has already exited (exitCode: ${server.process.exitCode})`);
    }

    // For status and serverinfo, return cached data immediately
    if (command === 'status') {
      const status = await this.getRCONStatus(gameId);
      return JSON.stringify(status);
    } else if (command === 'serverinfo') {
      const info = await this.getRCONServerInfo(gameId);
      return JSON.stringify(info);
    }
    
    // For other commands, send directly without waiting
    try {
      server.process.write(command + '\r');
      logger.info(`[RCON] Sent command to ${gameId}: ${command}`);
      return 'Command sent';
    } catch (error) {
      throw new Error(`Failed to send RCON command: ${error.message}`);
    }
  }


  /**
   * Get server status from cache
   * @param {string} gameId - Game ID
   * @returns {Promise<Object>} Cached server status
   */
  async getRCONStatus(gameId) {
    const server = this.servers.get(gameId);
    if (!server) {
      throw new Error(`Server ${gameId} not found`);
    }
    
    // Check cache validity
    const cacheAge = Date.now() - server.playerCache.lastUpdate;
    if (cacheAge > server.playerCache.ttl) {
      logger.info(`[CACHE] Cache expired for ${gameId} (age: ${cacheAge}ms), triggering refresh`);
      // Trigger a status refresh but don't wait for it
      this.sendStatusCommand(gameId);
    }
    
    // Return cached data - simplified to just score and name
    const players = Array.from(server.playerCache.players.values());
    const result = {
      map: server.serverInfo.map,
      players: players.map(p => ({
        name: p.name,
        score: p.score
      })),
      cached: true,
      cacheAge: cacheAge,
      lastUpdate: server.playerCache.lastUpdate
    };
    
    logger.info(`[CACHE] Returning cached status for ${gameId}: ${players.length} players`);
    return result;
  }

  /**
   * Get server info from cache
   * @param {string} gameId - Game ID
   * @returns {Promise<Object>} Cached server info
   */
  async getRCONServerInfo(gameId) {
    const server = this.servers.get(gameId);
    if (!server) {
      throw new Error(`Server ${gameId} not found`);
    }
    
    // Return basic server info from cache
    return {
      map: server.serverInfo.map,
      name: server.serverInfo.name,
      address: server.serverInfo.address,
      maxPlayers: server.serverInfo.maxPlayers,
      players: server.playerCache.players.size,
      gameId: gameId,
      cached: true
    };
  }

  /**
   * Parse status command output
   * @param {string} output - Raw status output
   * @returns {Object} Parsed status data
   */
  parseStatusOutput(output) {
    const lines = output.split('\n').map(line => line.trim()).filter(line => line);
    const result = { map: null, players: [] };

    // Find map line
    const mapLine = lines.find(line => line.startsWith('map:'));
    if (mapLine) {
      const parts = mapLine.split(/\s+/);
      if (parts.length >= 2) {
        result.map = parts[1];
      }
    }

    // Find player data section
    let inPlayerData = false;
    let foundSeparator = false;
    
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      
      // Start of player data section
      if (line.includes('num score ping name')) {
        inPlayerData = true;
        foundSeparator = false;
        continue;
      }
      
      // Separator line (should be after header)
      if (inPlayerData && line.match(/^-+$/)) {
        foundSeparator = true;
        continue;
      }
      
      // Parse player data
      if (inPlayerData && foundSeparator) {
        // Check if this line looks like player data (starts with a number)
        if (line.match(/^\s*\d+\s+/)) {
          const player = this.parsePlayerLine(line);
          if (player) {
            // Check if we already have this player (deduplication)
            const exists = result.players.some(p => 
              p.clientSlot === player.clientSlot && 
              p.name === player.name &&
              p.address === player.address
            );
            
            if (!exists) {
              result.players.push(player);
            }
          }
        } else {
          // Line doesn't start with a number, we're done with players
          inPlayerData = false;
        }
      }
    }

    return result;
  }

  /**
   * Parse individual player line from status output
   * @param {string} line - Player status line
   * @returns {Object|null} Parsed player data
   */
  parsePlayerLine(line) {
    try {
      // Split by whitespace
      const parts = line.trim().split(/\s+/);
      
      // Need at least 8 parts: num, score, ping, name, lastmsg, address, qport, rate
      if (parts.length < 8) return null;
      
      // Parse client number
      const num = parseInt(parts[0]);
      if (isNaN(num) || num < 0 || num >= 100) return null;
      
      // Parse score
      const score = parseInt(parts[1]);
      if (isNaN(score)) return null;
      
      // Parse ping (can be number or text like "CNCT" or "ZMBI")
      const pingStr = parts[2];
      const ping = parseInt(pingStr);
      
      // Parse name (remove color codes)
      const name = parts[3].replace(/\^./g, '');
      if (!name) return null;
      
      // Parse last message time
      const lastmsg = parseInt(parts[4]);
      if (isNaN(lastmsg)) return null;
      
      // Parse address
      const address = parts[5];
      
      // Validate address format (should contain : or be valid IP or 'bot')
      if (address !== 'bot' && !address.includes(':') && !address.match(/^\d+\.\d+\.\d+\.\d+$/)) return null;
      
      // Parse qport
      const qport = parseInt(parts[6]);
      if (isNaN(qport)) return null;
      
      // Parse rate
      const rate = parseInt(parts[7]);
      if (isNaN(rate)) return null;

      return {
        clientSlot: num,
        score: score,
        ping: isNaN(ping) ? pingStr : ping,
        name: name,
        lastMessage: lastmsg,
        address: address,
        qport: qport,
        rate: rate
      };
    } catch (error) {
      logger.warn('Failed to parse player line:', line, error.message);
      return null;
    }
  }

  /**
   * Parse serverinfo command output
   * @param {string} output - Raw serverinfo output
   * @returns {Object} Parsed server info
   */
  parseServerInfoOutput(output) {
    const lines = output.split('\n');
    let infoString = '';
    
    // Find the info string (starts with backslash)
    for (const line of lines) {
      if (line.trim().startsWith('\\')) {
        infoString = line.trim();
        break;
      }
    }

    return this.parseInfoString(infoString);
  }

  /**
   * Parse Quake info string format (\key\value\key\value...)
   * @param {string} infoString - Info string to parse
   * @returns {Object} Parsed key-value pairs
   */
  parseInfoString(infoString) {
    const info = {};
    const parts = infoString.split('\\').filter(part => part.length > 0);
    
    for (let i = 0; i < parts.length; i += 2) {
      if (i + 1 < parts.length) {
        info[parts[i]] = parts[i + 1];
      }
    }
    
    return info;
  }
}

module.exports = GameServerManager;