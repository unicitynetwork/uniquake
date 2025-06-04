/**
 * Browser Mock Game for testing WebRTC P2P connections
 * 
 * Provides a simple mock game implementation for the browser environment
 * to test the P2P networking and token management framework
 */

(function(window) {
  'use strict';

  // Compatibility helpers for browser environment
  const log = console.log.bind(console);
  const error = console.error.bind(console);
  const warn = console.warn.bind(console);
  const debug = window.UNIQUAKE_CONFIG?.debug ? console.debug.bind(console) : function() {};

  /**
   * Generate a random ID
   */
  function generateId() {
    return Math.random().toString(36).substring(2, 15);
  }

  /**
   * Generate random coordinates
   */
  function randomPosition() {
    return {
      x: Math.floor(Math.random() * 1000),
      y: Math.floor(Math.random() * 1000),
      z: Math.floor(Math.random() * 1000)
    };
  }

  /**
   * Mock Game class for browser environment
   */
  class BrowserMockGame {
    /**
     * Create a new mock game instance
     * @param {Object} config - Mock game configuration
     */
    constructor(config = {}) {
      // Configuration
      this.config = Object.assign({
        isServer: false,
        updateInterval: 1000,
        playerCount: 0,
        logElement: null,
        onStateChange: null
      }, config);

      // Game state
      this.gameState = {
        gameId: `game-${Date.now()}`,
        frame: 0,
        timestamp: Date.now(),
        started: false,
        players: {},
        score: {},
        items: {}
      };

      // Internal state
      this.updateIntervalId = null;
      this.eventHandlers = {
        stateChange: [],
        playerJoin: [],
        playerLeave: [],
        gameEnd: []
      };

      // Register callback if provided
      if (this.config.onStateChange) {
        this.on('stateChange', this.config.onStateChange);
      }

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
     * Initialize the mock game
     */
    async init() {
      this.log(`Initializing mock game (${this.config.isServer ? 'server' : 'client'} mode)...`);
      
      // Create mock players if needed
      if (this.config.isServer && this.config.playerCount > 0) {
        for (let i = 0; i < this.config.playerCount; i++) {
          const playerId = `mock-player-${i+1}`;
          this.addPlayer({
            id: playerId,
            name: `MockPlayer${i+1}`,
            position: randomPosition()
          });
        }
      }
      
      this.log('Mock game initialized');
      return true;
    }

    /**
     * Start the mock game simulation
     */
    async start() {
      if (this.gameState.started) {
        this.log('Game already started');
        return false;
      }
      
      this.log('Starting mock game simulation...');
      this.gameState.started = true;
      
      // Reset frame counter to 0
      this.gameState.frame = 0;
      this.gameState.timestamp = Date.now();
      
      // Set up update interval
      this.updateIntervalId = setInterval(() => {
        this.update();
      }, this.config.updateInterval);
      
      // Emit state change event
      this.emitStateChange();
      
      return true;
    }

    /**
     * Stop the mock game simulation
     */
    stop() {
      if (!this.gameState.started) {
        return;
      }
      
      this.log('Stopping mock game simulation...');
      
      // Clear update interval
      if (this.updateIntervalId) {
        clearInterval(this.updateIntervalId);
        this.updateIntervalId = null;
      }
      
      this.gameState.started = false;
      
      // Emit state change event
      this.emitStateChange();
    }

    /**
     * Update the game state
     */
    update() {
      // Increment frame
      this.gameState.frame++;
      this.gameState.timestamp = Date.now();
      
      // Update player positions randomly
      Object.keys(this.gameState.players).forEach(playerId => {
        const player = this.gameState.players[playerId];
        
        // Random movement
        player.position.x += (Math.random() - 0.5) * 20;
        player.position.y += (Math.random() - 0.5) * 20;
        player.position.z += (Math.random() - 0.5) * 20;
        
        // Random health changes
        if (Math.random() < 0.1) {
          player.health = Math.max(0, Math.min(100, player.health + (Math.random() - 0.3) * 10));
        }
        
        // Random score changes
        if (Math.random() < 0.2) {
          this.gameState.score[playerId] = (this.gameState.score[playerId] || 0) + Math.floor(Math.random() * 10);
        }
      });
      
      // Spawn or remove items randomly
      if (Math.random() < 0.1) {
        if (Object.keys(this.gameState.items).length < 10) {
          // Spawn a new item
          const itemId = `item-${generateId()}`;
          this.gameState.items[itemId] = {
            type: ['health', 'ammo', 'weapon', 'armor'][Math.floor(Math.random() * 4)],
            position: randomPosition(),
            value: Math.floor(Math.random() * 100)
          };
        } else {
          // Remove a random item
          const itemIds = Object.keys(this.gameState.items);
          const randomItemId = itemIds[Math.floor(Math.random() * itemIds.length)];
          delete this.gameState.items[randomItemId];
        }
      }
      
      // Emit state change event
      this.emitStateChange();
    }

    /**
     * Add a player to the game
     * @param {Object} player - Player data
     */
    addPlayer(player) {
      if (!player || !player.id) {
        this.error('Invalid player data');
        return null;
      }
      
      const playerId = player.id;
      
      // Check if player already exists
      if (this.gameState.players[playerId]) {
        this.warn(`Player ${playerId} already exists`);
        return playerId;
      }
      
      // Add player to game state
      this.gameState.players[playerId] = {
        id: playerId,
        name: player.name || `Player-${playerId}`,
        position: player.position || randomPosition(),
        health: player.health || 100,
        connected: true,
        joinTime: Date.now()
      };
      
      // Initialize score
      this.gameState.score[playerId] = 0;
      
      this.log(`Added player ${playerId} (${this.gameState.players[playerId].name})`);
      
      // Emit player join event
      this.emit('playerJoin', {
        id: playerId,
        name: this.gameState.players[playerId].name
      });
      
      // Emit state change event
      this.emitStateChange();
      
      return playerId;
    }

    /**
     * Remove a player from the game
     * @param {string} playerId - Player ID
     */
    removePlayer(playerId) {
      if (!this.gameState.players[playerId]) {
        this.warn(`Player ${playerId} not found`);
        return false;
      }
      
      // Get player name before removing
      const playerName = this.gameState.players[playerId].name;
      
      // Remove player from game state
      delete this.gameState.players[playerId];
      
      // Remove score
      delete this.gameState.score[playerId];
      
      this.log(`Removed player ${playerId} (${playerName})`);
      
      // Emit player leave event
      this.emit('playerLeave', {
        id: playerId,
        name: playerName
      });
      
      // Emit state change event
      this.emitStateChange();
      
      return true;
    }

    /**
     * Get the current game state
     */
    getGameState() {
      // Create a copy of the game state to avoid direct reference modification
      const stateCopy = { ...this.gameState };
      
      // Ensure we always have required properties
      stateCopy.gameId = stateCopy.gameId || `game-${Date.now()}`;
      stateCopy.frame = stateCopy.frame || 0;
      stateCopy.players = stateCopy.players || {};
      
      // Use global normalization if available
      if (typeof window !== 'undefined' && window.normalizeGameState) {
        // Just for debugging - we don't actually modify our returned state with this
        const normalizedForDebug = window.normalizeGameState(stateCopy);
        if (this.config.debug) {
          console.log('Game state normalized form for debugging:', JSON.stringify(normalizedForDebug));
        }
      }
      
      return stateCopy;
    }

    /**
     * Update the game state manually
     * @param {Object} updates - State updates to apply
     */
    updateGameState(updates) {
      if (!updates) {
        return this.gameState;
      }
      
      // Apply updates to game state
      Object.keys(updates).forEach(key => {
        if (key === 'players' || key === 'items' || key === 'score') {
          // Merge objects
          this.gameState[key] = {
            ...this.gameState[key],
            ...updates[key]
          };
        } else {
          // Direct update
          this.gameState[key] = updates[key];
        }
      });
      
      // Emit state change event
      this.emitStateChange();
      
      return this.gameState;
    }

    /**
     * Generate a random game state update
     */
    generateRandomUpdate() {
      // Generate a random update to the game state
      const update = {
        timestamp: Date.now()
      };
      
      // Randomly choose what to update
      const updateType = Math.floor(Math.random() * 3);
      
      if (updateType === 0) {
        // Update player positions
        update.players = {};
        Object.keys(this.gameState.players).forEach(playerId => {
          update.players[playerId] = {
            ...this.gameState.players[playerId],
            position: randomPosition(),
            health: Math.max(10, Math.min(100, this.gameState.players[playerId].health + (Math.random() - 0.5) * 20))
          };
        });
      } else if (updateType === 1) {
        // Update scores
        update.score = {};
        Object.keys(this.gameState.score).forEach(playerId => {
          update.score[playerId] = this.gameState.score[playerId] + Math.floor(Math.random() * 20);
        });
      } else {
        // Update items
        update.items = {};
        
        // Add a new random item
        const itemId = `item-${generateId()}`;
        update.items[itemId] = {
          type: ['health', 'ammo', 'weapon', 'armor'][Math.floor(Math.random() * 4)],
          position: randomPosition(),
          value: Math.floor(Math.random() * 100)
        };
      }
      
      return update;
    }

    /**
     * End the game with a specific winner
     * @param {string} winnerId - Winner ID (random if not specified)
     */
    endGame(winnerId = null) {
      // If no winner specified, pick a random player
      let winner = winnerId;
      if (!winner) {
        const playerIds = Object.keys(this.gameState.players);
        if (playerIds.length > 0) {
          winner = playerIds[Math.floor(Math.random() * playerIds.length)];
        }
      }
      
      // Stop the game
      this.stop();
      
      // Update game state
      this.gameState.ended = true;
      this.gameState.endTime = Date.now();
      this.gameState.winner = winner;
      
      // Calculate final scores
      const scores = {};
      Object.keys(this.gameState.score).forEach(playerId => {
        scores[playerId] = this.gameState.score[playerId];
      });
      
      // If we have a winner, give them a bonus
      if (winner && scores[winner] !== undefined) {
        scores[winner] += 100;
      }
      
      this.gameState.finalScores = scores;
      
      this.log(`Game ended. Winner: ${winner ? `${winner} (${this.gameState.players[winner]?.name || 'Unknown'})` : 'None'}`);
      
      // Emit game end event
      this.emit('gameEnd', {
        winner: winner,
        winnerName: winner ? this.gameState.players[winner]?.name : null,
        scores: scores
      });
      
      // Emit state change event
      this.emitStateChange();
      
      return {
        winner: winner,
        scores: scores
      };
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
     * Emit state change event
     */
    emitStateChange() {
      this.emit('stateChange', this.gameState);
    }

    /**
     * Log a message
     */
    log(...args) {
      log('[MockGame]', ...args);
      this.logToElement(`[MockGame] ${args.join(' ')}`);
    }
    
    /**
     * Log a warning
     */
    warn(...args) {
      warn('[MockGame]', ...args);
      this.logToElement(`⚠️ [MockGame] ${args.join(' ')}`);
    }
    
    /**
     * Log an error
     */
    error(...args) {
      error('[MockGame]', ...args);
      this.logToElement(`❌ [MockGame] ${args.join(' ')}`);
    }
    
    /**
     * Log a debug message
     */
    debug(...args) {
      if (this.config.debug) {
        debug('[MockGame]', ...args);
        this.logToElement(`🔍 [MockGame] ${args.join(' ')}`);
      }
    }
  }

  // Export to global scope
  window.BrowserMockGame = BrowserMockGame;

})(window);