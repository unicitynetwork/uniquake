/**
 * WebRTC signaling service for P2P game connections
 * Handles SDP and ICE candidate exchange between peers
 * Also handles Quake server protocol for backward compatibility
 * Supports Unicity Framework integration
 */

const { v4: uuidv4 } = require('uuid');
const { createSignalingMessage } = require('./protocol-utils');

class SignalingService {
  /**
   * Create a new signaling service
   * @param {WebSocketServer} wsServer - WebSocket server for signaling
   * @param {ServerRegistry} serverRegistry - Server registry
   * @param {CredentialManager} credentialManager - Credential manager for TURN
   * @param {TransportService} transportService - Transport service for WebSocket fallback
   */
  constructor(wsServer, serverRegistry, credentialManager, transportService, masterServer) {
    this.wsServer = wsServer;
    this.serverRegistry = serverRegistry;
    this.credentialManager = credentialManager;
    this.transportService = transportService;
    this.master = masterServer; // Reference to parent master server
    
    // Set up server state change callback
    this.serverRegistry.setStateChangeCallback(this.handleServerStateChange.bind(this));
    
    // Map client ID -> client connection data
    this.clients = new Map();
    
    // Map connection ID -> pending connection data
    this.pendingConnections = new Map();
    
    // Quake server registry (separate from WebRTC servers)
    this.quakeServers = {};
    
    // Unicity server registry - maps serverIds to server data
    this.unicityServers = new Map();
    
    // Reference to the game server manager (will be set later)
    this.gameServerManager = null;
    
    // Map gameId -> clientId (for tracking which client owns which game server)
    this.gameServerOwners = new Map();
    
    // Periodic token monitoring interval
    this.tokenMonitoringInterval = null;
    
    console.log('WebRTC signaling service initialized with Unicity support');
  }
  
  /**
   * Set the game server manager reference
   * @param {GameServerManager} gameServerManager - The game server manager
   */
  setGameServerManager(gameServerManager) {
    this.gameServerManager = gameServerManager;
    this.startTokenMonitoring();
  }

  /**
   * Start periodic monitoring of game state tokens
   */
  startTokenMonitoring() {
    if (this.tokenMonitoringInterval) {
      clearInterval(this.tokenMonitoringInterval);
    }
    
    // Check every 30 seconds for inactive servers
    this.tokenMonitoringInterval = setInterval(() => {
      this.checkInactiveGameServers();
    }, 30000);
    
    // Token monitoring started - checking every 30 seconds
  }

  /**
   * Stop token monitoring
   */
  stopTokenMonitoring() {
    if (this.tokenMonitoringInterval) {
      clearInterval(this.tokenMonitoringInterval);
      this.tokenMonitoringInterval = null;
      // Token monitoring stopped
    }
  }

  /**
   * Check for servers that haven't sent game state tokens and terminate them
   * Note: This is separate from general server pruning (2 hours) and only applies to token monitoring (1 minute)
   */
  checkInactiveGameServers() {
    const inactiveServers = this.serverRegistry.getInactiveGameStateServers(60000); // 1 minute timeout
    
    if (inactiveServers.length === 0) return;
    
    if (inactiveServers.length > 0) {
      console.log(`[TOKEN MONITOR] Found ${inactiveServers.length} inactive servers`);
    }
    
    inactiveServers.forEach(peerId => {
      this.terminateInactiveServer(peerId);
    });
  }

  /**
   * Terminate an inactive server
   * @param {string} peerId - Server peer ID to terminate
   */
  async terminateInactiveServer(peerId) {
    console.log(`[TOKEN MONITOR] Terminating inactive server ${peerId}`);
    
    // Remove from server registry first
    this.serverRegistry.removeServer(peerId);
    
    // Find and disconnect the client
    const serverClient = this.findClientByPeerId(peerId);
    if (serverClient) {
      // Notify connected clients about server shutdown
      serverClient.connectedTo.forEach(clientId => {
        this.sendToClient(clientId, {
          type: 'server_shutdown',
          serverPeerId: peerId,
          reason: 'Inactive server - no game state tokens received'
        });
      });
      
      // Close the server's WebSocket connection
      if (serverClient.ws && serverClient.ws.readyState === 1) {
        serverClient.ws.close(1000, 'Server terminated due to inactivity');
      }
      
      // Remove from clients map
      this.removeClient(serverClient.id);
    }
    
    // If we have a game server manager, terminate the dedicated server process
    if (this.gameServerManager) {
      try {
        await this.gameServerManager.terminateServerByPeerId(peerId);
        // Successfully terminated dedicated server process
      } catch (error) {
        console.error(`Failed to terminate dedicated server for ${peerId}:`, error);
      }
    }
  }
  
  /**
   * Check if a buffer contains a Quake protocol message
   * @param {Buffer} buffer - Buffer to check
   * @returns {boolean} True if the buffer looks like a Quake protocol message
   */
  isQuakeProtocolMessage(buffer) {
    // Quake messages start with 0xFFFFFFFF (4 bytes of 0xFF)
    return buffer.length >= 4 && 
           buffer[0] === 0xFF && 
           buffer[1] === 0xFF && 
           buffer[2] === 0xFF && 
           buffer[3] === 0xFF;
  }
  
  /**
   * Start the signaling service
   */
  start() {
    this.wsServer.on('connection', (ws) => {
      // Generate a unique ID for this client
      const clientId = uuidv4();
      
      // Create connection object with metadata
      const conn = {
        socket: ws,
        id: clientId
      };
      
      // Initialize client in our registry and the transport service
      this.addClient(clientId, ws, conn);
      
      // Setup message handler
      ws.on('message', (data) => {
        // Try to handle as WebRTC signaling (JSON)
        let message;
        try {
          if (data instanceof Buffer) {
            // Check if this looks like a Quake binary protocol message
            if (this.isQuakeProtocolMessage(data)) {
              // Forward to Quake handler if registered
              if (this.master && this.master.quakeHandler) {
                this.master.quakeHandler.handleQuakeMessage(ws, data);
              }
              return;
            }
            
            // Try to parse as JSON
            message = JSON.parse(data.toString('utf8'));
          } else {
            message = JSON.parse(data);
          }
          
          // If message has a unicity property, handle as Unicity message
          if (message.unicity) {
            this.handleUnicityMessage(clientId, message);
          } else {
            // Handle as regular WebRTC signaling
            this.handleSignalingMessage(clientId, message);
          }
        } catch (err) {
          // Not JSON, could be binary Quake protocol
          if (data instanceof Buffer && this.master && this.master.quakeHandler) {
            // Try to handle as Quake protocol
            this.master.quakeHandler.handleQuakeMessage(ws, data);
          } else {
            // Non-JSON message received and no Quake handler available
          }
        }
      });
      
      // Handle disconnection
      ws.on('close', () => {
        this.handleClientDisconnection(clientId);
      });
      
      // Handle errors
      ws.on('error', (err) => {
        console.error(`Client ${clientId} websocket error:`, err);
        this.handleClientDisconnection(clientId);
      });
      
      // Send initial connection confirmation with client ID
      this.sendToClient(clientId, {
        type: 'connected',
        clientId: clientId,
        iceServers: this.getIceServers(),
        fallbackAvailable: true,  // Indicate WebSocket fallback is available
        unicitySupport: true      // Indicate Unicity Framework support
      });
    });
    
    // Start maintenance tasks
    this.startMaintenanceTasks();
    
    console.log('WebRTC signaling service started');
  }
  
