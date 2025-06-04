/**
 * Game Integration for UniQuake
 * 
 * Connects the game with the token service and networking layer
 */

(function(window) {
  'use strict';

  // Compatibility helpers for browser environment
  const log = console.log.bind(console);
  const error = console.error.bind(console);
  const warn = console.warn.bind(console);
  const debug = window.UNIQUAKE_CONFIG?.debug ? console.debug.bind(console) : function() {};

  /**
   * Game Integration class
   */
  class GameIntegration {
    /**
     * Create a new game integration
     * @param {Object} config - Integration configuration
     */
    constructor(config = {}) {
      // Configuration
      this.config = Object.assign({
        client: null,
        server: null,
        logElement: null,
        debug: false,
        onGameStateUpdate: null,
        onTokenEvent: null,
        onPlayerJoin: null,
        onPlayerLeave: null,
        onGameEnd: null
      }, config);

      // Internal state
      this.game = null;
      this.isServer = false;
      this.stateUpdateInterval = null;
      this.lastStateUpdate = 0;
      this.stateUpdateThrottle = 10000; // 10 seconds between state updates
      this.pendingStateUpdate = false;

      // Event handlers
      this.eventHandlers = {
        gameStateUpdate: [],
        tokenEvent: [],
        playerJoin: [],
        playerLeave: [],
        gameEnd: []
      };

      // Register callbacks if provided
      if (this.config.onGameStateUpdate) this.on('gameStateUpdate', this.config.onGameStateUpdate);
      if (this.config.onTokenEvent) this.on('tokenEvent', this.config.onTokenEvent);
      if (this.config.onPlayerJoin) this.on('playerJoin', this.config.onPlayerJoin);
      if (this.config.onPlayerLeave) this.on('playerLeave', this.config.onPlayerLeave);
      if (this.config.onGameEnd) this.on('gameEnd', this.config.onGameEnd);

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
     * Initialize the game integration
     * @param {Object} game - Reference to the game instance
     */
    async init(game) {
      if (!game) {
        this.error('No game instance provided');
        return false;
      }

      this.log('Initializing game integration...');
      this.game = game;

      // Determine if we're a server or client
      this.isServer = !!this.config.server;

      // Set up game event handlers
      this.setupGameEventHandlers();

      // If we're a server, set up server-specific logic
      if (this.isServer) {
        // Set the server's gameInstance property to our game instance
        // This is important for proper token updates coordination
        if (this.config.server) {
          this.config.server.gameInstance = this.game;
          this.log('Registered game instance with server for coordinated token updates');
        }
        
        this.setupServerLogic();
      } 
      // If we're a client, set up client-specific logic
      else if (this.config.client) {
        this.setupClientLogic();
      }

      this.log(`Game integration initialized in ${this.isServer ? 'server' : 'client'} mode`);
      return true;
    }

    /**
     * Set up game event handlers
     */
    setupGameEventHandlers() {
      // Listen for game state changes
      this.game.on('stateChange', (gameState) => {
        this.handleGameStateChange(gameState);
      });

      // Listen for player join/leave events
      this.game.on('playerJoin', (player) => {
        this.emit('playerJoin', player);
      });

      this.game.on('playerLeave', (player) => {
        this.emit('playerLeave', player);
      });

      // Listen for game end event
      this.game.on('gameEnd', (result) => {
        this.handleGameEnd(result);
      });
    }

    /**
     * Set up server-specific logic
     */
    setupServerLogic() {
      const server = this.config.server;
      if (!server) return;

      // Listen for client connections
      server.on('clientConnect', async (client) => {
        this.log(`Client connected: ${client.id} (${client.username || 'Unknown'})`);
        
        // Add player to game
        this.game.addPlayer({
          id: client.id,
          name: client.username || `Player-${client.id}`,
          position: {
            x: Math.random() * 1000,
            y: Math.random() * 1000,
            z: Math.random() * 1000
          }
        });
      });

      // Listen for client disconnections
      server.on('clientDisconnect', (client) => {
        this.log(`Client disconnected: ${client.id}`);
        
        // Remove player from game
        this.game.removePlayer(client.id);
      });

      // Listen for token entry events
      server.on('tokenEntry', (event) => {
        this.emit('tokenEvent', {
          type: 'entry_token_received',
          clientId: event.clientId,
          username: event.username,
          success: event.success
        });
      });
    }

    /**
     * Set up client-specific logic
     */
    setupClientLogic() {
      const client = this.config.client;
      if (!client) return;

      // Listen for server connection changes
      client.on('connectionChange', (status) => {
        if (status.connected) {
          this.log(`Connected to server: ${status.server}`);
        } else {
          this.log('Disconnected from server');
        }
      });

      // Listen for token updates
      client.on('tokenUpdate', (tokenStatus) => {
        this.emit('tokenEvent', {
          type: 'token_inventory_updated',
          count: tokenStatus.tokens.total,
          value: tokenStatus.value
        });
      });
    }

    /**
     * Handle game state changes
     * @param {Object} gameState - Updated game state
     */
    handleGameStateChange(gameState) {
      // For clients, check if we need to get state from verification
      if (!this.isServer && this.config.client) {
        // Get verified frame from the client's token service if available
        const lastVerification = this.config.client.clientState.lastGameStateVerification;
        if (lastVerification && lastVerification.frame) {
          // Use the verified frame from the token verification instead of local frame
          // This ensures we display the correct frame number from the server
          this.debug(`Using verified frame ${lastVerification.frame} instead of local frame ${gameState.frame}`);
          gameState.frame = lastVerification.frame;
          
          // Also store the server hash if available
          if (lastVerification.stateHash) {
            gameState.serverHash = lastVerification.stateHash;
          }
        }
      }
      
      // Emit game state update event
      this.emit('gameStateUpdate', gameState);

      // If we're a server, update the token service with new game state
      if (this.isServer && this.config.server && this.config.server.serverState.tokenService) {
        // Throttle updates to avoid overwhelming the token service
        const now = Date.now();
        if (now - this.lastStateUpdate > this.stateUpdateThrottle) {
          this.lastStateUpdate = now;
          this.updateGameState(gameState);
        } else if (!this.pendingStateUpdate) {
          // Schedule an update
          this.pendingStateUpdate = true;
          setTimeout(() => {
            this.pendingStateUpdate = false;
            this.lastStateUpdate = Date.now();
            this.updateGameState(this.game.getGameState());
          }, this.stateUpdateThrottle);
        }
      }
    }
    
    /**
     * Public method to trigger a game state update event
     * @param {Object} gameState - Game state to emit
     */
    onGameStateChange(gameState) {
      // This is called externally to update the game state
      this.handleGameStateChange(gameState);
    }

    /**
     * Handle game end event
     * @param {Object} result - Game end result
     */
    handleGameEnd(result) {
      this.log(`Game ended. Winner: ${result.winner ? result.winnerName : 'None'}`);
      
      // Emit game end event
      this.emit('gameEnd', result);

      // If we're a server, distribute tokens to winner
      if (this.isServer && this.config.server && result.winner) {
        this.endGame(result.winner);
      }
    }

    /**
     * Get the current game state
     */
    getGameState() {
      return this.game ? this.game.getGameState() : null;
    }

    /**
     * Update the token service with new game state
     * @param {Object} gameState - New game state
     */
    async updateGameState(gameState) {
      if (!this.isServer || !this.config.server || !this.config.server.serverState.tokenService) {
        return null;
      }

      try {
        const tokenService = this.config.server.serverState.tokenService;
        
        // Log game state frame for debugging
        this.debug(`Updating token with game state frame ${gameState.frame}`);
        
        // Make sure the server's game state is in sync
        if (this.config.server.serverState.gameState) {
          // Ensure frames are in sync
          if (this.config.server.serverState.gameState.frame !== gameState.frame) {
            this.log(`Fixing frame sync - Server: ${this.config.server.serverState.gameState.frame}, Game: ${gameState.frame}`);
            this.config.server.serverState.gameState.frame = gameState.frame;
          }
        }
        
        // Create or update game state token
        let token = null;
        
        if (!tokenService.lastStateToken) {
          token = await tokenService.createGameStateToken(gameState);
          this.debug(`Created initial game state token for frame ${gameState.frame}`);
        } else {
          token = await tokenService.updateGameStateToken(
            tokenService.lastStateToken,
            gameState
          );
          this.debug(`Updated game state token for frame ${gameState.frame}`);
        }

        return token;
      } catch (err) {
        this.error('Failed to update game state token:', err.message);
        return null;
      }
    }

    /**
     * Handle player join with token verification
     * @param {string} playerId - Player ID
     * @param {Object} tokenFlow - Token flow for validation
     */
    async handlePlayerJoin(playerId, tokenFlow) {
      if (!this.isServer || !this.config.server) {
        return false;
      }

      try {
        // Validate entry token
        const result = await this.config.server.validateEntryToken(playerId, tokenFlow);
        
        this.emit('tokenEvent', {
          type: 'entry_token_validation',
          playerId: playerId,
          success: result.success,
          reason: result.reason
        });

        return result.success;
      } catch (err) {
        this.error('Failed to handle player join:', err.message);
        return false;
      }
    }

    /**
     * Handle player leave
     * @param {string} playerId - Player ID
     */
    async handlePlayerLeave(playerId) {
      if (!this.game) return;
      
      // Remove player from game
      return this.game.removePlayer(playerId);
    }

    /**
     * End game and distribute tokens to winner
     * @param {string} winnerId - ID of the winning player
     */
    async endGame(winnerId) {
      if (!this.isServer || !this.config.server) {
        return false;
      }

      try {
        // End the game in the game instance if it's not already ended
        if (!this.game.gameState.ended) {
          this.game.endGame(winnerId);
        }

        // Distribute tokens to the winner
        const result = await this.config.server.endGame(winnerId);
        
        if (result) {
          this.log(`Distributed ${result.tokenCount} tokens to winner ${result.winner}`);
          
          // Emit token event
          this.emit('tokenEvent', {
            type: 'tokens_distributed',
            winnerId: result.winner,
            winnerName: result.username,
            tokenCount: result.tokenCount
          });
        } else {
          this.log('Failed to distribute tokens to winner');
        }

        return result;
      } catch (err) {
        this.error('Failed to end game:', err.message);
        return false;
      }
    }

    /**
     * Verify game state token
     * @param {Object} tokenFlow - Token flow to verify
     */
    async verifyGameStateToken(tokenFlow) {
      if (!this.config.client || !this.config.client.clientState.tokenService) {
        return { verified: false, error: 'Token service not available' };
      }

      try {
        const tokenService = this.config.client.clientState.tokenService;
        return await tokenService.verifyGameStateToken(tokenFlow);
      } catch (err) {
        this.error('Failed to verify game state token:', err.message);
        return { verified: false, error: err.message };
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
     * Log a message
     */
    log(...args) {
      log('[GameIntegration]', ...args);
      this.logToElement(`[GameIntegration] ${args.join(' ')}`);
    }
    
    /**
     * Log a warning
     */
    warn(...args) {
      warn('[GameIntegration]', ...args);
      this.logToElement(`⚠️ [GameIntegration] ${args.join(' ')}`);
    }
    
    /**
     * Log an error
     */
    error(...args) {
      error('[GameIntegration]', ...args);
      this.logToElement(`❌ [GameIntegration] ${args.join(' ')}`);
    }
    
    /**
     * Log a debug message
     */
    debug(...args) {
      if (this.config.debug) {
        debug('[GameIntegration]', ...args);
        this.logToElement(`🔍 [GameIntegration] ${args.join(' ')}`);
      }
    }
  }

  // Export to global scope
  window.GameIntegration = GameIntegration;

})(window);