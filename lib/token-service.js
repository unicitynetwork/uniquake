/**
 * Token Service for UniQuake
 * 
 * This module provides token operations for the UniQuake game using 
 * the Unicity state transition SDK (tx-flow-engine).
 */

const crypto = require('crypto');

class TokenService {
    constructor(secret, username) {
        // Will be initialized in async init
        this.TXF = null;
        this.TokenPool = null;
        
        // Identity
        this.secret = secret || this.generateRandomSecret();
        this.username = username || `user-${this.generateRandomId(6)}`;
        this.pubkey = null; // Will be set during init
        
        // Network transport
        this.transport = null; // Will be set during init
        
        // Token pool
        this.tokenPool = null;  // Will use the existing TokenPool implementation
        
        // Token class identifiers
        this.tokenTypes = {
            COIN: null, // Will be set during init
            STATE: null // Will be set during init
        };
        
        // Last verified game state
        this.lastVerifiedState = {
            timestamp: null,
            stateHash: null,
            isValid: false
        };
        
        // Last state token - separate from token pool
        this.lastStateToken = null;
        
        // Token reset management
        this.resetFrameInterval = 10; // Reset token every 10 frames
        this.stateHashHistory = []; // Record state hashes for performance tracking
        
        // Debug flag (to be set externally)
        this.debugMode = false;
    }
    
    /**
     * Log a debug message, only if debug mode is enabled
     * @param {string} message - Message to log
     */
    debug(message) {
        if (this.debugMode) {
            console.log(message);
        }
    }
    
    /**
     * Initialize the token service
     * This needs to be async because we load the SDK dynamically
     */
    async init() {
        try {
            // Import the tx-flow-engine and TokenPool
            this.TXF = require('@unicitylabs/tx-flow-engine');
            const { TokenPool } = require('@unicitylabs/tx-flow-engine/tokenpool');
            
            // Create token pool instance
            this.tokenPool = new TokenPool();
            
            // Set up public key
            this.pubkey = this.TXF.generateRecipientPubkeyAddr(this.secret);
            
            // Initialize transport
            this.transport = this.TXF.getHTTPTransport(this.TXF.defaultGateway());
            
            // Initialize token types
            this.tokenTypes.COIN = this.TXF.validateOrConvert('token_class', 'quake_test_coin');
            this.tokenTypes.STATE = this.TXF.validateOrConvert('token_class', 'quake_game_state');
            
            // Show initialization success to everyone (not just debug)
            console.log(`Token service initialized for ${this.username} (${this.pubkey.substring(0, 10)}...)`);
            return true;
        } catch (error) {
            console.error('[TokenService] Initialization error:', error.message);
            return false;
        }
    }
    
    /**
     * Generate a random secret key
     */
    generateRandomSecret() {
        return crypto.randomBytes(32).toString('hex');
    }
    
    /**
     * Generate a random ID of specified length
     */
    generateRandomId(length = 8) {
        return crypto.randomBytes(Math.ceil(length / 2))
            .toString('hex')
            .substring(0, length);
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
     * Mint new coin tokens
     * @param {number} count - Number of tokens to mint
     * @param {string} value - Value for each token
     * @returns {Promise<Array>} - Array of minted tokens
     */
    async mintCoins(count = 1, value = '1') {
        const results = [];
        
        this.debug(`[TokenService] Minting ${count} token(s) with value ${value}...`);
        // Show minting status to everyone (not just debug)
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
                
                this.debug(`[TokenService] Minted token ${i+1}/${count} with ID ${tokenId.substring(0, 8)}...`);
            } catch (error) {
                console.error(`[TokenService] Failed to mint token ${i+1}/${count}:`, error.message);
            }
        }
        