  /**
   * Start periodic maintenance tasks
   */
  startMaintenanceTasks() {
    // Clean up stale pending connections
    setInterval(() => {
      this.cleanupStalePendingConnections();
    }, 30000); // every 30 seconds
    
    // Clean up stale Unicity servers
    setInterval(() => {
      this.cleanupStaleUnicityServers();
    }, 60000); // every 60 seconds
    
    // Check dedicated server heartbeats every 60 seconds
    setInterval(() => {
      this.serverRegistry.checkDedicatedServerHeartbeats();
    }, 60000); // every 60 seconds
  }
  
  /**
   * Clean up stale Unicity servers
   */
  cleanupStaleUnicityServers() {
    const now = Date.now();
    const timeout = 2 * 60 * 60000; // 2 hours timeout
    
    let cleanupCount = 0;
    
    for (const [id, server] of this.unicityServers.entries()) {
      if (now - server.lastUpdate > timeout) {
        this.unicityServers.delete(id);
        cleanupCount++;
      }
    }
    
    // Cleaned up stale Unicity servers if any
  }
  
  /**
   * Add a new client to the registry
   * @param {string} clientId - Unique client ID
   * @param {WebSocket} ws - WebSocket connection
   */
  addClient(clientId, ws) {
    this.clients.set(clientId, {
      id: clientId,
      ws: ws,
      peerId: null,        // Will be set if client registers as a server
      isServer: false,     // Flag for game servers
      connectedTo: [],     // Peers this client is connected to
      lastActivity: Date.now()
    });
    
    // Also register with the transport service for WebSocket fallback
    if (this.transportService) {
      this.transportService.registerClient(clientId, ws, true);
    }
    
    // Client connected
  }
  
  /**
   * Handle client disconnection and notify connected servers
   * @param {string} clientId - Client ID that disconnected
   */
  handleClientDisconnection(clientId) {
    const client = this.clients.get(clientId);
    if (!client) {
      return; // Client already removed
    }
    
    // Handle client disconnection
    
    // Find all servers this client was connected to and notify them
    let notifiedServers = 0;
    for (const [serverId, serverClient] of this.clients.entries()) {
      if (serverClient.isServer) {
        // Check if this client was connected to this server
        const wasConnected = serverClient.connectedTo && serverClient.connectedTo.includes(clientId);
        
        if (wasConnected) {
          
          // Send disconnection notification to the server
          this.sendToClient(serverId, {
            type: 'client_disconnected',
            clientId: clientId,
            reason: 'websocket_closed'
          });
          
          // Remove client from server's connected list
          const index = serverClient.connectedTo.indexOf(clientId);
          if (index > -1) {
            serverClient.connectedTo.splice(index, 1);
          }
          
          notifiedServers++;
        }
      }
    }
    
    if (notifiedServers === 0) {
      
      // Fallback: Check transport service for proxy connections
      if (this.transportService && this.transportService.clientConnections) {
        const clientConnections = this.transportService.clientConnections.get(clientId);
        if (clientConnections) {
          for (const serverPeerId of clientConnections) {
            // Find server by peer ID
            const serverClient = this.findClientByPeerId(serverPeerId);
            if (serverClient) {
              // Found server via transport service
              
              this.sendToClient(serverClient.id, {
                type: 'client_disconnected',
                clientId: clientId,
                reason: 'websocket_closed'
              });
              
              notifiedServers++;
            }
          }
        }
      }
    }
    
    // Notified servers about client disconnection
    
    // Remove the client using the existing method
    this.removeClient(clientId);
  }
  
  /**
   * Remove a client from the registry
   * @param {string} clientId - Client ID to remove
   */
  removeClient(clientId) {
    const client = this.clients.get(clientId);
    if (!client) return;
    
    // Client disconnected
    
    // If this was a server, remove it from registry
    if (client.isServer && client.peerId) {
      this.serverRegistry.removeServer(client.peerId);
      
      // Also remove any proxy connections
      if (this.transportService) {
        this.transportService.removeProxyConnections(client.peerId);
      }
    }
    
    // If this was a Unicity server, remove it from registry
    if (client.isUnicityServer && client.unicityServerId) {
      this.unicityServers.delete(client.unicityServerId);
      // Removed Unicity server
    }
    
    // Clean up any pending connections
    this.pendingConnections.forEach((conn, id) => {
      if (conn.clientId === clientId || conn.serverId === clientId) {
        this.pendingConnections.delete(id);
      }
    });
    
    // Also remove from transport service
    if (this.transportService) {
      this.transportService.removeClient(clientId);
    }
    
    // Remove from our registry
    this.clients.delete(clientId);
  }
  
  /**
   * Handle incoming signaling messages
   * @param {string} clientId - Source client ID
   * @param {Object} message - Parsed message object
   */
  handleSignalingMessage(clientId, message) {
    const client = this.clients.get(clientId);
    if (!client) return;
    
    // Update activity timestamp
    client.lastActivity = Date.now();
    
    // Process by message type
    switch (message.type) {
      case 'register_server':
        this.handleRegisterServer(clientId, message);
        break;
        
      case 'get_servers':
        this.handleGetServers(clientId);
        break;
        
      case 'connect_to_server':
        this.handleConnectToServer(clientId, message);
        break;
        
      case 'offer':
        this.handleOffer(clientId, message);
        break;
        
      case 'answer':
        this.handleAnswer(clientId, message);
        break;
        
      case 'ice_candidate':
        this.handleIceCandidate(clientId, message);
        break;
        
      case 'heartbeat':
        this.handleHeartbeat(clientId, message);
        break;
        
      case 'connection_success':
        this.handleConnectionSuccess(clientId, message);
        break;
        
      case 'connection_failed':
        this.handleConnectionFailed(clientId, message);
        break;
        
      case 'proxy_message':
        this.handleProxyMessage(clientId, message);
        break;
        
      case 'proxy_connection':
        this.handleProxyConnectionFromServer(clientId, message);
        break;
        
      case 'proxy_data':
        this.handleProxyDataFromServer(clientId, message);
        break;
        
      case 'proxy_client_disconnected':
        this.handleProxyClientDisconnected(clientId, message);
        break;
        
      case 'disconnect_from_server':
        this.handleDisconnectFromServer(clientId, message);
        break;
        
      case 'server:state:update':
        this.handleServerStateUpdate(clientId, message);
        break;
        
      case 'update_server':
        this.handleUpdateServer(clientId, message);
        break;
        
      case 'list_servers':
        this.handleListServers(clientId, message);
        break;
        
      case 'rcon_command':
        this.handleRCONCommand(clientId, message);
        break;
        
      case 'rcon_commands':
        this.handleRCONCommands(clientId, message);
        break;
        
      case 'game:state:token':
        this.handleGameStateToken(clientId, message);
        break;
        
      default:
        console.warn(`Unknown message type: ${message.type}`);
        break;
    }
  }
  
