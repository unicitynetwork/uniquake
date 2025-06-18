/**
 * QuakeJS RCON Service
 * Provides RCON-like functionality for QuakeJS dedicated servers
 * Since QuakeJS servers don't support direct console input, we implement
 * RCON through process management and log parsing
 */

const fs = require('fs');
const path = require('path');
const logger = require('winston');

class QuakeJSRCON {
  constructor(gameServerManager) {
    this.gameServerManager = gameServerManager;
    this.logParsers = new Map(); // gameId -> log parser state
  }

  /**
   * Execute an RCON command on a QuakeJS server
   * @param {string} gameId - Game server ID
   * @param {string} command - Command to execute
   * @returns {Promise<Object>} Command result
   */
  async executeCommand(gameId, command) {
    const server = this.gameServerManager.servers.get(gameId);
    if (!server) {
      throw new Error(`Server ${gameId} not found`);
    }

    const [cmd, ...args] = command.split(' ');
    
    switch (cmd.toLowerCase()) {
      case 'status':
        return this.getServerStatus(gameId);
      
      case 'kick':
        return this.kickPlayer(gameId, args[0]);
      
      case 'say':
        return this.sayMessage(gameId, args.join(' '));
      
      case 'map':
        return this.changeMap(gameId, args[0]);
      
      case 'map_restart':
        return this.restartMap(gameId);
      
      case 'killserver':
        return this.killServer(gameId);
      
      case 'serverinfo':
        return this.getServerInfo(gameId);
      
      case 'players':
        return this.getPlayers(gameId);
        
      default:
        throw new Error(`Command '${cmd}' not supported. Available: status, kick, say, map, map_restart, killserver, serverinfo, players`);
    }
  }

  /**
   * Get current server status by parsing logs
   * @param {string} gameId - Game server ID
   * @returns {Promise<Object>} Server status
   */
  async getServerStatus(gameId) {
    const server = this.gameServerManager.servers.get(gameId);
    if (!server) {
      throw new Error(`Server ${gameId} not found`);
    }

    // Parse recent log entries for player connections and game state
    const players = await this.parsePlayersFromLogs(gameId);
    
    return {
      gameId,
      name: server.serverInfo.name,
      map: server.serverInfo.map,
      address: server.serverInfo.address,
      maxPlayers: server.serverInfo.maxPlayers,
      currentPlayers: players.length,
      players: players,
      uptime: Math.floor((Date.now() - server.startTime) / 1000),
      state: server.state,
      lastActivity: server.lastActivity
    };
  }

  /**
   * Parse players from server logs
   * @param {string} gameId - Game server ID
   * @returns {Promise<Array>} List of connected players
   */
  async parsePlayersFromLogs(gameId) {
    const server = this.gameServerManager.servers.get(gameId);
    if (!server || !server.logPath) {
      return [];
    }

    try {
      // Read the last 100 lines of the log file
      const logContent = await this.readLastLines(server.logPath, 100);
      const players = [];
      const playerMap = new Map();

      // Parse log entries for player events
      const lines = logContent.split('\n');
      for (const line of lines) {
        // Look for client connect/disconnect patterns
        if (line.includes('ClientConnect:')) {
          const match = line.match(/ClientConnect:\s*(\d+)/);
          if (match) {
            const clientId = match[1];
            playerMap.set(clientId, { clientId, connected: true, name: `Player${clientId}` });
          }
        }
        
        if (line.includes('ClientUserinfoChanged:')) {
          const match = line.match(/ClientUserinfoChanged:\s*(\d+).*\\name\\([^\\]+)/);
          if (match) {
            const clientId = match[1];
            const name = match[2];
            if (playerMap.has(clientId)) {
              playerMap.get(clientId).name = name;
            }
          }
        }
        
        if (line.includes('ClientDisconnect:')) {
          const match = line.match(/ClientDisconnect:\s*(\d+)/);
          if (match) {
            const clientId = match[1];
            playerMap.delete(clientId);
          }
        }
      }

      // Convert to array
      for (const player of playerMap.values()) {
        if (player.connected) {
          players.push({
            clientSlot: parseInt(player.clientId),
            name: player.name,
            score: 0, // Would need to parse from game logs
            ping: 0   // Would need to parse from game logs
          });
        }
      }

      return players;
    } catch (error) {
      logger.warn(`Failed to parse players from logs for ${gameId}:`, error.message);
      return [];
    }
  }

