# UniQuake Token Integration Implementation Plan

This document outlines the step-by-step plan for implementing token-based features in the UniQuake mock client-server environment. We will focus on two primary use cases:

1. **Play-to-earn game entry and rewards**
2. **Game state integrity verification**

## Overall Architecture

We will extend the existing P2P network infrastructure to handle token transactions between clients and servers. All token operations will use in-memory storage for this demo, and communication will happen through the existing message transport mechanisms.

## Implementation Sequence

### Phase 1: Set Up Token Infrastructure

1. **Create Token Service Module**
   - Create `lib/token-service.js` to handle token operations using the state-transition SDK
   - Implement mint, send, and receive operations for tokens
   - Set up in-memory token pool storage

2. **Add Identity Generation**
   - Extend mock client and server to generate cryptographic identities on startup
   - Implement public key sharing during connection setup
   - Store these identities for token operations

### Phase 2: Implement Play-to-Earn Flow

3. **Add Client Token Minting**
   - Implement `--mint <value>` command-line option
   - Add token minting on client startup
   - Implement token pool management functions

4. **Implement Server Entry Fee**
   - Add token transfer during client-server connection handshake
   - Implement server-side token validation and storage
   - Add connection rejection for invalid tokens

5. **Create Game End and Reward Distribution**
   - Implement `gameover <client_id>` command on server
   - Add reward token distribution to winner
   - Implement client-side token receiving and processing

### Phase 3: Implement Game State Integrity

6. **Create Game State Token System**
   - Implement game state token minting on server
   - Add periodic (10s) state update broadcasting
   - Create state hash generation functions

7. **Add Client-Side Verification**
   - Implement game state token verification
   - Add verification reporting to client status command
   - Set up status report to include token verification results

### Phase 4: Final Integration and Testing

8. **Message Handling Integration**
   - Update message handlers to process token messages
   - Ensure proper format conversion between transport layers
   - Add error handling for token operations

9. **Command Line Interface Enhancements**
   - Add token-related commands to client and server
   - Implement status reporting for token operations
   - Create help documentation for new commands

## Detailed Implementation Steps

### 1. Token Service Module (`lib/token-service.js`)

```javascript
// Basic structure
class TokenService {
  constructor(secret, username) {
    // Initialize SDK, token types, and pool
  }
  
  async generateIdentity() {
    // Generate random secret if not provided
    // Derive public key
    // Return identity information
  }
  
  async mintCoins(count, value) {
    // Mint specified number of tokens with given value
    // Add to owned token pool
  }
  
  async sendEntryToken(recipientPubkey) {
    // Select one token from pool
    // Create transaction to recipient
    // Remove from pool and return tokenFlow
  }
  
  async receiveToken(tokenFlow) {
    // Import token from flow
    // Validate ownership and status
    // Add to owned pool if valid
  }
  
  async createGameStateToken(gameState) {
    // Create token with game state hash
    // Add proof of state integrity
  }
  
  getTokenStatus() {
    // Return summary of token pool
  }
}
```

### 2. Mock Client Extensions (`lib/mock-game-client.js`)

Add these functions to the mock client:

```javascript
// Identity generation
function generateIdentity() {
  // Create identity using TokenService
  // Store secret and pubkey in client state
}

// Initial token minting
function mintInitialTokens(count) {
  // Use TokenService to mint tokens
  // Add to client's token pool
}

// Send entry token
async function sendEntryTokenToServer() {
  // Select token and create transaction
  // Send to server via existing transport
}

// Process game state token
async function verifyGameStateToken(tokenFlow) {
  // Verify the token is valid
  // Compare game state hash with local state
}

// Enhanced status command
function enhancedStatusCommand() {
  // Show existing status info
  // Add token balance and pool info
  // Add game state verification status
}
```

### 3. Mock Server Extensions (`lib/mock-server-client.js`)

Add these functions to the mock server:

```javascript
// Identity generation
function generateIdentity() {
  // Create identity using TokenService
  // Store secret and pubkey in server state
}

// Validate entry token
async function validateEntryToken(clientId, tokenFlow) {
  // Import and validate token
  // Store in session tokens map if valid
}

// Create game session token
async function createGameSessionToken() {
  // Capture current game state
  // Create token with state hash
  // Broadcast to all clients
}

// Send rewards to winner
async function distributeRewardsToWinner(winnerId) {
  // Transfer all collected tokens to winner
  // Send token flows to winner client
}

// Game over command
function handleGameOver(clientId) {
  // Distribute rewards to winner
  // Notify all clients
  // Reset game state
}
```

### 4. Message Handlers

Extend the existing message handling system:

```javascript
// Client-side
const tokenMessageHandlers = {
  'token:entry:ack': (message) => {
    // Handle server's acknowledgment of entry token
  },
  'token:reward': (message) => {
    // Process received reward tokens
  },
  'game:state:token': (message) => {
    // Verify game state token
  }
};

// Server-side
const tokenMessageHandlers = {
  'token:entry': (clientId, message) => {
    // Validate entry token from client
  }
};
```

### 5. Command-Line Interface Extensions

```javascript
// Client-side commands
const tokenCommands = {
  'mint <count>': 'Mint additional tokens',
  'tokens': 'Show token inventory',
  'verify': 'Verify current game state token'
};

// Server-side commands
const tokenCommands = {
  'gameover <client_id>': 'End game and send rewards to winner',
  'tokens': 'Show all collected tokens',
  'gamestate': 'Manually create and broadcast game state token'
};
```

## Testing Plan

1. **Basic Token Creation**
   - Start client with `--mint 5` parameter
   - Check token pool content with `tokens` command
   - Verify values and ownership

2. **Connection and Entry Fee**
   - Start server and client
   - Connect client to server
   - Verify token transfer and validation
   - Check server token pool contains client's entry token

3. **Game End and Rewards**
   - Connect multiple clients to server
   - Run `gameover <client_id>` command
   - Verify winner receives all collected tokens
   - Check token pools on all clients

4. **Game State Verification**
   - Verify periodic state token broadcasting works
   - Run `status` command on client to see verification results
   - Test with modified state to see how verification fails

## Implementation Workflow

1. Create `lib/token-service.js`
2. Add identity generation to both client and server
3. Add token minting to client
4. Implement entry token sending during connection
5. Add token validation on server
6. Implement `gameover` command
7. Create game state token generation and verification
8. Update CLI interfaces and status reporting
9. Test all token operations
10. Document the complete system

This implementation plan provides a clear roadmap for adding token functionality to the UniQuake mock client-server environment, focusing on the play-to-earn mechanics and game state verification requirements.