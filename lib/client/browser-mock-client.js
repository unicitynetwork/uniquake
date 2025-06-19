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
        tokenUpdate: [],
        serverStateUpdate: [] // Add handler for server state updates
      };

      // Register callbacks if provided
      if (this.config.onStatusUpdate) this.on('statusUpdate', this.config.onStatusUpdate);
      if (this.config.onChatMessage) this.on('chatMessage', this.config.onChatMessage);
      if (this.config.onConnectionChange) this.on('connectionChange', this.config.onConnectionChange);
      if (this.config.onServerList) this.on('serverList', this.config.onServerList);
      if (this.config.onServerStateUpdate) this.on('serverStateUpdate', this.config.onServerStateUpdate);

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
      
      // Set up graceful disconnection on page unload
      this.setupGracefulDisconnection();
    }

    /**
     * Set up graceful disconnection handlers for page unload/reload
     */
    setupGracefulDisconnection() {
      // Handle page unload (close, reload, navigation)
      const handleBeforeUnload = () => {
        this.log('Page unloading - attempting graceful disconnection...');
        
        if (this.clientState.connected && this.clientState.signaling) {
          try {
            // Send disconnect message synchronously
            this.sendToMaster({
              type: 'disconnect_from_server',
              serverPeerId: this.clientState.connectedServerPeerId
            });
            
            this.log('Graceful disconnect message sent');
          } catch (error) {
            this.error('Failed to send graceful disconnect:', error.message);
          }
        }
      };
      
      // Handle visibility change (tab switching, minimizing)
      const handleVisibilityChange = () => {
        if (document.hidden) {
          this.log('Page hidden - client may disconnect soon');
        } else {
          this.log('Page visible again');
        }
      };
      
      // Set up event listeners
      if (typeof window !== 'undefined') {
        // beforeunload fires before the page unloads
        window.addEventListener('beforeunload', handleBeforeUnload);
        
        // unload fires when the page is actually unloading
        window.addEventListener('unload', handleBeforeUnload);
        
        // pagehide fires when navigating away (including mobile)
        window.addEventListener('pagehide', handleBeforeUnload);
        
        // visibilitychange for detecting tab switches
        document.addEventListener('visibilitychange', handleVisibilityChange);
        
        this.log('Graceful disconnection handlers installed');
      }
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
        
        // Check if we should restore from saved identity
        const restoreIdentity = this.config.restoreIdentity;
        
        let tokenServiceConfig = {
          username: this.clientInfo.name,
          debug: this.config.debug
        };
        
        // If we have saved identity, use it to restore the token service
        if (restoreIdentity) {
          this.log('Restoring token service from saved identity...');
          tokenServiceConfig = {
            username: restoreIdentity.username,
            secret: restoreIdentity.secret, // Restore the saved secret key
            debug: this.config.debug
          };
          
          // Update client info to match restored identity
          this.clientInfo.name = restoreIdentity.username;
        } else {
          // If no restore data, ensure we use the current client name
          // which should be updated after clearing localStorage
          this.log(`Creating fresh token service for: ${this.clientInfo.name}`);
        }
        
        // Create token service with appropriate config
        this.clientState.tokenService = new window.UniQuakeTokenService(tokenServiceConfig);
        
        // Initialize the service
        await this.clientState.tokenService.init();
        
        // If we have saved tokens, restore them
        if (restoreIdentity && restoreIdentity.tokens) {
          this.log(`Restoring ${restoreIdentity.tokens.total || 0} saved tokens...`);
          // Note: Token restoration would need to be implemented in the token service
          // For now, we'll mint the saved amount to match the previous state
          if (restoreIdentity.tokens.total > 0) {
            await this.clientState.tokenService.mintCoins(restoreIdentity.tokens.total, '1');
            this.log(`Restored ${restoreIdentity.tokens.total} tokens`);
          }
        } else {
          // Mint initial tokens if configured and not restoring
          if (this.config.mintTokens > 0) {
            this.log(`Minting ${this.config.mintTokens} initial tokens...`);
            await this.clientState.tokenService.mintCoins(this.config.mintTokens, '1');
            this.log(`Minted ${this.config.mintTokens} tokens successfully`);
          }
        }
        
        // Get identity info
        const identity = this.clientState.tokenService.getIdentity();
        this.log(`Token service initialized with identity: ${identity.username} (${identity.pubkey.substring(0, 10)}...)`);
        
        // Trigger token update event
        this.emitTokenUpdate();
        
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
      
      // Handle server:state:update messages specially
      if (data && data.type === 'server:state:update') {
        this.log(`[SERVER_STATE] PROXY: Received dedicated server state update`);
        this.log(`[SERVER_STATE] PROXY: Message keys: ${Object.keys(data).join(', ')}`);
        
        if (data.serverInfo) {
          this.log(`[SERVER_STATE] PROXY: Server info included: ${JSON.stringify(data.serverInfo)}`);
          
          // Ensure serverInfo has all required properties
          if (!data.serverInfo.playerCount && data.serverInfo.playerCount !== 0) {
            this.log(`[SERVER_STATE] PROXY: Adding missing playerCount`);
            data.serverInfo.playerCount = 0;
          }
          
          if (!data.serverInfo.itemCount && data.serverInfo.itemCount !== 0) {
            this.log(`[SERVER_STATE] PROXY: Adding missing itemCount`);
            data.serverInfo.itemCount = 0;
          }
          
          if (!data.serverInfo.timestamp) {
            this.log(`[SERVER_STATE] PROXY: Adding missing timestamp`);
            data.serverInfo.timestamp = Date.now();
          }
          
          // Store server state info in client state
          this.clientState.serverStateInfo = {
            playerCount: data.serverInfo.playerCount,
            itemCount: data.serverInfo.itemCount,
            timestamp: data.serverInfo.timestamp
          };
          
          this.log(`[SERVER_STATE] PROXY: Stored server state info in client state`);
          
          // Update lastGameStateVerification with this info as well
          if (this.clientState.lastGameStateVerification) {
            this.clientState.lastGameStateVerification.serverInfo = this.clientState.serverStateInfo;
            this.log(`[SERVER_STATE] PROXY: Updated lastGameStateVerification with new server info`);
          }
        }
      }
      // For game state tokens, also add detailed logging
      else if (data && data.type === 'game:state:token') {
        this.log(`[CRITICAL] PROXY: Received game state token with frame ${data.frame}`);
        this.log(`[CRITICAL] PROXY: Message keys: ${Object.keys(data).join(', ')}`);
        
        if (data.serverInfo) {
          this.log(`[CRITICAL] PROXY: Server info included: ${JSON.stringify(data.serverInfo)}`);
          
          // Ensure serverInfo has all required properties
          if (!data.serverInfo.playerCount && data.serverInfo.playerCount !== 0) {
            this.log(`[CRITICAL] PROXY: Adding missing playerCount`);
            data.serverInfo.playerCount = 0;
          }
          
          if (!data.serverInfo.itemCount && data.serverInfo.itemCount !== 0) {
            this.log(`[CRITICAL] PROXY: Adding missing itemCount`);
            data.serverInfo.itemCount = 0;
          }
          
          if (!data.serverInfo.timestamp) {
            this.log(`[CRITICAL] PROXY: Adding missing timestamp`);
            data.serverInfo.timestamp = Date.now();
          }
        } else {
          this.log(`[CRITICAL] PROXY: No server info in message, adding it now`);
          
          // First try to use existing serverStateInfo if available
          if (this.clientState.serverStateInfo) {
            data.serverInfo = this.clientState.serverStateInfo;
            this.log(`[CRITICAL] PROXY: Added serverInfo from dedicated state update`);
          } else {
            data.serverInfo = {
              playerCount: 0,
              itemCount: 0,
              timestamp: Date.now()
            };
            this.log(`[CRITICAL] PROXY: Added fallback serverInfo`);
          }
        }
      }
      
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
            // Log detailed info for important messages
            if (data.type === 'game:state:token') {
              this.log(`[CRITICAL] Forwarding game state token with serverInfo: ${JSON.stringify(data.serverInfo)}`);
              
              // Ensure serverInfo is properly set before forwarding
              if (!data.serverInfo) {
                this.log(`[CRITICAL] Adding missing serverInfo before forwarding`);
                data.serverInfo = {
                  playerCount: 0,
                  itemCount: 0,
                  timestamp: Date.now()
                };
              }
              
              // Create a deep copy to ensure it's not lost in message passing
              const dataCopy = JSON.parse(JSON.stringify(data));
              
              // Ensure server info is still present in the copy
              if (!dataCopy.serverInfo && data.serverInfo) {
                this.log(`[DIRECT_FIX] Restoring missing serverInfo in data copy`);
                dataCopy.serverInfo = JSON.parse(JSON.stringify(data.serverInfo));
              }
              
              // One final check to ensure serverInfo is present
              if (!dataCopy.serverInfo) {
                this.log(`[DIRECT_FIX] Adding missing serverInfo in data copy before final forwarding`);
                dataCopy.serverInfo = {
                  playerCount: Object.keys(this.gameIntegration?.game?.gameState?.players || {}).length || 0,
                  itemCount: Object.keys(this.gameIntegration?.game?.gameState?.items || {}).length || 0,
                  timestamp: Date.now()
                };
              }
              
              this.log(`[DIRECT_FIX] Final message being forwarded: ${JSON.stringify(dataCopy)}`);
              this.clientState.channel.receiveMessage(dataCopy);
            } else {
              this.debug(`Forwarding object to channel: ${JSON.stringify(data).substring(0, 50)}...`);
              this.clientState.channel.receiveMessage(data);
            }
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
        case 'server:state:update':
          // Handle dedicated server state update message
          if (message.serverInfo) {
            this.log(`[SERVER_STATE] Received dedicated server state update: ${JSON.stringify(message.serverInfo)}`);
            
            // Store server state info in a dedicated property
            this.clientState.serverStateInfo = {
              playerCount: message.serverInfo.playerCount,
              itemCount: message.serverInfo.itemCount,
              timestamp: message.serverInfo.timestamp
            };
            
            // Update the last verification with this info as well
            if (this.clientState.lastGameStateVerification) {
              this.clientState.lastGameStateVerification.serverInfo = this.clientState.serverStateInfo;
              this.log(`[SERVER_STATE] Updated lastGameStateVerification with new server info`);
            }
            
            // If game integration exists, update the game state with server info
            if (this.gameIntegration && this.gameIntegration.game) {
              // Trigger a game state update to refresh UI with the new server info
              this.gameIntegration.onGameStateChange(this.gameIntegration.game.getGameState());
              this.log(`[SERVER_STATE] Triggered game state update with new server info`);
            }
            
            // Emit an event that UI can listen for
            this.emit('serverStateUpdate', this.clientState.serverStateInfo);
          }
          break;
          
        case 'welcome':
          this.log(`Connected to server`);
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
              
              // Send identity update message - payment requirement will be determined after this
              this.sendMessage({
                type: 'identity:update',
                identity: {
                  pubkey: identity.pubkey,
                  username: identity.username
                }
              });
              
              // Note: Payment logic moved to payment_requirement message handler
              this.log('Waiting for server to determine payment requirement after identity verification...');
            }
          }
          
          // Emit status update
          this.emitStatusUpdate();
          break;
          
        case 'payment_requirement':
          this.log(`Server payment requirement: ${message.message}`);
          
          // Now handle payment logic based on server's determination
          const paymentRequired = message.serverInfo?.paymentRequired !== false;
          const isRejoining = message.serverInfo?.isRejoining || false;
          
          if (isRejoining) {
            this.log('Server confirmed this is a rejoin - no entry token payment required');
            this.clientState.entryTokenSent = true; // Mark as sent to prevent future attempts
            this.emitStatusUpdate();
          } else if (paymentRequired && !this.clientState.entryTokenSent) {
            // Check if we have sufficient tokens before attempting to pay
            const tokenInventory = this.getTokenInventory();
            const requiredFee = message.serverInfo?.entryFee || 1;
            
            if (tokenInventory.error) {
              this.error('Cannot check token balance:', tokenInventory.error);
              return;
            }
            
            if (tokenInventory.total < requiredFee) {
              this.error(`Insufficient tokens for entry fee. Required: ${requiredFee}, Available: ${tokenInventory.total}`);
              this.log('Disconnecting due to insufficient tokens...');
              this.handleDisconnect('insufficient_tokens');
              return;
            }
            
            try {
              this.log(`Server requires ${requiredFee} token(s) for entry fee. Available: ${tokenInventory.total}. Sending entry token...`);
              
              // Send the token immediately since identity verification is complete
              const tokenFlow = await this.clientState.tokenService.sendEntryToken(this.clientState.serverPubkey);
              
              // Send token to server
              const result = this.sendMessage({
                type: 'token:entry',
                tokenFlow: tokenFlow
              });
              
              if (result) {
                // Mark token as sent only if the send was successful
                this.clientState.entryTokenSent = true;
                this.log('Entry token sent to server');
                
                // Emit status update to refresh UI
                this.emitStatusUpdate();
              } else {
                this.error('Failed to send entry token to server');
              }
            } catch (error) {
              this.error('Failed to send entry token:', error.message);
            }
          } else if (!paymentRequired) {
            this.log('Server indicates no payment required for this connection');
            this.clientState.entryTokenSent = true; // Mark as sent to prevent future attempts
            this.emitStatusUpdate();
          }
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
          } else if (message.success) {
            // Update entryTokenSent flag to ensure UI shows correct status
            this.clientState.entryTokenSent = true;
            // Emit status update to refresh UI
            this.emitStatusUpdate();
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
            
            // Add critical detailed logging for the server info
            this.log(`[CRITICAL] Raw message object keys: ${Object.keys(message).join(', ')}`);
            
            if (message.serverInfo) {
              this.log(`[CRITICAL] Server info received: players=${message.serverInfo.playerCount}, items=${message.serverInfo.itemCount}`);
              this.log(`[CRITICAL] Complete server info: ${JSON.stringify(message.serverInfo)}`);
            } else {
              this.log(`[CRITICAL] No serverInfo in message`);
              // Add placeholder server info if not provided
              message.serverInfo = {
                playerCount: Object.keys(this.gameIntegration?.game?.gameState?.players || {}).length || 0,
                itemCount: Object.keys(this.gameIntegration?.game?.gameState?.items || {}).length || 0,
                timestamp: Date.now()
              };
              this.log(`[CRITICAL] Added placeholder: ${JSON.stringify(message.serverInfo)}`);
            }
            
            // Add more detailed logging
            this.debug(`Server sent token for frame ${message.frame}, starting verification...`);
            
            // Store the current timestamp to track this verification process
            const verificationTimestamp = Date.now();
            
            const result = await this.clientState.tokenService.verifyGameStateToken(tokenFlow);
            
            // Log the verification result in detail
            if (result.verified) {
              this.debug(`Token verification successful: server hash=${result.stateHash}, frame=${result.frame}`);
            } else {
              this.debug(`Token verification failed: ${result.error || 'Unknown error'}`);
            }
            
            // Add a timestamp to the result to track when this verification occurred
            result.verificationTimestamp = verificationTimestamp;
            
            // Update the last verification result, including server info if available
            const currentTime = Date.now();
            
            // If we don't have serverInfo already, create a reliable default
            const serverInfo = message.serverInfo || {
              playerCount: Object.keys(this.gameIntegration?.game?.gameState?.players || {}).length || 0,
              itemCount: Object.keys(this.gameIntegration?.game?.gameState?.items || {}).length || 0,
              timestamp: currentTime
            };
            
            // Log critical information about the serverInfo we're about to store
            this.log(`[CRITICAL] Storing server info in verification: ${JSON.stringify(serverInfo)}`);
            
            // Create temporary verification object first for debugging
            const verificationObj = {
              timestamp: currentTime,
              result: result,
              frame: message.frame || result.frame || 0,
              serverFrame: message.frame || 0,
              stateHash: result.stateHash || null,
              // Store the enhanced server state information
              serverInfo: serverInfo
            };
            
            // Log the full verification object
            this.log(`[CRITICAL] Full verification object: ${JSON.stringify(verificationObj)}`);
            
            // Now store it
            this.clientState.lastGameStateVerification = verificationObj;
            
            // Update local game state to match server's verified state
            if (this.gameIntegration && this.gameIntegration.game) {
              // Sync the local game state with server state
              const serverFrame = message.frame || 0;
              
              // Make sure we have a valid game state object
              if (this.gameIntegration.game.gameState) {
                // Calculate our local hash for the current state to compare with server hash
                const gameState = this.gameIntegration.game.gameState;
                let localHash = null;
                
                if (this.clientState.tokenService) {
                  // Use our token service to calculate hash using the same algorithm
                  localHash = this.clientState.tokenService.hashGameState(gameState);
                  this.debug(`Current local state hash: ${localHash}`);
                  this.debug(`Server state hash: ${result.stateHash}`);
                  
                  // If hashes don't match, we need to sync with server state
                  if (localHash !== result.stateHash) {
                    this.debug(`Hash mismatch, syncing with server state...`);
                  } else {
                    this.debug(`Hash match! Client and server states are in sync.`);
                  }
                }
                
                // We want to use the server's frame number to ensure consistency
                this.gameIntegration.game.gameState.frame = serverFrame;
                this.gameIntegration.game.gameState.gameId = result.gameId || this.gameIntegration.game.gameState.gameId;
                
                // Store server state hash for consistency checking
                this.gameIntegration.game.gameState.serverHash = result.stateHash || null;
                
                this.log(`Synchronized game state with server frame: ${serverFrame}`);
                
                // Trigger a game state update to refresh UI
                this.gameIntegration.onGameStateChange(this.gameIntegration.game.gameState);
              } else {
                this.error("Cannot update game state: game.gameState is undefined");
              }
            }
            
            // Emit token event to update UI with verification result
            this.emit('tokenUpdate', {
              type: 'game_state_verification',
              result: result,
              frame: message.frame || 0
            });
            
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
          
        case 'match:end':
          this.log(`🏁 Match ended: ${message.reasonText || 'Game completed'}`);
          
          // Display match results
          if (message.winner) {
            this.log(`🏆 Winner: ${message.winner.name} with ${message.winner.score} points`);
          }
          
          if (message.finalScores && message.finalScores.length > 0) {
            this.log(`📊 Final scores:`);
            message.finalScores.forEach((player, index) => {
              const medal = index === 0 ? '🥇' : index === 1 ? '🥈' : index === 2 ? '🥉' : '  ';
              this.log(`${medal} ${player.name}: ${player.score} points`);
            });
          }
          
          // Reset the game iframe to clear the current game state
          this.resetGameIframe();
          
          // Show a modal/notification to the user
          if (this.gameIntegration && this.gameIntegration.game) {
            // Create a match end modal
            this.showMatchEndModal({
              winner: message.winner,
              finalScores: message.finalScores,
              matchEndReason: message.matchEndReason,
              reasonText: message.reasonText,
              matchEndTime: message.matchEndTime
            });
          }
          
          // Emit event for other parts of the client to handle
          this.emit('matchEnd', {
            winner: message.winner,
            finalScores: message.finalScores,
            matchEndReason: message.matchEndReason,
            reasonText: message.reasonText,
            matchEndTime: message.matchEndTime
          });
          
          break;
          
        default:
          this.debug(`Unhandled channel message: ${message.type}`);
          break;
      }
    }

    /**
     * Show match end modal with results
     */
    showMatchEndModal(matchData) {
      // Create a modal overlay
      const modalOverlay = document.createElement('div');
      modalOverlay.style.cssText = `
        position: fixed;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        background-color: rgba(0, 0, 0, 0.8);
        display: flex;
        justify-content: center;
        align-items: center;
        z-index: 10000;
        font-family: monospace;
      `;
      
      // Create modal content
      const modalContent = document.createElement('div');
      modalContent.style.cssText = `
        background-color: #1a1a1a;
        border: 3px solid #4caf50;
        border-radius: 10px;
        padding: 30px;
        max-width: 600px;
        width: 90%;
        color: #e0e0e0;
        text-align: center;
        box-shadow: 0 0 20px rgba(76, 175, 80, 0.5);
      `;
      
      // Build content HTML
      let contentHTML = `
        <div style="font-size: 28px; font-weight: bold; color: #4caf50; margin-bottom: 20px;">
          🏁 MATCH ENDED
        </div>
        <div style="font-size: 18px; color: #ffc107; margin-bottom: 20px;">
          ${matchData.reasonText || 'Game completed'}
        </div>
      `;
      
      if (matchData.winner) {
        contentHTML += `
          <div style="font-size: 24px; font-weight: bold; color: #ffc107; margin-bottom: 15px;">
            🏆 Winner: ${matchData.winner.name}
          </div>
          <div style="font-size: 18px; color: #e0e0e0; margin-bottom: 20px;">
            Score: ${matchData.winner.score} points
          </div>
        `;
      }
      
      if (matchData.finalScores && matchData.finalScores.length > 0) {
        contentHTML += `
          <div style="font-size: 20px; font-weight: bold; color: #e0e0e0; margin-bottom: 15px;">
            📊 Final Scores
          </div>
          <div style="text-align: left; max-width: 300px; margin: 0 auto 20px auto;">
        `;
        
        matchData.finalScores.forEach((player, index) => {
          const medal = index === 0 ? '🥇' : index === 1 ? '🥈' : index === 2 ? '🥉' : '  ';
          contentHTML += `
            <div style="margin-bottom: 5px; font-size: 16px;">
              ${medal} ${player.name}: ${player.score} pts
            </div>
          `;
        });
        
        contentHTML += `</div>`;
      }
      
      contentHTML += `
        <button id="closeMatchEndModal" style="
          background-color: #4caf50;
          border: none;
          color: white;
          padding: 12px 24px;
          font-size: 16px;
          border-radius: 5px;
          cursor: pointer;
          margin-top: 20px;
        ">Close</button>
      `;
      
      modalContent.innerHTML = contentHTML;
      modalOverlay.appendChild(modalContent);
      
      // Add to DOM
      document.body.appendChild(modalOverlay);
      
      // Close button handler
      const closeButton = document.getElementById('closeMatchEndModal');
      if (closeButton) {
        closeButton.addEventListener('click', () => {
          document.body.removeChild(modalOverlay);
        });
      }
      
      // Click outside to close
      modalOverlay.addEventListener('click', (e) => {
        if (e.target === modalOverlay) {
          document.body.removeChild(modalOverlay);
        }
      });
      
      // Auto-close after 30 seconds
      setTimeout(() => {
        if (document.body.contains(modalOverlay)) {
          document.body.removeChild(modalOverlay);
        }
      }, 30000);
      
      this.log('🎮 Match end modal displayed');
    }

    /**
     * Reset the game iframe to clear current game state and keep it empty
     */
    resetGameIframe() {
      try {
        // Find the game iframe in the document
        const gameIframe = document.querySelector('#gameframe') || 
                          document.querySelector('iframe[src*="game"]') ||
                          document.querySelector('iframe');
        
        if (gameIframe) {
          this.log('🔄 Clearing game iframe (match ended)...');
          
          // Clear the iframe and keep it empty
          gameIframe.src = 'about:blank';
          
          // Optionally add some content to show the match has ended
          gameIframe.onload = () => {
            try {
              const iframeDoc = gameIframe.contentDocument || gameIframe.contentWindow.document;
              if (iframeDoc) {
                iframeDoc.body.innerHTML = `
                  <div style="
                    display: flex;
                    justify-content: center;
                    align-items: center;
                    height: 100vh;
                    background-color: #1a1a1a;
                    color: #e0e0e0;
                    font-family: monospace;
                    font-size: 24px;
                    text-align: center;
                  ">
                    <div>
                      <div style="font-size: 32px; margin-bottom: 20px;">🏁</div>
                      <div>Match Ended</div>
                      <div style="font-size: 16px; margin-top: 10px; color: #888;">
                        Game will restart with next match
                      </div>
                    </div>
                  </div>
                `;
              }
            } catch (e) {
              // Cross-origin restrictions might prevent this, that's OK
              this.debug('Could not add content to iframe (cross-origin)');
            }
            gameIframe.onload = null; // Remove the handler
          };
          
          this.log('✅ Game iframe cleared - awaiting next match');
          
        } else {
          this.warn('⚠️  No game iframe found to reset');
        }
      } catch (error) {
        this.error('❌ Error resetting game iframe:', error);
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
        
        // Save identity to localStorage if in browser environment
        if (typeof window !== 'undefined' && window.savePlayerIdentity) {
          window.savePlayerIdentity();
        }
        
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

    /**
     * Update the player name
     * @param {string} newName - New player name
     * @returns {boolean} Success flag
     */
    updatePlayerName(newName) {
      if (!newName || typeof newName !== 'string') {
        this.error('Invalid player name provided');
        return false;
      }
      
      const cleanName = newName.trim().substring(0, 16);
      if (!cleanName) {
        this.error('Player name cannot be empty');
        return false;
      }
      
      // Update client info and config
      this.clientInfo.name = cleanName;
      this.config.name = cleanName;
      
      // If token service is initialized, we need to reinitialize it with the new name
      if (this.clientState.tokenService) {
        this.log(`Updating token service username to: ${cleanName}`);
        // Note: The token service creates a cryptographic identity based on the username
        // Changing the name would create a different identity, so we'll keep the existing one
        // but update the display name in the UI
      }
      
      this.log(`Player name updated to: ${cleanName}`);
      return true;
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
        
        // Save identity to localStorage when tokens are updated (if in browser environment)
        if (typeof window !== 'undefined' && window.savePlayerIdentity) {
          window.savePlayerIdentity();
        }
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