  /**
   * Kick a player (restart server without that player - limitation of current approach)
   * @param {string} gameId - Game server ID
   * @param {string} playerIdentifier - Player name or client ID
   * @returns {Promise<Object>} Command result
   */
  async kickPlayer(gameId, playerIdentifier) {
    // Since we can't send commands directly to QuakeJS server,
    // this would require a more sophisticated approach like:
    // 1. Modifying server config to ban the player
    // 2. Restarting the server
    // For now, return a message indicating limitation
    
    return {
      success: false,
      message: `Direct kick not available. Player ${playerIdentifier} kick requires server restart with modified configuration.`,
      suggestion: 'Use killserver and restart with ban list to effectively kick players'
    };
  }

  /**
   * Send a say message (not directly possible, return status)
   * @param {string} gameId - Game server ID
   * @param {string} message - Message to send
   * @returns {Promise<Object>} Command result
   */
  async sayMessage(gameId, message) {
    return {
      success: false,
      message: 'Direct say messages not available in current QuakeJS implementation',
      suggestion: 'Use web interface or modify server MOTD for player communication'
    };
  }

  /**
   * Change map by restarting server with new map
   * @param {string} gameId - Game server ID
   * @param {string} mapName - New map name
   * @returns {Promise<Object>} Command result
   */
  async changeMap(gameId, mapName) {
    const server = this.gameServerManager.servers.get(gameId);
    if (!server) {
      throw new Error(`Server ${gameId} not found`);
    }

    try {
      // Stop current server
      await this.gameServerManager.stopServer(gameId);
      
      // Start new server with different map
      const newGameId = await this.gameServerManager.startServer({
        name: server.serverInfo.name,
        map: mapName,
        maxPlayers: server.serverInfo.maxPlayers,
        private: server.serverInfo.private
      });

      return {
        success: true,
        message: `Server restarted with map ${mapName}`,
        newGameId: newGameId,
        oldGameId: gameId
      };
    } catch (error) {
      throw new Error(`Failed to change map: ${error.message}`);
    }
  }

  /**
   * Restart current map
   * @param {string} gameId - Game server ID
   * @returns {Promise<Object>} Command result
   */
  async restartMap(gameId) {
    const server = this.gameServerManager.servers.get(gameId);
    if (!server) {
      throw new Error(`Server ${gameId} not found`);
    }

    return this.changeMap(gameId, server.serverInfo.map);
  }

  /**
   * Kill server
   * @param {string} gameId - Game server ID
   * @returns {Promise<Object>} Command result
   */
  async killServer(gameId) {
    try {
      const success = await this.gameServerManager.stopServer(gameId);
      return {
        success: success,
        message: success ? `Server ${gameId} stopped` : `Failed to stop server ${gameId}`
      };
    } catch (error) {
      throw new Error(`Failed to kill server: ${error.message}`);
    }
  }

  /**
   * Get server info
   * @param {string} gameId - Game server ID
   * @returns {Promise<Object>} Server info
   */
  async getServerInfo(gameId) {
    const server = this.gameServerManager.servers.get(gameId);
    if (!server) {
      throw new Error(`Server ${gameId} not found`);
    }

    return {
      gameId,
      serverInfo: server.serverInfo,
      uptime: Math.floor((Date.now() - server.startTime) / 1000),
      state: server.state,
      logPath: server.logPath,
      process: {
        pid: server.process.pid,
        connected: server.process.connected
      }
    };
  }

  /**
   * Get connected players
   * @param {string} gameId - Game server ID
   * @returns {Promise<Object>} Players list
   */
  async getPlayers(gameId) {
    const players = await this.parsePlayersFromLogs(gameId);
    return {
      count: players.length,
      players: players
    };
  }

  /**
   * Read last N lines from a file
   * @param {string} filePath - File path
   * @param {number} lines - Number of lines to read
   * @returns {Promise<string>} File content
   */
  async readLastLines(filePath, lines = 100) {
    return new Promise((resolve, reject) => {
      if (!fs.existsSync(filePath)) {
        resolve('');
        return;
      }

      fs.readFile(filePath, 'utf8', (err, data) => {
        if (err) {
          reject(err);
          return;
        }

        const allLines = data.split('\n');
        const lastLines = allLines.slice(-lines).join('\n');
        resolve(lastLines);
      });
    });
  }

  /**
   * Get available commands
   * @returns {Array} List of available commands
   */
  getAvailableCommands() {
    return [
      { command: 'status', description: 'Get server status and player list' },
      { command: 'serverinfo', description: 'Get server configuration info' },
      { command: 'players', description: 'Get connected players list' },
      { command: 'map <mapname>', description: 'Change map (restarts server)' },
      { command: 'map_restart', description: 'Restart current map' },
      { command: 'killserver', description: 'Stop the server' },
      { command: 'kick <player>', description: 'Kick player (requires restart)' },
      { command: 'say <message>', description: 'Send message (not implemented)' }
    ];
  }
}

module.exports = QuakeJSRCON;