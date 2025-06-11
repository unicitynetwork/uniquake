/**
 * Game Server Manager
 * Handles spawning and managing dedicated game server processes
 */

const childProcess = require('child_process');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const logger = require('winston');

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
      logsDirectory: config.logsDirectory || 'logs'
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
    
    // Build command line arguments exactly as specified, only modifying the port
    const args = [
      // Use the build/ioq3ded.js from fresh_quakejs
      'build/ioq3ded.js',
      '+set', 'fs_game', 'baseq3',
      '+set', 'dedicated', '2',
      '+set', 'sv_master1', `${this.config.masterServerHost}:${this.config.masterServerPort}`,
      '+set', 'net_port', port.toString(),
      '+set', 'net_ip', '0.0.0.0',
      '+exec', this.config.serverConfigPath
    ];

    logger.info(`Starting game server with command: node ${args.join(' ')}`);
    logger.info(`Launching dedicated server from ${freshQuakeJsPath} to use its dependencies`);

    try {
      
      const serverProcess = childProcess.spawn('node', args, {
        stdio: ['ignore', 'pipe', 'pipe'], // Redirect stdout and stderr
        detached: false, // Keep process attached for easier management
        cwd: freshQuakeJsPath // Set working directory to fresh_quakejs
      });

      // Capture stdout and stderr
      serverProcess.stdout.pipe(logStream);
      serverProcess.stderr.pipe(logStream);

      // Add server to tracking
      const serverInstance = {
        gameId,
        process: serverProcess,
        port,
        serverInfo: {
          name: serverName,
          address: `${this.config.masterServerHost}:${port}`,
          map: mapName,
          maxPlayers,
          private: !!serverInfo.private
        },
        logPath,
        logStream,
        startTime: Date.now(),
        lastActivity: Date.now(),
        players: [],
        state: 'starting'
      };

      this.servers.set(gameId, serverInstance);
      this.usedPorts.add(port);

      // Set up event handlers
      serverProcess.on('exit', (code, signal) => {
        this.handleServerExit(gameId, code, signal);
      });

      serverProcess.on('error', (err) => {
        logger.error(`Server ${gameId} process error:`, err);
        this.stopServer(gameId);
      });

      // Parse server output for status information
      serverProcess.stdout.on('data', (data) => {
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
      // Kill the server process
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

          server.process.once('exit', () => {
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
   * Clean up inactive servers
   * @param {number} timeout - Inactivity timeout in milliseconds
   */
  cleanupInactiveServers(timeout = 30 * 60 * 1000) { // Default 30 minutes
    const now = Date.now();
    
    for (const [gameId, server] of this.servers.entries()) {
      if (now - server.lastActivity > timeout) {
        logger.info(`Stopping inactive server ${gameId} (no activity for ${Math.floor(timeout/60000)} minutes)`);
        this.stopServer(gameId);
      }
    }
  }
}

module.exports = GameServerManager;