        // Show completion to everyone
        console.log(`Successfully minted ${results.length} of ${count} tokens`);
        return results;
    }
    
    /**
     * Send an entry token to join a game
     * @param {string} recipientPubkey - Recipient's public key
     * @returns {Promise<Object>} - Token flow for transmission
     */
    async sendEntryToken(recipientPubkey) {
        this.debug(`[TokenService] Preparing to send entry token to ${recipientPubkey.substring(0, 10)}...`);
        // Show to everyone
        console.log(`Preparing entry token...`);
        
        // Find a spendable token
        const spendableTokens = await this.getSpendableTokens(this.tokenTypes.COIN);
        
        if (spendableTokens.length === 0) {
            throw new Error('No spendable tokens available for entry fee');
        }
        
        // Use the first available token
        const token = spendableTokens[0];
        this.debug(`[TokenService] Selected token ${token.tokenId.substring(0, 8)}... for entry fee`);
        
        // Create transaction to recipient
        const salt = this.TXF.generateRandom256BitHex();
        const tx = await this.TXF.createTx(token, recipientPubkey, salt, this.secret, this.transport);
        
        // Export the token flow for transmission
        const tokenFlow = this.TXF.exportFlow(token, tx);
        
        // Remove from pool
        this.tokenPool.deleteToken(this.secret, token.tokenId);
        
        this.debug(`[TokenService] Entry token prepared for sending`);
        // Show to everyone
        console.log(`Entry token ready to send`);
        
        return tokenFlow;
    }
    
    /**
     * Process a received token
     * @param {Object|string} tokenFlowStr - Token flow to process
     * @returns {Promise<Object>} - Result of token processing
     */
    async receiveToken(tokenFlowStr) {
        this.debug(`[TokenService] Processing received token...`);
        // Show to everyone
        console.log(`Processing received token...`);
        
        try {
            // Import the token flow
            const token = this.TXF.importFlow(tokenFlowStr, this.secret);
            
            // Check token status
            const status = await this.TXF.getTokenStatus(token, this.secret, this.transport);
            
            if (status.owned && status.unspent) {
                // Add to token pool
                this.tokenPool.addToken(this.secret, this.TXF.exportFlow(token));
                
                this.debug(`[TokenService] Received valid token ${token.tokenId.substring(0, 8)}...`);
                // Show to everyone
                console.log(`Token received successfully`);
                return { success: true, token };
            } else {
                this.debug(`[TokenService] Received invalid token: owned=${status.owned}, unspent=${status.unspent}`);
                console.log(`Invalid token received`);
                return { 
                    success: false, 
                    error: 'Token is not valid, not owned, or already spent',
                    status
                };
            }
        } catch (error) {
            console.error(`[TokenService] Failed to process token:`, error.message);
            return { success: false, error: error.message };
        }
    }
    
    /**
     * Get list of spendable tokens for a given token class
     * @param {string} tokenClassId - Token class ID to filter by
     * @returns {Promise<Array>} - Array of spendable tokens
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
                console.error(`[TokenService] Error checking token status:`, error.message);
            }
        }
        
        return result;
    }
    
    /**
     * Create a game state token - this should be called once at game start
     * @param {Object} gameState - The initial game state to tokenize
     * @returns {Promise<Object>} - Created state token
     */
    async createGameStateToken(gameState) {
        try {
            const tokenId = this.TXF.generateRandom256BitHex();
            const nonce = this.TXF.generateRandom256BitHex();
            const salt = this.TXF.generateRandom256BitHex();
            
            // Serialize and hash the game state
            const stateHash = this.hashGameState(gameState);
            
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
            // We don't need to add state tokens to the token pool
            this.lastStateToken = token;
            
            console.log(`[TokenService] Created initial game state token with ID ${tokenId.substring(0, 8)}...`);
            return token;
        } catch (error) {
            console.error(`[TokenService] Failed to create game state token:`, error.message);
            throw error;
        }
    }
    
    /**
     * Update game state with a transaction - this should be called for each state update
     * @param {Object} stateToken - The current state token
     * @param {Object} newState - The new game state
     * @returns {Promise<Object>} - Updated token with transaction applied
     */
    async updateGameStateToken(stateToken, newState) {
        try {
            // Check if we should reset the token to prevent growth
            const currentFrame = newState.frame || 0;
            if (currentFrame > 0 && currentFrame % this.resetFrameInterval === 0) {
                console.log(`[TokenService] Resetting token at frame ${currentFrame} to prevent size growth`);
                return await this.resetGameStateToken(newState);
            }
/*            console.log(`[TokenService] Checking token structure:`, 
                JSON.stringify({
                    tokenId: stateToken.tokenId,
                    hasTransitions: !!stateToken.transitions,
                    transitionsType: stateToken.transitions ? typeof stateToken.transitions : 'undefined'
                }));
            
            // Ensure the token has a transitions array
            if (!stateToken.transitions) {
                stateToken.transitions = [];
                console.log(`[TokenService] Added missing transitions array to token`);
            }*/
            
            // Hash the new state
            const stateHash = this.hashGameState(newState);
            
            // Record state hash for performance tracking
            this.recordStateHash(currentFrame, stateHash);
            
            // Create a message with the new state hash
            const message = {
                state_hash: stateHash,
                timestamp: Date.now(),
                frame: newState.frame || 0,
                prev_hash: stateToken.tokenData?.state_hash
            };
            
            // Use the SDK's transaction creation
            console.log(`[TokenService] Creating transaction for token ${stateToken.tokenId}`);
            
            try {
                // Create a transaction to self
                const pubkeyAddr = this.TXF.generateRecipientPubkeyAddr(this.secret);
                
                // Generate data hash for the message
                const messageData = JSON.stringify(message);
                const dataHash = this.TXF.getHashOf(messageData);
                
                console.log(`[TokenService] Created data hash: ${dataHash.substring(0, 10)}...`);
                
                // Create transaction using SDK method with proper data hash
                const tx = await this.TXF.createTx(
                    stateToken,
                    pubkeyAddr,
                    this.TXF.generateRandom256BitHex(), // salt
                    this.secret,
                    this.transport,
                    dataHash, // proper data hash
                    messageData // message data
                );
                
                console.log(`[TokenService] Transaction created, now exporting token flow with transaction`);
                
                // Export the token flow with the transaction
                const tokenFlow = this.TXF.exportFlow(stateToken, tx);
                
                // Import the token flow to get an updated token with the transaction applied
                // For importing with transaction, we need to pass secret and message data
                const updatedToken = this.TXF.importFlow(tokenFlow, this.secret, null, messageData);
                
                this.debug(`[TokenService] Successfully imported updated token`);
                this.lastStateToken = updatedToken;
        	this.debug(`[TokenService] Updated game state token with new state at frame ${newState.frame || 0}`);
		return updatedToken;
            } catch (txError) {
                console.error(`[TokenService] Transaction error: ${txError.message}`);
                throw txError;
	    }
    	} catch (error) {
    	    console.error(`[TokenService] Failed to update game state token:`, error.message);
    	    throw error;
    	}
    }
    
    /**
     * Verify a game state token
     * @param {Object} tokenFlow - Token flow to verify
     * @returns {Promise<Object>} - Verification result
     */
    async verifyGameStateToken(tokenFlow) {
        try {
            this.debug(`[TokenService] Verifying game state token...`);
            
            // Import the token from the flow - don't use secret since we're just verifying
            const token = this.TXF.importFlow(
                typeof tokenFlow === 'string' ? tokenFlow : JSON.stringify(tokenFlow)
            );
            
            this.debug(`[TokenService] Token imported successfully, ID: ${token.tokenId.substring(0, 8)}...`);
            
            // For game state tokens, we use empty string as the secret parameter to check validity without ownership
            const status = await this.TXF.getTokenStatus(token, '', this.transport);

            this.debug(`[TokenService] Token status check result: valid=${status.valid}`);

            // Access token data directly from the SDK's token object
            // The immutable data should contain our state hash
            let stateData = status.data;
            
/*            if (token.immutableData) {
                try {
                    stateData = typeof token.immutableData === 'string' ? 
                        JSON.parse(token.immutableData) : token.immutableData;
                    console.log(`[TokenService] Found state data in immutable data`);
                } catch (error) {
                    console.log(`[TokenService] Error parsing immutable data: ${error.message}`);
                }
            }
            
            // If no data in immutable data, check the latest transition message
            if (!stateData && token.transitions && token.transitions.length > 0) {
                const latestTransition = token.transitions[token.transitions.length - 1];
                if (latestTransition.tx && latestTransition.tx.input && latestTransition.tx.input.msg) {
                    try {
                        stateData = typeof latestTransition.tx.input.msg === 'string' ?
                            JSON.parse(latestTransition.tx.input.msg) :
                            latestTransition.tx.input.msg;
                        console.log(`[TokenService] Found state data in transition message`);
                    } catch (error) {
                        console.log(`[TokenService] Error parsing transition message: ${error.message}`);
                    }
                }
            }
            
            // Fallback to token data
            if (!stateData && token.tokenData) {
                try {
                    stateData = typeof token.tokenData === 'string' ?
                        JSON.parse(token.tokenData) : token.tokenData;
                    console.log(`[TokenService] Found state data in token data`);
                } catch (error) {
                    console.log(`[TokenService] Error parsing token data: ${error.message}`);
                    return { verified: false, error: 'Invalid state data format' };
                }
            }
            
            if (!stateData) {
                console.log(`[TokenService] No state data found in token`);
                return { verified: false, error: 'No state data found in token' };
            }
*/            
            if (!stateData.state_hash) {
                this.debug(`[TokenService] State data missing required field: state_hash`);
                return { verified: false, error: 'State data missing state hash' };
            }
            
            this.debug(`[TokenService] State verification successful, frame: ${stateData.frame || 0}`);
            
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
            console.error(`[TokenService] Game state verification error:`, error.message);
            return { verified: false, error: error.message };
        }
    }
    
    /**
     * Verify if local game state matches the verified state
     * @param {Object} localState - Local game state to verify
     * @returns {boolean} - True if state matches
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
        // We need to sort keys to ensure consistent hashing
        const serialized = this.serializeGameState(gameState);
        
        // Use the crypto module since TXF doesn't export sha256 directly
        const { hash } = require('@unicitylabs/shared/hasher/sha256hasher.js').SHA256Hasher;
        return hash(serialized);
    }
    
    /**
     * Serialize game state for consistent hashing
     * @param {Object} gameState - Game state to serialize
     * @returns {string} - Serialized game state
     */
    serializeGameState(gameState) {
        // Clone the state and extract only the necessary properties
        const essentialState = {
            gameId: gameState.gameId || '',
            frame: gameState.frame || 0,
            timestamp: gameState.timestamp || Date.now(),
            players: gameState.players || {}
        };
        
        // Sort keys for deterministic serialization
        return JSON.stringify(essentialState, (key, value) => {
            if (value && typeof value === 'object' && !Array.isArray(value)) {
                return Object.keys(value).sort().reduce((obj, key) => {
                    obj[key] = value[key];
                    return obj;
                }, {});
            }
            return value;
        });
    }
    
    /**
     * Get the token status report
     * @returns {Object} - Status of token pool and game state
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
                    console.error(`[TokenService] Error importing token:`, error.message);
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
                    `${this.lastVerifiedState.stateHash.substring(0, 8)}...` : 'None'
            }
        };
    }
    
    /**
     * Send tokens to a recipient (for reward distribution)
     * @param {Array} tokens - Array of tokens to send
     * @param {string} recipientPubkey - Recipient's public key
     * @returns {Promise<Array>} - Array of token flows
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
                
                console.log(`[TokenService] Sent token ${token.tokenId.substring(0, 8)}... to recipient`);
            } catch (error) {
                console.error(`[TokenService] Failed to send token ${token.tokenId.substring(0, 8)}...:`, error.message);
            }
        }
        
        return sentFlows;
    }
    
    /**
     * Reset game state token by creating a new one (discarding old transactions)
     * @param {Object} newState - The new game state
     * @returns {Promise<Object>} - New state token
     */
    async resetGameStateToken(newState) {
        try {
            console.log(`[TokenService] Creating fresh token for frame ${newState.frame || 0} (discarding old token)`);
            
            // Create a completely new token (this automatically discards the old one)
            const newToken = await this.createGameStateToken(newState);
            
            // Update our reference
            this.lastStateToken = newToken;
            
            console.log(`[TokenService] Successfully reset token at frame ${newState.frame || 0}`);
            return newToken;
        } catch (error) {
            console.error(`[TokenService] Failed to reset game state token:`, error.message);
            throw error;
        }
    }
    
    /**
     * Record a state hash for performance tracking
     * @param {number} frame - Frame number
     * @param {string} stateHash - State hash
     */
    recordStateHash(frame, stateHash) {
        const record = {
            frame,
            stateHash,
            timestamp: Date.now()
        };
        
        // Add to history
        this.stateHashHistory.push(record);
        
        // Keep only last 50 records to prevent memory growth
        if (this.stateHashHistory.length > 50) {
            this.stateHashHistory = this.stateHashHistory.slice(-50);
        }
        
        this.debug(`[TokenService] Recorded state hash for frame ${frame}: ${stateHash.substring(0, 8)}...`);
    }
    
    /**
     * Get state hash history for debugging/monitoring
     * @returns {Array} - Array of state hash records
     */
    getStateHashHistory() {
        return this.stateHashHistory.slice(); // Return a copy
    }
}

module.exports = { TokenService };