  /**
   * Handle server registration
   * @param {string} clientId - Client ID
   * @param {Object} message - Message with server details
   */
  handleRegisterServer(clientId, message) {
    const client = this.clients.get(clientId);
    if (!client) return;
    
    // Get or generate peer ID
    const peerId = message.peerId || uuidv4();
    
    // Update client record
    client.peerId = peerId;
    client.isServer = true;
    
    // Register with server registry
    this.serverRegistry.registerServer(peerId, message.serverInfo || {});
    
    // Also register with transport service for WebSocket fallback
    if (this.transportService) {
      this.transportService.registerServer(clientId, peerId, message.serverInfo || {});
    }
    
    // Link peer ID with game server manager if this is a dedicated server
    if (this.gameServerManager && message.serverInfo && message.serverInfo.gameId) {
      this.gameServerManager.setPeerIdForServer(message.serverInfo.gameId, peerId);
    }
    
    // Send confirmation
    this.sendToClient(clientId, {
      type: 'server_registered',
      peerId: peerId
    });
    
    console.log(`Client ${clientId} registered as game server with peer ID: ${peerId}`);
  }
  
  /**
   * Handle get servers request
   * @param {string} clientId - Client ID
   */
  handleGetServers(clientId) {
    // Get server list from registry
    const servers = this.serverRegistry.getServerList();
    
    // Send to client
    this.sendToClient(clientId, {
      type: 'server_list',
      servers: servers
    });
    
    // Sent server list to client
  }
  
  /**
   * Handle request to connect to a game server
   * @param {string} clientId - Client ID
   * @param {Object} message - Message with target server peer ID
   */
  handleConnectToServer(clientId, message) {
    const targetPeerId = message.peerId;
    if (!targetPeerId) {
      return this.sendToClient(clientId, {
        type: 'error',
        error: 'Missing peer ID'
      });
    }
    
    // Find server in registry
    const server = this.serverRegistry.getServer(targetPeerId);
    if (!server) {
      return this.sendToClient(clientId, {
        type: 'error',
        error: 'Server not found'
      });
    }
    
    // Find server's client connection
    const serverClient = this.findClientByPeerId(targetPeerId);
    if (!serverClient) {
      return this.sendToClient(clientId, {
        type: 'error',
        error: 'Server not connected to signaling'
      });
    }
    
    // Check if client is requesting WebSocket fallback
    if (message.useWebSocket) {
      // Client requested WebSocket fallback connection
      
      // Create WebSocket proxy connection
      const success = this.transportService.createProxyConnection(clientId, targetPeerId);
      
      if (success) {
        // Notify client about successful proxy connection
        this.sendToClient(clientId, {
          type: 'proxy_connection',
          serverPeerId: targetPeerId
        });
        
        // Created WebSocket proxy connection
      } else {
        // Notify client about failure
        this.sendToClient(clientId, {
          type: 'error',
          error: 'Failed to create proxy connection'
        });
      }
      
      return;
    }
    
    // Handle WebRTC connection
    
    // Create a connection ID for this session
    const connectionId = uuidv4();
    
    // Store in pending connections
    this.pendingConnections.set(connectionId, {
      id: connectionId,
      clientId: clientId,
      serverId: serverClient.id,
      createdAt: Date.now(),
      state: 'pending'
    });
    
    // Notify server about connection request
    this.sendToClient(serverClient.id, {
      type: 'connection_request',
      connectionId: connectionId,
      clientId: clientId,
      identity: message.identity // Forward client identity if provided
    });
    
    // Send ICE configuration to client
    this.sendToClient(clientId, {
      type: 'ice_config',
      iceServers: this.getIceServers()
    });
    
    // Client requested WebRTC connection to server
  }
  
  /**
   * Handle SDP offer
   * @param {string} clientId - Source client ID
   * @param {Object} message - Message with offer details
   */
  handleOffer(clientId, message) {
    const targetId = message.targetId;
    if (!targetId) return;
    
    this.sendToClient(targetId, {
      type: 'offer',
      connectionId: message.connectionId,
      sourceId: clientId,
      sdp: message.sdp
    });
    
    // Forwarded offer between clients
  }
  
  /**
   * Handle SDP answer
   * @param {string} clientId - Source client ID
   * @param {Object} message - Message with answer details
   */
  handleAnswer(clientId, message) {
    const targetId = message.targetId;
    if (!targetId) return;
    
    this.sendToClient(targetId, {
      type: 'answer',
      connectionId: message.connectionId,
      sourceId: clientId,
      sdp: message.sdp
    });
    
    // Forwarded answer between clients
  }
  
  /**
   * Handle ICE candidate
   * @param {string} clientId - Source client ID
   * @param {Object} message - Message with ICE candidate
   */
  handleIceCandidate(clientId, message) {
    const targetId = message.targetId;
    if (!targetId) return;
    
    this.sendToClient(targetId, {
      type: 'ice_candidate',
      connectionId: message.connectionId,
      sourceId: clientId,
      candidate: message.candidate
    });
  }
  
  /**
   * Handle heartbeat from game server
   * @param {string} clientId - Client ID
   * @param {Object} message - Heartbeat message
   */
  handleHeartbeat(clientId, message) {
    const client = this.clients.get(clientId);
    if (!client || !client.isServer || !client.peerId) return;
    
    // Update server in registry
    this.serverRegistry.updateServer(client.peerId, message.serverInfo);
    
    // Send acknowledgement
    this.sendToClient(clientId, {
      type: 'heartbeat_ack'
    });
  }
  
  /**
   * Handle successful WebRTC connection
   * @param {string} clientId - Client ID
   * @param {Object} message - Success message
   */
  handleConnectionSuccess(clientId, message) {
    const connectionId = message.connectionId;
    if (!connectionId) return;
    
    const conn = this.pendingConnections.get(connectionId);
    if (!conn) return;
    
    // Update connection state
    conn.state = 'connected';
    
    // Get the server client
    const serverClient = this.clients.get(conn.serverId);
    if (!serverClient || !serverClient.peerId) return;
    
    // Add client to server in registry
    this.serverRegistry.addClientToServer(serverClient.peerId, clientId);
    
    // Connection established between client and server
    
    // Remove from pending after a delay
    setTimeout(() => {
      this.pendingConnections.delete(connectionId);
    }, 10000);
  }
  
  /**
   * Handle failed WebRTC connection
   * @param {string} clientId - Client ID
   * @param {Object} message - Failure message
   */
  handleConnectionFailed(clientId, message) {
    const connectionId = message.connectionId;
    if (!connectionId) return;
    
    const conn = this.pendingConnections.get(connectionId);
    if (!conn) return;
    
    // Update connection state
    conn.state = 'failed';
    conn.error = message.error || 'Connection failed';
    
    console.log(`Connection failed: ${conn.error}`);
    
    // Clean up the connection
    this.pendingConnections.delete(connectionId);
  }
  
