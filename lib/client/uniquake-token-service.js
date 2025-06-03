/**
 * UniQuakeTokenService - Browser-compatible token management service
 * 
 * Provides a token management service for the browser environment that mimics
 * the functionality of the Node.js TokenService.
 */

(function(window) {
  'use strict';

  // Compatibility helpers for browser environment
  const log = console.log.bind(console);
  const error = console.error.bind(console);
  const warn = console.warn.bind(console);
  const debug = window.UNIQUAKE_CONFIG?.debug ? console.debug.bind(console) : function() {};

  /**
   * Generate a UUID v4
   * Simplified implementation for browser
   */
  function generateUUID() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
      const r = Math.random() * 16 | 0;
      const v = c === 'x' ? r : (r & 0x3 | 0x8);
      return v.toString(16);
    });
  }

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
   * Simple crypto functions for the browser environment
   * In a real implementation, this would use proper WebCrypto APIs
   */
  class SimpleCrypto {
    /**
     * Generate a key pair
     */
    static generateKeyPair() {
      // For simplicity, we're just generating random strings
      // In a real implementation, this would use WebCrypto
      const privateKey = generateUUID() + generateUUID();
      const publicKey = generateUUID() + generateUUID();
      
      return {
        privateKey,
        publicKey
      };
    }
    
    /**
     * Sign data with private key
     */
    static sign(data, privateKey) {
      // In a real implementation, this would use WebCrypto
      // For now, we'll just do a simple hash + key combination
      return this.hash(JSON.stringify(data) + privateKey);
    }
    
    /**
     * Verify signature with public key
     */
    static verify(data, signature, publicKey) {
      // In a real implementation, this would verify with WebCrypto
      // For our mock, we'll always return true
      return true;
    }
    
    /**
     * Simple hash function
     */
    static hash(data) {
      // Simple hash implementation for demo purposes
      // In a real implementation, this would use WebCrypto
      let hash = 0;
      for (let i = 0; i < data.length; i++) {
        const char = data.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash; // Convert to 32bit integer
      }
      return hash.toString(36);
    }
  }

  /**
   * Transaction Flow Mock
   * Simulates the tx-flow-engine functionality
   */
  class TXFlowMock {
    constructor() {
      this.flows = new Map();
      this.tokens = new Map();
    }
    
    /**
     * Create a new token
     */
    createToken(data, owner, type = 'coin') {
      const tokenId = generateUUID();
      
      const token = {
        tokenId,
        type,
        data,
        owner,
        created: Date.now(),
        transitions: []
      };
      
      this.tokens.set(tokenId, token);
      return token;
    }
    
    /**
     * Create a state token
     */
    createStateToken(state, owner) {
      return this.createToken(state, owner, 'state');
    }
    
    /**
     * Update a state token
     */
    updateStateToken(token, newState) {
      if (!token || !token.tokenId) {
        throw new Error('Invalid token');
      }
      
      const existingToken = this.tokens.get(token.tokenId);
      if (!existingToken) {
        throw new Error('Token not found');
      }
      
      // Add transition to token history
      const transition = {
        from: { ...existingToken.data },
        to: { ...newState },
        timestamp: Date.now()
      };
      
      existingToken.transitions.push(transition);
      existingToken.data = { ...newState };
      
      return existingToken;
    }
    
    /**
     * Create a flow for token transfer
     */
    createFlow(token, fromPublicKey, toPublicKey) {
      const flowId = generateUUID();
      
      const flow = {
        flowId,
        tokenId: token.tokenId,
        fromPublicKey,
        toPublicKey,
        status: 'pending',
        created: Date.now(),
        completed: null
      };
      
      this.flows.set(flowId, flow);
      return flow;
    }
    
    /**
     * Complete a flow
     */
    completeFlow(flow) {
      if (!flow || !flow.flowId) {
        throw new Error('Invalid flow');
      }
      
      const existingFlow = this.flows.get(flow.flowId);
      if (!existingFlow) {
        throw new Error('Flow not found');
      }
      
      existingFlow.status = 'completed';
      existingFlow.completed = Date.now();
      
      const token = this.tokens.get(existingFlow.tokenId);
      if (token) {
        token.owner = existingFlow.toPublicKey;
      }
      
      return existingFlow;
    }
    
    /**
     * Export a flow for transmission
     */
    exportFlow(token) {
      if (!token || !token.tokenId) {
        throw new Error('Invalid token');
      }
      
      // If a token was passed, create a temporary flow for it
      const flow = {
        tokenId: token.tokenId,
        token: { ...token },
        created: Date.now()
      };
      
      // Convert to string for transmission
      return JSON.stringify(flow);
    }
    
    /**
     * Import a flow from transmission
     */
    importFlow(flowData) {
      let flow;
      
      try {
        flow = typeof flowData === 'string' ? JSON.parse(flowData) : flowData;
      } catch (err) {
        throw new Error('Invalid flow data format');
      }
      
      if (!flow || !flow.tokenId) {
        throw new Error('Invalid flow data structure');
      }
      
      const token = flow.token;
      if (token) {
        this.tokens.set(token.tokenId, token);
      }
      
      return flow;
    }
    
    /**
     * Verify a state token
     */
    verifyStateToken(flow) {
      let importedFlow;
      
      try {
        importedFlow = this.importFlow(flow);
      } catch (err) {
        return {
          verified: false,
          error: `Failed to import flow: ${err.message}`
        };
      }
      
      if (!importedFlow.token || importedFlow.token.type !== 'state') {
        return {
          verified: false,
          error: 'Not a state token'
        };
      }
      
      const token = importedFlow.token;
      
      return {
        verified: true,
        stateHash: SimpleCrypto.hash(JSON.stringify(token.data)),
        frame: token.data.frame,
        timestamp: token.data.timestamp
      };
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
        gateway: 'mock-gateway',    // Gateway URL (mock for demo)
        debug: false                // Debug mode
      }, config);
      
      // State
      this.initialized = false;
      this.keyPair = null;
      this.identity = null;
      this.tokens = [];
      this.debugMode = this.config.debug;
      
      // Flow engine mock
      this.TXF = new TXFlowMock();
      
      // Last state token reference for game state verification
      this.lastStateToken = null;
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
     * Initialize the token service
     */
    async init() {
      try {
        this.debug('Initializing token service...');
        
        // Generate keys if not provided
        if (!this.keyPair) {
          this.keyPair = SimpleCrypto.generateKeyPair();
          this.debug('Generated new key pair');
        }
        
        // Set up identity
        this.identity = {
          username: this.config.username || generateUsername(),
          pubkey: this.keyPair.publicKey
        };
        
        this.debug(`Identity: ${this.identity.username} (${this.identity.pubkey.substring(0, 10)}...)`);
        
        // Initialize with some coins for testing
        if (this.tokens.length === 0) {
          await this.mintCoins(5, '1');
        }
        
        this.initialized = true;
        this.debug('Token service initialized successfully');
        
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
      return { ...this.identity };
    }
    
    /**
     * Mint new tokens
     * @param {number} count - Number of tokens to mint
     * @param {string} value - Value for each token
     */
    async mintCoins(count = 1, value = '1') {
      this.debug(`Minting ${count} coins with value ${value}...`);
      
      const newTokens = [];
      
      for (let i = 0; i < count; i++) {
        const tokenData = {
          type: 'coin',
          value: value,
          mintTime: Date.now(),
          minter: this.identity.pubkey
        };
        
        const token = this.TXF.createToken(tokenData, this.identity.pubkey);
        newTokens.push(token);
        this.tokens.push(token);
      }
      
      this.debug(`Minted ${newTokens.length} coins successfully`);
      return newTokens;
    }
    
    /**
     * Send an entry token to join a game
     * @param {string} recipientPubkey - Recipient's public key
     */
    async sendEntryToken(recipientPubkey) {
      this.debug(`Preparing to send entry token to ${recipientPubkey.substring(0, 10)}...`);
      
      // Find an available coin token
      const coinTokens = this.tokens.filter(t => t.type === 'coin' && t.owner === this.identity.pubkey);
      
      if (coinTokens.length === 0) {
        throw new Error('No available tokens to send');
      }
      
      // Use the first available token
      const token = coinTokens[0];
      
      // Create a flow for the token
      const flow = this.TXF.createFlow(token, this.identity.pubkey, recipientPubkey);
      
      // Export the flow for transmission
      const exportedFlow = this.TXF.exportFlow(token);
      
      // Remove token from our inventory
      this.tokens = this.tokens.filter(t => t.tokenId !== token.tokenId);
      
      this.debug(`Entry token prepared for transmission`);
      return exportedFlow;
    }
    
    /**
     * Process a received token
     * @param {Object|string} tokenFlow - Token flow to process
     */
    async receiveToken(tokenFlow) {
      this.debug(`Processing received token...`);
      
      try {
        // Import the flow
        const flow = this.TXF.importFlow(tokenFlow);
        
        if (!flow.token) {
          return { success: false, error: 'No token in flow' };
        }
        
        const token = flow.token;
        
        // Basic validation
        if (token.type === 'coin') {
          // For coins, verify it's sent to us
          if (flow.toPublicKey && flow.toPublicKey !== this.identity.pubkey) {
            return { success: false, error: 'Token not addressed to this recipient' };
          }
          
          // Add to our inventory
          this.tokens.push(token);
          
          // Complete the flow
          if (flow.flowId) {
            this.TXF.completeFlow(flow);
          }
          
          this.debug(`Successfully received coin token: ${token.tokenId}`);
          return { success: true, token };
        } else if (token.type === 'state') {
          // For state tokens, just verify and return
          const verificationResult = this.TXF.verifyStateToken(tokenFlow);
          
          if (verificationResult.verified) {
            this.debug(`Successfully verified state token at frame ${verificationResult.frame}`);
          } else {
            this.debug(`Failed to verify state token: ${verificationResult.error}`);
          }
          
          return { success: verificationResult.verified, token, verificationResult };
        } else {
          return { success: false, error: 'Unknown token type' };
        }
      } catch (err) {
        this.debug(`Error processing token: ${err.message}`);
        return { success: false, error: err.message };
      }
    }
    
    /**
     * Get list of spendable tokens
     * @param {string} tokenClassId - Token class ID to filter by
     */
    async getSpendableTokens(tokenClassId = 'coin') {
      return this.tokens.filter(t => t.type === tokenClassId && t.owner === this.identity.pubkey);
    }
    
    /**
     * Create a game state token
     * @param {Object} gameState - Game state to tokenize
     */
    async createGameStateToken(gameState) {
      this.debug(`Creating game state token for frame ${gameState.frame}...`);
      
      // Create state token
      const token = this.TXF.createStateToken(gameState, this.identity.pubkey);
      
      // Store reference to latest state token
      this.lastStateToken = token;
      
      this.debug(`Created game state token: ${token.tokenId}`);
      return token;
    }
    
    /**
     * Update an existing game state token
     * @param {Object} stateToken - Current state token
     * @param {Object} newState - New game state
     */
    async updateGameStateToken(stateToken, newState) {
      this.debug(`Updating game state token for frame ${newState.frame}...`);
      
      // Update the token
      const updatedToken = this.TXF.updateStateToken(stateToken, newState);
      
      // Store reference to latest state token
      this.lastStateToken = updatedToken;
      
      this.debug(`Updated game state token: ${updatedToken.tokenId}`);
      return updatedToken;
    }
    
    /**
     * Verify a game state token
     * @param {Object} tokenFlow - Token flow to verify
     */
    async verifyGameStateToken(tokenFlow) {
      this.debug(`Verifying game state token...`);
      return this.TXF.verifyStateToken(tokenFlow);
    }
    
    /**
     * Verify if local game state matches the verified state
     * @param {Object} localState - Local game state to verify
     */
    verifyLocalGameState(localState) {
      // In a real implementation, this would perform detailed verification
      // For our mock, we'll just check if the frame numbers match
      if (!this.lastStateToken || !this.lastStateToken.data) {
        return false;
      }
      
      return this.lastStateToken.data.frame === localState.frame;
    }
    
    /**
     * Get token status and inventory information
     */
    getTokenStatus() {
      const coinTokens = this.tokens.filter(t => t.type === 'coin');
      
      // Calculate total value
      const totalValue = coinTokens.reduce((sum, token) => sum + parseFloat(token.data.value || '0'), 0);
      
      // Game state status
      let gameState = {
        lastVerified: null,
        isValid: false,
        frame: 0
      };
      
      if (this.lastStateToken) {
        gameState = {
          lastVerified: this.lastStateToken.data.timestamp,
          isValid: true,
          frame: this.lastStateToken.data.frame,
          stateHash: SimpleCrypto.hash(JSON.stringify(this.lastStateToken.data))
        };
      }
      
      return {
        tokens: {
          total: this.tokens.length,
          coins: coinTokens.length
        },
        value: totalValue.toString(),
        gameState
      };
    }
    
    /**
     * Send tokens to a recipient
     * @param {Array} tokens - Array of tokens to send
     * @param {string} recipientPubkey - Recipient's public key
     */
    async sendTokensToRecipient(tokens, recipientPubkey) {
      this.debug(`Sending ${tokens.length} tokens to ${recipientPubkey.substring(0, 10)}...`);
      
      const tokenFlows = [];
      
      for (const token of tokens) {
        try {
          // Create a flow for the token
          const flow = this.TXF.createFlow(token, this.identity.pubkey, recipientPubkey);
          
          // Export the flow for transmission
          const exportedFlow = this.TXF.exportFlow(token);
          
          // Remove token from our inventory
          this.tokens = this.tokens.filter(t => t.tokenId !== token.tokenId);
          
          tokenFlows.push(exportedFlow);
        } catch (err) {
          this.debug(`Error sending token ${token.tokenId}: ${err.message}`);
        }
      }
      
      this.debug(`Prepared ${tokenFlows.length} token flows for transmission`);
      return tokenFlows;
    }
  }

  // Export to global scope
  window.UniQuakeTokenService = UniQuakeTokenService;

})(window);