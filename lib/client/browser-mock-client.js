/**
 * Browser Mock Game Client for testing WebRTC P2P connections
 * 
 * This is a browser-compatible version of the mock-game-client.js
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
   * Mock Client Channel for the browser environment
   */
  class MockClientChannel {
    constructor() {
      this.readyState = 'connecting';
      
      // Event handlers
      this.onopen = null;
      this.onmessage = null;
      this.onclose = null;
      this.onerror = null;
    }
    
    // Send a message
    send(data) {
      debug(`[Client] Channel sent: ${typeof data === 'string' ? 
        (data.substr(0, 30) + '...') : 
        JSON.stringify(data).substr(0, 30) + '...'}`);
      return true;
    }
    
    // Close the channel
    close() {
      this._close();
    }
    
    // Set to open state
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
        debug(`MockClientChannel received message: ${typeof data} data`);
        
        // Create a proper message event object
        const event = { 
          data: data,
          type: 'message' 
        };
        
        // Call the message handler
        this.onmessage(event);
      } else {
        warn('No message handler defined for channel');
      }
    }
  }

  /**
   * Browser Mock Game Client
   */
  class BrowserMockClient {
    /**
     * Create a new browser mock client
     * @param {Object} config - Client configuration
     */
    constructor(config = {}) {
      // Configuration
      this.config = Object.assign({
        masterServer: 'localhost:27950',
        name: 'BrowserPlayer',
        verbose: false,
        debug: false,
        mintTokens: 10,
        useWebRTC: true,
        logElement: null,
        autoConnect: null,
        onStatusUpdate: null,
        onChatMessage: null,
        onConnectionChange: null,
        onServerList: null
      }, config);

      // Client state
      this.clientState = {
        clientId: null,
        channel: null,
        signaling: null,
        latencyInterval: null,
        connected: false,
        connectedServerPeerId: null,
        connectionId: null,
        serverList: [],
        pingResults: [],
        chatHistory: [],
        lastPingTime: null,
        lastPing: null,
        lastPingWasManual: false,
        serverInfo: null,
        
        // Token-related state
        tokenService: null,
        serverPubkey: null,  // Server's public key for token operations
        entryTokenSent: false,
        lastGameStateVerification: {
          timestamp: null,
          result: null,
          frame: 0
        }
      };

      // Client info
      this.clientInfo = {
        name: this.config.name
      };

      // Event handlers
      this.eventHandlers = {
        statusUpdate: [],
        serverList: [],
        serverConnect: [],
        serverDisconnect: [],
        chatMessage: [],
        connectionChange: [],
        tokenUpdate: []
      };

      // Register callbacks if provided
      if (this.config.onStatusUpdate) this.on('statusUpdate', this.config.onStatusUpdate);
      if (this.config.onChatMessage) this.on('chatMessage', this.config.onChatMessage);
      if (this.config.onConnectionChange) this.on('connectionChange', this.config.onConnectionChange);
      if (this.config.onServerList) this.on('serverList', this.config.onServerList);

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

      this.inBackgroundPing = false;
    }

    /**
     * Initialize the client
     */
    async init() {
      this.log('Initializing browser mock client...');
      
      // Initialize token service if UniQuakeTokenService is available
      if (window.UniQuakeTokenService) {
        await this.initializeTokenService();
      } else {
        this.log('Token service not available - running without token features');
      }
      
      // Connect to master server
      await this.connectToMasterServer();
      
      // Auto-connect if specified
      if (this.config.autoConnect) {
        setTimeout(() => {
          this.connectToServer(this.config.autoConnect);
        }, 1000);
      }
      
      return true;
    }

    /**
     * Initialize token service
     */
    async initializeTokenService() {
      try {
        this.log('Initializing token service...');
        
        // Create token service with client name as username
        this.clientState.tokenService = new window.UniQuakeTokenService({
          username: this.clientInfo.name,
          debug: this.config.debug
        });
        
        // Initialize the service
        await this.clientState.tokenService.init();
        
        // Get identity info
        const identity = this.clientState.tokenService.getIdentity();
        this.log(`Token service initialized with identity: ${identity.username} (${identity.pubkey.substring(0, 10)}...)`);
        
        // Mint initial tokens if configured
        if (this.config.mintTokens > 0) {
          this.log(`Minting ${this.config.mintTokens} initial tokens...`);
          await this.clientState.tokenService.mintCoins(this.config.mintTokens, '1');
          this.log(`Minted ${this.config.mintTokens} tokens successfully`);
          
          // Trigger token update event
          this.emitTokenUpdate();
        }
        
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
          this.clientState.signaling = new WebSocket(masterUrl);
          
          this.clientState.signaling.onopen = () => {
            this.log('Connected to master server');
            
            // Get server list after a short delay
            setTimeout(() => {
              this.requestServerList();
            }, 500);
            
            resolve(true);
          };
          
          this.clientState.signaling.onmessage = (event) => {
            try {
              const message = JSON.parse(event.data);
              this.handleSignalingMessage(message);
            } catch (err) {
              this.error('Failed to parse message:', err.message);
            }
          };
          
          this.clientState.signaling.onclose = () => {
            this.log('Disconnected from master server');
            
            // Reset state
            this.clientState.clientId = null;
            this.clientState.serverList = [];
            
            // Emit connection change event
            this.emit('connectionChange', { connected: false, server: null });
            
            // Try to reconnect after a delay
            setTimeout(() => this.connectToMasterServer(), 5000);
            
            resolve(false);
          };
          
          this.clientState.signaling.onerror = (err) => {
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
     * Request server list from master server
     */
    async requestServerList() {
      return new Promise((resolve) => {
        this.sendToMaster({
          type: 'get_servers'
        });
        
        // Create a one-time event handler to get the server list response
        const handler = (servers) => {
          this.off('serverList', handler);
          resolve(servers);
        };
        
        this.on('serverList', handler);
        
        // Timeout after 5 seconds
        setTimeout(() => {
          this.off('serverList', handler);
          resolve([]);
        }, 5000);
      });
    }

    /**
     * Connect to a game server
     * @param {string} peerId - Server peer ID
     */
    async connectToServer(peerId) {
      return new Promise((resolve) => {
        this.log(`Connecting to server with peer ID: ${peerId}...`);
        
        // Store server peer ID
        this.clientState.connectedServerPeerId = peerId;
        
        // Create and setup a channel for this connection with all event handlers
        this.clientState.channel = this.setupChannel();
        
        // Check if token service is initialized
        if (!this.clientState.tokenService) {
          this.warn('Warning: Token service not initialized. Entry token will not be sent.');
        } else {
          // Reset entry token flag
          this.clientState.entryTokenSent = false;
        }
        
        // Send connect request with WebSocket fallback flag
        this.sendToMaster({
          type: 'connect_to_server',
          peerId: peerId,
          useWebSocket: true,  // Explicitly request WebSocket fallback
          // Include client identity for token operations
          identity: this.clientState.tokenService ? {
            pubkey: this.clientState.tokenService.getIdentity().pubkey,
            username: this.clientState.tokenService.getIdentity().username
          } : null
        });
        
        // Create a one-time event handler for connection status
        const handler = (status) => {
          this.off('serverConnect', handler);
          resolve(status.connected);
        };
        
        this.on('serverConnect', handler);
        
        // Timeout after 10 seconds
        setTimeout(() => {
          this.off('serverConnect', handler);
          resolve(false);
        }, 10000);
      });
    }

    /**
     * Set up channel for server communication
     */
    setupChannel() {
      // Always create a fresh channel to ensure handlers are properly set
      const channel = new MockClientChannel();
      this.debug('Creating and setting up new MockClientChannel');
      
      channel.onopen = () => {
        this.log('Channel open');
        this.clientState.connected = true;
        
        // Emit connection change event
        this.emit('connectionChange', { 
          connected: true, 
          server: this.clientState.connectedServerPeerId 
        });
      };
      
      channel.onmessage = (event) => {
        try {
          this.debug(`Received channel message type: ${typeof event.data}`);
          
          let message;
          if (typeof event.data === 'string') {
            try {
              message = JSON.parse(event.data);
              this.debug(`Successfully parsed string message into object`);
            } catch (parseErr) {
              this.error(`Failed to parse string as JSON: ${parseErr.message}`);
              this.debug(`Raw data that failed to parse: ${event.data}`);
              return; // Can't proceed without valid message
            }
          } else if (typeof event.data === 'object') {
            message = event.data;
            this.debug(`Using object message directly`);
          } else {
            throw new Error(`Unexpected data type: ${typeof event.data}`);
          }
          
          if (!message || !message.type) {
            this.error(`Invalid message format: missing 'type' property`);
            this.debug(`Problematic message: ${JSON.stringify(message, null, 2)}`);
            return;
          }
          
          this.debug(`Processing message of type: ${message.type}`);
          this.handleChannelMessage(message);
        } catch (err) {
          // If processing fails, log the error and raw data
          this.error(`Failed to process message: ${err.message}`);
          this.error(err.stack);
          this.debug(`Raw data: ${JSON.stringify(event.data, null, 2)}`);
        }
      };
      
      channel.onclose = () => {
        this.log('Channel closed');
        this.handleDisconnect('channel_closed');
      };
      
      channel.onerror = (error) => {
        this.error('Channel error:', error);
      };
      
      return channel;
    }

    /**
     * Handle incoming signaling messages
     */
    handleSignalingMessage(message) {
      this.verbose(`Received signaling message: ${message.type}`);
      
      switch (message.type) {
        case 'connected':
          this.log(`Connected to signaling server with client ID: ${message.clientId}`);
          this.clientState.clientId = message.clientId;
          break;
          
        case 'server_list':
          this.handleServerList(message);
          break;
          
        case 'proxy_connection':
          this.handleProxyConnection(message);
          break;
          
        case 'proxy_data':
          this.handleProxyData(message);
          break;
          
        case 'server_disconnected':
          this.handleServerDisconnected(message);
          break;
          
        case 'disconnect_ack':
          this.log('Disconnected from server successfully');
          this.handleDisconnect('user_disconnect');
          break;
          
        case 'error':
          this.error(`Signaling error: ${message.error}`);
          break;
          
        default:
          this.verbose(`Unhandled message type: ${message.type}`);
          break;
      }
    }

    /**
     * Handle server list response
     */
    handleServerList(message) {
      const servers = message.servers || [];
      this.clientState.serverList = servers;
      
      this.log(`Received server list with ${servers.length} servers`);
      
      // Emit server list event
      this.emit('serverList', servers);
    }

    /**
     * Handle proxy connection to server
     */
    async handleProxyConnection(message) {
      const { serverPeerId, connectionId, serverIdentity } = message;
      
      this.log(`Connection established to server ${serverPeerId} with connection ID: ${connectionId || 'unknown'}`);
      
      // Update client state
      this.clientState.connected = true;
      this.clientState.connectedServerPeerId = serverPeerId;
      
      // Store server's public key for token operations if provided
      if (serverIdentity && serverIdentity.pubkey) {
        this.clientState.serverPubkey = serverIdentity.pubkey;
        this.log(`Received server public key: ${this.clientState.serverPubkey.substring(0, 10)}...`);
      }
      
      // Ensure we have a connection ID (use the one from message or generate a mock one)
      this.clientState.connectionId = connectionId || `mock-${Date.now()}`;
      
      // Always setup the channel to ensure handlers are properly set
      // This is critical because we need onmessage handler
      this.clientState.channel = this.setupChannel();
      
      // Open the channel
      this.clientState.channel.open();
      
      // Start ping test
      this.startPingTest();
      
      // Notify connection success
      this.sendToMaster({
        type: 'connection_success',
        connectionId: this.clientState.connectionId,
        serverPeerId: serverPeerId
      });
      
      // Emit server connect event
      this.emit('serverConnect', { 
        connected: true, 
        peerId: serverPeerId,
        connectionId: connectionId
      });
    }

    /**
     * Handle proxy data from server
     */
    handleProxyData(message) {
      const { serverPeerId, data } = message;
      
      // Check if this is likely a pong response to a background ping
      const isPongForBackgroundPing = data && 
                                    data.type === 'pong' && 
                                    !this.clientState.lastPingWasManual;
      
      // If this is a background operation, set the flag
      if (isPongForBackgroundPing) {
        this.inBackgroundPing = true;
      }
      
      this.debug(`Received proxy data from server ${serverPeerId}`);
      
      // Make sure we're connected to this server
      if (this.clientState.connectedServerPeerId !== serverPeerId) {
        // Only show warnings for user-initiated actions
        if (!this.inBackgroundPing) {
          this.warn(`Received data from unexpected server: ${serverPeerId}`);
        }
        return;
      }
      
      // Forward to the channel
      if (this.clientState.channel) {
        try {
          // Send the data as is to the channel
          // This ensures we don't lose the object structure
          if (typeof data === 'string') {
            // If it's already a string, try to parse it as JSON first
            try {
              const parsedData = JSON.parse(data);
              this.debug(`Forwarding parsed object to channel`);
              this.clientState.channel.receiveMessage(parsedData);
            } catch (parseErr) {
              // If parsing fails, it's a plain string message
              this.debug(`Forwarding string data to channel: ${data.substring(0, 50)}${data.length > 50 ? '...' : ''}`);
              this.clientState.channel.receiveMessage(data);
            }
          } else {
            // If it's an object, send it directly without stringifying
            this.debug(`Forwarding object to channel: ${JSON.stringify(data).substring(0, 50)}...`);
            this.clientState.channel.receiveMessage(data);
          }
        } catch (err) {
          // Only log errors for user-initiated actions
          if (!this.inBackgroundPing) {
            this.error('Failed to forward data to channel:', err);
            this.error(err.stack);
          }
        }
      } else {
        // Only show warnings for user-initiated actions
        if (!this.inBackgroundPing) {
          this.warn('Cannot forward data: channel not initialized');
        }
      }
      
      // Clear the background ping flag if it was set
      if (isPongForBackgroundPing) {
        this.inBackgroundPing = false;
      }
    }

    /**
     * Handle server disconnection
     */
    handleServerDisconnected(message) {
      const { serverPeerId, connectionId } = message;
      
      if (this.clientState.connectedServerPeerId === serverPeerId || 
          (connectionId && this.clientState.connectionId === connectionId)) {
        this.log(`Server ${serverPeerId} disconnected`);
        this.handleDisconnect('server_disconnected');
      }
    }

    /**
     * Handle disconnection
     */
    handleDisconnect(reason) {
      if (!this.clientState.connected) return;
      
      this.log(`Disconnected from server (${reason})`);
      
      // If this is a user-initiated disconnect, notify the server
      if (reason === 'user_disconnect' && 
          this.clientState.signaling && this.clientState.signaling.readyState === WebSocket.OPEN) {
        this.sendToMaster({
          type: 'disconnect_from_server',
          serverPeerId: this.clientState.connectedServerPeerId
        });
      }
      
      // Stop ping test
      if (this.clientState.latencyInterval) {
        clearInterval(this.clientState.latencyInterval);
        this.clientState.latencyInterval = null;
      }
      
      // Emit server disconnect event
      this.emit('serverDisconnect', { 
        peerId: this.clientState.connectedServerPeerId,
        reason: reason
      });
      
      // Reset connection state
      this.clientState.connected = false;
      this.clientState.connectedServerPeerId = null;
      this.clientState.connectionId = null;
      
      // Close channel
      if (this.clientState.channel) {
        this.clientState.channel.close();
        this.clientState.channel = null;
      }
      
      // Clear ping results
      this.clientState.pingResults = [];
      
      // Emit connection change event
      this.emit('connectionChange', { 
        connected: false, 
        server: null
      });
    }

    /**
     * Start periodic ping test
     */
    startPingTest() {
      // Clear any existing interval
      if (this.clientState.latencyInterval) {
        clearInterval(this.clientState.latencyInterval);
      }
      
      // Start a new interval
      this.clientState.latencyInterval = setInterval(() => {
        if (this.clientState.connected) {
          // Set the background ping flag
          this.inBackgroundPing = true;
          
          // Send ping without setting the manual flag
          this.sendMessage({
            type: 'ping',
            timestamp: Date.now()
          });
          
          // This is a background ping, don't log it
          this.clientState.lastPingWasManual = false;
          
          // Clear the background ping flag
          this.inBackgroundPing = false;
        }
      }, 5000); // every 5 seconds
    }

    /**
     * Handle messages received through the channel
     */
    async handleChannelMessage(message) {
      switch (message.type) {
        case 'welcome':
          this.log(`Connected to: ${message.serverInfo.name} - Map: ${message.serverInfo.map}`);
          this.log(`Server message: ${message.message}`);
          
          // Store server info in client state
          this.clientState.serverInfo = {
            name: message.serverInfo.name,
            map: message.serverInfo.map,
            game: message.serverInfo.game,
            players: message.serverInfo.players,
            maxPlayers: message.serverInfo.maxPlayers
          };
          
          // Store server's public key if provided
          if (message.serverIdentity && message.serverIdentity.pubkey) {
            this.clientState.serverPubkey = message.serverIdentity.pubkey;
            this.log(`Server identity: ${message.serverIdentity.username} (${this.clientState.serverPubkey.substring(0, 10)}...)`);
            
            // Always send our identity information to ensure the server has it
            if (this.clientState.tokenService) {
              const identity = this.clientState.tokenService.getIdentity();
              this.log(`Sending identity update to server: ${identity.username} (${identity.pubkey.substring(0, 10)}...)`);
              
              // Send identity update message
              this.sendMessage({
                type: 'identity:update',
                identity: {
                  pubkey: identity.pubkey,
                  username: identity.username
                }
              });
              
              // Now that we have the server's pubkey, send entry token if not already sent
              if (!this.clientState.entryTokenSent) {
                try {
                  this.log('Server pubkey received in welcome message, preparing to send entry token...');
                  
                  // Send the token after a short delay to ensure the connection is fully established
                  setTimeout(async () => {
                    try {
                      // Generate entry token
                      const tokenFlow = await this.clientState.tokenService.sendEntryToken(this.clientState.serverPubkey);
                      
                      // Send token to server
                      this.sendMessage({
                        type: 'token:entry',
                        tokenFlow: tokenFlow
                      });
                      
                      // Mark token as sent
                      this.clientState.entryTokenSent = true;
                      this.log('Entry token sent to server');
                    } catch (error) {
                      this.error('Failed to send entry token:', error.message);
                    }
                  }, 500);
                } catch (error) {
                  this.error('Failed to prepare entry token:', error.message);
                }
              }
            }
          }
          
          // Emit status update
          this.emitStatusUpdate();
          break;
          
        case 'chat':
          // Add to chat history
          if (!this.clientState.chatHistory) {
            this.clientState.chatHistory = [];
          }
          
          const chatEntry = {
            from: message.from,
            message: message.message,
            timestamp: Date.now()
          };
          
          this.clientState.chatHistory.push(chatEntry);
          
          // Only keep last 50 messages
          if (this.clientState.chatHistory.length > 50) {
            this.clientState.chatHistory.shift();
          }
          
          this.log(`[CHAT] ${message.from}: ${message.message}`);
          
          // Emit chat message event
          this.emit('chatMessage', chatEntry);
          break;
          
        case 'pong':
          // Calculate ping
          const now = Date.now();
          const ping = now - message.timestamp;
          
          // Store last ping time
          this.clientState.lastPingTime = now;
          this.clientState.lastPing = ping;
          
          // Add to ping history
          this.clientState.pingResults.push(ping);
          
          // Only keep last 10 results
          if (this.clientState.pingResults.length > 10) {
            this.clientState.pingResults.shift();
          }
          
          // Only show ping results when explicitly requested or in debug mode
          if (this.clientState.lastPingWasManual || this.config.debug) {
            this.log(`Ping: ${ping}ms`);
            
            // Calculate average
            const avg = this.clientState.pingResults.reduce((a, b) => a + b, 0) / this.clientState.pingResults.length;
            this.log(`Average ping: ${Math.round(avg)}ms`);
          }
          
          // Reset the manual ping flag
          this.clientState.lastPingWasManual = false;
          break;
          
        case 'kick':
          this.log(`Kicked from server: ${message.reason || 'No reason given'}`);
          this.handleDisconnect('kicked');
          break;
          
        // Token-related message handlers
        case 'token:entry:ack':
          this.log(`Server acknowledged entry token: ${message.success ? 'Accepted' : 'Rejected'}`);
          if (!message.success && message.reason) {
            this.log(`Reason: ${message.reason}`);
          }
          break;
          
        case 'token:reward':
          if (!this.clientState.tokenService) {
            this.log(`Received reward tokens but token service is not initialized`);
            break;
          }
          
          this.log(`Received reward tokens from server...`);
          
          // Process reward tokens
          try {
            // Process each token flow
            const tokenFlows = message.tokenFlows || [];
            let successCount = 0;
            
            for (const tokenFlow of tokenFlows) {
              const result = await this.clientState.tokenService.receiveToken(tokenFlow);
              if (result.success) {
                successCount++;
              }
            }
            
            this.log(`Successfully received ${successCount} of ${tokenFlows.length} reward tokens`);
            
            // Emit token update event
            this.emitTokenUpdate();
          } catch (error) {
            this.error(`Failed to process reward tokens: ${error.message}`);
          }
          break;
          
        case 'identity:update:ack':
          this.log(`Server acknowledged identity update: ${message.success ? 'Success' : 'Failed'}`);
          break;
          
        case 'game:state:token':
          if (!this.clientState.tokenService) {
            this.debug(`Received game state token but token service is not initialized`);
            break;
          }
          
          try {
            // Verify the game state token
            const tokenFlow = message.tokenFlow;
            this.debug(`Received game state token for verification at frame ${message.frame || 0}`);
            
            const result = await this.clientState.tokenService.verifyGameStateToken(tokenFlow);
            
            // Update the last verification result
            this.clientState.lastGameStateVerification = {
              timestamp: Date.now(),
              result: result,
              frame: message.frame || result.frame || 0,
              serverFrame: message.frame || 0
            };
            
            // Update local game state frame to match server's frame
            if (this.gameIntegration && this.gameIntegration.game) {
              this.gameIntegration.game.state.frame = message.frame || 0;
              this.gameIntegration.game.state.gameId = result.gameId || this.gameIntegration.game.state.gameId;
            }
            
            if (result.verified) {
              this.debug(`Game state verified: Valid state at frame ${result.frame}`);
            } else if (result.error) {
              // Always show verification failures
              this.log(`Game state verification failed: ${result.error}`);
            }
          } catch (error) {
            this.error(`Failed to verify game state token: ${error.message}`);
          }
          break;
          
        default:
          this.debug(`Unhandled channel message: ${message.type}`);
          break;
      }
    }

    /**
     * Send a message to the master server
     */
    sendToMaster(message) {
      if (!this.clientState.signaling || this.clientState.signaling.readyState !== WebSocket.OPEN) {
        this.warn('Cannot send message: not connected to master server');
        return false;
      }
      
      try {
        this.clientState.signaling.send(JSON.stringify(message));
        return true;
      } catch (err) {
        this.error('Failed to send message to master server:', err);
        return false;
      }
    }

    /**
     * Send a message to the game server
     */
    sendMessage(message) {
      if (!this.clientState.connected) {
        // Only show warnings for user-initiated actions
        if (!this.inBackgroundPing) {
          this.warn('Cannot send message: not connected to a server');
        }
        return false;
      }
      
      if (!this.clientState.signaling || this.clientState.signaling.readyState !== WebSocket.OPEN) {
        // Only show warnings for user-initiated actions
        if (!this.inBackgroundPing) {
          this.warn('Cannot send message: signaling connection not open');
        }
        return false;
      }
      
      try {
        // Determine if this is a background ping (automatic, not manual)
        const isBackgroundPing = message.type === 'ping' && !this.clientState.lastPingWasManual;
        
        // Only log if it's not a background ping or we're in debug mode
        if ((!isBackgroundPing || this.config.debug) && !this.inBackgroundPing) {
          this.debug(`Sending message to server: ${JSON.stringify(message)}`);
        }
        
        // Send message via master server
        const proxyMessage = {
          type: 'proxy_message',
          serverPeerId: this.clientState.connectedServerPeerId,
          connectionId: this.clientState.connectionId,
          data: message
        };
        
        // Send to master server
        this.clientState.signaling.send(JSON.stringify(proxyMessage));
        return true;
      } catch (err) {
        // Only log errors for user-initiated actions
        if (!this.inBackgroundPing) {
          this.error('Failed to send message to game server:', err);
        }
        return false;
      }
    }

    /**
     * Disconnect from the current server
     */
    async disconnect() {
      if (!this.clientState.connected) {
        this.log('Not connected to a server');
        return false;
      }
      
      this.handleDisconnect('user_disconnect');
      this.log('Disconnected from server');
      return true;
    }

    /**
     * Send a chat message to the server
     */
    sendChatMessage(message) {
      if (!this.clientState.connected) {
        this.warn('Cannot send chat: not connected to a server');
        return false;
      }
      
      if (!message || message.trim() === '') {
        this.warn('Cannot send empty message');
        return false;
      }
      
      return this.sendMessage({
        type: 'chat',
        message: message
      });
    }

    /**
     * Send a ping to the server
     */
    async ping() {
      if (!this.clientState.connected) {
        this.warn('Cannot ping: not connected to a server');
        return -1;
      }
      
      return new Promise((resolve) => {
        const startTime = Date.now();
        this.clientState.lastPingWasManual = true;
        
        // Send ping message
        this.sendMessage({
          type: 'ping',
          timestamp: startTime
        });
        
        // Check for response
        const checkInterval = setInterval(() => {
          if (this.clientState.lastPingTime > startTime) {
            clearInterval(checkInterval);
            clearTimeout(timeout);
            resolve(this.clientState.lastPing);
          }
        }, 10);
        
        // Timeout after 5 seconds
        const timeout = setTimeout(() => {
          clearInterval(checkInterval);
          resolve(-1);
        }, 5000);
      });
    }

    /**
     * Get client status information
     */
    getStatus() {
      // Calculate time since last ping if available
      let pingTimeAgo = 'N/A';
      if (this.clientState.lastPingTime) {
        const seconds = Math.round((Date.now() - this.clientState.lastPingTime) / 1000);
        pingTimeAgo = `${seconds}s ago`;
      }
      
      // Get server info if connected
      const serverInfo = this.clientState.serverInfo || {};
      
      // Calculate average ping
      const avgPing = this.clientState.pingResults.length > 0
        ? Math.round(this.clientState.pingResults.reduce((a, b) => a + b, 0) / this.clientState.pingResults.length)
        : null;
      
      // Basic status
      const status = {
        clientId: this.clientState.clientId,
        playerName: this.clientInfo.name,
        connected: this.clientState.connected,
        transport: window.UNIQUAKE_CONFIG?.useWebRTC ? 'WebRTC' : 'WebSocket',
        serverPeerId: this.clientState.connectedServerPeerId,
        connectionId: this.clientState.connectionId,
        serverInfo: serverInfo,
        ping: {
          last: this.clientState.lastPing,
          avg: avgPing,
          lastUpdate: this.clientState.lastPingTime,
          timeAgo: pingTimeAgo
        },
        chatHistory: this.getChatHistory()
      };
      
      // Add token information if available
      if (this.clientState.tokenService) {
        try {
          const tokenStatus = this.clientState.tokenService.getTokenStatus();
          const identity = this.clientState.tokenService.getIdentity();
          
          status.tokens = {
            identity: {
              username: identity.username,
              pubkey: identity.pubkey
            },
            count: tokenStatus.tokens.total,
            coins: tokenStatus.tokens.coins,
            value: tokenStatus.value,
            entrySent: this.clientState.entryTokenSent
          };
          
          status.gameState = {
            lastVerified: this.clientState.lastGameStateVerification.timestamp,
            isValid: this.clientState.lastGameStateVerification.result?.verified || false,
            frame: this.clientState.lastGameStateVerification.frame,
            stateHash: this.clientState.lastGameStateVerification.result?.stateHash || null
          };
        } catch (error) {
          status.tokens = { error: error.message };
        }
      }
      
      // Emit status update event
      this.emit('statusUpdate', status);
      
      return status;
    }

    /**
     * Get chat history
     */
    getChatHistory(limit = 50) {
      if (!this.clientState.chatHistory) {
        return [];
      }
      
      // Return most recent messages up to limit
      return this.clientState.chatHistory.slice(-limit);
    }

    /**
     * Mint new tokens
     */
    async mintTokens(count = 1) {
      if (!this.clientState.tokenService) {
        this.warn('Token service not initialized');
        return [];
      }
      
      try {
        this.log(`Minting ${count} tokens...`);
        const tokens = await this.clientState.tokenService.mintCoins(count, '1');
        this.log(`Successfully minted ${tokens.length} tokens`);
        
        // Emit token update event
        this.emitTokenUpdate();
        
        return tokens;
      } catch (error) {
        this.error(`Failed to mint tokens: ${error.message}`);
        return [];
      }
    }

    /**
     * Get token inventory
     */
    getTokenInventory() {
      if (!this.clientState.tokenService) {
        return { error: 'Token service not initialized' };
      }
      
      try {
        const tokenStatus = this.clientState.tokenService.getTokenStatus();
        return {
          total: tokenStatus.tokens.total,
          coins: tokenStatus.tokens.coins,
          value: tokenStatus.value
        };
      } catch (error) {
        return { error: error.message };
      }
    }

    /**
     * Request game state verification
     */
    async verifyGameState() {
      if (!this.clientState.tokenService) {
        this.warn('Token service not initialized');
        return { verified: false, error: 'Token service not initialized' };
      }
      
      if (!this.clientState.connected) {
        this.warn('Not connected to a server');
        return { verified: false, error: 'Not connected to a server' };
      }
      
      // Request a new game state token from the server
      this.log('Requesting game state verification...');
      this.sendMessage({
        type: 'request:game:state:token'
      });
      
      // Wait for verification response
      return new Promise((resolve) => {
        const checkInterval = setInterval(() => {
          const lastVerification = this.clientState.lastGameStateVerification;
          if (lastVerification.timestamp && lastVerification.timestamp > Date.now() - 5000) {
            clearInterval(checkInterval);
            clearTimeout(timeout);
            resolve(lastVerification.result || { verified: false, error: 'Unknown verification result' });
          }
        }, 100);
        
        // Timeout after 5 seconds
        const timeout = setTimeout(() => {
          clearInterval(checkInterval);
          resolve({ verified: false, error: 'Verification timeout' });
        }, 5000);
      });
    }

    // Event handling methods
    
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
    
    /**
     * Emit token update event
     */
    emitTokenUpdate() {
      if (!this.clientState.tokenService) {
        return;
      }
      
      try {
        const tokenStatus = this.clientState.tokenService.getTokenStatus();
        this.emit('tokenUpdate', tokenStatus);
      } catch (error) {
        this.error(`Failed to emit token update: ${error.message}`);
      }
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
    
    /**
     * Log a verbose message
     */
    verbose(...args) {
      if (this.config.verbose) {
        log(...args);
      }
    }
  }

  // Export to global scope
  window.BrowserMockClient = BrowserMockClient;

})(window);