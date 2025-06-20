/**
 * Server registry for managing WebRTC game servers
 * Replaces the traditional IP:port identification with peer IDs
 */

const { v4: uuidv4 } = require('uuid');

class ServerRegistry {
  /**
   * Create a new server registry
   */
  constructor() {
    // Servers indexed by their peer ID
    this.servers = {};
    
    // Timestamp of last pruning operation
    this.lastPrune = Date.now();
    
    // Callback for state change notifications
    this.stateChangeCallback = null;
    
    // Server registry initialized
  }
  
  /**
   * Register a new game server
   * @param {string} peerId - Optional peer ID (generates one if not provided)
   * @param {Object} metadata - Server metadata (game, map, players, etc.)
   * @returns {string} The server's peer ID
   */
  registerServer(peerId, metadata = {}) {
    // Generate peer ID if not provided
    const id = peerId || uuidv4();
    
    this.servers[id] = {
      peerId: id,
      metadata: metadata,
      lastUpdate: Date.now(),
      lastGameStateToken: null, // Track last game state token timestamp
      lastHeartbeat: null, // Track last QuakeJS heartbeat timestamp
      dedicatedServerState: 'not_running', // not_running, starting, running, game_over
      dedicatedServerPort: null, // Port of the dedicated server process
      gameId: metadata.gameId || null, // Game ID for mapping
      clients: []
    };
    
    // Server registered
    
    return id;
  }
  
  /**
   * Update an existing server's metadata and timestamp
   * @param {string} peerId - The server's peer ID
   * @param {Object} metadata - Updated metadata (optional)
   * @returns {string} The server's peer ID
   */
  updateServer(peerId, metadata = null) {
    if (!this.servers[peerId]) {
      return this.registerServer(peerId, metadata || {});
    }
    
    this.servers[peerId].lastUpdate = Date.now();
    
    if (metadata) {
      this.servers[peerId].metadata = {
        ...this.servers[peerId].metadata,
        ...metadata
      };
    }
    
    return peerId;
  }
  
  /**
   * Remove a server from the registry
   * @param {string} peerId - The server's peer ID
   * @returns {boolean} True if server was found and removed
   */
  removeServer(peerId) {
    if (this.servers[peerId]) {
      // Server removed from registry
      delete this.servers[peerId];
      return true;
    }
    return false;
  }
  
  /**
   * Get a specific server by peer ID
   * @param {string} peerId - The server's peer ID
   * @returns {Object|null} Server object or null if not found
   */
  getServer(peerId) {
    return this.servers[peerId] || null;
  }
  
  /**
   * Get all registered servers
   * @returns {Array} Array of server objects
   */
  getAllServers() {
    return Object.values(this.servers);
  }
  
  /**
   * Get formatted server list for clients
   * @returns {Array} Array of simplified server objects
   */
  getServerList() {
    return Object.values(this.servers).map(server => ({
      peerId: server.peerId,
      name: server.metadata.name || 'Unknown Server',
      game: server.metadata.game || 'baseq3',
      map: server.metadata.map || 'unknown',
      players: server.metadata.players || 0,
      maxPlayers: server.metadata.maxPlayers || 16,
      // Include address information if available
      address: server.metadata.address || null,
      // Include dedicated server state
      dedicatedServerState: server.dedicatedServerState || 'not_running',
      gameId: server.gameId
    }));
  }
  
  /**
   * Record client connection to a server
   * @param {string} peerId - Server peer ID
   * @param {string} clientId - Client ID
   * @returns {boolean} True if successful
   */
  addClientToServer(peerId, clientId) {
    const server = this.servers[peerId];
    if (!server) return false;
    
    if (!server.clients.includes(clientId)) {
      server.clients.push(clientId);
      
      // Update player count in metadata
      if (server.metadata) {
        server.metadata.players = (server.metadata.players || 0) + 1;
      }
    }
    
    return true;
  }
  
  /**
   * Remove client connection from a server
   * @param {string} peerId - Server peer ID
   * @param {string} clientId - Client ID
   * @returns {boolean} True if successful
   */
  removeClientFromServer(peerId, clientId) {
    const server = this.servers[peerId];
    if (!server) return false;
    
    const index = server.clients.indexOf(clientId);
    if (index !== -1) {
      server.clients.splice(index, 1);
      
      // Update player count in metadata
      if (server.metadata && server.metadata.players > 0) {
        server.metadata.players--;
      }
      
      return true;
    }
    
    return false;
  }
  
  /**
   * Update game state token timestamp for a server
   * @param {string} peerId - Server peer ID
   * @returns {boolean} True if successful
   */
  updateGameStateToken(peerId) {
    const server = this.servers[peerId];
    if (!server) return false;
    
    server.lastGameStateToken = Date.now();
    return true;
  }