  /**
   * Find a client by its peer ID
   * @param {string} peerId - Peer ID to find
   * @returns {Object|null} Client object or null if not found
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
   * Send a message to a client
   * @param {string} clientId - Target client ID
   * @param {Object} message - Message to send
   * @returns {boolean} True if message was sent
   */
  sendToClient(clientId, message) {
    const client = this.clients.get(clientId);
    if (!client || !client.ws || client.ws.readyState !== 1) return false;
    
    try {
      client.ws.send(JSON.stringify(message));
      return true;
    } catch (err) {
      console.error(`Failed to send message to client ${clientId}:`, err);
      return false;
    }
  }
  
  /**
   * Handle proxy message from client to server
   * @param {string} clientId - Client ID
   * @param {Object} message - Proxy message details
   */
  handleProxyMessage(clientId, message) {
    const serverPeerId = message.serverPeerId;
    if (!serverPeerId) {
      return;
    }
    
    // Forward the message using the transport service
    const success = this.transportService.forwardToServer(clientId, serverPeerId, message.data);
    
    if (!success) {
      console.warn(`Failed to forward proxy message to server ${serverPeerId}`);
      
      // Notify client about the failure
      this.sendToClient(clientId, {
        type: 'error',
        error: 'Failed to forward message to server',
        serverPeerId: serverPeerId
      });
    }
  }
  
  /**
   * Handle proxy connection message from server
   * @param {string} clientId - Server's client ID
   * @param {Object} message - Connection message details
   */
  handleProxyConnectionFromServer(clientId, message) {
    const targetClientId = message.clientId;
    const connectionId = message.connectionId;
    
    // Received proxy connection from server
    
    // Find server's peer ID
    const server = this.clients.get(clientId);
    if (!server || !server.isServer || !server.peerId) {
      console.warn(`Received proxy_connection from non-server client: ${clientId}`);
      return;
    }
    
    // Server establishing proxy connection with client
    
    // Track that this client is connected to this server
    if (!server.connectedTo) {
      server.connectedTo = [];
    }
    if (!server.connectedTo.includes(targetClientId)) {
      server.connectedTo.push(targetClientId);
    }
    
    // Make sure the proxy connection is also set up in the transport service
    // This is a safeguard in case it wasn't created when the client initially connected
    if (this.transportService) {
      // Check if the connection already exists
      let connectionExists = false;
      if (this.transportService.proxyConnections.has(server.peerId)) {
        const connections = this.transportService.proxyConnections.get(server.peerId);
        connectionExists = connections.has(targetClientId);
      }
      
      // If the connection doesn't exist, create it
      if (!connectionExists) {
        this.transportService.createProxyConnection(targetClientId, server.peerId);
      }
    }
    
    // Forward the connection info to the client
    const sent = this.sendToClient(targetClientId, {
      type: 'proxy_connection',
      serverPeerId: server.peerId,
      connectionId: connectionId
    });
    
    if (!sent) {
      console.warn(`Failed to send proxy_connection message to client`);
    }
  }
  
  /**
   * Handle proxy data from server to client
   * @param {string} clientId - Server's client ID
   * @param {Object} message - Proxy data message
   */
  handleProxyDataFromServer(clientId, message) {
    const targetClientId = message.clientId;
    const data = message.data;
    
    // Find server's peer ID
    const server = this.clients.get(clientId);
    if (!server || !server.isServer || !server.peerId) {
      return;
    }
    
    // Server sending data to client
    
    // Forward the data to the client through transport service
    if (this.transportService) {
      this.transportService.forwardToClient(server.peerId, targetClientId, data);
    }
  }
  
  /**
   * Handle client disconnection message from server
   * @param {string} clientId - Server's client ID
   * @param {Object} message - Disconnection message details
   */
  handleProxyClientDisconnected(clientId, message) {
    const targetClientId = message.clientId;
    
    // Find server's peer ID
    const server = this.clients.get(clientId);
    if (!server || !server.isServer || !server.peerId) {
      return;
    }
    
    // Server disconnected from client
    
    // Notify the client about the disconnection
    this.sendToClient(targetClientId, {
      type: 'server_disconnected',
      serverPeerId: server.peerId
    });
    
    // Remove the proxy connection in the transport service
    this.transportService.removeClientProxyConnection(targetClientId, server.peerId);
  }
  
  /**
   * Handle client disconnection from server
   * @param {string} clientId - Client ID
   * @param {Object} message - Disconnect message details
   */
  handleDisconnectFromServer(clientId, message) {
    const serverPeerId = message.serverPeerId;
    if (!serverPeerId) {
      return;
    }
    
    // Client gracefully disconnecting from server
    
    // Find the server and notify it about the client disconnection
    const serverClient = this.findClientByPeerId(serverPeerId);
    if (serverClient) {
      // Notifying server about client graceful disconnection
      
      // Send disconnection notification to the server
      this.sendToClient(serverClient.id, {
        type: 'client_disconnected',
        clientId: clientId,
        reason: 'user_disconnect'
      });
      
      // Remove client from server's connected list
      if (serverClient.connectedTo && serverClient.connectedTo.includes(clientId)) {
        const index = serverClient.connectedTo.indexOf(clientId);
        if (index > -1) {
          serverClient.connectedTo.splice(index, 1);
          // Removed client from server connection list
        }
      }
    } else {
      console.warn(`Server with peerId ${serverPeerId} not found for client disconnection`);
    }
    
    // Remove the proxy connection in the transport service
    this.transportService.removeClientProxyConnection(clientId, serverPeerId);
    
    // Notify client about successful disconnection
    this.sendToClient(clientId, {
      type: 'disconnect_ack',
      serverPeerId: serverPeerId
    });
    
    // NOTE: Client remains in master server registry since WebSocket is still connected
    // Client disconnected from game server but remains connected to master
  }

  /**
   * Handle server state update with game state token
   * @param {string} clientId - Server's client ID
   * @param {Object} message - State update message
   */
  handleServerStateUpdate(clientId, message) {
    const client = this.clients.get(clientId);
    if (!client || !client.isServer || !client.peerId) {
      return;
    }
    
    // Update the game state token timestamp in the registry
    const success = this.serverRegistry.updateGameStateToken(client.peerId);
    
    // Also update the server activity in the game server manager
    if (this.gameServerManager) {
      this.gameServerManager.updateServerActivity(client.peerId);
    }
    
    if (success) {
      // Game state token received from server
      
      // Forward the state update to any connected clients if needed
      if (message.serverInfo) {
        // Broadcast to connected clients
        client.connectedTo.forEach(connectedClientId => {
          this.sendToClient(connectedClientId, {
            type: 'server:state:update',
            serverPeerId: client.peerId,
            serverInfo: message.serverInfo
          });
        });
      }
    } else {
      console.warn(`Failed to update game state token for server`);
    }
  }
  
