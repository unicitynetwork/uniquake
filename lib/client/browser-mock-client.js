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
        onServerList: null,
        onPlayerScoreUpdate: null
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

      // UI intervals
      this.orangeBannerInterval = null;

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
      if (this.config.onPlayerScoreUpdate) this.on('playerScoreUpdate', this.config.onPlayerScoreUpdate);

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
          this.log('Page visible again - checking for pending restart commands');
          
          // Force WebSocket message processing by triggering a small keepalive
          // This helps browsers process any queued messages that were throttled during hidden state
          if (this.clientState.signaling && this.clientState.signaling.readyState === WebSocket.OPEN) {
            // Send a lightweight ping to force message queue processing
            this.clientState.signaling.send(JSON.stringify({ 
              type: 'keepalive', 
              timestamp: Date.now() 
            }));
          }
          
          // Also trigger any pending restart if we detect a restart cycle
          // Check if we're in a game_over state that should have restarted by now
          setTimeout(() => {
            this.checkForStuckRestartCycle();
          }, 500); // Short delay to allow message processing
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
      
      // Set up periodic restart cycle recovery check (every 10 seconds)
      // This helps detect and recover from stuck restart cycles caused by tab focus issues
      this.recoveryInterval = setInterval(() => {
        this.checkForStuckRestartCycle();
      }, 10000);
      
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
            this.log(`Minting ${this.config.mintTokens} initial tokens in background...`);
            // Mint tokens in background to not block page load
            this.clientState.tokenService.mintCoins(this.config.mintTokens, '1').then(() => {
              this.log(`Minted ${this.config.mintTokens} tokens successfully`);
              // Trigger token update event after minting
              this.emitTokenUpdate();
              
              // Save identity to localStorage if in browser environment
              if (typeof window !== 'undefined' && window.savePlayerIdentity) {
                window.savePlayerIdentity();
              }
            }).catch(error => {
              this.error(`Failed to mint initial tokens: ${error.message}`);
            });
          }
        }
        
        // Get identity info
        const identity = this.clientState.tokenService.getIdentity();
        this.log(`Token service initialized with identity: ${identity.username} (${identity.pubkey.substring(0, 10)}...)`);
        
        // Trigger token update event
        this.emitTokenUpdate();
        
        // Start automint monitoring
        this.startAutoMintMonitoring();
        
        return true;
      } catch (error) {
        this.error('Failed to initialize token service:', error);
        return false;
      }
    }
    
    /**
     * Start monitoring token balance for automint
     */
    startAutoMintMonitoring() {
      // Check balance every 5 seconds
      this.autoMintInterval = setInterval(() => {
        this.checkAndAutoMint();
      }, 5000);
      
      // Also check immediately
      this.checkAndAutoMint();
    }
    
    /**
     * Check token balance and automint if needed
     */
    async checkAndAutoMint() {
      try {
        const inventory = this.getTokenInventory();
        
        if (inventory.error) {
          this.debug('Cannot check token balance for automint:', inventory.error);
          return;
        }
        
        // If balance is 0, automint 5 tokens
        if (inventory.total === 0) {
          this.log('Token balance is 0, autominting 5 tokens...');
          
          // Mint tokens in background (don't await)
          this.mintTokens(5).then(() => {
            this.log('Automint complete: 5 tokens minted successfully');
            
            // Save identity to localStorage if in browser environment
            if (typeof window !== 'undefined' && window.savePlayerIdentity) {
              window.savePlayerIdentity();
            }
          }).catch(error => {
            this.error('Automint failed:', error.message);
          });
        }
      } catch (error) {
        this.debug('Error checking token balance for automint:', error.message);
      }
    }

    /**
     * Connect to the master server
     */
    async connectToMasterServer() {
      return new Promise((resolve, reject) => {
        // Use the provided URL directly (should already include ws:// protocol)
        const masterUrl = this.config.masterServer;
        this.debug('MASTER URL (raw):', this.config.masterServer);
        this.debug('MASTER URL (used):', masterUrl);
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
        
        // Store the last connected server for auto-reconnect purposes
        this.clientState.lastConnectedServerPeerId = this.clientState.connectedServerPeerId;
        
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
          
        case 'server_restarted':
          this.handleServerRestarted(message);
          break;
          
        case 'disconnect_ack':
          this.log('Disconnected from server successfully');
          this.handleDisconnect('user_disconnect');
          break;
          
        case 'scores_response':
          // Handle response to score request from master server
          this.handleScoresResponse(message);
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
        if (data.serverInfo) {
          
          // Ensure serverInfo has all required properties
          if (!data.serverInfo.playerCount && data.serverInfo.playerCount !== 0) {
            data.serverInfo.playerCount = 0;
          }
          
          if (!data.serverInfo.itemCount && data.serverInfo.itemCount !== 0) {
            data.serverInfo.itemCount = 0;
          }
          
          if (!data.serverInfo.timestamp) {
            data.serverInfo.timestamp = Date.now();
          }
          
          // Store server state info in client state
          this.clientState.serverStateInfo = {
            playerCount: data.serverInfo.playerCount,
            itemCount: data.serverInfo.itemCount,
            timestamp: data.serverInfo.timestamp
          };
          
          // Update lastGameStateVerification with this info as well
          if (this.clientState.lastGameStateVerification) {
            this.clientState.lastGameStateVerification.serverInfo = this.clientState.serverStateInfo;
          }
        }
      }
      // For game state tokens, also add detailed logging
      else if (data && data.type === 'game:state:token') {
        if (data.serverInfo) {
          
          // Ensure serverInfo has all required properties
          if (!data.serverInfo.playerCount && data.serverInfo.playerCount !== 0) {
            data.serverInfo.playerCount = 0;
          }
          
          if (!data.serverInfo.itemCount && data.serverInfo.itemCount !== 0) {
            data.serverInfo.itemCount = 0;
          }
          
          if (!data.serverInfo.timestamp) {
            data.serverInfo.timestamp = Date.now();
          }
        } else {
          // First try to use existing serverStateInfo if available
          if (this.clientState.serverStateInfo) {
            data.serverInfo = this.clientState.serverStateInfo;
          } else {
            data.serverInfo = {
              playerCount: 0,
              itemCount: 0,
              timestamp: Date.now()
            };
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
              // Ensure serverInfo is properly set before forwarding
              if (!data.serverInfo) {
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
                dataCopy.serverInfo = JSON.parse(JSON.stringify(data.serverInfo));
              }
              
              // One final check to ensure serverInfo is present
              if (!dataCopy.serverInfo) {
                dataCopy.serverInfo = {
                  playerCount: Object.keys(this.gameIntegration?.game?.gameState?.players || {}).length || 0,
                  itemCount: Object.keys(this.gameIntegration?.game?.gameState?.items || {}).length || 0,
                  timestamp: Date.now()
                };
              }
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
      
      // Stop recovery check interval
      if (this.recoveryInterval) {
        clearInterval(this.recoveryInterval);
        this.recoveryInterval = null;
      }
      
      // Note: We don't stop automint interval on disconnect
      // because we want to keep monitoring token balance even when disconnected
      
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
            
            // Store server state info in a dedicated property
            this.clientState.serverStateInfo = {
              playerCount: message.serverInfo.playerCount,
              itemCount: message.serverInfo.itemCount,
              timestamp: message.serverInfo.timestamp
            };
            
            // Update the last verification with this info as well
            if (this.clientState.lastGameStateVerification) {
              this.clientState.lastGameStateVerification.serverInfo = this.clientState.serverStateInfo;
            }
            
            // If game integration exists, update the game state with server info
            if (this.gameIntegration && this.gameIntegration.game) {
              // Trigger a game state update to refresh UI with the new server info
              this.gameIntegration.onGameStateChange(this.gameIntegration.game.getGameState());
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
                
                // Check for automint after spending token
                setTimeout(() => {
                  this.checkAndAutoMint();
                }, 1000);
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
            
            if (!message.serverInfo) {
              // Add placeholder server info if not provided
              message.serverInfo = {
                playerCount: Object.keys(this.gameIntegration?.game?.gameState?.players || {}).length || 0,
                itemCount: Object.keys(this.gameIntegration?.game?.gameState?.items || {}).length || 0,
                timestamp: Date.now()
              };
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
          
        // RESTART FUNCTIONALITY DISABLED
        // TO RE-ENABLE RESTART: Uncomment the case blocks below
        /*
        case 'server:restart:cycle':
          this.log(`🔄 Server restart cycle initiated: ${message.message}`);
          this.showServerRestartNotification(message);
          break;
          
        case 'server:restart:countdown':
          this.log(`⏳ Server restart countdown: ${message.message}`);
          this.updateRestartCountdown(message.remainingTime);
          break;
          
        case 'server:restart:starting':
          this.log(`🚀 Server is restarting: ${message.message}`);
          this.showRestartingMessage();
          break;
          
        case 'server:restart:complete':
          this.log(`✅ Server restart complete: ${message.message}`);
          this.handleServerRestartComplete(message);
          break;
          
        case 'server:restart:error':
          this.error(`❌ Server restart error: ${message.message}`);
          this.showRestartError(message);
          break;
          
        case 'game:restart:command':
          this.log(`🎮 Game restart command received: ${message.message}`);
          this.handleGameRestartCommand(message);
          break;
        */
        
        case 'server:restart:cycle':
        case 'server:restart:countdown':
        case 'server:restart:starting':
        case 'server:restart:complete':
        case 'server:restart:error':
        case 'game:restart:command':
          this.log(`🚫 Restart message ignored (restart disabled): ${message.type} - ${message.message}`);
          break;
          
        case 'match:final:end':
          this.log(`🏁 Final match end: ${message.message}`);
          this.showFinalMatchEnd(message);
          break;
          
        case 'player_score_update':
          // FALLBACK: Allow server page updates when master server requests fail
          // But use timestamp checking to prevent stale data overwrites
          this.handlePlayerScoreUpdateWithTimestampCheck(message);
          break;
          
        case 'scores_response':
          // Handle response to score request from master server
          this.handleScoresResponse(message);
          break;
          
        default:
          this.debug(`Unhandled channel message: ${message.type}`);
          break;
      }
    }

    /**
     * Handle player score and countdown updates from server
     * DISABLED: This method is no longer called to prevent server page data from
     * overwriting fresh master server data. Client now gets scores directly from master.
     */
    handlePlayerScoreUpdate(message) {
      // Store the latest player score data
      if (message.playerScore) {
        this.clientState.latestPlayerScore = {
          score: message.playerScore.score || 0,
          ping: message.playerScore.ping || 999,
          name: message.playerScore.name || '',
          rank: message.playerScore.rank || 0,
          lastUpdate: Date.now()
        };
        
        this.debug(`Updated player score: ${this.clientState.latestPlayerScore.score} (rank ${this.clientState.latestPlayerScore.rank})`);
      }
      
      // Store the match countdown data
      if (message.countdown) {
        this.clientState.matchCountdown = {
          totalSeconds: message.countdown.totalSeconds || 0,
          timeText: message.countdown.timeText || "00:00",
          isActive: message.countdown.isActive || false,
          lastUpdate: Date.now()
        };
        
        this.debug(`Updated countdown: ${this.clientState.matchCountdown.timeText} (active: ${this.clientState.matchCountdown.isActive})`);
      }
      
      // Store all player scores for leaderboard
      if (message.allScores) {
        this.clientState.allPlayerScores = message.allScores.map(player => ({
          name: player.name || '',
          score: player.score || 0,
          ping: player.ping || 999
        }));
        
        this.debug(`Updated leaderboard with ${this.clientState.allPlayerScores.length} players`);
      }
      
      // Emit event for UI to listen to
      this.emit('playerScoreUpdate', {
        playerScore: this.clientState.latestPlayerScore,
        countdown: this.clientState.matchCountdown,
        allScores: this.clientState.allPlayerScores,
        timestamp: message.timestamp
      });
    }

    /**
     * Handle player score updates with timestamp checking to prevent stale data overwrites
     * This is used as a fallback when master server requests fail
     */
    handlePlayerScoreUpdateWithTimestampCheck(message) {
      this.debug('Received server page score update - checking timestamps');
      
      // ALWAYS process countdown data regardless of timestamp checks
      // The countdown comes from the server page and is needed for the timer overlay
      if (message.countdown) {
        this.clientState.matchCountdown = {
          totalSeconds: message.countdown.totalSeconds || 0,
          timeText: message.countdown.timeText || "00:00",
          isActive: message.countdown.isActive || false,
          lastUpdate: Date.now()
        };
        
        this.debug(`Updated countdown from server page: ${this.clientState.matchCountdown.timeText} (active: ${this.clientState.matchCountdown.isActive})`);
      }
      
      // Check if we have recent master server data for SCORE updates only
      const latestScore = this.clientState.latestPlayerScore;
      const masterRequestTime = this.clientState.lastMasterScoreRequest || 0;
      const currentTime = Date.now();
      
      // If master server request was made recently (within last 10 seconds), ignore server page SCORE data
      if (currentTime - masterRequestTime < 10000) {
        this.debug('Ignoring server page score data - recent master request detected (countdown still processed)');
        return;
      }
      
      // If we have recent score data from master (within last 15 seconds), ignore server page SCORE data
      if (latestScore && latestScore.lastUpdate && (currentTime - latestScore.lastUpdate) < 15000) {
        this.debug('Ignoring server page score data - recent master data available (countdown still processed)');
        return;
      }
      
      // If server page data is too old (more than 30 seconds), ignore SCORE data
      if (message.timestamp && (currentTime - message.timestamp) > 30000) {
        this.debug('Ignoring server page score data - too old (countdown still processed)');
        return;
      }
      
      // Fallback: use server page SCORE data when master is failing
      this.debug('Using server page score data as fallback (master requests failing)');
      
      // Track that we're using fallback data
      this.clientState.usingScoreFallback = true;
      
      // Process the score update normally (but countdown was already processed above)
      this.handlePlayerScoreUpdate(message);
      
      // Log when fallback is being used
      console.log('🔄 Using server page score data as fallback (master server requests failing)');
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
        const gameIframe = document.querySelector('#game-iframe') || 
                          document.querySelector('#gameframe') ||
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
     * Show final match end notification (no restart)
     */
    showFinalMatchEnd(message) {
      this.log(`🏁 Showing final match end notification: ${message.message}`);
      
      // Remove any existing notifications
      this.removeRestartNotifications();
      
      // Create final match end overlay
      const finalOverlay = document.createElement('div');
      finalOverlay.id = 'final-match-end-notification';
      finalOverlay.style.cssText = `
        position: fixed;
        top: 20px;
        right: 20px;
        background-color: rgba(244, 67, 54, 0.95);
        color: white;
        padding: 20px 25px;
        border-radius: 8px;
        font-family: monospace;
        font-size: 16px;
        z-index: 9999;
        box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
        max-width: 300px;
      `;
      
      finalOverlay.innerHTML = `
        <div style="font-weight: bold; margin-bottom: 10px;">🏁 Match Complete</div>
        <div>${message.message}</div>
        <div style="margin-top: 10px; font-size: 14px; opacity: 0.9;">
          Reason: ${message.reason || 'Unknown'}
        </div>
      `;
      
      document.body.appendChild(finalOverlay);
      
      // Auto-remove after 10 seconds
      setTimeout(() => {
        if (document.body.contains(finalOverlay)) {
          document.body.removeChild(finalOverlay);
        }
      }, 10000);
    }

    /**
     * Show server restart notification with countdown (uses server registry data)
     * RESTART FUNCTIONALITY DISABLED
     * TO RE-ENABLE RESTART: Uncomment the implementation below
     */
    showServerRestartNotification(message) {
      this.log(`🚫 Server restart notification ignored (restart disabled): ${message.message}`);
      return;
      
      /*
      // ORIGINAL RESTART NOTIFICATION IMPLEMENTATION - COMMENTED OUT
      // TO RE-ENABLE RESTART: Uncomment this block
      
      // Remove any existing restart notifications
      this.removeRestartNotifications();
      
      // Create restart notification overlay
      const notificationOverlay = document.createElement('div');
      notificationOverlay.id = 'restart-notification';
      notificationOverlay.style.cssText = `
        position: fixed;
        top: 20px;
        right: 20px;
        background-color: rgba(255, 152, 0, 0.95);
        color: white;
        padding: 20px;
        border-radius: 8px;
        font-family: monospace;
        font-size: 16px;
        z-index: 9999;
        min-width: 300px;
        box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
      `;
      
      notificationOverlay.innerHTML = `
        <div style="font-weight: bold; margin-bottom: 10px;">🔄 Server Restart</div>
        <div>${message.message}</div>
        <div id="restart-countdown" style="font-weight: bold; margin-top: 10px; color: #fff3e0;">
          ⏱️ Next match in: --s
        </div>
      `;
      
      document.body.appendChild(notificationOverlay);
      
      // Start using server registry data for countdown display
      this.startOrangeBannerCountdown();
      
      this.log('🔄 Server restart notification displayed (using server registry data)');
      */
    }
    
    /**
     * Start orange banner countdown using server registry data
     */
    startOrangeBannerCountdown() {
      // Clear any existing interval
      if (this.orangeBannerInterval) {
        clearInterval(this.orangeBannerInterval);
      }
      
      // Update countdown every second using server registry data
      this.orangeBannerInterval = setInterval(() => {
        this.updateOrangeBannerFromServerRegistry();
      }, 1000);
      
      // Initial update
      this.updateOrangeBannerFromServerRegistry();
    }
    
    /**
     * Update orange banner countdown from server registry data
     */
    updateOrangeBannerFromServerRegistry() {
      const countdownEl = document.getElementById('restart-countdown');
      if (!countdownEl) {
        // Banner was removed, stop the interval
        if (this.orangeBannerInterval) {
          clearInterval(this.orangeBannerInterval);
          this.orangeBannerInterval = null;
        }
        return;
      }
      
      // Get countdown directly from server list data
      let restartCountdown = null;
      
      // DEBUG: Log what we have
      console.log('BANNER DEBUG: connectedServerPeerId =', this.clientState?.connectedServerPeerId);
      console.log('BANNER DEBUG: serverList available =', !!this.clientState?.serverList);
      console.log('BANNER DEBUG: serverList length =', this.clientState?.serverList?.length);
      
      // Find the server we're connected to in the server list
      if (this.clientState?.connectedServerPeerId && this.clientState?.serverList) {
        const connectedServer = this.clientState.serverList.find(s => s.peerId === this.clientState.connectedServerPeerId);
        console.log('BANNER DEBUG: found connected server =', connectedServer);
        
        if (connectedServer) {
          console.log('BANNER DEBUG: server state =', connectedServer.dedicatedServerState);
          console.log('BANNER DEBUG: server restartCountdown =', connectedServer.restartCountdown);
        }
        
        if (connectedServer && connectedServer.dedicatedServerState === 'game_over' && connectedServer.restartCountdown > 0) {
          restartCountdown = connectedServer.restartCountdown;
          console.log('BANNER DEBUG: using restartCountdown =', restartCountdown);
        }
      }
      
      // Update display
      if (restartCountdown !== null && restartCountdown > 0) {
        countdownEl.innerHTML = `⏱️ Next match in: ${restartCountdown}s`;
        console.log('BANNER DEBUG: updated banner with countdown =', restartCountdown);
      } else {
        countdownEl.innerHTML = `⏱️ Next match in: --s`;
        console.log('BANNER DEBUG: no valid countdown found, showing --s');
        
        // If countdown expired, stop the interval but don't trigger restart
        // (restart will be triggered by explicit game:restart:command)
        if (this.orangeBannerInterval) {
          clearInterval(this.orangeBannerInterval);
          this.orangeBannerInterval = null;
        }
      }
    }
    
    /**
     * Update restart countdown display (legacy method for compatibility)
     * RESTART FUNCTIONALITY DISABLED
     * TO RE-ENABLE RESTART: Uncomment the implementation below
     */
    updateRestartCountdown(remainingTime) {
      this.log(`🚫 Restart countdown ignored (restart disabled): ${Math.ceil(remainingTime / 1000)}s`);
      return;
      
      /*
      // ORIGINAL IMPLEMENTATION - COMMENTED OUT
      // TO RE-ENABLE RESTART: Uncomment this block
      
      // This method is kept for compatibility but now just logs the old-style update
      this.debug(`Legacy countdown update: ${Math.ceil(remainingTime / 1000)}s (now using server registry data)`);
      */
    }
    
    /**
     * Show restarting message
     * RESTART FUNCTIONALITY DISABLED
     * TO RE-ENABLE RESTART: Uncomment the implementation below
     */
    showRestartingMessage() {
      this.log(`🚫 Restarting message ignored (restart disabled)`);
      return;
      
      /*
      // ORIGINAL IMPLEMENTATION - COMMENTED OUT
      // TO RE-ENABLE RESTART: Uncomment this block
      
      this.removeRestartNotifications();
      
      const restartingOverlay = document.createElement('div');
      restartingOverlay.id = 'restarting-notification';
      restartingOverlay.style.cssText = `
        position: fixed;
        top: 20px;
        right: 20px;
        background-color: rgba(33, 150, 243, 0.95);
        color: white;
        padding: 20px;
        border-radius: 8px;
        font-family: monospace;
        font-size: 16px;
        z-index: 9999;
        min-width: 300px;
        box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
      `;
      
      restartingOverlay.innerHTML = `
        <div style="font-weight: bold; margin-bottom: 10px;">🚀 Server Restarting</div>
        <div>Please wait while the server restarts...</div>
        <div style="margin-top: 10px;">🔄 Preparing new match...</div>
      `;
      
      document.body.appendChild(restartingOverlay);
      */
    }
    
    /**
     * Handle server restart complete (legacy method - restart now handled by explicit command)
     * RESTART FUNCTIONALITY DISABLED
     * TO RE-ENABLE RESTART: Uncomment the implementation below
     */
    handleServerRestartComplete(message) {
      this.log(`🚫 Server restart complete ignored (restart disabled): ${message.message}`);
      return;
      
      /*
      // ORIGINAL IMPLEMENTATION - COMMENTED OUT
      // TO RE-ENABLE RESTART: Uncomment this block
      
      this.removeRestartNotifications();
      
      // Clear any countdown intervals
      if (this.orangeBannerInterval) {
        clearInterval(this.orangeBannerInterval);
        this.orangeBannerInterval = null;
      }
      
      // Show completion notification briefly (but don't restart automatically)
      const completeOverlay = document.createElement('div');
      completeOverlay.style.cssText = `
        position: fixed;
        top: 20px;
        right: 20px;
        background-color: rgba(76, 175, 80, 0.95);
        color: white;
        padding: 20px;
        border-radius: 8px;
        font-family: monospace;
        font-size: 16px;
        z-index: 9999;
        min-width: 300px;
        box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
      `;
      
      completeOverlay.innerHTML = `
        <div style="font-weight: bold; margin-bottom: 10px;">✅ Server Ready</div>
        <div>Waiting for restart command...</div>
      `;
      
      document.body.appendChild(completeOverlay);
      
      // Auto-remove notification after 3 seconds (but don't restart automatically)
      setTimeout(() => {
        if (document.body.contains(completeOverlay)) {
          document.body.removeChild(completeOverlay);
        }
      }, 3000);
      
      this.log('✅ Server restart complete - waiting for explicit restart command');
      */
    }
    
    /**
     * Show restart error
     * RESTART FUNCTIONALITY DISABLED
     * TO RE-ENABLE RESTART: Uncomment the implementation below
     */
    showRestartError(message) {
      this.log(`🚫 Restart error ignored (restart disabled): ${message.message}`);
      return;
      
      /*
      // ORIGINAL IMPLEMENTATION - COMMENTED OUT
      // TO RE-ENABLE RESTART: Uncomment this block
      
      this.removeRestartNotifications();
      
      const errorOverlay = document.createElement('div');
      errorOverlay.style.cssText = `
        position: fixed;
        top: 20px;
        right: 20px;
        background-color: rgba(244, 67, 54, 0.95);
        color: white;
        padding: 20px;
        border-radius: 8px;
        font-family: monospace;
        font-size: 16px;
        z-index: 9999;
        min-width: 300px;
        box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
      `;
      
      errorOverlay.innerHTML = `
        <div style="font-weight: bold; margin-bottom: 10px;">❌ Restart Failed</div>
        <div>${message.message}</div>
        <button onclick="window.location.reload()" style="
          background-color: white;
          color: #f44336;
          border: none;
          padding: 8px 16px;
          border-radius: 4px;
          margin-top: 10px;
          cursor: pointer;
        ">Refresh Page</button>
      `;
      
      document.body.appendChild(errorOverlay);
      */
    }
    
    /**
     * Handle explicit game restart command from server
     * RESTART FUNCTIONALITY DISABLED
     * TO RE-ENABLE RESTART: Uncomment the implementation below
     */
    handleGameRestartCommand(message) {
      this.log(`🚫 Game restart command ignored (restart disabled) from server ${message.serverPeerId}`);
      this.log(`Message: ${message.message}`);
      
      // Do nothing - restart is disabled
      return;
      
      /*
      // ORIGINAL RESTART IMPLEMENTATION - COMMENTED OUT
      // TO RE-ENABLE RESTART: Uncomment this block
      
      this.log(`🎮 Processing game restart command from server ${message.serverPeerId}`);
      
      // Remove all restart notifications
      this.removeRestartNotifications();
      
      // Show brief restart notification
      const restartNotification = document.createElement('div');
      restartNotification.id = 'game-restart-notification';
      restartNotification.style.cssText = `
        position: fixed;
        top: 20px;
        right: 20px;
        background-color: rgba(76, 175, 80, 0.95);
        color: white;
        padding: 15px 20px;
        border-radius: 8px;
        font-family: monospace;
        font-size: 16px;
        z-index: 9999;
        box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
      `;
      
      restartNotification.innerHTML = `
        <div style="font-weight: bold;">🎮 Game Restarting</div>
        <div style="margin-top: 5px;">${message.message}</div>
      `;
      
      document.body.appendChild(restartNotification);
      
      // Auto-remove notification after 3 seconds
      setTimeout(() => {
        if (document.body.contains(restartNotification)) {
          document.body.removeChild(restartNotification);
        }
      }, 3000);
      
      // Execute the game restart immediately
      this.restartGameForNewMatch();
      
      // If we have a gameIntegration, notify it of the restart
      if (this.gameIntegration) {
        this.gameIntegration.onServerRestart?.();
      }
      
      // Force immediate processing by ensuring page is active
      // This prevents the restart from being deferred due to tab visibility
      if (document.hidden) {
        this.log('🔄 Page is hidden during restart - scheduling retry when visible');
        
        // Set up a one-time listener for when the page becomes visible
        const handleVisibilityForRestart = () => {
          if (!document.hidden) {
            this.log('🔄 Page visible again - executing deferred restart');
            this.restartGameForNewMatch(); // Execute again when page becomes visible
            document.removeEventListener('visibilitychange', handleVisibilityForRestart);
          }
        };
        
        document.addEventListener('visibilitychange', handleVisibilityForRestart);
        
        // Also set a timeout as fallback (max 10 seconds)
        setTimeout(() => {
          document.removeEventListener('visibilitychange', handleVisibilityForRestart);
          if (document.hidden) {
            this.log('⚠️ Forcing restart despite hidden page state');
            this.restartGameForNewMatch();
          }
        }, 10000);
      }
      */
    }
    
    /**
     * Remove existing restart notifications
     */
    removeRestartNotifications() {
      const existing = document.querySelectorAll('#restart-notification, #restarting-notification');
      existing.forEach(el => {
        if (document.body.contains(el)) {
          document.body.removeChild(el);
        }
      });
    }
    
    /**
     * Restart the game iframe for new match
     * RESTART FUNCTIONALITY DISABLED
     * TO RE-ENABLE RESTART: Uncomment the implementation below
     */
    restartGameForNewMatch() {
      this.log('🚫 Game restart disabled - restartGameForNewMatch() ignored');
      return;
      
      /*
      // ORIGINAL RESTART IMPLEMENTATION - COMMENTED OUT
      // TO RE-ENABLE RESTART: Uncomment this block
      
      try {
        const gameIframe = document.querySelector('#game-iframe') || 
                          document.querySelector('#gameframe') ||
                          document.querySelector('iframe[src*="game"]') ||
                          document.querySelector('iframe');
        
        if (gameIframe) {
          this.log('🔄 Restarting game for new match...');
          
          // Store the original src
          const originalSrc = gameIframe.src;
          
          // Clear iframe first
          gameIframe.src = 'about:blank';
          
          // After a brief delay, reload the game
          setTimeout(() => {
            gameIframe.src = originalSrc;
            this.log('✅ Game restarted for new match');
          }, 1000);
          
        } else {
          this.warn('⚠️  No game iframe found to restart');
        }
      } catch (error) {
        this.error('❌ Error restarting game iframe:', error);
      }
      */
    }

    /**
     * Check for stuck restart cycle and force recovery
     * RESTART FUNCTIONALITY DISABLED
     * TO RE-ENABLE RESTART: Uncomment the implementation below
     */
    checkForStuckRestartCycle() {
      this.log('🚫 Stuck restart cycle check disabled (restart functionality disabled)');
      return;
      
      /*
      // ORIGINAL IMPLEMENTATION - COMMENTED OUT
      // TO RE-ENABLE RESTART: Uncomment this block
      
      try {
        // Look for game over banners that should have been cleared by now
        const orangeBanner = document.querySelector('#restart-countdown-banner');
        const yellowBanner = document.querySelector('#restart-wait-banner');
        
        // If we have a yellow "waiting for restart" banner, the restart cycle is stuck
        if (yellowBanner) {
          this.log('🔄 Detected stuck restart cycle - forcing recovery');
          
          // Remove the stuck banner
          if (document.body.contains(yellowBanner)) {
            document.body.removeChild(yellowBanner);
            this.log('🗑️ Removed stuck restart banner');
          }
          
          // Force a server list refresh to get current server state
          if (this.requestServerList) {
            this.requestServerList();
            this.log('🔄 Forced server list refresh to check current state');
          }
          
          // If we're connected to a server that should have restarted, reconnect
          if (this.clientState.connected && this.clientState.connectedServerPeerId) {
            setTimeout(() => {
              this.log('🔄 Attempting automatic reconnection after stuck restart');
              this.disconnect();
              setTimeout(() => {
                // Trigger reconnection through the UI if connect button exists
                const connectButton = document.getElementById('connect-button');
                if (connectButton && !connectButton.disabled) {
                  connectButton.click();
                }
              }, 1000);
            }, 2000);
          }
        }
        
        // Also check for orange banners that have been stuck for too long (>35 seconds)
        if (orangeBanner) {
          const bannerText = orangeBanner.textContent || '';
          // If countdown shows 0 or negative, it's stuck
          if (bannerText.includes('0s') || bannerText.includes('-')) {
            this.log('🔄 Detected stuck countdown banner - removing');
            if (document.body.contains(orangeBanner)) {
              document.body.removeChild(orangeBanner);
            }
          }
        }
        
      } catch (error) {
        this.warn('⚠️ Error checking for stuck restart cycle:', error);
      }
      */
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
     * Get the latest player score data
     */
    getLatestPlayerScore() {
      return this.clientState.latestPlayerScore || {
        score: 0,
        ping: 999,
        name: '',
        rank: 0,
        lastUpdate: null
      };
    }

    /**
     * Get the current match countdown
     */
    getMatchCountdown() {
      return this.clientState.matchCountdown || {
        totalSeconds: 0,
        timeText: "00:00",
        isActive: false,
        lastUpdate: null
      };
    }

    /**
     * Get all player scores (leaderboard)
     */
    getAllPlayerScores() {
      return this.clientState.allPlayerScores || [];
    }

    /**
     * Request player scores directly from master server for a specific game server
     * @param {string} gameId - Game server ID (optional if peerId provided)
     * @param {string} peerId - Peer ID of the game server (optional if gameId provided)
     * @param {string} playerName - Player name to highlight in results (optional)
     * @returns {Promise} Promise that resolves with score data
     */
    requestScoresFromMaster(gameId = null, peerId = null, playerName = null) {
      return new Promise((resolve, reject) => {
        if (!this.clientState.connected) {
          reject(new Error('Not connected to master server'));
          return;
        }

        if (!gameId && !peerId) {
          reject(new Error('Must provide either gameId or peerId'));
          return;
        }

        const requestId = this.generateRequestId();
        
        // Store the promise resolvers for when response comes back
        if (!this.clientState.pendingRequests) {
          this.clientState.pendingRequests = new Map();
        }
        
        this.clientState.pendingRequests.set(requestId, {
          resolve,
          reject,
          timestamp: Date.now(),
          timeout: setTimeout(() => {
            this.clientState.pendingRequests.delete(requestId);
            reject(new Error('Request timeout'));
          }, 10000) // 10 second timeout
        });

        // Use the current player name if not provided
        const requestPlayerName = playerName || this.clientInfo.name || this.config.name;

        // Send score request to master server
        const message = {
          type: 'request_scores',
          requestId: requestId,
          gameId: gameId,
          peerId: peerId,
          playerName: requestPlayerName,
          timestamp: Date.now()
        };

        // Add comprehensive logging to debug the timeout issue
        console.log('[SCORE REQUEST DEBUG] Sending score request to master server:', {
          message: message,
          masterServerUrl: this.config.masterServer,
          webSocketState: this.clientState.signaling ? this.clientState.signaling.readyState : 'no connection',
          webSocketUrl: this.clientState.signaling ? this.clientState.signaling.url : 'no URL',
          connectionStatus: this.clientState.connected,
          timestamp: new Date().toISOString()
        });

        // Send directly to master server (not through game server proxy)
        const sent = this.sendToMaster(message);
        
        if (sent) {
          this.debug(`Successfully sent score request for ${gameId || peerId} to master server`);
          console.log('[SCORE REQUEST DEBUG] Message sent successfully to master server');
        } else {
          this.error(`Failed to send score request to master server`);
          console.error('[SCORE REQUEST DEBUG] Failed to send message to master server');
          this.clientState.pendingRequests.delete(requestId);
          reject(new Error('Failed to send request to master server'));
          return;
        }
      });
    }

    /**
     * Handle scores response from master server
     */
    handleScoresResponse(message) {
      console.log('[SCORE REQUEST DEBUG] Received scores response from master server:', {
        requestId: message.requestId,
        success: message.success,
        gameId: message.gameId,
        peerId: message.peerId,
        playerCount: message.allScores ? message.allScores.length : 0,
        timestamp: new Date().toISOString()
      });

      if (!message.requestId) {
        this.warn('Received scores response without request ID');
        return;
      }

      const pendingRequest = this.clientState.pendingRequests?.get(message.requestId);
      if (!pendingRequest) {
        this.warn(`Received scores response for unknown request: ${message.requestId}`);
        return;
      }

      // Clear timeout and remove from pending requests
      clearTimeout(pendingRequest.timeout);
      this.clientState.pendingRequests.delete(message.requestId);

      if (message.success) {
        // Update local score data
        if (message.playerScore) {
          this.clientState.latestPlayerScore = {
            score: message.playerScore.score || 0,
            ping: message.playerScore.ping || 999,
            name: message.playerScore.name || '',
            rank: message.playerScore.rank || 0,
            lastUpdate: Date.now()
          };
        }

        if (message.allScores) {
          this.clientState.allPlayerScores = message.allScores;
        }

        this.debug(`Received scores from master: ${message.allScores?.length || 0} players`);
        
        // Emit update event for UI
        this.emit('playerScoreUpdate', {
          playerScore: this.clientState.latestPlayerScore,
          allScores: this.clientState.allPlayerScores,
          matchInfo: message.matchInfo,
          timestamp: message.timestamp,
          source: 'master_server'
        });

        // Resolve the promise with the score data
        pendingRequest.resolve({
          success: true,
          playerScore: message.playerScore,
          allScores: message.allScores,
          matchInfo: message.matchInfo,
          gameId: message.gameId,
          peerId: message.peerId,
          timestamp: message.timestamp
        });
      } else {
        // Handle error response
        this.warn(`Score request failed: ${message.error}`);
        pendingRequest.reject(new Error(message.error || 'Unknown error'));
      }
    }

    /**
     * Generate a unique request ID
     */
    generateRequestId() {
      return 'req_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
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

    /**
     * Handle server restart notification
     * @param {Object} message - Server restart message
     */
    handleServerRestarted(message) {
      const serverPeerId = message.serverPeerId;
      this.log(`🔄 Server ${serverPeerId} has restarted and is now running!`);
      
      // Check if we were connected to this server before it went into game_over state
      const wasConnectedToThisServer = this.clientState.lastConnectedServerPeerId === serverPeerId ||
                                       this.clientState.connectedServerPeerId === serverPeerId;
      
      // If we have a game running and were connected to this server, restart the game
      if (this.gameIntegration && this.gameIntegration.game && wasConnectedToThisServer) {
        this.log(`🎮 Auto-restarting game connection to restarted server ${serverPeerId}`);
        
        // Reset the game iframe to clear the current game state
        this.resetGameIframe();
        
        // Wait a moment for the iframe to reset, then reconnect
        setTimeout(() => {
          this.autoReconnectToServer(serverPeerId);
        }, 2000);
      }
      
      // Update server list to reflect the new state
      this.requestServerList();
      
      // Emit event for UI to handle
      this.emit('serverRestarted', {
        serverPeerId: serverPeerId,
        serverInfo: message.serverInfo,
        wasConnectedToThisServer: wasConnectedToThisServer
      });
    }

    /**
     * Auto-reconnect to a restarted server
     * @param {string} serverPeerId - Server peer ID to reconnect to
     */
    async autoReconnectToServer(serverPeerId) {
      try {
        this.log(`🔗 Auto-reconnecting to server ${serverPeerId}...`);
        
        // Store the server ID we're reconnecting to
        this.clientState.lastConnectedServerPeerId = serverPeerId;
        
        // Connect to the server
        await this.connectToServer(serverPeerId);
        
        this.log(`✅ Successfully auto-reconnected to server ${serverPeerId}`);
      } catch (error) {
        this.error(`❌ Failed to auto-reconnect to server ${serverPeerId}: ${error.message}`);
        
        // Show user notification about failed reconnection
        if (typeof window !== 'undefined' && window.alert) {
          window.alert(`Failed to automatically reconnect to the restarted server. You may need to connect manually.`);
        }
      }
    }
    
    /**
     * Clean up and destroy the client
     */
    destroy() {
      this.log('Destroying client...');
      
      // Stop automint monitoring
      if (this.autoMintInterval) {
        clearInterval(this.autoMintInterval);
        this.autoMintInterval = null;
      }
      
      // Stop ping test
      if (this.clientState.latencyInterval) {
        clearInterval(this.clientState.latencyInterval);
        this.clientState.latencyInterval = null;
      }
      
      // Stop recovery check interval
      if (this.recoveryInterval) {
        clearInterval(this.recoveryInterval);
        this.recoveryInterval = null;
      }
      
      // Disconnect from server
      if (this.clientState.connected) {
        this.disconnect();
      }
      
      // Close WebSocket connection to master server
      if (this.clientState.signaling) {
        this.clientState.signaling.close();
        this.clientState.signaling = null;
      }
      
      // Clear all event handlers
      this.eventHandlers = {};
      
      this.log('Client destroyed');
    }
  }

  // Export to global scope
  window.BrowserMockClient = BrowserMockClient;

})(window);