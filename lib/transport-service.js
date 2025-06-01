/**
 * Transport service for handling both WebRTC and WebSocket connections
 * Provides a fallback mechanism for environments without WebRTC support
 */

const WebSocket = require('ws');
const logger = require('winston');
const EventEmitter = require('events');

class TransportService extends EventEmitter {
  /**
   * Create a new transport service
   * @param {Object} config - Configuration options
   * @param {ServerRegistry} serverRegistry - Server registry
   */
  constructor(config, serverRegistry) {
    super();
    this.config = config;
    this.serverRegistry = serverRegistry;
    
    // Map client ID -> client connection data
    this.clients = new Map();
    
    // Map of server peer ID -> proxy connections
    this.proxyConnections = new Map();
    
    // WebSocket server for handling direct connections
    this.wsServer = null;
    
    logger.info('Transport service initialized');
  }
  
  /**
   * Set WebSocket server reference
   * @param {WebSocketServer} wsServer - WebSocket server instance
   */
  setWebSocketServer(wsServer) {
    this.wsServer = wsServer;
  }
  
  /**
   * Start the transport service
   */
  start() {
    logger.info('Transport service started');
    
    // Start maintenance tasks
    this.startMaintenanceTasks();
  }
  
  /**
   * Start periodic maintenance tasks
   */
  startMaintenanceTasks() {
    // Clean up stale proxy connections
    setInterval(() => {
      this.cleanupStaleProxyConnections();
    }, 60000); // every 60 seconds
  }
  
  /**
   * Register a client connection
   * @param {string} clientId - Client ID
   * @param {WebSocket} ws - WebSocket connection
   * @param {boolean} supportsWebRTC - Whether the client supports WebRTC
   */
  registerClient(clientId, ws, supportsWebRTC = true) {
    this.clients.set(clientId, {
      id: clientId,
      ws: ws,
      supportsWebRTC: supportsWebRTC,
      isServer: false,
      peerId: null,
      lastActivity: Date.now()
    });
    
    logger.debug(`Client ${clientId} registered (WebRTC: ${supportsWebRTC ? 'yes' : 'no'})`);
  }
  
  /**
   * Remove a client
   * @param {string} clientId - Client ID to remove
   */
  removeClient(clientId) {
    const client = this.clients.get(clientId);
    if (!client) return;
    
    logger.debug(`Client ${clientId} removed`);
    
    // If this was a server, remove any proxy connections
    if (client.isServer && client.peerId) {
      this.removeProxyConnections(client.peerId);
      
      // Also remove from server registry
      this.serverRegistry.removeServer(client.peerId);
    }
    
    // Remove from clients map
    this.clients.delete(clientId);
  }
  
  /**
   * Update client's activity timestamp
   * @param {string} clientId - Client ID
   */
  updateClientActivity(clientId) {
    const client = this.clients.get(clientId);
    if (client) {
      client.lastActivity = Date.now();
    }
  }
  
  /**
   * Register a client as a game server
   * @param {string} clientId - Client ID
   * @param {string} peerId - Peer ID for the server
   * @param {Object} serverInfo - Server information
   * @returns {string} The assigned peer ID
   */
  registerServer(clientId, peerId, serverInfo) {
    const client = this.clients.get(clientId);
    if (!client) return null;
    
    // Register with server registry
    const assignedPeerId = this.serverRegistry.registerServer(peerId, serverInfo);
    
    // Update client record
    client.isServer = true;
    client.peerId = assignedPeerId;
    
    logger.info(`Client ${clientId} registered as game server with peer ID: ${assignedPeerId}`);
    
    return assignedPeerId;
  }
  
  /**
   * Update server information
   * @param {string} clientId - Client ID
   * @param {Object} serverInfo - Updated server information
   */
  updateServerInfo(clientId, serverInfo) {
    const client = this.clients.get(clientId);
    if (!client || !client.isServer || !client.peerId) return;
    
    // Update in server registry
    this.serverRegistry.updateServer(client.peerId, serverInfo);
  }
  