  /**
   * Handle server information update (name, map, etc.)
   * @param {string} clientId - Client ID
   * @param {Object} message - Message with updated server info
   */
  handleUpdateServer(clientId, message) {
    const client = this.clients.get(clientId);
    if (!client || !client.isServer || !client.peerId) {
      return;
    }
    
    // Server updating server info
    
    // Update server registry with new information
    const success = this.serverRegistry.updateServer(client.peerId, message.serverInfo);
    
    if (success) {
      // Server information updated successfully
      
      // Broadcast updated server list to all clients
      this.broadcastServerListUpdate();
      
      // Send confirmation back to the server
      this.sendToClient(clientId, {
        type: 'server_updated',
        success: true,
        peerId: client.peerId
      });
    } else {
      console.warn(`Failed to update server information`);
      this.sendToClient(clientId, {
        type: 'server_updated',
        success: false,
        peerId: client.peerId,
        error: 'Failed to update server information'
      });
    }
  }
  
  /**
   * Broadcast server list update to all connected clients
   */
  broadcastServerListUpdate() {
    const serverList = this.serverRegistry.getServerList();
    // Broadcasting server list update to clients
    
    // Send to all clients that are not servers themselves
    for (const [clientId, client] of this.clients.entries()) {
      if (!client.isServer) {
        this.sendToClient(clientId, {
          type: 'server_list',
          servers: serverList,
          timestamp: Date.now()
        });
      }
    }
  }
  
  /**
   * Clean up stale pending connections
   */
  cleanupStalePendingConnections() {
    const now = Date.now();
    const timeout = 60000; // 1 minute timeout
    
    let cleanupCount = 0;
    
    for (const [id, conn] of this.pendingConnections.entries()) {
      if (now - conn.createdAt > timeout && conn.state === 'pending') {
        this.pendingConnections.delete(id);
        cleanupCount++;
      }
    }
    
    // Cleaned up stale pending connections if any
  }
  
  /**
   * Get ICE server configuration
   * @returns {Object} ICE server configuration
   */
  getIceServers() {
    return this.credentialManager.getICEServerConfig();
  }
  
  /**
   * Handle Unicity-specific messages
   * @param {string} clientId - Source client ID
   * @param {Object} message - Parsed message object with unicity property
   */
  handleUnicityMessage(clientId, message) {
    const client = this.clients.get(clientId);
    if (!client) return;
    
    // Update activity timestamp
    client.lastActivity = Date.now();
    
    // Received Unicity message
    
    // Process by message type
    switch (message.type) {
      case 'register_unicity_server':
        this.handleRegisterUnicityServer(clientId, message);
        break;
        
      case 'get_unicity_servers':
        this.handleGetUnicityServers(clientId);
        break;
        
      case 'connect_to_unicity_server':
        // Force WebSocket fallback mode for Unicity connections
        if (!message.useWebSocket) {
          message.useWebSocket = true;
          // Forcing WebSocket fallback for Unicity connection
        }
        this.handleConnectToUnicityServer(clientId, message);
        break;
        
      case 'unicity_heartbeat':
        this.handleUnicityHeartbeat(clientId, message);
        break;
        
      case 'unicity_game_state':
        this.handleUnicityGameState(clientId, message);
        break;
        
      case 'unicity_token_transaction':
        this.handleUnicityTokenTransaction(clientId, message);
        break;
        
      case 'quake_game_message':
        this.handleQuakeGameMessage(clientId, message);
        break;
        
      // Game server management messages
      case 'start_game_server':
        this.handleStartGameServer(clientId, message);
        break;
        
      case 'stop_game_server':
        this.handleStopGameServer(clientId, message);
        break;
        
      case 'get_server_status':
        this.handleGetGameServerStatus(clientId, message);
        break;
        
      case 'get_server_logs':
        this.handleGetGameServerLogs(clientId, message);
        break;
        
      case 'get_all_game_servers':
        this.handleGetAllGameServers(clientId);
        break;
        
      default:
        console.warn(`Unknown Unicity message type: ${message.type}`);
        break;
    }
  }
  