  /**
   * Get servers that haven't sent game state tokens within the timeout
   * @param {number} tokenTimeout - Timeout in milliseconds (default: 60s)
   * @returns {Array} Array of inactive server peer IDs
   */
  getInactiveGameStateServers(tokenTimeout = 60000) {
    const now = Date.now();
    const inactiveServers = [];
    
    Object.keys(this.servers).forEach(peerId => {
      const server = this.servers[peerId];
      // Only check servers that have sent at least one token
      if (server.lastGameStateToken && (now - server.lastGameStateToken > tokenTimeout)) {
        inactiveServers.push(peerId);
      }
    });
    
    return inactiveServers;
  }

  /**
   * Set dedicated server state and port for a server
   * @param {string} peerId - Server peer ID
   * @param {string} state - State: 'not_running', 'starting', 'running', 'game_over'
   * @param {number} port - Dedicated server port (optional)
   * @param {string} gameId - Game ID for mapping (optional)
   * @returns {boolean} True if successful
   */
  setDedicatedServerState(peerId, state, port = null, gameId = null) {
    const server = this.servers[peerId];
    if (!server) return false;
    
    server.dedicatedServerState = state;
    if (port !== null) {
      server.dedicatedServerPort = port;
    }
    if (gameId !== null) {
      server.gameId = gameId;
    }
    
    // Server dedicated server state updated
    return true;
  }
  
  /**
   * Update heartbeat timestamp for a dedicated server (QuakeJS protocol)
   * @param {number} port - Dedicated server port
   * @returns {boolean} True if successful
   */
  updateDedicatedServerHeartbeat(port) {
    // Find server by dedicated server port
    const server = Object.values(this.servers).find(s => s.dedicatedServerPort === port);
    if (!server) {
      // No server found for dedicated server port
      return false;
    }
    
    const now = Date.now();
    server.lastHeartbeat = now;
    
    // If this is the first heartbeat and server was starting, mark as running
    if (server.dedicatedServerState === 'starting') {
      const previousState = server.dedicatedServerState;
      server.dedicatedServerState = 'running';
      console.log(`Server ${server.peerId} dedicated server transitioned to running state`);
      
      // Notify about state change
      if (this.stateChangeCallback) {
        this.stateChangeCallback(server.peerId, previousState, 'running', server);
      }
    }
    
    return true;
  }
  
  /**
   * Update heartbeat timestamp for a server by peer ID
   * @param {string} peerId - Server peer ID
   * @returns {boolean} True if successful
   */
  updateServerHeartbeat(peerId) {
    const server = this.servers[peerId];
    if (!server) return false;
    
    server.lastHeartbeat = Date.now();
    return true;
  }
  
  /**
   * Check for servers with stale heartbeats and update their state
   * QuakeJS servers send heartbeats every ~350 seconds, so we use 400 seconds as timeout
   * @param {number} heartbeatTimeout - Timeout in milliseconds (default: 400s)
   */
  checkDedicatedServerHeartbeats(heartbeatTimeout = 400000) {
    const now = Date.now();
    let staleCount = 0;
    
    Object.values(this.servers).forEach(server => {
      // Only check servers that should have dedicated servers (running or game_over)
      if (server.dedicatedServerPort && (server.dedicatedServerState === 'running' || server.dedicatedServerState === 'game_over')) {
        if (server.lastHeartbeat && (now - server.lastHeartbeat > heartbeatTimeout)) {
          server.dedicatedServerState = 'not_running';
          console.log(`Server ${server.peerId} dedicated server marked as not_running`);
          staleCount++;
        }
      }
    });
    
    if (staleCount > 0) {
      console.log(`Marked ${staleCount} dedicated servers as not_running`);
    }
  }
  
  /**
   * Find server by game ID
   * @param {string} gameId - Game ID
   * @returns {Object|null} Server object or null if not found
   */
  getServerByGameId(gameId) {
    return Object.values(this.servers).find(server => server.gameId === gameId) || null;
  }
  
  /**
   * Find server by dedicated server port
   * @param {number} port - Dedicated server port
   * @returns {Object|null} Server object or null if not found
   */
  getServerByPort(port) {
    return Object.values(this.servers).find(server => server.dedicatedServerPort === port) || null;
  }

  /**
   * Remove inactive servers from the registry
   * @param {number} maxAge - Maximum age in milliseconds (default: 2 hours)
   */
  pruneInactiveServers(maxAge = 7200000) {
    const now = Date.now();
    let pruneCount = 0;
    
    Object.keys(this.servers).forEach(peerId => {
      const server = this.servers[peerId];
      if (now - server.lastUpdate > maxAge) {
        this.removeServer(peerId);
        pruneCount++;
      }
    });
    
    if (pruneCount > 0) {
      console.log(`[SESSION TIMEOUT] Pruned ${pruneCount} servers after 2-hour session timeout`);
    }
    
    this.lastPrune = now;
  }

  /**
   * Set callback for server state changes
   * @param {Function} callback - Callback function (peerId, oldState, newState, server)
   */
  setStateChangeCallback(callback) {
    this.stateChangeCallback = callback;
  }
}

module.exports = ServerRegistry;