  /**
   * Find a client by peer ID
   * @param {string} peerId - Peer ID to find
   * @returns {Object|null} Client data or null if not found
   */
  findClientByPeerId(peerId) {
    for (const [id, client] of this.clients.entries()) {
      if (client.peerId === peerId) {
        return client;
      }
    }
    return null;
  }
  
  /**
   * Create a WebSocket proxy connection between client and server
   * @param {string} clientId - Client ID
   * @param {string} serverPeerId - Server peer ID
   * @returns {boolean} True if proxy was created successfully
   */
  createProxyConnection(clientId, serverPeerId) {
    const client = this.clients.get(clientId);
    if (!client) return false;
    
    // Find the server client
    const serverClient = this.findClientByPeerId(serverPeerId);
    if (!serverClient) {
      logger.warn(`Server with peer ID ${serverPeerId} not found`);
      return false;
    }
    
    // Create a unique connection ID
    const connectionId = `${clientId}-${serverPeerId}-${Date.now()}`;
    
    // Store in proxy connections map
    if (!this.proxyConnections.has(serverPeerId)) {
      this.proxyConnections.set(serverPeerId, new Map());
    }
    
    const serverProxies = this.proxyConnections.get(serverPeerId);
    serverProxies.set(clientId, {
      connectionId: connectionId,
      clientId: clientId,
      serverPeerId: serverPeerId,
      serverId: serverClient.id,
      createdAt: Date.now(),
      lastActivity: Date.now(),
      active: true
    });
    
    logger.info(`Created WebSocket proxy connection between client ${clientId} and server ${serverPeerId}`);
    
    // Notify the server about the client connection
    this.sendToClient(serverClient.id, {
      type: 'proxy_connection',
      clientId: clientId,
      connectionId: connectionId
    });
    
    // Update server player count
    this.serverRegistry.addClientToServer(serverPeerId, clientId);
    
    return true;
  }
  
  /**
   * Remove proxy connections for a server
   * @param {string} serverPeerId - Server peer ID
   */
  removeProxyConnections(serverPeerId) {
    if (this.proxyConnections.has(serverPeerId)) {
      const connections = this.proxyConnections.get(serverPeerId);
      connections.forEach((conn, clientId) => {
        // Notify clients about the disconnection
        const client = this.clients.get(clientId);
        if (client) {
          this.sendToClient(clientId, {
            type: 'server_disconnected',
            serverPeerId: serverPeerId
          });
        }
      });
      
      this.proxyConnections.delete(serverPeerId);
      logger.debug(`Removed all proxy connections for server ${serverPeerId}`);
    }
  }
  
  /**
   * Remove a client's proxy connection to a server
   * @param {string} clientId - Client ID
   * @param {string} serverPeerId - Server peer ID
   */
  removeClientProxyConnection(clientId, serverPeerId) {
    if (this.proxyConnections.has(serverPeerId)) {
      const connections = this.proxyConnections.get(serverPeerId);
      if (connections.has(clientId)) {
        connections.delete(clientId);
        
        // Remove from server player count
        this.serverRegistry.removeClientFromServer(serverPeerId, clientId);
        
        logger.debug(`Removed proxy connection for client ${clientId} to server ${serverPeerId}`);
        
        // If no more connections, clean up
        if (connections.size === 0) {
          this.proxyConnections.delete(serverPeerId);
        }
      }
    }
  }
  
