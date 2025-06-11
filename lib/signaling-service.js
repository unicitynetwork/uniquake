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
    
    console.log('WebRTC signaling service initialized with Unicity support');
  }
  
  /**
   * Set the game server manager reference
   * @param {GameServerManager} gameServerManager - The game server manager
   */
  setGameServerManager(gameServerManager) {
    this.gameServerManager = gameServerManager;
    console.log('Game server manager registered with signaling service');
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
            console.debug('Non-JSON message received and no Quake handler available');
          }
        }
      });
      
      // Handle disconnection
      ws.on('close', () => {
        this.removeClient(clientId);
      });
      
      // Handle errors
      ws.on('error', (err) => {
        console.error(`Client ${clientId} websocket error:`, err);
        this.removeClient(clientId);
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
  }
  
  /**
   * Clean up stale Unicity servers
   */
  cleanupStaleUnicityServers() {
    const now = Date.now();
    const timeout = 5 * 60000; // 5 minutes timeout
    
    let cleanupCount = 0;
    
    for (const [id, server] of this.unicityServers.entries()) {
      if (now - server.lastUpdate > timeout) {
        this.unicityServers.delete(id);
        cleanupCount++;
      }
    }
    
    if (cleanupCount > 0) {
      console.log(`Cleaned up ${cleanupCount} stale Unicity servers`);
    }
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
    
    console.log(`Client ${clientId} connected`);
  }
  
  /**
   * Remove a client from the registry
   * @param {string} clientId - Client ID to remove
   */
  removeClient(clientId) {
    const client = this.clients.get(clientId);
    if (!client) return;
    
    console.log(`Client ${clientId} disconnected`);
    
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
      console.log(`Removed Unicity server ${client.unicityServerId}`);
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
    
    console.log(`Sent server list to client ${clientId}: ${servers.length} servers`);
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
      console.log(`Client ${clientId} requested WebSocket fallback connection to server ${targetPeerId}`);
      
      // Create WebSocket proxy connection
      const success = this.transportService.createProxyConnection(clientId, targetPeerId);
      
      if (success) {
        // Notify client about successful proxy connection
        this.sendToClient(clientId, {
          type: 'proxy_connection',
          serverPeerId: targetPeerId
        });
        
        console.log(`Created WebSocket proxy connection between client ${clientId} and server ${targetPeerId}`);
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
      clientId: clientId
    });
    
    // Send ICE configuration to client
    this.sendToClient(clientId, {
      type: 'ice_config',
      iceServers: this.getIceServers()
    });
    
    console.log(`Client ${clientId} requested WebRTC connection to server ${targetPeerId}`);
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
    
    console.log(`Forwarded offer from ${clientId} to ${targetId}`);
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
    
    console.log(`Forwarded answer from ${clientId} to ${targetId}`);
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
    
    console.log(`Connection established between client ${clientId} and server ${serverClient.peerId}`);
    
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
    
    console.log(`Connection failed between client ${clientId} and server: ${conn.error}`);
    
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
      console.warn(`Client ${clientId} sent proxy message without server peer ID`);
      return;
    }
    
    // Forward the message using the transport service
    const success = this.transportService.forwardToServer(clientId, serverPeerId, message.data);
    
    if (!success) {
      console.warn(`Failed to forward proxy message from client ${clientId} to server ${serverPeerId}`);
      
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
    
    // Find server's peer ID
    const server = this.clients.get(clientId);
    if (!server || !server.isServer || !server.peerId) {
      console.warn(`Received proxy_connection from non-server client: ${clientId}`);
      return;
    }
    
    console.log(`Server ${server.peerId} established proxy connection with client ${targetClientId}`);
    
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
        console.log(`Creating missing proxy connection from client ${targetClientId} to server ${server.peerId}`);
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
      console.warn(`Failed to send proxy_connection message to client ${targetClientId}`);
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
      console.warn(`Received proxy_data from non-server client: ${clientId}`);
      return;
    }
    
    console.log(`Server ${server.peerId} sending data to client ${targetClientId}`);
    
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
      console.warn(`Received proxy_client_disconnected from non-server client: ${clientId}`);
      return;
    }
    
    console.log(`Server ${server.peerId} disconnected from client ${targetClientId}`);
    
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
      console.warn(`Client ${clientId} sent disconnect message without server peer ID`);
      return;
    }
    
    console.log(`Client ${clientId} disconnecting from server ${serverPeerId}`);
    
    // Remove the proxy connection in the transport service
    this.transportService.removeClientProxyConnection(clientId, serverPeerId);
    
    // Notify client about successful disconnection
    this.sendToClient(clientId, {
      type: 'disconnect_ack',
      serverPeerId: serverPeerId
    });
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
    
    if (cleanupCount > 0) {
      console.log(`Cleaned up ${cleanupCount} stale pending connections`);
    }
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
    
    console.log(`Received Unicity message from ${clientId}: ${message.type}`);
    
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
          console.log('Forcing WebSocket fallback for Unicity connection (WebRTC disabled)');
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
    console.log(`Client ${clientId} requested to start a game server:`, message.serverInfo);
    
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
      
      // Send success response with server details
      this.sendToClient(clientId, {
        unicity: true,
        type: 'game_server_started',
        gameId: gameId,
        serverInfo: {
          name: serverInstance.serverInfo.name,
          address: serverInstance.serverInfo.address,
          map: serverInstance.serverInfo.map,
          maxPlayers: serverInstance.serverInfo.maxPlayers
        },
        success: true
      });
      
      console.log(`Started game server ${gameId} for client ${clientId}`);
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
    console.log(`Client ${clientId} requested to stop game server: ${message.gameId}`);
    
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
      console.warn(`Client ${clientId} attempted to stop game server ${message.gameId} owned by ${ownerClientId}`);
      
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
      
      // Send success response
      this.sendToClient(clientId, {
        unicity: true,
        type: 'game_server_stopped',
        gameId: message.gameId,
        success: true
      });
      
      console.log(`Stopped game server ${message.gameId}`);
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
    console.log(`Client ${clientId} requested game server status: ${message.gameId}`);
    
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
    console.log(`Client ${clientId} requested game server logs: ${message.gameId}`);
    
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
      console.warn(`Client ${clientId} attempted to read logs from game server ${message.gameId} owned by ${ownerClientId}`);
      
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
    console.log(`Client ${clientId} requested list of all game servers`);
    
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
    
    console.log(`Registered Unicity server ${serverId} from client ${clientId}`);
    
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
    
    console.log(`Sending ${servers.length} Unicity servers to client ${clientId}`);
    
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
    
    console.log(`Client ${clientId} requesting connection to Unicity server ${serverId}`);
    
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
}

module.exports = SignalingService;