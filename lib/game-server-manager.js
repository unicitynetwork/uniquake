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

      // Capture all output for logging
      serverProcess.onData((data) => {
        logStream.write(data);
      });
      
      // Set up RCON response parsing from TTY output
      this.setupRCONParsingTTY(serverProcess, gameId);

      // Add server to tracking
      const serverInstance = {
        gameId,
        process: serverProcess,
        port,
        serverInfo: {
          name: serverName,
          address: `${this.config.gameServerIP}:${port}`,
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
          commandId: 0
        }
      };

      this.servers.set(gameId, serverInstance);
      this.usedPorts.add(port);

      // Set up event handlers for node-pty
      serverProcess.onExit((exitCode) => {
        this.handleServerExit(gameId, exitCode.exitCode, exitCode.signal);
      });

      // Parse server output for status information
      serverProcess.onData((data) => {
        this.parseServerOutput(gameId, data.toString());
      });

      // Wait a bit for the server to start up
      await new Promise(resolve => setTimeout(resolve, 1000));

      logger.info(`Game server ${gameId} started on port ${port}`);
      
      // Update server state
      serverInstance.state = 'running';
      this.servers.set(gameId, serverInstance);

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
    
    serverProcess.onData((data) => {
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
   * Process RCON response from server output
   * @param {string} gameId - Game ID
   * @param {string} line - Output line
   */
  processRCONResponse(gameId, line) {
    const server = this.servers.get(gameId);
    if (!server) return;

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
    
    server.rcon.recentOutput.push({
      timestamp: Date.now(),
      line: line
    });
    
    // Keep only last 50 lines
    if (server.rcon.recentOutput.length > 50) {
      server.rcon.recentOutput.shift();
    }
  }

  /**
   * Send RCON command to a server
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

    logger.info(`[RCON DEBUG] TTY Server process exists: ${!!server.process}, PID: ${server.process.pid}`);
    logger.info(`[RCON DEBUG] Process exitCode: ${server.process.exitCode}`);

    return new Promise((resolve, reject) => {
      const commandId = ++server.rcon.commandId;
      const timeout = 10000; // 10 second timeout

      // Clear recent output before sending command
      server.rcon.recentOutput = [];
      
      // Set up response handler
      const responseHandler = setTimeout(() => {
        // Collect all output received since command was sent
        const output = server.rcon.recentOutput
          .map(entry => entry.line)
          .join('\n');
        
        logger.info(`[RCON DEBUG] Command '${command}' returned ${server.rcon.recentOutput.length} lines of output`);
        logger.info(`[RCON DEBUG] Raw output: ${JSON.stringify(output)}`);
        
        resolve(output || 'Command executed (no output)');
      }, 1000); // Wait 1 second for response

      // Set up timeout
      const timeoutHandler = setTimeout(() => {
        clearTimeout(responseHandler);
        reject(new Error(`RCON command timeout after ${timeout}ms`));
      }, timeout);

      // Send command via TTY
      try {
        server.process.write(command + '\r');
        logger.info(`[RCON DEBUG] Sent TTY command to ${gameId}: ${command}`);
        
        // Store command info
        server.rcon.pendingCommands.set(commandId, {
          command,
          timestamp: Date.now(),
          responseHandler,
          timeoutHandler
        });
      } catch (error) {
        clearTimeout(responseHandler);
        clearTimeout(timeoutHandler);
        logger.error(`[RCON DEBUG] Failed to send TTY command: ${error.message}`);
        reject(new Error(`Failed to send RCON command: ${error.message}`));
      }
    });
  }

  /**
   * Get server status via direct RCON command
   * @param {string} gameId - Game ID
   * @returns {Promise<Object>} Parsed server status
   */
  async getRCONStatus(gameId) {
    const output = await this.sendRCONCommand(gameId, 'status');
    logger.info(`[RCON DEBUG] getRCONStatus raw output: "${output}"`);
    logger.info(`[RCON DEBUG] Output length: ${output.length}`);
    const parsed = this.parseStatusOutput(output);
    logger.info(`[RCON DEBUG] Parsed result: ${JSON.stringify(parsed)}`);
    return parsed;
  }

  /**
   * Get server info via direct RCON command
   * @param {string} gameId - Game ID
   * @returns {Promise<Object>} Parsed server info
   */
  async getRCONServerInfo(gameId) {
    const output = await this.sendRCONCommand(gameId, 'serverinfo');
    return this.parseServerInfoOutput(output);
  }

  /**
   * Parse status command output
   * @param {string} output - Raw status output
   * @returns {Object} Parsed status data
   */
  parseStatusOutput(output) {
    const lines = output.split('\n');
    const result = { map: null, players: [] };

    // Find map line
    const mapLine = lines.find(line => line.startsWith('map:'));
    if (mapLine) {
      result.map = mapLine.split(' ')[1];
    }

    // Find player data section
    let inPlayerData = false;
    let foundSeparator = false;
    
    for (const line of lines) {
      // Start of player data section
      if (line.includes('num score ping name')) {
        inPlayerData = true;
        foundSeparator = false;
        continue;
      }
      
      // Separator line (should be after header)
      if (inPlayerData && line.startsWith('---')) {
        foundSeparator = true;
        continue;
      }
      
      // End of player data section - empty line or non-player data
      if (inPlayerData && foundSeparator) {
        // If we hit an empty line, the player section is done
        if (!line.trim()) {
          inPlayerData = false;
          continue;
        }
        
        // Try to parse as player line - if it fails parsing, we've probably hit other server output
        const player = this.parsePlayerLine(line);
        if (player) {
          result.players.push(player);
        } else {
          // This line doesn't look like player data - end the player section
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
      // Validate line format - should be at least 40 characters and match basic pattern
      if (line.length < 40) return null;
      
      // First 3 characters should be client number (0-99)
      const numStr = line.substring(0, 3).trim();
      const num = parseInt(numStr);
      if (isNaN(num) || num < 0 || num >= 100) return null;
      
      // Next section should be score (5 chars)
      const scoreStr = line.substring(4, 9).trim();
      const score = parseInt(scoreStr);
      if (isNaN(score)) return null;
      
      // Next section should be ping (4 chars) - can be number or "999" for bots
      const pingStr = line.substring(10, 14).trim();
      if (!pingStr || (isNaN(parseInt(pingStr)) && pingStr !== '999')) return null;
      
      // Name section (15 chars starting at position 15)
      const name = line.substring(15, 30).trim().replace(/\^./g, ''); // Remove color codes
      if (!name) return null;
      
      // Last message time (7 chars starting at position 31)
      const lastmsgStr = line.substring(31, 38).trim();
      const lastmsg = parseInt(lastmsgStr);
      if (isNaN(lastmsg)) return null;
      
      // Find address and other fields (variable length after position 39)
      const remaining = line.substring(39).trim();
      const parts = remaining.split(/\s+/);
      
      if (parts.length < 3) return null;
      
      const address = parts[0];
      const qport = parseInt(parts[1]);
      const rate = parseInt(parts[2]);
      
      // Validate address format (should contain : or be valid IP)
      if (!address.includes(':') && !address.match(/^\d+\.\d+\.\d+\.\d+$/)) return null;
      
      // Validate qport and rate are numbers
      if (isNaN(qport) || isNaN(rate)) return null;

      return {
        clientSlot: num,
        score: score,
        ping: isNaN(parseInt(pingStr)) ? pingStr : parseInt(pingStr),
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