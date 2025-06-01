/**
 * WebRTC signaling service for P2P game connections
 * Handles SDP and ICE candidate exchange between peers
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
  constructor(wsServer, serverRegistry, credentialManager, transportService) {
    this.wsServer = wsServer;
    this.serverRegistry = serverRegistry;
    this.credentialManager = credentialManager;
    this.transportService = transportService;
    
    // Map client ID -> client connection data
    this.clients = new Map();
    
    // Map connection ID -> pending connection data
    this.pendingConnections = new Map();
    
    console.log('WebRTC signaling service initialized');
  }
  
  /**
   * Start the signaling service
   */
  start() {
    this.wsServer.on('connection', (ws) => {
      // Generate a unique ID for this client
      const clientId = uuidv4();
      
      // Initialize client in our registry
      this.addClient(clientId, ws);
      
      // Setup message handler
      ws.on('message', (data) => {
        // Handle both text and binary messages
        let message;
        try {
          if (data instanceof Buffer) {
            // Try to parse as JSON
            message = JSON.parse(data.toString('utf8'));
          } else {
            message = JSON.parse(data);
          }
          this.handleSignalingMessage(clientId, message);
        } catch (err) {
          console.warn('Failed to parse message:', err.message);
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
        iceServers: this.getIceServers()
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
    }
    
    // Clean up any pending connections
    this.pendingConnections.forEach((conn, id) => {
      if (conn.clientId === clientId || conn.serverId === clientId) {
        this.pendingConnections.delete(id);
      }
    });
    
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
}

module.exports = SignalingService;