  /**
   * Forward a message from client to server
   * @param {string} clientId - Source client ID
   * @param {string} serverPeerId - Target server peer ID
   * @param {Object|string|Buffer} message - Message to forward
   * @returns {boolean} True if message was forwarded
   */
  forwardToServer(clientId, serverPeerId, message) {
    // Check if client has a proxy connection to this server
    if (!this.proxyConnections.has(serverPeerId)) {
      logger.warn(`No proxy connections found for server ${serverPeerId}`);
      return false;
    }
    
    const connections = this.proxyConnections.get(serverPeerId);
    if (!connections.has(clientId)) {
      logger.warn(`Client ${clientId} does not have a proxy connection to server ${serverPeerId}`);
      
      // Log all current connections for debugging
      logger.debug(`Available connections for server ${serverPeerId}:`);
      for (const [connClientId, conn] of connections.entries()) {
        logger.debug(`- Client ${connClientId}, connectionId: ${conn.connectionId}, active: ${conn.active}`);
      }
      
      return false;
    }
    
    // Find the server client
    const serverClient = this.findClientByPeerId(serverPeerId);
    if (!serverClient) {
      logger.warn(`Server client with peer ID ${serverPeerId} not found`);
      return false;
    }
    
    // Update connection activity timestamp
    const conn = connections.get(clientId);
    conn.lastActivity = Date.now();
    
    // Wrap the message with client ID for the server
    const wrappedMessage = {
      type: 'proxy_data',
      clientId: clientId,
      connectionId: conn.connectionId,
      data: message
    };
    
    logger.debug(`Forwarding message from client ${clientId} to server ${serverPeerId}`);
    
    // Send to server
    return this.sendToClient(serverClient.id, wrappedMessage);
  }
  
  /**
   * Forward a message from server to client
   * @param {string} serverPeerId - Source server peer ID
   * @param {string} clientId - Target client ID
   * @param {Object|string|Buffer} message - Message to forward
   * @returns {boolean} True if message was forwarded
   */
  forwardToClient(serverPeerId, clientId, message) {
    // Check if server has a proxy connection to this client
    if (!this.proxyConnections.has(serverPeerId)) {
      return false;
    }
    
    const connections = this.proxyConnections.get(serverPeerId);
    if (!connections.has(clientId)) {
      return false;
    }
    
    // Update connection activity timestamp
    const conn = connections.get(clientId);
    conn.lastActivity = Date.now();
    
    // Wrap the message with server ID for the client
    const wrappedMessage = {
      type: 'proxy_data',
      serverPeerId: serverPeerId,
      data: message
    };
    
    // Send to client
    return this.sendToClient(clientId, wrappedMessage);
  }
  
  /**
   * Send a message to a client
   * @param {string} clientId - Target client ID
   * @param {Object|string|Buffer} message - Message to send
   * @returns {boolean} True if message was sent
   */
  sendToClient(clientId, message) {
    const client = this.clients.get(clientId);
    if (!client || !client.ws || client.ws.readyState !== WebSocket.OPEN) {
      logger.warn(`Cannot send to client ${clientId}: client not found or connection not open`);
      return false;
    }
    
    try {
      // Ensure we're sending a string
      let data;
      if (typeof message === 'string') {
        data = message;
      } else if (typeof message === 'object') {
        data = JSON.stringify(message);
      } else {
        data = String(message);
      }
      
      logger.debug(`Sending to client ${clientId}: ${data.substring(0, 50)}${data.length > 50 ? '...' : ''}`);
      client.ws.send(data);
      return true;
    } catch (err) {
      logger.error(`Failed to send message to client ${clientId}:`, err);
      return false;
    }
  }
  
  /**
   * Clean up stale proxy connections
   */
  cleanupStaleProxyConnections() {
    const now = Date.now();
    const timeout = 300000; // 5 minutes without activity
    let cleanedCount = 0;
    
    for (const [serverPeerId, connections] of this.proxyConnections.entries()) {
      for (const [clientId, conn] of connections.entries()) {
        if (now - conn.lastActivity > timeout) {
          // Remove stale connection
          connections.delete(clientId);
          
          // Remove from server player count
          this.serverRegistry.removeClientFromServer(serverPeerId, clientId);
          
          cleanedCount++;
        }
      }
      
      // If no more connections, clean up server entry
      if (connections.size === 0) {
        this.proxyConnections.delete(serverPeerId);
      }
    }
    
    if (cleanedCount > 0) {
      logger.info(`Cleaned up ${cleanedCount} stale proxy connections`);
    }
  }
}

module.exports = TransportService;