/**
 * UniQuakeTokenService - Browser-compatible token management service
 * 
 * Provides a token management service for the browser environment that uses
 * the state-transition-sdk (TXF) to manage tokens, matching the Node.js implementation.
 */

(function(window) {
  'use strict';

  // Compatibility helpers for browser environment
  const log = console.log.bind(console);
  const error = console.error.bind(console);
  const warn = console.warn.bind(console);
  const debug = window.UNIQUAKE_CONFIG?.debug ? console.debug.bind(console) : function() {};

  /**
   * Generate a random username
   */
  function generateUsername() {
    const adjectives = ['Happy', 'Lucky', 'Sunny', 'Clever', 'Swift', 'Brave', 'Bright', 'Wild', 'Mighty', 'Bold'];
    const nouns = ['Player', 'Gamer', 'Hero', 'Warrior', 'Knight', 'Mage', 'Hunter', 'Scout', 'Archer', 'Ninja'];
    
    const adj = adjectives[Math.floor(Math.random() * adjectives.length)];
    const noun = nouns[Math.floor(Math.random() * nouns.length)];
    const num = Math.floor(Math.random() * 1000);
    
    return `${adj}${noun}${num}`;
  }

  /**
   * Load the TXF SDK
   * @returns {Promise} - Promise that resolves when the SDK is loaded
   */
  async function loadTXFSDK() {
    return new Promise((resolve, reject) => {
      if (window.TXF) {
        resolve(window.TXF);
        return;
      }

      const script = document.createElement('script');
      script.src = 'https://unicitynetwork.github.io/state-transition-sdk/txf.min.js';
      script.async = true;
      script.onload = () => {
        if (window.TXF) {
          resolve(window.TXF);
        } else {
          reject(new Error('Failed to load TXF SDK'));
        }
      };
      script.onerror = () => {
        reject(new Error('Failed to load TXF SDK script'));
      };
      document.head.appendChild(script);
    });
  }

  /**
   * TokenPool Implementation for browser environment
   * Mimics the functionality of TokenPool in the Node.js environment
   */
  class BrowserTokenPool {
    constructor() {
      this.tokens = new Map();
      this.nonces = new Map();
    }

    addToken(secret, tokenFlow) {
      const flow = typeof tokenFlow === 'string' ? tokenFlow : JSON.stringify(tokenFlow);
      const parsedFlow = JSON.parse(flow);
      const tokenId = parsedFlow.token.tokenId;
      
      this.tokens.set(tokenId, flow);
      return tokenId;
    }

    getTokens(secret) {
      const result = {};
      for (const [tokenId, tokenFlow] of this.tokens.entries()) {
        result[tokenId] = tokenFlow;
      }
      return result;
    }

    deleteToken(secret, tokenId) {
      return this.tokens.delete(tokenId);
    }

    setNonce(destRef, nonce) {
      this.nonces.set(destRef, nonce);
    }

    getNonce(destRef) {
      return this.nonces.get(destRef);
    }
  }

  /**
   * UniQuake Token Service for browser environment
   */
  class UniQuakeTokenService {
    /**
     * Create a new token service instance
     * @param {Object} config - Configuration options
     */
    constructor(config = {}) {
      // Configuration with defaults
      this.config = Object.assign({
        secret: null,               // Secret key (generated if not provided)
        username: null,             // Username (generated if not provided)
        gateway: null,              // Gateway URL (will use default if not provided)
        debug: false                // Debug mode
      }, config);
      
      // State
      this.initialized = false;
      this.TXF = null;              // Will be set during init
      this.tokenPool = null;        // Will be set during init
      this.pubkey = null;           // Will be set during init
      this.transport = null;        // Will be set during init
      this.secret = this.config.secret || null;
      this.username = this.config.username || generateUsername();
      this.debugMode = this.config.debug;
      
      // Token class identifiers
      this.tokenTypes = {
        COIN: null,                 // Will be set during init
        STATE: null                 // Will be set during init
      };
      
      // Last state token reference for game state verification
      this.lastStateToken = null;
      
      // Last verified state
      this.lastVerifiedState = {
        timestamp: null,
        stateHash: null,
        isValid: false,
        frame: 0
      };
    }
    
    /**
     * Log debug message
     */
    debug(...args) {
      if (this.debugMode) {
        debug('[TokenService]', ...args);
      }
    }
    
    /**
     * Generate a random secret key
     */
    generateRandomSecret() {
      const array = new Uint8Array(32);
      window.crypto.getRandomValues(array);
      return Array.from(array, b => b.toString(16).padStart(2, '0')).join('');
    }
    
    /**
     * Initialize the token service
     */
    async init() {
      try {
        this.debug('Initializing token service...');
        
        // Load the TXF SDK
        this.TXF = await loadTXFSDK();
        this.debug('TXF SDK loaded successfully');
        
        // Create token pool instance
        this.tokenPool = new BrowserTokenPool();
        
        // Generate secret if not provided
        if (!this.secret) {
          this.secret = this.generateRandomSecret();
          this.debug('Generated new secret key');
        }
        
        // Set up public key
        this.pubkey = this.TXF.generateRecipientPubkeyAddr(this.secret);
        
        // Initialize transport
        const gateway = this.config.gateway || this.TXF.defaultGateway();
        this.transport = this.TXF.getHTTPTransport(gateway);
        
        // Initialize token types
        this.tokenTypes.COIN = this.TXF.validateOrConvert('token_class', 'quake_test_coin');
        this.tokenTypes.STATE = this.TXF.validateOrConvert('token_class', 'quake_game_state');
        
        this.initialized = true;
        this.debug(`Token service initialized for ${this.username} (${this.pubkey.substring(0, 10)}...)`);
        
        return true;
      } catch (err) {
        error('Failed to initialize token service:', err);
        throw err;
      }
    }
    
    /**
     * Get identity information
     */
    getIdentity() {
      return {
        username: this.username,
        pubkey: this.pubkey,
        // Do NOT include the secret in returned data in a real implementation
        // For demo purposes only
        secretPreview: this.secret ? `${this.secret.substring(0, 5)}...${this.secret.substring(this.secret.length - 5)}` : null
      };
    }
    
    /**
     * Mint new tokens
     * @param {number} count - Number of tokens to mint
     * @param {string} value - Value for each token
     */
    async mintCoins(count = 1, value = '1') {
      const results = [];
      
      this.debug(`Minting ${count} token(s) with value ${value}...`);
      console.log(`Minting ${count} token(s)...`);
      
      for (let i = 0; i < count; i++) {
        try {
          const tokenId = this.TXF.generateRandom256BitHex();
          const nonce = this.TXF.generateRandom256BitHex();
          const salt = this.TXF.generateRandom256BitHex();
          
          // Create token with unique metadata for demo
          const token = await this.TXF.mint({
            token_id: tokenId,
            token_class_id: this.tokenTypes.COIN,
            token_value: value,
            sign_alg: 'secp256k1',
            hash_alg: 'sha256',
            secret: this.secret,
            nonce,
            mint_salt: salt,
            immutable_data: JSON.stringify({
              creator: this.username,
              created_at: Date.now(),
              description: `UniQuake token #${i+1} of ${count}`
            }),
            transport: this.transport
          });
          
          // Add token to pool
          const tokenFlow = this.TXF.exportFlow(token);
          this.tokenPool.addToken(this.secret, tokenFlow);
          
          results.push(token);
          
          this.debug(`Minted token ${i+1}/${count} with ID ${tokenId.substring(0, 8)}...`);
        } catch (error) {
          console.error(`Failed to mint token ${i+1}/${count}:`, error.message);
        }
      }
      
      // Show completion to everyone
      console.log(`Successfully minted ${results.length} of ${count} tokens`);
      return results;
    }
    
    /**
     * Send an entry token to join a game
     * @param {string} recipientPubkey - Recipient's public key
     */
    async sendEntryToken(recipientPubkey) {
      this.debug(`Preparing to send entry token to ${recipientPubkey.substring(0, 10)}...`);
      console.log(`Preparing entry token...`);
      
      // Find a spendable token
      const spendableTokens = await this.getSpendableTokens(this.tokenTypes.COIN);
      
      if (spendableTokens.length === 0) {
        throw new Error('No spendable tokens available for entry fee');
      }
      
      // Use the first available token
      const token = spendableTokens[0];
      this.debug(`Selected token ${token.tokenId.substring(0, 8)}... for entry fee`);
      
      // Create transaction to recipient
      const salt = this.TXF.generateRandom256BitHex();
      const tx = await this.TXF.createTx(token, recipientPubkey, salt, this.secret, this.transport);
      
      // Export the token flow for transmission
      const tokenFlow = this.TXF.exportFlow(token, tx);
      
      // Remove from pool
      this.tokenPool.deleteToken(this.secret, token.tokenId);
      
      this.debug(`Entry token prepared for sending`);
      console.log(`Entry token ready to send`);
      
      return tokenFlow;
    }
    
    /**
     * Process a received token
     * @param {Object|string} tokenFlowStr - Token flow to process
     */
    async receiveToken(tokenFlowStr) {
      this.debug(`Processing received token...`);
      console.log(`Processing received token...`);
      
      try {
        // Import the token flow
        const token = this.TXF.importFlow(tokenFlowStr, this.secret);
        
        // Check token status
        const status = await this.TXF.getTokenStatus(token, this.secret, this.transport);
        
        if (status.owned && status.unspent) {
          // Add to token pool
          this.tokenPool.addToken(this.secret, this.TXF.exportFlow(token));
          
          this.debug(`Received valid token ${token.tokenId.substring(0, 8)}...`);
          console.log(`Token received successfully`);
          return { success: true, token };
        } else {
          this.debug(`Received invalid token: owned=${status.owned}, unspent=${status.unspent}`);
          console.log(`Invalid token received`);
          return { 
            success: false, 
            error: 'Token is not valid, not owned, or already spent',
            status
          };
        }
      } catch (error) {
        console.error(`Failed to process token:`, error.message);
        return { success: false, error: error.message };
      }
    }
    
    /**
     * Get list of spendable tokens
     * @param {string} tokenClassId - Token class ID to filter by
     */
    async getSpendableTokens(tokenClassId) {
      const result = [];
      const tokensList = this.tokenPool.getTokens(this.secret);
      
      if (!tokensList) {
        return result;
      }
      
      for (const tokenKey in tokensList) {
        try {
          const tokenFlow = tokensList[tokenKey];
          const token = this.TXF.importFlow(tokenFlow);
          
          if (token.tokenClass === tokenClassId) {
            const status = await this.TXF.getTokenStatus(token, this.secret, this.transport);
            if (status.owned && status.unspent) {
              result.push(token);
            }
          }
        } catch (error) {
          console.error(`Error checking token status:`, error.message);
        }
      }
      
      return result;
    }
    
    /**
     * Create a game state token
     * @param {Object} gameState - Game state to tokenize
     */
    async createGameStateToken(gameState) {
      try {
        const tokenId = this.TXF.generateRandom256BitHex();
        const nonce = this.TXF.generateRandom256BitHex();
        const salt = this.TXF.generateRandom256BitHex();
        
        // Create a clean minimal state for consistent hashing
        const minimalState = {
          gameId: gameState.gameId || '',
          frame: gameState.frame || 0,
          players: {}
        };
        
        // Only include essential player data
        if (gameState.players) {
          Object.keys(gameState.players).sort().forEach(playerId => {
            const player = gameState.players[playerId];
            if (player) {
              minimalState.players[playerId] = {
                name: player.name || 'Unknown',
                health: Math.round(player.health || 100)
              };
            }
          });
        }
        
        // Include scores if present
        if (gameState.score && Object.keys(gameState.score).length > 0) {
          minimalState.score = {};
          Object.keys(gameState.score).sort().forEach(playerId => {
            minimalState.score[playerId] = Math.round(gameState.score[playerId] || 0);
          });
        }
        
        // Serialize and hash the minimal state
        const stateHash = this.hashGameState(minimalState);
        
        // Create immutable data with game state hash and timestamp
        const immutableData = JSON.stringify({
          state_hash: stateHash,
          timestamp: Date.now(),
          frame: gameState.frame || 0,
          game_id: gameState.gameId || this.generateRandomId(8)
        });
        
        // Mint token with game state data
        const token = await this.TXF.mint({
          token_id: tokenId,
          token_class_id: this.tokenTypes.STATE,
          token_value: '1', // Nominal value for state tokens
          immutable_data: immutableData,
          sign_alg: 'secp256k1',
          hash_alg: 'sha256',
          secret: this.secret,
          nonce,
          mint_salt: salt,
          transport: this.transport
        });
        
        // Store the token as our latest state token
        this.lastStateToken = token;
        
        console.log(`Created initial game state token with ID ${tokenId.substring(0, 8)}...`);
        return token;
      } catch (error) {
        console.error(`Failed to create game state token:`, error.message);
        throw error;
      }
    }
    
    /**
     * Update an existing game state token
     * @param {Object} stateToken - Current state token
     * @param {Object} newState - New game state
     */
    async updateGameStateToken(stateToken, newState) {
      try {
        // Make a copy of the state token to avoid modifying the original directly
        // This is important because the token object is passed by reference
        let tokenToUpdate = { ...stateToken };
        
        // Create a clean minimal state for consistent hashing
        const minimalState = {
          gameId: newState.gameId || '',
          frame: newState.frame || 0,
          players: {}
        };
        
        // Only include essential player data
        if (newState.players) {
          Object.keys(newState.players).sort().forEach(playerId => {
            const player = newState.players[playerId];
            if (player) {
              minimalState.players[playerId] = {
                name: player.name || 'Unknown',
                health: Math.round(player.health || 100)
              };
            }
          });
        }
        
        // Include scores if present
        if (newState.score && Object.keys(newState.score).length > 0) {
          minimalState.score = {};
          Object.keys(newState.score).sort().forEach(playerId => {
            minimalState.score[playerId] = Math.round(newState.score[playerId] || 0);
          });
        }
        
        // Hash the minimal state for consistency between client and server
        const stateHash = this.hashGameState(minimalState);
        
        // Create a message with the new state hash
        const message = {
          state_hash: stateHash,
          timestamp: Date.now(),
          frame: newState.frame || 0,
          prev_hash: tokenToUpdate.tokenData?.state_hash
        };
        
        // Use the SDK's transaction creation
        console.log(`Creating transaction for token ${tokenToUpdate.tokenId}`);
        
        try {
          // Create a transaction to self
          const pubkeyAddr = this.TXF.generateRecipientPubkeyAddr(this.secret);
          
          // Generate data hash for the message
          const messageData = JSON.stringify(message);
          const dataHash = this.TXF.getHashOf(messageData);
          
          console.log(`Created data hash: ${dataHash.substring(0, 10)}...`);
          
          // Create transaction using SDK method with proper data hash
          const tx = await this.TXF.createTx(
            tokenToUpdate,
            pubkeyAddr,
            this.TXF.generateRandom256BitHex(), // salt
            this.secret,
            this.transport,
            dataHash, // proper data hash
            messageData // message data
          );
          
          // Important: The transaction modifies the token object passed to it
          // Now tokenToUpdate has been updated with the transaction details
          
          console.log(`Transaction created, now exporting token flow with transaction`);
          
          // Export the token flow with the transaction
          const tokenFlow = this.TXF.exportFlow(tokenToUpdate, tx);
          
          // Import the token flow to get an updated token with the transaction applied
          // For importing with transaction, we need to pass secret and message data
          const updatedToken = this.TXF.importFlow(tokenFlow, this.secret, null, messageData);
          
          this.debug(`Successfully imported updated token`);
          this.lastStateToken = updatedToken;
          this.debug(`Updated game state token with new state at frame ${newState.frame || 0}`);
          return updatedToken;
        } catch (txError) {
          console.error(`Transaction error: ${txError.message}`);
          throw txError;
        }
      } catch (error) {
        console.error(`Failed to update game state token:`, error.message);
        throw error;
      }
    }
    
    /**
     * Verify a game state token
     * @param {Object} tokenFlow - Token flow to verify
     */
    async verifyGameStateToken(tokenFlow) {
      try {
        this.debug(`Verifying game state token...`);
        
        // Import the token from the flow - don't use secret since we're just verifying
        const token = this.TXF.importFlow(
          typeof tokenFlow === 'string' ? tokenFlow : JSON.stringify(tokenFlow)
        );
        
        this.debug(`Token imported successfully, ID: ${token.tokenId.substring(0, 8)}...`);
        
        // For game state tokens, we use empty string as the secret parameter to check validity without ownership
        const status = await this.TXF.getTokenStatus(token, '', this.transport);
        
        this.debug(`Token status check result: valid=${status.valid}`);
        
        // Access token data from status
        let stateData = status.data;
        
        if (!stateData.state_hash) {
          this.debug(`State data missing required field: state_hash`);
          return { verified: false, error: 'State data missing state hash' };
        }
        
        this.debug(`State verification successful, frame: ${stateData.frame || 0}`);
        
        // Update last verified state
        this.lastVerifiedState = {
          timestamp: Date.now(),
          stateHash: stateData.state_hash,
          frame: stateData.frame || 0,
          isValid: true
        };
        
        // Return verification result
        return {
          verified: true,
          stateHash: stateData.state_hash,
          timestamp: stateData.timestamp,
          frame: stateData.frame || 0
        };
      } catch (error) {
        console.error(`Game state verification error:`, error.message);
        return { verified: false, error: error.message };
      }
    }
    
    /**
     * Verify if local game state matches the verified state
     * @param {Object} localState - Local game state to verify
     */
    verifyLocalGameState(localState) {
      if (!this.lastVerifiedState.isValid) {
        return false;
      }
      
      const localHash = this.hashGameState(localState);
      return localHash === this.lastVerifiedState.stateHash;
    }
    
    /**
     * Hash a game state object
     * @param {Object} gameState - Game state to hash
     * @returns {string} - Hash of the game state
     */
    hashGameState(gameState) {
      // First, create a deterministic serialization of the state
      const serialized = this.serializeGameState(gameState);
      
      // Log the serialized state for debugging purposes
      if (this.debugMode) {
        console.log('Serialized game state for hashing:', serialized);
      }
      
      // Use the TXF getHashOf method for consistent hashing
      const hash = this.TXF.getHashOf(serialized);
      
      // Log the hash result
      if (this.debugMode) {
        console.log(`Generated hash for frame ${gameState.frame}: ${hash}`);
      }
      
      return hash;
    }
    
    /**
     * Serialize game state for consistent hashing
     * @param {Object} gameState - Game state to serialize
     * @returns {string} - Serialized game state
     */
    serializeGameState(gameState) {
      // CRITICAL FIX: We need to create a SIMPLIFIED representation 
      // that's IDENTICAL between client and server
      
      // Only include the absolute minimum necessary data:
      // 1. gameId - unique identifier for the game session
      // 2. frame - the current frame number
      // 3. players - only the names and health values
      
      // Create an extremely minimal state representation
      const minimalState = {
        gameId: gameState.gameId || '',
        frame: gameState.frame || 0,
        players: {}
      };
      
      // Only include player names and health - nothing else
      if (gameState.players) {
        const playerIds = Object.keys(gameState.players).sort(); // Sort player IDs for consistency
        playerIds.forEach(playerId => {
          const player = gameState.players[playerId];
          if (player) {
            minimalState.players[playerId] = {
              name: player.name || 'Unknown',
              health: Math.round(player.health || 100) // Round health to integer for consistency
            };
          }
        });
      }
      
      // Include scores in a consistent format if present
      if (gameState.score && Object.keys(gameState.score).length > 0) {
        minimalState.score = {};
        const scoreIds = Object.keys(gameState.score).sort(); // Sort IDs for consistency
        scoreIds.forEach(playerId => {
          // Always store score as integer
          minimalState.score[playerId] = Math.round(gameState.score[playerId] || 0);
        });
      }
      
      // Log the minimal state for debugging
      this.debug('Minimal game state for hashing:', JSON.stringify(minimalState, null, 2));
      
      // Use a strict serialization process that's guaranteed to be identical every time
      // 1. Sort all keys
      // 2. No whitespace
      // 3. No special characters in output
      const serialized = JSON.stringify(minimalState, (key, value) => {
        if (value && typeof value === 'object' && !Array.isArray(value)) {
          return Object.keys(value).sort().reduce((obj, key) => {
            obj[key] = value[key];
            return obj;
          }, {});
        }
        return value;
      });
      
      this.debug('Serialized game state for hashing:', serialized);
      
      return serialized;
    }
    
    /**
     * Generate a random ID of specified length
     */
    generateRandomId(length = 8) {
      const charset = 'abcdefghijklmnopqrstuvwxyz0123456789';
      let result = '';
      for (let i = 0; i < length; i++) {
        result += charset.charAt(Math.floor(Math.random() * charset.length));
      }
      return result;
    }
    
    /**
     * Get token status and inventory information
     */
    getTokenStatus() {
      const tokens = this.tokenPool.getTokens(this.secret);
      const coinTokens = [];
      let totalValue = BigInt(0);
      
      // Process token information
      if (tokens) {
        for (const tokenKey in tokens) {
          try {
            const token = this.TXF.importFlow(tokens[tokenKey]);
            if (token.tokenClass === this.tokenTypes.COIN) {
              coinTokens.push(token);
              totalValue += BigInt(token.tokenValue || '0');
            }
          } catch (error) {
            console.error(`Error importing token:`, error.message);
          }
        }
      }
      
      return {
        tokens: {
          total: tokens ? Object.keys(tokens).length : 0,
          coins: coinTokens.length,
        },
        value: totalValue.toString(),
        gameState: {
          lastVerified: this.lastVerifiedState.timestamp 
            ? new Date(this.lastVerifiedState.timestamp).toLocaleTimeString()
            : 'Never',
          isValid: this.lastVerifiedState.isValid,
          frame: this.lastVerifiedState.frame || 0,
          stateHash: this.lastVerifiedState.stateHash ? 
            this.lastVerifiedState.stateHash : 'None'
        }
      };
    }
    
    /**
     * Send tokens to a recipient
     * @param {Array} tokens - Array of tokens to send
     * @param {string} recipientPubkey - Recipient's public key
     */
    async sendTokensToRecipient(tokens, recipientPubkey) {
      const sentFlows = [];
      
      for (const token of tokens) {
        try {
          // Create transaction
          const salt = this.TXF.generateRandom256BitHex();
          const tx = await this.TXF.createTx(
            token,
            recipientPubkey,
            salt,
            this.secret,
            this.transport
          );
          
          // Export the token flow
          const tokenFlow = this.TXF.exportFlow(token, tx);
          sentFlows.push(tokenFlow);
          
          // Remove from token pool
          this.tokenPool.deleteToken(this.secret, token.tokenId);
          
          console.log(`Sent token ${token.tokenId.substring(0, 8)}... to recipient`);
        } catch (error) {
          console.error(`Failed to send token ${token.tokenId.substring(0, 8)}...:`, error.message);
        }
      }
      
      return sentFlows;
    }
  }

  // Export to global scope
  window.UniQuakeTokenService = UniQuakeTokenService;

})(window);