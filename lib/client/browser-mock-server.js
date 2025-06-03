/**
 * Browser Mock Game Server for testing WebRTC P2P connections
 * 
 * This is a browser-compatible version of the mock-server-client.js
 * Provides the same functionality for testing in a web browser environment
 */

(function(window) {
  'use strict';

  // Compatibility helpers for browser environment
  const log = console.log.bind(console);
  const error = console.error.bind(console);
  const warn = console.warn.bind(console);
  const debug = window.UNIQUAKE_CONFIG?.debug ? console.debug.bind(console) : function() {};

  /**
   * Mock Server Channel for the browser environment
   */
  class MockServerChannel {
    constructor(clientId) {
      this.clientId = clientId;
      this.readyState = 'connecting';
      
      // Event handlers
      this.onopen = null;
      this.onmessage = null;
      this.onclose = null;
      this.onerror = null;
    }
    
    // Send a message
    send(data) {
      debug(`[Server] Channel sent to ${this.clientId}: ${typeof data === 'string' ? 
        (data.substr(0, 30) + '...') : 
        JSON.stringify(data).substr(0, 30) + '...'}`);
      return true;
    }
    
    // Close the channel
    close() {
      this._close();
    }
    
    // Set channel to open state
    open() {
      this.readyState = 'open';
      if (this.onopen) {
        this.onopen();
      }
    }
    
    // Internal close method
    _close() {
      this.readyState = 'closed';
      if (this.onclose) {
        this.onclose();
      }
    }
    
    // Receive a message
    receiveMessage(data) {
      if (this.onmessage) {
        // Create a proper message event object
        const event = { 
          data: data,
          type: 'message' 
        };
        
        // Call the message handler
        this.onmessage(event);
      } else {
        warn(`No message handler defined for channel to client ${this.clientId}`);
      }
    }
  }

  /**
   * Browser Mock Game Server
   */
  class BrowserMockServer {
    /**
     * Create a new browser mock server
     * @param {Object} config - Server configuration
     */
    constructor(config = {}) {
      // Configuration
      this.config = Object.assign({
        masterServer: 'localhost:27950',
        serverName: 'BrowserMockServer',
        map: 'browser_map',
        game: 'baseq3',
        maxPlayers: 16,
        tokenEnabled: true,
        entryFee: 1,
        stateInterval: 10, // seconds between token updates
        debug: false,
        logElement: null,
        onStatusUpdate: null,
        onClientConnect: null,
        onClientDisconnect: null,
        onChatMessage: null
      }, config);

      // Server state
      this.serverState = {
        peerId: null,
        connections: new Map(), // Map of clientId -> channel connection
        clients: new Map(),     // Map of clientId -> client state
        signaling: null,        // WebSocket connection to master server
        heartbeatInterval: null,
        gameStateInterval: null, // Interval for game state token broadcasting
        registered: false,
        
        // Token-related state
        tokenService: null,    // TokenService instance
        clientTokens: new Map(), // Map of clientId -> entry tokens
        gameState: {           // Current game state for token verification
          gameId: `game-${Date.now()}`,
          frame: 0,
          timestamp: Date.now(),
          players: {}
        },
        collectedTokens: []    // Entry tokens collected from clients
      };

      // Server info
      this.serverInfo = {
        name: this.config.serverName,
        map: this.config.map,
        game: this.config.game,
        players: 0,
        maxPlayers: this.config.maxPlayers
      };

      // Event handlers
      this.eventHandlers = {
        statusUpdate: [],
        clientConnect: [],
        clientDisconnect: [],
        chatMessage: [],
        tokenEntry: [],
        gameStateUpdate: []
      };

      // Register callbacks if provided
      if (this.config.onStatusUpdate) this.on('statusUpdate', this.config.onStatusUpdate);
      if (this.config.onClientConnect) this.on('clientConnect', this.config.onClientConnect);
      if (this.config.onClientDisconnect) this.on('clientDisconnect', this.config.onClientDisconnect);
      if (this.config.onChatMessage) this.on('chatMessage', this.config.onChatMessage);

      // Set up logging
      this.logToElement = this.config.logElement ? 
        (msg) => { 
          const elem = document.getElementById(this.config.logElement);
          if (elem) {
            elem.innerHTML += msg + '<br>'; 
            elem.scrollTop = elem.scrollHeight;
          }
        } : 
        () => {};
    }

    /**
     * Initialize the server
     */
    async init() {
      this.log('Initializing browser mock server...');
      
      // Initialize token service if UniQuakeTokenService is available
      if (window.UniQuakeTokenService && this.config.tokenEnabled) {
        await this.initializeTokenService();
      } else {
        this.log('Token service not available or disabled - running without token features');
      }
      
      // Connect to master server
      console.log('About to connect to master server');
      const connected = await this.connectToMasterServer();
      console.log('Connected to master server:', connected);
      
      if (connected) {
        console.log('Registering server with master');
        const registered = await this.registerServer();
        console.log('Server registration result:', registered);
      }
      
      // Emit initial status update
      this.emitStatusUpdate();
      
      return true;
    }

    /**
     * Initialize token service
     */
    async initializeTokenService() {
      try {
        this.log('Initializing token service...');
        
        // Create token service with server name as username
        this.serverState.tokenService = new window.UniQuakeTokenService({
          username: this.serverInfo.name,
          debug: this.config.debug
        });
        
        // Initialize the service
        await this.serverState.tokenService.init();
        
        // Get identity info
        const identity = this.serverState.tokenService.getIdentity();
        this.log(`Token service initialized with identity: ${identity.username} (${identity.pubkey.substring(0, 10)}...)`);
        
        return true;
      } catch (error) {
        this.error('Failed to initialize token service:', error);
        return false;
      }
    }

    /**
     * Connect to the master server
     */
    async connectToMasterServer() {
      return new Promise((resolve, reject) => {
        // Use the provided URL directly (should already include ws:// protocol)
        const masterUrl = this.config.masterServer;
        console.log('MASTER URL (raw):', this.config.masterServer);
        console.log('MASTER URL (used):', masterUrl);
        this.log(`Connecting to master server at ${masterUrl}...`);
        
        try {
          this.serverState.signaling = new WebSocket(masterUrl);
          
          this.serverState.signaling.onopen = () => {
            this.log('Connected to master server');
            resolve(true);
          };
          
          this.serverState.signaling.onmessage = (event) => {
            try {
              console.log('Raw message from master:', event.data);
              const message = JSON.parse(event.data);
              console.log('Parsed message from master:', message);
              this.handleSignalingMessage(message);
            } catch (err) {
              this.error('Failed to parse message:', err.message, 'Raw data:', event.data);
            }
          };
          
          this.serverState.signaling.onclose = () => {
            this.log('Disconnected from master server');
            
            // Clear heartbeat interval
            if (this.serverState.heartbeatInterval) {
              clearInterval(this.serverState.heartbeatInterval);
              this.serverState.heartbeatInterval = null;
            }
            
            // Mark as unregistered
            this.serverState.registered = false;
            
            // Try to reconnect after a delay
            setTimeout(() => this.connectToMasterServer(), 5000);
            
            resolve(false);
          };
          
          this.serverState.signaling.onerror = (err) => {
            console.error('Master server connection error (raw):', err);
            this.error('Master server connection error:', err.message || 'Unknown error');
            this.error('WebSocket error:', err.message);
            reject(err);
          };
        } catch (err) {
          this.error('Failed to connect to master server:', err);
          reject(err);
        }
      });
    }

    /**
     * Register server with master server
     */
    async registerServer() {
      if (!this.serverState.signaling || this.serverState.signaling.readyState !== WebSocket.OPEN) {
        this.error('Cannot register server: not connected to master server');
        return false;
      }
      
      // Add token-related info to server info
      const serverInfoWithTokens = {
        ...this.serverInfo,
        tokenEnabled: !!this.serverState.tokenService,
        entryFee: this.config.entryFee
      };
      
      // If token service is initialized, include the identity information
      if (this.serverState.tokenService) {
        serverInfoWithTokens.identity = this.serverState.tokenService.getIdentity();
      }
      
      this.log('Registering server with master server...');
      
      console.log('REGISTERING SERVER WITH INFO:', serverInfoWithTokens);
      this.sendToMaster({
        type: 'register_server',
        serverInfo: serverInfoWithTokens
      });
      
      // Wait for registration confirmation
      return new Promise((resolve) => {
        const checkInterval = setInterval(() => {
          if (this.serverState.registered) {
            clearInterval(checkInterval);
            clearTimeout(timeout);
            resolve(true);
          }
        }, 100);
        
        // Timeout after 5 seconds
        const timeout = setTimeout(() => {
          clearInterval(checkInterval);
          resolve(false);
        }, 5000);
      });
    }

    /**
     * Unregister server from master server
     */
    async unregisterServer() {
      if (!this.serverState.signaling || this.serverState.signaling.readyState !== WebSocket.OPEN) {
        this.error('Cannot unregister server: not connected to master server');
        return false;
      }
      
      if (!this.serverState.registered) {
        this.log('Server is not registered');
        return true;
      }
      
      this.log('Unregistering server from master server...');
      
      this.sendToMaster({
        type: 'unregister_server'
      });
      
      // Clear heartbeat interval
      if (this.serverState.heartbeatInterval) {
        clearInterval(this.serverState.heartbeatInterval);
        this.serverState.heartbeatInterval = null;
      }
      
      // Clear game state interval
      if (this.serverState.gameStateInterval) {
        clearInterval(this.serverState.gameStateInterval);
        this.serverState.gameStateInterval = null;
      }
      
      // Mark as unregistered
      this.serverState.registered = false;
      
      // Emit status update
      this.emitStatusUpdate();
      
      return true;
    }

    /**
     * Start sending periodic heartbeats to the master server
     */
    startHeartbeats() {
      // Clear any existing interval
      if (this.serverState.heartbeatInterval) {
        clearInterval(this.serverState.heartbeatInterval);
      }
      
      // Start a new interval
      this.serverState.heartbeatInterval = setInterval(() => {
        this.sendToMaster({
          type: 'heartbeat',
          serverInfo: this.serverInfo
        });
      }, 30000); // every 30 seconds
    }

    /**
     * Handle incoming signaling messages
     */
    handleSignalingMessage(message) {
      this.debug(`Received message: ${message.type}`);
      console.log('SERVER RECEIVED MESSAGE:', message);
      
      switch (message.type) {
        case 'connected':
          this.log(`Connected to signaling server with client ID: ${message.clientId}`);
          break;
          
        case 'server_registered':
          this.log(`Registered as game server with peer ID: ${message.peerId}`);
          this.serverState.peerId = message.peerId;
          this.serverState.registered = true;
          
          // Start sending heartbeats
          this.startHeartbeats();
          
          // Start game state token broadcasts if token service is available
          if (this.serverState.tokenService) {
            this.startGameStateTokens();
          }
          
          // Emit status update
          this.emitStatusUpdate();
          break;
          
        case 'connection_request':
          this.handleConnectionRequest(message);
          break;
          
        case 'heartbeat_ack':
          // Nothing to do
          break;
          
        case 'proxy_connection':
          this.handleProxyConnection(message);
          break;
          
        case 'proxy_data':
          this.handleProxyData(message);
          break;
          
        default:
          this.debug(`Unhandled message type: ${message.type}`);
          break;
      }
    }

    /**
     * Handle connection request from a client
     */
    handleConnectionRequest(message) {
      const { connectionId, clientId, identity } = message;
      
      this.log(`Received connection request from client ${clientId}`);
      
      // Store client identity if provided
      let clientIdentity = null;
      if (identity) {
        clientIdentity = {
          pubkey: identity.pubkey,
          username: identity.username
        };
        this.log(`Client identity: ${identity.username} (${identity.pubkey.substring(0, 10)}...)`);
      }
      
      // Create a new channel for this client
      const channel = new MockServerChannel(clientId);
      
      // Set up channel handlers
      this.setupChannel(channel, clientId);
      
      // Store connection state
      this.serverState.connections.set(clientId, channel);
      
      // Add client to our clients map
      this.serverState.clients.set(clientId, {
        id: clientId,
        connectionId: connectionId,
        connected: true,
        pubkey: clientIdentity ? clientIdentity.pubkey : null,
        username: clientIdentity ? clientIdentity.username : clientId,
        entryTokenReceived: false
      });
      
      // Update player count
      this.serverInfo.players++;
      this.log(`Client ${clientId} connected. Players: ${this.serverInfo.players}`);
      
      // Send connection acceptance to master server
      this.sendToMaster({
        type: 'proxy_connection',
        clientId: clientId,
        connectionId: connectionId,
        // Include server identity for token operations
        serverIdentity: this.serverState.tokenService ? {
          pubkey: this.serverState.tokenService.getIdentity().pubkey,
          username: this.serverState.tokenService.getIdentity().username
        } : null
      });
      
      // Set channel to open state
      channel.open();
      
      // Emit client connect event
      this.emit('clientConnect', {
        id: clientId,
        username: clientIdentity ? clientIdentity.username : clientId,
        pubkey: clientIdentity ? clientIdentity.pubkey : null
      });
      
      // Emit status update
      this.emitStatusUpdate();
    }

    /**
     * Set up channel handlers
     */
    setupChannel(channel, clientId) {
      channel.onopen = () => {
        this.log(`Channel open for client ${clientId}`);
        
        // Send welcome message
        const welcomeMessage = {
          type: 'welcome',
          message: `Welcome to ${this.serverInfo.name}!`,
          serverInfo: this.serverInfo,
          // Include server identity for token operations if available
          serverIdentity: this.serverState.tokenService ? {
            pubkey: this.serverState.tokenService.getIdentity().pubkey,
            username: this.serverState.tokenService.getIdentity().username
          } : null
        };
        
        // Send via proxy instead of directly through channel
        this.sendToClient(clientId, welcomeMessage);
      };
      
      channel.onmessage = (event) => {
        let message;
        try {
          // Try to parse as JSON if it's a string
          if (typeof event.data === 'string') {
            try {
              message = JSON.parse(event.data);
            } catch (parseErr) {
              this.error(`Failed to parse string as JSON from client ${clientId}: ${parseErr.message}`);
              return; // Can't proceed without valid message
            }
          } else if (typeof event.data === 'object') {
            // If it's already an object, use it directly
            message = event.data;
          } else {
            throw new Error(`Unexpected data type: ${typeof event.data}`);
          }
          
          if (!message || !message.type) {
            this.error(`Invalid message format from client ${clientId}: missing 'type' property`);
            return;
          }
          
          // Handle different message types
          switch (message.type) {
            case 'chat':
              // Get client info
              const client = this.serverState.clients.get(clientId);
              const username = client ? client.username || clientId : clientId;
              
              // Broadcast chat message to all clients with proper formatting
              this.broadcast({
                type: 'chat',
                from: username,
                message: message.message,
                timestamp: Date.now()
              });
              
              // Emit chat message event
              this.emit('chatMessage', {
                clientId: clientId,
                username: username,
                message: message.message
              });
              break;
              
            case 'ping':
              // Send pong response via proxy
              this.sendToClient(clientId, {
                type: 'pong',
                timestamp: message.timestamp
              });
              break;
              
            // Token-related messages
            case 'token:entry':
              this.handleEntryToken(clientId, message);
              break;
            
            case 'identity:update':
              // Handle client identity update
              if (message.identity && message.identity.pubkey) {
                const client = this.serverState.clients.get(clientId);
                if (client) {
                  client.pubkey = message.identity.pubkey;
                  client.username = message.identity.username || client.username;
                  this.log(`Updated client identity for ${clientId}: ${client.username} (${client.pubkey.substring(0, 10)}...)`);
                  
                  // Send acknowledgment
                  this.sendToClient(clientId, {
                    type: 'identity:update:ack',
                    success: true
                  });
                }
              }
              break;
              
            case 'request:game:state:token':
              this.handleGameStateTokenRequest(clientId);
              break;
              
            default:
              this.debug(`Unhandled message type from client ${clientId}: ${message.type}`);
              break;
          }
        } catch (err) {
          this.error(`Error processing message from client ${clientId}: ${err.message}`);
          this.error(err.stack);
        }
      };
      
      channel.onclose = () => {
        this.log(`Channel closed for client ${clientId}`);
        this.handleClientDisconnect(clientId);
      };
      
      channel.onerror = (error) => {
        this.error(`Channel error (${clientId}):`, error);
      };
    }

    /**
     * Handle client disconnection
     */
    handleClientDisconnect(clientId) {
      // Get client before removing
      const client = this.serverState.clients.get(clientId);
      
      // Remove connection
      const channel = this.serverState.connections.get(clientId);
      if (channel) {
        // Close the channel
        channel.close();
        
        // Notify master server
        this.sendToMaster({
          type: 'proxy_client_disconnected',
          clientId: clientId
        });
        
        // Remove connection
        this.serverState.connections.delete(clientId);
      }
      
      // Remove client
      if (this.serverState.clients.has(clientId)) {
        this.serverState.clients.delete(clientId);
        
        // Update player count
        if (this.serverInfo.players > 0) {
          this.serverInfo.players--;
        }
        
        this.log(`Client ${clientId} disconnected. Players: ${this.serverInfo.players}`);
        
        // Emit client disconnect event if we had client info
        if (client) {
          this.emit('clientDisconnect', {
            id: clientId,
            username: client.username,
            pubkey: client.pubkey
          });
        }
        
        // Emit status update
        this.emitStatusUpdate();
      }
    }

    /**
     * Handle proxy connection message from master server
     */
    handleProxyConnection(message) {
      const { clientId, connectionId } = message;
      
      // Create a new channel for this client if it doesn't exist already
      if (!this.serverState.connections.has(clientId)) {
        const channel = new MockServerChannel(clientId);
        
        // Set up channel handlers
        this.setupChannel(channel, clientId);
        
        // Store connection state
        this.serverState.connections.set(clientId, channel);
        
        // Check if we already have data for this client
        const existingClient = this.serverState.clients.get(clientId);
        
        // Add client to our clients map, preserving any existing data like pubkey
        this.serverState.clients.set(clientId, {
          id: clientId,
          connectionId: connectionId,
          connected: true,
          // Preserve pubkey and username if they already exist
          pubkey: existingClient ? existingClient.pubkey : null,
          username: existingClient ? existingClient.username : clientId,
          entryTokenReceived: existingClient ? existingClient.entryTokenReceived : false
        });
        
        // Update player count
        this.serverInfo.players++;
        this.log(`Client ${clientId} connected. Players: ${this.serverInfo.players}`);
        
        // Set channel to open state
        channel.open();
        
        // Emit client connect event
        this.emit('clientConnect', {
          id: clientId,
          username: existingClient ? existingClient.username : clientId,
          pubkey: existingClient ? existingClient.pubkey : null
        });
        
        // Emit status update
        this.emitStatusUpdate();
      } else {
        // Silently update connection ID
        const client = this.serverState.clients.get(clientId);
        if (client) {
          client.connectionId = connectionId;
        }
      }
    }

    /**
     * Handle proxy data from client
     */
    handleProxyData(message) {
      const { clientId, connectionId, data } = message;
      
      // If client is not in our registry, but we got data, create a connection
      if (!this.serverState.clients.has(clientId)) {
        this.warn(`Received proxy data from unknown client: ${clientId}`);
        
        // Create connection on-demand (this is a recovery mechanism)
        if (connectionId) {
          this.log(`Creating missing connection for client ${clientId}`);
          
          // Extract identity data if present in the message
          let identity = null;
          if (data && data.identity) {
            identity = data.identity;
            this.log(`Found identity in data: ${identity.username} (${identity.pubkey.substring(0, 10)}...)`);
          }
          
          this.handleProxyConnection({
            clientId: clientId,
            connectionId: connectionId,
            identity: identity
          });
        } else {
          return;
        }
      }
      
      // Get the client's channel
      const channel = this.serverState.connections.get(clientId);
      if (!channel) {
        this.warn(`No channel found for client ${clientId}`);
        return;
      }
      
      // Forward the message to the channel
      // We need to handle both string and object formats
      try {
        if (typeof data === 'string') {
          // If it's a string, try to parse it first in case it's a stringified JSON
          try {
            const parsedData = JSON.parse(data);
            channel.receiveMessage(parsedData);
          } catch (parseErr) {
            // If parsing fails, it's a plain string message
            channel.receiveMessage(data);
          }
        } else {
          // If it's already an object, send it directly
          channel.receiveMessage(data);
        }
      } catch (err) {
        this.error(`Failed to process data from client ${clientId}:`, err);
        this.error(err.stack);
      }
    }

    /**
     * Send a message to the master server
     */
    sendToMaster(message) {
      if (!this.serverState.signaling || this.serverState.signaling.readyState !== WebSocket.OPEN) {
        this.warn('Cannot send message: not connected to master server');
        return false;
      }
      
      try {
        this.serverState.signaling.send(JSON.stringify(message));
        return true;
      } catch (err) {
        this.error('Failed to send message to master server:', err);
        return false;
      }
    }

    /**
     * Send data to a client via WebSocket proxy
     */
    sendToClient(clientId, data) {
      if (!this.serverState.signaling || this.serverState.signaling.readyState !== WebSocket.OPEN) {
        this.warn('Cannot send data: not connected to master server');
        return false;
      }
      
      // Ensure client exists
      const client = this.serverState.clients.get(clientId);
      if (!client) {
        this.warn(`Cannot send data: client ${clientId} not found`);
        return false;
      }
      
      try {
        const message = {
          type: 'proxy_data',
          clientId: clientId,
          connectionId: client.connectionId || 'mock-connection',
          data: data
        };
        
        this.serverState.signaling.send(JSON.stringify(message));
        return true;
      } catch (err) {
        this.error(`Failed to send data to client ${clientId}:`, err);
        return false;
      }
    }

    /**
     * Broadcast a message to all connected clients
     */
    broadcast(message) {
      let count = 0;
      
      // Log the actual message content (truncated to 160 chars)
      const messageStr = JSON.stringify(message);
      this.debug(`Broadcasting message: ${messageStr.length > 160 ? messageStr.substring(0, 160) + '...' : messageStr}`);
      
      // Get all channels and send message
      this.serverState.clients.forEach((client, clientId) => {
        const channel = this.serverState.connections.get(clientId);
        if (channel && channel.readyState === 'open') {
          // Send message through the proxy
          try {
            const result = this.sendToClient(clientId, message);
            if (result) {
              count++;
            }
          } catch (err) {
            this.error(`Failed to send to client ${clientId}:`, err);
          }
        }
      });
      
      this.debug(`Broadcast message to ${count} clients`);
      return count;
    }

    /**
     * Send a broadcast chat message from the server
     * @param {string} message - The message text to broadcast
     */
    broadcastMessage(message) {
      return this.broadcast({
        type: 'chat',
        from: 'SERVER',
        message: message,
        timestamp: Date.now()
      });
    }

    /**
     * Kick a client from the server
     */
    kickClient(clientId, reason = 'Kicked by server') {
      if (!this.serverState.clients.has(clientId)) {
        this.log(`Client ${clientId} not found`);
        return false;
      }
      
      // Send kick message
      this.sendToClient(clientId, {
        type: 'kick',
        reason: reason
      });
      
      // Disconnect the client
      this.handleClientDisconnect(clientId);
      this.log(`Kicked client ${clientId}: ${reason}`);
      
      return true;
    }

    /**
     * Get server status information
     * @param {boolean} emitEvent - Whether to emit a statusUpdate event (default: true)
     */
    getStatus(emitEvent = true) {
      // Basic status
      const status = {
        peerId: this.serverState.peerId,
        name: this.serverInfo.name,
        map: this.serverInfo.map,
        game: this.serverInfo.game,
        players: this.serverInfo.players,
        maxPlayers: this.serverInfo.maxPlayers,
        registered: this.serverState.registered,
        clients: this.getClients()
      };
      
      // Add token information if available
      if (this.serverState.tokenService) {
        try {
          const tokenStatus = this.serverState.tokenService.getTokenStatus();
          const identity = this.serverState.tokenService.getIdentity();
          
          status.tokens = {
            identity: {
              username: identity.username,
              pubkey: identity.pubkey
            },
            entry: this.serverState.collectedTokens.length,
            totalValue: tokenStatus.value
          };
          
          status.gameState = {
            frame: this.serverState.gameState.frame,
            timestamp: this.serverState.gameState.timestamp,
            playerCount: Object.keys(this.serverState.gameState.players).length
          };
        } catch (error) {
          status.tokens = { error: error.message };
        }
      }
      
      // IMPORTANT: We only emit a status update if specifically requested
      // to avoid infinite recursion with event handlers that call getStatus()
      if (emitEvent !== false) {
        this.emit('statusUpdate', status);
      }
      
      return status;
    }

    /**
     * Get list of connected clients
     */
    getClients() {
      const clients = [];
      
      this.serverState.clients.forEach((client, clientId) => {
        clients.push({
          id: clientId,
          username: client.username || clientId,
          pubkey: client.pubkey,
          entryTokenReceived: client.entryTokenReceived
        });
      });
      
      return clients;
    }

    /**
     * Handle entry token from client
     */
    async handleEntryToken(clientId, message) {
      if (!this.serverState.tokenService) {
        this.log(`Received entry token from client ${clientId} but token service is disabled`);
        
        // Send rejection message
        this.sendToClient(clientId, {
          type: 'token:entry:ack',
          success: false,
          reason: 'Token service is disabled on this server'
        });
        
        return;
      }
      
      this.log(`Received entry token from client ${clientId}`);
      
      const client = this.serverState.clients.get(clientId);
      if (!client) {
        this.log(`Client ${clientId} not found`);
        return;
      }
      
      // Check if client already sent an entry token
      if (client.entryTokenReceived) {
        this.log(`Client ${clientId} already sent an entry token`);
        
        // Send acknowledgment
        this.sendToClient(clientId, {
          type: 'token:entry:ack',
          success: true,
          message: 'Entry token already received'
        });
        
        return;
      }
      
      // Validate the token
      try {
        const tokenFlow = message.tokenFlow;
        const result = await this.validateEntryToken(clientId, tokenFlow);
        
        if (result.success) {
          // Mark client as having sent an entry token
          client.entryTokenReceived = true;
          
          // Send acknowledgment
          this.sendToClient(clientId, {
            type: 'token:entry:ack',
            success: true,
            message: 'Entry token accepted'
          });
          
          // Also broadcast a message to all clients
          this.broadcastMessage(`${client.username || clientId} has paid the entry fee!`);
          
          // Emit token entry event
          this.emit('tokenEntry', {
            clientId: clientId,
            username: client.username,
            success: true
          });
        } else {
          // Send rejection
          this.sendToClient(clientId, {
            type: 'token:entry:ack',
            success: false,
            reason: result.reason || 'Invalid token'
          });
          
          // Emit token entry event
          this.emit('tokenEntry', {
            clientId: clientId,
            username: client.username,
            success: false,
            reason: result.reason
          });
        }
      } catch (error) {
        this.error(`Error processing entry token from client ${clientId}:`, error.message);
        
        // Send error message
        this.sendToClient(clientId, {
          type: 'token:entry:ack',
          success: false,
          reason: error.message
        });
      }
    }

    /**
     * Process an entry token from a client
     */
    async validateEntryToken(clientId, tokenFlow) {
      if (!this.serverState.tokenService) {
        return { success: false, reason: 'Token service not enabled on server' };
      }
      
      try {
        this.log(`Validating entry token from client ${clientId}...`);
        
        // Receive and validate the token
        const result = await this.serverState.tokenService.receiveToken(tokenFlow);
        
        if (result.success) {
          // Store the token in the client tokens map
          this.serverState.clientTokens.set(clientId, result.token);
          
          // Add to collected tokens
          this.serverState.collectedTokens.push(result.token);
          
          this.log(`Valid entry token received from client ${clientId}`);
          return { success: true };
        } else {
          this.log(`Invalid entry token from client ${clientId}: ${result.error}`);
          return { success: false, reason: result.error };
        }
      } catch (error) {
        this.error(`Error processing entry token from client ${clientId}:`, error.message);
        return { success: false, reason: error.message };
      }
    }

    /**
     * Handle game state token request from client
     */
    async handleGameStateTokenRequest(clientId) {
      if (!this.serverState.tokenService) {
        this.log(`Received game state token request from client ${clientId} but token service is disabled`);
        return;
      }
      
      this.log(`Received game state token request from client ${clientId}`);
      
      try {
        // Use the existing game state token or create a new one if needed
        if (!this.serverState.tokenService.lastStateToken) {
          await this.createGameStateToken(false);
        }
        
        if (this.serverState.tokenService.lastStateToken) {
          // Export the token flow with all transitions
          const tokenFlow = this.serverState.tokenService.TXF.exportFlow(this.serverState.tokenService.lastStateToken);
          
          // Send to the requesting client
          this.sendToClient(clientId, {
            type: 'game:state:token',
            tokenFlow: tokenFlow,
            frame: this.serverState.gameState.frame
          });
          
          this.log(`Sent game state token to client ${clientId}`);
        } else {
          this.log(`Failed to process game state token for client ${clientId}`);
        }
      } catch (error) {
        this.error(`Error sending game state token to client ${clientId}:`, error.message);
      }
    }

    /**
     * Create a game state token and broadcast to all clients
     */
    async createGameStateToken(broadcast = true) {
      if (!this.serverState.tokenService) {
        return null;
      }
      
      // Set flag to indicate update is in progress
      this.serverState.isUpdatingGameState = true;
      
      try {
        // ALWAYS get the complete game state from the game instance if available
        // This ensures we're using exactly the same game state object, not just copying values
        if (this.gameInstance) {
          // Get a fresh copy of the current game state
          const currentGameState = this.gameInstance.getGameState();
          
          // Log the frame numbers to help debug
          this.debug(`Syncing frames - Server frame: ${this.serverState.gameState.frame}, Game frame: ${currentGameState.frame}`);
          
          // Create a normalized version for consistent hashing if the window function exists
          if (typeof window !== 'undefined' && window.normalizeGameState) {
            this.debug('Using normalized game state for consistent hashing');
            const normalizedState = window.normalizeGameState(currentGameState);
            this.debug(`Normalized state: ${JSON.stringify(normalizedState)}`);
          }
          
          // Replace our gameState object completely instead of just updating fields
          this.serverState.gameState = {
            gameId: currentGameState.gameId,
            frame: currentGameState.frame,
            timestamp: currentGameState.timestamp,
            players: {}
          };
          
          // Add additional state for each connected client
          this.serverState.clients.forEach((client, clientId) => {
            // Start with game player data if it exists
            const playerData = currentGameState.players[clientId] || {};
            
            // Add connection data
            this.serverState.gameState.players[clientId] = {
              ...playerData,
              connected: client.connected,
              connectionId: client.connectionId,
              lastActive: Date.now()
            };
          });
        } else {
          // Fallback to incrementing our own frame
          this.serverState.gameState.timestamp = Date.now();
          this.serverState.gameState.frame++;
          
          // Add basic state for each connected client
          this.serverState.gameState.players = {};
          this.serverState.clients.forEach((client, clientId) => {
            this.serverState.gameState.players[clientId] = {
              connected: client.connected,
              connectionId: client.connectionId,
              lastActive: Date.now()
            };
          });
        }
        
        // Log the game state frame number being used
        this.log(`Creating token for game state frame ${this.serverState.gameState.frame}`);
        
        // Create a token with the game state if we don't have one yet
        // or update the existing token with the new state
        let token = null;
        
        if (!this.serverState.tokenService.lastStateToken) {
          this.log('Creating initial game state token...');
          token = await this.serverState.tokenService.createGameStateToken(this.serverState.gameState);
          this.log(`Created initial game state token for frame ${this.serverState.gameState.frame}`);
        } else {
          this.log('Updating existing game state token...');
          try {
            token = await this.serverState.tokenService.updateGameStateToken(
              this.serverState.tokenService.lastStateToken,
              this.serverState.gameState
            );
            this.log(`Updated game state token for frame ${this.serverState.gameState.frame}`);
          } catch (updateError) {
            // If update fails, create a new token instead
            this.warn(`Could not update token, creating a new one: ${updateError.message}`);
            token = await this.serverState.tokenService.createGameStateToken(this.serverState.gameState);
            this.log(`Created new game state token for frame ${this.serverState.gameState.frame} (after update failure)`);
          }
        }
        
        // The token service now manages the lastStateToken property internally
        // Just keep a reference for broadcasting
        token = this.serverState.tokenService.lastStateToken;
        
        // Emit game state update event
        this.emit('gameStateUpdate', {
          frame: this.serverState.gameState.frame,
          timestamp: this.serverState.gameState.timestamp,
          playerCount: Object.keys(this.serverState.gameState.players).length
        });
        
        // Broadcast to all clients if requested
        if (broadcast && token) {
          const tokenFlow = this.serverState.tokenService.TXF.exportFlow(token);
          
          this.broadcast({
            type: 'game:state:token',
            tokenFlow: tokenFlow,
            frame: this.serverState.gameState.frame
          });
          
          this.debug(`Broadcast game state token to all clients`);
        }
        
        return token;
      } catch (error) {
        this.error('Failed to process game state token:', error.message);
        return null;
      } finally {
        // Clear update flag regardless of success or failure
        this.serverState.isUpdatingGameState = false;
      }
    }

    /**
     * Start periodic game state token broadcasts
     */
    startGameStateTokens() {
      // Clear existing interval
      if (this.serverState.gameStateInterval) {
        clearInterval(this.serverState.gameStateInterval);
      }
      
      // Skip if token service is not available
      if (!this.serverState.tokenService) {
        return;
      }
      
      // Check if we have a GameIntegration instance managing this server
      // We can detect this by checking if this.gameInstance is set, which
      // GameIntegration would have set when initializing
      const usingGameIntegration = !!this.gameInstance;
      
      if (usingGameIntegration) {
        this.log('Game integration detected - token updates will be managed by GameIntegration');
        
        // In this case, don't set up our own token updates
        // Just set up UI refresh interval
        this.serverState.gameStateInterval = setInterval(() => {
          if (this.gameInstance) {
            const gameState = this.gameInstance.getGameState();
            // Update UI with current state to ensure sync
            this.emit('gameStateUpdate', {
              frame: gameState.frame,
              timestamp: gameState.timestamp,
              playerCount: Object.keys(gameState.players).length
            });
          }
        }, 10000); // Update UI every 10 seconds
        
        return;
      }
      
      this.log(`Starting game state token broadcasts every ${this.config.stateInterval} seconds...`);
      
      // Create initial game state token - only if not using GameIntegration
      // Add a short delay to ensure everything is initialized
      setTimeout(() => {
        // Create initial token
        this.createGameStateToken();
        
        // Set up a single event listener for game state changes instead of an interval
        if (this.gameInstance) {
          // Remove any existing listener first
          this.gameInstance.off('stateChange', this._gameStateChangeHandler);
          
          // Create handler function that keeps a reference to 'this'
          this._gameStateChangeHandler = (gameState) => {
            // Log that we received a game state change event
            this.debug(`Game state change event received: frame ${gameState.frame}`);
            
            // Only attempt update if last one has completed
            if (!this.serverState.isUpdatingGameState) {
              // Create a token for the new game state
              this.createGameStateToken();
              
              // Also update the UI immediately even if token creation is in progress
              this.emit('gameStateUpdate', {
                frame: gameState.frame,
                timestamp: gameState.timestamp,
                playerCount: Object.keys(gameState.players).length
              });
            }
          };
          
          // Listen for state changes
          this.gameInstance.on('stateChange', this._gameStateChangeHandler);
          this.log('Listening for game state changes to update token');
          
          // Also set up a polling interval to ensure UI stays updated
          // even if game state changes aren't coming through regularly
          this.serverState.gameStateInterval = setInterval(() => {
            if (this.gameInstance) {
              const gameState = this.gameInstance.getGameState();
              // Update UI with current state to ensure sync
              this.emit('gameStateUpdate', {
                frame: gameState.frame,
                timestamp: gameState.timestamp,
                playerCount: Object.keys(gameState.players).length
              });
            }
          }, 10000); // Update UI every 10 seconds
        } else {
          // Fallback to interval-based updates if no game instance
          this.serverState.gameStateInterval = setInterval(() => {
            // Only attempt update if last one has completed
            if (!this.serverState.isUpdatingGameState) {
              this.createGameStateToken();
            } else {
              this.log('Skipping game state update as previous update is still in progress');
            }
          }, this.config.stateInterval * 1000);
        }
      }, 2000); // 2 second delay for initial token creation
    }

    /**
     * End the game and distribute tokens to winner
     */
    async endGame(winnerId) {
      if (!this.serverState.tokenService || !this.serverState.clients.has(winnerId)) {
        this.log(`Cannot end game: token service disabled or winner ${winnerId} not found`);
        return false;
      }
      
      try {
        const client = this.serverState.clients.get(winnerId);
        
        // Ensure client is connected
        if (!client.connected) {
          this.log(`Cannot distribute tokens: Client ${winnerId} is not connected`);
          return false;
        }
        
        // Ensure we have the client's public key
        if (!client.pubkey) {
          this.log(`Cannot distribute tokens: Client ${winnerId} public key not available`);
          return false;
        }
        
        // Check if we have any tokens to distribute
        if (this.serverState.collectedTokens.length === 0) {
          this.log(`No tokens available to distribute to winner ${winnerId}`);
          return false;
        }
        
        this.log(`Distributing ${this.serverState.collectedTokens.length} tokens to winner ${winnerId}...`);
        
        // Send tokens to the winner
        const tokenFlows = await this.serverState.tokenService.sendTokensToRecipient(
          this.serverState.collectedTokens,
          client.pubkey
        );
        
        // Send the token flows to the client
        this.sendToClient(winnerId, {
          type: 'token:reward',
          tokenFlows: tokenFlows,
          count: tokenFlows.length
        });
        
        // Clear the collected tokens
        this.serverState.collectedTokens = [];
        
        this.log(`Tokens distributed to winner ${winnerId}`);
        
        // Broadcast game over message to all clients
        this.broadcastMessage(`Game over! ${client.username || winnerId} is the winner and received all collected tokens!`);
        
        return {
          winner: winnerId,
          username: client.username,
          tokenCount: tokenFlows.length
        };
      } catch (error) {
        this.error(`Failed to distribute tokens to winner ${winnerId}:`, error.message);
        return false;
      }
    }

    /**
     * Register an event handler
     */
    on(event, handler) {
      if (!this.eventHandlers[event]) {
        this.eventHandlers[event] = [];
      }
      
      this.eventHandlers[event].push(handler);
      return this;
    }
    
    /**
     * Remove an event handler
     */
    off(event, handler) {
      if (!this.eventHandlers[event]) {
        return this;
      }
      
      if (handler) {
        this.eventHandlers[event] = this.eventHandlers[event].filter(h => h !== handler);
      } else {
        this.eventHandlers[event] = [];
      }
      
      return this;
    }
    
    /**
     * Emit an event
     */
    emit(event, data) {
      if (!this.eventHandlers[event]) {
        return;
      }
      
      for (const handler of this.eventHandlers[event]) {
        try {
          handler(data);
        } catch (err) {
          this.error(`Error in event handler for ${event}:`, err);
        }
      }
    }
    
    /**
     * Emit status update event
     */
    emitStatusUpdate() {
      const status = this.getStatus();
      this.emit('statusUpdate', status);
    }

    // Logging methods
    
    /**
     * Log a message
     */
    log(...args) {
      log(...args);
      this.logToElement(args.join(' '));
    }
    
    /**
     * Log a warning
     */
    warn(...args) {
      warn(...args);
      this.logToElement(`⚠️ ${args.join(' ')}`);
    }
    
    /**
     * Log an error
     */
    error(...args) {
      error(...args);
      this.logToElement(`❌ ${args.join(' ')}`);
    }
    
    /**
     * Log a debug message
     */
    debug(...args) {
      if (this.config.debug) {
        debug(...args);
        this.logToElement(`🔍 ${args.join(' ')}`);
      }
    }
  }

  // Export to global scope
  window.BrowserMockServer = BrowserMockServer;

})(window);