  /**
   * Handle request to start a new game server
   * @param {string} clientId - Client ID
   * @param {Object} message - Start server message
   */
  async handleStartGameServer(clientId, message) {
    // Client requested to start a game server
    
    // Check if we have a game server manager
    if (!this.gameServerManager && !this.master) {
      return this.sendToClient(clientId, {
        unicity: true,
        type: 'error',
        error: 'Game server management not available',
        requestType: 'start_game_server'
      });
    }
    
    // Validate input
    if (!message.serverInfo) {
      return this.sendToClient(clientId, {
        unicity: true,
        type: 'error',
        error: 'Missing server info',
        requestType: 'start_game_server'
      });
    }
    
    try {
      // Generate a gameId if not provided
      const gameId = message.serverInfo.gameId || message.gameId || `game-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
      
      // Add gameId to serverInfo
      message.serverInfo.gameId = gameId;
      
      // Start the server using the master server's method
      const serverInstance = await this.master.startGameServer(message.serverInfo);
      
      if (!serverInstance) {
        return this.sendToClient(clientId, {
          unicity: true,
          type: 'error',
          error: 'Failed to start game server',
          requestType: 'start_game_server'
        });
      }
      
      // Track which client owns this server
      this.gameServerOwners.set(gameId, clientId);
      
      // Get the client's original peer ID to update with dedicated server info
      const client = this.clients.get(clientId);
      let serverPeerId = null;
      
      if (client && client.isServer && client.peerId) {
        serverPeerId = client.peerId;
        console.log(`Using existing server ID: ${serverPeerId} for dedicated server`);
        
        // Update the server registry with the dedicated server info
        // but keeping the original server ID
        this.serverRegistry.updateServer(serverPeerId, {
          name: serverInstance.serverInfo.name,
          map: serverInstance.serverInfo.map,
          game: 'baseq3',
          players: 0,
          maxPlayers: serverInstance.serverInfo.maxPlayers,
          address: serverInstance.serverInfo.address,
          isDedicated: true
        });
        
        // Set dedicated server state to "starting" and track port/gameId
        this.serverRegistry.setDedicatedServerState(serverPeerId, 'starting', serverInstance.port, gameId);
        
        // Clear game over flags if transitioning from game_over state
        const server = this.serverRegistry.getServer(serverPeerId);
        if (server && server.metadata && server.metadata.gameOver) {
          this.serverRegistry.updateServer(serverPeerId, {
            ...server.metadata,
            gameOver: false,
            lastGameEndTime: null,
            gameRestarted: true,
            lastRestartTime: Date.now()
          });
          console.log(`Server ${serverPeerId} transitioning from game_over to starting (game restarted)`);
        }
        
        // Store the game ID with the server peer ID for later reference
        this.serverState = this.serverState || {};
        this.serverState.gameIdToPeerId = this.serverState.gameIdToPeerId || new Map();
        this.serverState.gameIdToPeerId.set(gameId, serverPeerId);
        
        // Updated server with dedicated server address
      } else {
        // Fallback in case we don't have a registered server (shouldn't happen)
        serverPeerId = `dedicated-${gameId}`;
        // No existing server ID found, creating new ID
        
        this.serverRegistry.registerServer(serverPeerId, {
          name: serverInstance.serverInfo.name,
          map: serverInstance.serverInfo.map,
          game: 'baseq3',
          players: 0,
          maxPlayers: serverInstance.serverInfo.maxPlayers,
          address: serverInstance.serverInfo.address,
          isDedicated: true
        });
        
        // Set dedicated server state to "starting" and track port/gameId
        this.serverRegistry.setDedicatedServerState(serverPeerId, 'starting', serverInstance.port, gameId);
        
        // Registered dedicated server with address
      }
      
      // Send success response with server details
      this.sendToClient(clientId, {
        unicity: true,
        type: 'game_server_started',
        gameId: gameId,
        serverId: serverPeerId, // Use the client's original server ID
        serverInfo: {
          name: serverInstance.serverInfo.name,
          address: serverInstance.serverInfo.address,
          map: serverInstance.serverInfo.map,
          maxPlayers: serverInstance.serverInfo.maxPlayers
        },
        success: true
      });
      
      console.log(`Started game server ${gameId}`);
    } catch (error) {
      console.error('Error starting game server:', error);
      
      this.sendToClient(clientId, {
        unicity: true,
        type: 'error',
        error: `Failed to start game server: ${error.message}`,
        requestType: 'start_game_server'
      });
    }
  }
  
  /**
   * Handle request to stop a game server
   * @param {string} clientId - Client ID
   * @param {Object} message - Stop server message
   */
  async handleStopGameServer(clientId, message) {
    // Client requested to stop game server
    
    // Check if we have a game server manager
    if (!this.gameServerManager && !this.master) {
      return this.sendToClient(clientId, {
        unicity: true,
        type: 'error',
        error: 'Game server management not available',
        requestType: 'stop_game_server'
      });
    }
    
    // Validate input
    if (!message.gameId) {
      return this.sendToClient(clientId, {
        unicity: true,
        type: 'error',
        error: 'Missing game ID',
        requestType: 'stop_game_server'
      });
    }
    
    // Check if this client owns the server
    const ownerClientId = this.gameServerOwners.get(message.gameId);
    if (ownerClientId !== clientId) {
      console.warn(`Client attempted to stop game server owned by another client`);
      
      return this.sendToClient(clientId, {
        unicity: true,
        type: 'error',
        error: 'You are not authorized to stop this server',
        requestType: 'stop_game_server'
      });
    }
    
    try {
      // Stop the server
      const success = await this.master.stopGameServer(message.gameId);
      
      if (!success) {
        return this.sendToClient(clientId, {
          unicity: true,
          type: 'error',
          error: 'Failed to stop game server',
          requestType: 'stop_game_server'
        });
      }
      
      // Remove ownership tracking
      this.gameServerOwners.delete(message.gameId);
      
      // Get the server peer ID associated with this game ID
      const client = this.clients.get(clientId);
      let serverPeerId = null;
      
      // Try to get the server peer ID from our mapping
      if (this.serverState && this.serverState.gameIdToPeerId) {
        serverPeerId = this.serverState.gameIdToPeerId.get(message.gameId);
      }
      
      // Check if this is part of a restart cycle
      if (message.isRestartCycle) {
        // For restart cycles, set to game_over state and preserve address
        if (serverPeerId) {
          // Setting server to game_over state for restart cycle
          
          // Set server to game_over state instead of removing dedicated server info
          this.serverRegistry.setDedicatedServerState(serverPeerId, 'game_over');
          
          // Update server metadata to indicate game is over but keep address
          const server = this.serverRegistry.getServer(serverPeerId);
          if (server && server.metadata) {
            this.serverRegistry.updateServer(serverPeerId, {
              ...server.metadata,
              gameOver: true,
              lastGameEndTime: Date.now()
            });
          }
          
          // Server set to game_over state (address preserved for restart)
        }
      } else {
        // For normal stops, remove the server completely
        if (serverPeerId) {
          // Removing server completely (normal stop)
          this.serverRegistry.removeServer(serverPeerId);
          
          // Remove the game ID to peer ID mapping
          if (this.serverState && this.serverState.gameIdToPeerId) {
            this.serverState.gameIdToPeerId.delete(message.gameId);
          }
        } else {
          // Fallback to old approach if we don't have the mapping
          const dedicatedServerId = `dedicated-${message.gameId}`;
          this.serverRegistry.removeServer(dedicatedServerId);
          // Removed dedicated server from registry (fallback)
        }
      }
      
      // Send success response
      this.sendToClient(clientId, {
        unicity: true,
        type: 'game_server_stopped',
        gameId: message.gameId,
        success: true
      });
      
      console.log(`Stopped game server`);
    } catch (error) {
      console.error('Error stopping game server:', error);
      
      this.sendToClient(clientId, {
        unicity: true,
        type: 'error',
        error: `Failed to stop game server: ${error.message}`,
        requestType: 'stop_game_server'
      });
    }
  }
  
  /**
   * Handle request for game server status
   * @param {string} clientId - Client ID
   * @param {Object} message - Status request
   */
  async handleGetGameServerStatus(clientId, message) {
    // Client requested game server status
    
    // Check if we have a game server manager
    if (!this.gameServerManager && !this.master) {
      return this.sendToClient(clientId, {
        unicity: true,
        type: 'error',
        error: 'Game server management not available',
        requestType: 'get_server_status'
      });
    }
    
    // Validate input
    if (!message.gameId) {
      return this.sendToClient(clientId, {
        unicity: true,
        type: 'error',
        error: 'Missing game ID',
        requestType: 'get_server_status'
      });
    }
    
    try {
      // Get the server status
      const status = this.master.getGameServerStatus(message.gameId);
      
      if (!status) {
        return this.sendToClient(clientId, {
          unicity: true,
          type: 'error',
          error: 'Game server not found',
          requestType: 'get_server_status'
        });
      }
      
      // Send the status
      this.sendToClient(clientId, {
        unicity: true,
        type: 'game_server_status',
        gameId: message.gameId,
        status: status
      });
    } catch (error) {
      console.error('Error getting game server status:', error);
      
      this.sendToClient(clientId, {
        unicity: true,
        type: 'error',
        error: `Failed to get game server status: ${error.message}`,
        requestType: 'get_server_status'
      });
    }
  }
  
  /**
   * Handle request for game server logs
   * @param {string} clientId - Client ID
   * @param {Object} message - Logs request
   */
  async handleGetGameServerLogs(clientId, message) {
    // Client requested game server logs
    
    // Check if we have a game server manager
    if (!this.gameServerManager && !this.master) {
      return this.sendToClient(clientId, {
        unicity: true,
        type: 'error',
        error: 'Game server management not available',
        requestType: 'get_server_logs'
      });
    }
    
    // Validate input
    if (!message.gameId) {
      return this.sendToClient(clientId, {
        unicity: true,
        type: 'error',
        error: 'Missing game ID',
        requestType: 'get_server_logs'
      });
    }
    
    // Check if this client owns the server
    const ownerClientId = this.gameServerOwners.get(message.gameId);
    if (ownerClientId !== clientId) {
      console.warn(`Client attempted to read logs from game server owned by another client`);
      
      return this.sendToClient(clientId, {
        unicity: true,
        type: 'error',
        error: 'You are not authorized to read logs from this server',
        requestType: 'get_server_logs'
      });
    }
    
    try {
      // Get the server logs
      const lines = message.lines || 100;
      const logs = await this.master.readGameServerLogs(message.gameId, lines);
      
      // Send the logs
      this.sendToClient(clientId, {
        unicity: true,
        type: 'game_server_logs',
        gameId: message.gameId,
        logs: logs
      });
    } catch (error) {
      console.error('Error getting game server logs:', error);
      
      this.sendToClient(clientId, {
        unicity: true,
        type: 'error',
        error: `Failed to get game server logs: ${error.message}`,
        requestType: 'get_server_logs'
      });
    }
  }
  
  /**
   * Handle request for all game servers
   * @param {string} clientId - Client ID
   */
  handleGetAllGameServers(clientId) {
    // Client requested list of all game servers
    
    // Check if we have a game server manager
    if (!this.gameServerManager && !this.master) {
      return this.sendToClient(clientId, {
        unicity: true,
        type: 'error',
        error: 'Game server management not available',
        requestType: 'get_all_game_servers'
      });
    }
    
    try {
      // Get all servers
      const servers = this.master.getAllGameServers();
      
      // Filter sensitive information
      const sanitizedServers = servers.map(server => ({
        gameId: server.gameId,
        name: server.name,
        map: server.map,
        players: server.players,
        maxPlayers: server.maxPlayers,
        uptime: server.uptime,
        state: server.state
      }));
      
      // Send the server list
      this.sendToClient(clientId, {
        unicity: true,
        type: 'all_game_servers',
        servers: sanitizedServers
      });
    } catch (error) {
      console.error('Error getting all game servers:', error);
      
      this.sendToClient(clientId, {
        unicity: true,
        type: 'error',
        error: `Failed to get all game servers: ${error.message}`,
        requestType: 'get_all_game_servers'
      });
    }
  }
  
  /**
   * Handle Unicity server registration
   * @param {string} clientId - Client ID
   * @param {Object} message - Registration message
   */
  handleRegisterUnicityServer(clientId, message) {
    const client = this.clients.get(clientId);
    if (!client) return;
    
    // Generate or use provided server ID
    const serverId = message.serverId || uuidv4();
    
    // Update client record
    client.isUnicityServer = true;
    client.unicityServerId = serverId;
    
    // Store server info
    this.unicityServers.set(serverId, {
      id: serverId,
      clientId: clientId,
      gameId: message.gameId || null,         // Associated game ID (for linking with Quake server)
      info: message.serverInfo || {},          // Server metadata
      gameState: message.gameState || {},      // Current game state
      players: message.players || [],          // Connected players
      lastUpdate: Date.now()
    });
    
    console.log(`Registered Unicity server ${serverId}`);
    
    // Send registration confirmation
    this.sendToClient(clientId, {
      unicity: true,
      type: 'unicity_server_registered',
      serverId: serverId
    });
  }
  
  /**
   * Handle request for Unicity servers list
   * @param {string} clientId - Client ID
   */
  handleGetUnicityServers(clientId) {
    // Convert Map to array of server objects
    const servers = Array.from(this.unicityServers.values()).map(server => {
      // Return a sanitized version without internal fields
      return {
        id: server.id,
        gameId: server.gameId,
        info: server.info,
        players: server.players.length
      };
    });
    
    // Sending Unicity servers to client
    
    // Send server list
    this.sendToClient(clientId, {
      unicity: true,
      type: 'unicity_server_list',
      servers: servers
    });
  }
  
  /**
   * Handle request to connect to a Unicity server
   * @param {string} clientId - Client ID
   * @param {Object} message - Connection request
   */
  handleConnectToUnicityServer(clientId, message) {
    const serverId = message.serverId;
    if (!serverId) {
      return this.sendToClient(clientId, {
        unicity: true,
        type: 'error',
        error: 'Missing server ID'
      });
    }
    
    // Find the server
    const server = this.unicityServers.get(serverId);
    if (!server) {
      return this.sendToClient(clientId, {
        unicity: true,
        type: 'error',
        error: 'Unicity server not found'
      });
    }
    
    // Get the server's client connection
    const serverClientId = server.clientId;
    const serverClient = this.clients.get(serverClientId);
    if (!serverClient) {
      return this.sendToClient(clientId, {
        unicity: true,
        type: 'error',
        error: 'Unicity server not connected'
      });
    }
    
    // Client requesting connection to Unicity server
    
    // Generate connection ID
    const connectionId = uuidv4();
    
    // Store in pending connections
    this.pendingConnections.set(connectionId, {
      id: connectionId,
      clientId: clientId,
      serverId: serverClientId,
      type: 'unicity',
      createdAt: Date.now(),
      state: 'pending'
    });
    
    // Forward connection request to server
    this.sendToClient(serverClientId, {
      unicity: true,
      type: 'unicity_connection_request',
      connectionId: connectionId,
      clientId: clientId,
      playerInfo: message.playerInfo || {}
    });
    
    // Send ICE servers to client for WebRTC connection
    this.sendToClient(clientId, {
      unicity: true,
      type: 'unicity_ice_config',
      connectionId: connectionId,
      serverId: serverId,
      iceServers: this.getIceServers()
    });
  }
  
  /**
   * Handle Unicity server heartbeat
   * @param {string} clientId - Client ID
   * @param {Object} message - Heartbeat message
   */
  handleUnicityHeartbeat(clientId, message) {
    const client = this.clients.get(clientId);
    if (!client || !client.isUnicityServer || !client.unicityServerId) return;
    
    const serverId = client.unicityServerId;
    const server = this.unicityServers.get(serverId);
    if (!server) return;
    
    // Update server info
    if (message.serverInfo) {
      server.info = { ...server.info, ...message.serverInfo };
    }
    
    // Update player list if provided
    if (message.players) {
      server.players = message.players;
    }
    
    // Update game state if provided
    if (message.gameState) {
      server.gameState = message.gameState;
    }
    
    // Update timestamp
    server.lastUpdate = Date.now();
    
    // Acknowledge heartbeat
    this.sendToClient(clientId, {
      unicity: true,
      type: 'unicity_heartbeat_ack'
    });
  }
  
  /**
   * Handle Unicity game state update
   * @param {string} clientId - Client ID
   * @param {Object} message - Game state message
   */
  handleUnicityGameState(clientId, message) {
    const client = this.clients.get(clientId);
    if (!client || !client.isUnicityServer || !client.unicityServerId) return;
    
    const serverId = client.unicityServerId;
    const server = this.unicityServers.get(serverId);
    if (!server) return;
    
    // Update game state
    server.gameState = message.gameState || {};
    
    // If there are targets specified, forward to those clients
    if (message.targetClientIds && Array.isArray(message.targetClientIds)) {
      message.targetClientIds.forEach(targetId => {
        // Forward game state update to client
        this.sendToClient(targetId, {
          unicity: true,
          type: 'unicity_game_state_update',
          serverId: serverId,
          gameState: message.gameState
        });
      });
    }
    
    // Acknowledge receipt
    this.sendToClient(clientId, {
      unicity: true,
      type: 'unicity_game_state_ack'
    });
  }
  
  /**
   * Handle Unicity token transaction
   * @param {string} clientId - Client ID
   * @param {Object} message - Transaction message
   */
  handleUnicityTokenTransaction(clientId, message) {
    // If from client to server
    if (message.serverId) {
      const serverId = message.serverId;
      const server = this.unicityServers.get(serverId);
      
      if (!server) {
        return this.sendToClient(clientId, {
          unicity: true,
          type: 'error',
          error: 'Unicity server not found'
        });
      }
      
      // Forward to server
      this.sendToClient(server.clientId, {
        unicity: true,
        type: 'unicity_token_transaction',
        transactionId: message.transactionId || uuidv4(),
        clientId: clientId,
        data: message.data
      });
    } 
    // If from server to client
    else if (message.clientId) {
      const targetClientId = message.clientId;
      
      // Forward to client
      this.sendToClient(targetClientId, {
        unicity: true,
        type: 'unicity_token_transaction',
        transactionId: message.transactionId,
        serverId: message.serverId,
        data: message.data
      });
    }
  }
  
  /**
   * Handle list servers request
   * @param {string} clientId - Client ID
   * @param {Object} message - List servers request
   */
  handleListServers(clientId, message) {
    // Client requested server list
    
    try {
      const servers = [];
      
      // Get game servers from manager
      if (this.gameServerManager) {
        const gameServers = this.gameServerManager.getAllServers();
        servers.push(...gameServers);
      }
      
      this.sendToClient(clientId, {
        type: 'server_list',
        requestId: message.requestId,
        servers: servers
      });
    } catch (error) {
      console.error('Error listing servers:', error);
      
      this.sendToClient(clientId, {
        type: 'error',
        requestId: message.requestId,
        error: `Failed to list servers: ${error.message}`
      });
    }
  }
  
  /**
   * Handle RCON command request
   * @param {string} clientId - Client ID
   * @param {Object} message - RCON command request
   */
  async handleRCONCommand(clientId, message) {
    // Client requested RCON command
    
    // Initialize QuakeJS RCON if not already done
    if (!this.quakeJSRCON) {
      const QuakeJSRCON = require('./quakejs-rcon');
      this.quakeJSRCON = new QuakeJSRCON(this.gameServerManager);
    }
    
    try {
      // Validate input
      if (!message.gameId) {
        return this.sendToClient(clientId, {
          type: 'rcon_response',
          requestId: message.requestId,
          error: 'Missing game server ID'
        });
      }
      
      if (!message.command) {
        return this.sendToClient(clientId, {
          type: 'rcon_response',
          requestId: message.requestId,
          error: 'Missing command'
        });
      }
      
      // Execute the RCON command
      const result = await this.quakeJSRCON.executeCommand(message.gameId, message.command);
      
      this.sendToClient(clientId, {
        type: 'rcon_response',
        requestId: message.requestId,
        gameId: message.gameId,
        command: message.command,
        result: result
      });
      
    } catch (error) {
      console.error('Error executing RCON command:', error);
      
      this.sendToClient(clientId, {
        type: 'rcon_response',
        requestId: message.requestId,
        gameId: message.gameId,
        command: message.command,
        error: error.message
      });
    }
  }
  
  /**
   * Handle RCON commands list request
   * @param {string} clientId - Client ID
   * @param {Object} message - RCON commands request
   */
  handleRCONCommands(clientId, message) {
    // Client requested available RCON commands
    
    try {
      // Initialize QuakeJS RCON if not already done
      if (!this.quakeJSRCON) {
        const QuakeJSRCON = require('./quakejs-rcon');
        this.quakeJSRCON = new QuakeJSRCON(this.gameServerManager);
      }
      
      const commands = this.quakeJSRCON.getAvailableCommands();
      
      this.sendToClient(clientId, {
        type: 'rcon_commands_response',
        requestId: message.requestId,
        commands: commands
      });
      
    } catch (error) {
      console.error('Error getting RCON commands:', error);
      
      this.sendToClient(clientId, {
        type: 'rcon_commands_response',
        requestId: message.requestId,
        error: error.message
      });
    }
  }

  /**
   * Handle game state token from server
   * @param {string} clientId - Server client ID
   * @param {Object} message - Game state token message
   */
  handleGameStateToken(clientId, message) {
    const client = this.clients.get(clientId);
    if (!client || !client.isServer) {
      console.warn(`Received game state token from non-server client ${clientId}`);
      return;
    }

    // Get the server peer ID (should be the same as client ID for servers)
    const serverPeerId = client.serverPeerId || clientId;
    
    console.log(`Received game state token from server ${serverPeerId} for frame ${message.frame}`);
    
    // Forward the token to all connected game clients (not servers)
    let clientCount = 0;
    for (const [targetClientId, targetClient] of this.clients.entries()) {
      if (!targetClient.isServer && targetClient.ws && targetClient.ws.readyState === 1) {
        try {
          this.sendToClient(targetClientId, {
            type: 'game:state:token',
            tokenFlow: message.tokenFlow,
            frame: message.frame,
            serverInfo: message.serverInfo,
            serverPeerId: serverPeerId
          });
          clientCount++;
        } catch (error) {
          console.error(`Failed to forward game state token to client ${targetClientId}:`, error);
        }
      }
    }
    
    console.log(`Forwarded game state token from server ${serverPeerId} to ${clientCount} clients`);
  }

  /**
   * Handle server state changes from server registry
   * @param {string} peerId - Server peer ID
   * @param {string} oldState - Previous state
   * @param {string} newState - New state
   * @param {Object} server - Server object
   */
  handleServerStateChange(peerId, oldState, newState, server) {
    console.log(`Server ${peerId} state changed: ${oldState} -> ${newState}`);
    
    // RESTART FUNCTIONALITY DISABLED
    // If server transitioned from starting to running, and it was restarted after game_over
    // TO RE-ENABLE RESTART: Uncomment the code block below
    /*
    if (oldState === 'starting' && newState === 'running' && server.metadata && server.metadata.gameRestarted) {
      console.log(`Server ${peerId} restarted and now running - notifying all clients to restart games`);
      
      // Broadcast server restart notification to all clients
      this.broadcastServerRestart(peerId, server);
      
      // Clear the restart flag
      this.serverRegistry.updateServer(peerId, {
        ...server.metadata,
        gameRestarted: false
      });
    }
    */
    
    // Always broadcast server list update when state changes
    this.broadcastServerListUpdate();
  }

  /**
   * Broadcast server restart notification to all connected clients
   * @param {string} peerId - Server peer ID
   * @param {Object} server - Server object
   */
  broadcastServerRestart(peerId, server) {
    console.log(`Broadcasting server restart notification for ${peerId} to all clients`);
    
    // Send to all clients that are not servers themselves
    for (const [clientId, client] of this.clients.entries()) {
      if (!client.isServer) {
        this.sendToClient(clientId, {
          type: 'server_restarted',
          serverPeerId: peerId,
          serverInfo: server.metadata,
          timestamp: Date.now()
        });
      }
    }
  }
}

module.exports = SignalingService;