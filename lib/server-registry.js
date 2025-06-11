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
    
    console.log('Server registry initialized');
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
      clients: []
    };
    
    console.log(`Server registered with peer ID: ${id}`);
    
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
      console.log(`Server ${peerId} removed from registry`);
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
      address: server.metadata.address || null
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
   * Remove inactive servers from the registry
   * @param {number} maxAge - Maximum age in milliseconds (default: 350s)
   */
  pruneInactiveServers(maxAge = 350000) {
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
      console.log(`Pruned ${pruneCount} inactive servers. ${Object.keys(this.servers).length} servers remain.`);
    }
    
    this.lastPrune = now;
  }
}

module.exports = ServerRegistry;