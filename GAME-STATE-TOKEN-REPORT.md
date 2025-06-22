# Game State Token Generation and Update Report

## Overview

This report documents how the UniQuake server generates and updates game state tokens, including the hashing mechanism, 
data structure, and update workflow. The system uses the Unicity blockchain framework (`@unicitylabs/tx-flow-engine`) 
to create verifiable game state tokens while maintaining performance through strategic optimizations.

## Token Service Architecture

### Core Components

1. **Server-side Token Service** (`/lib/token-service.js`)
   - Handles token creation, updates, and verification
   - Manages token lifecycle and state transitions
   - Implements performance optimizations

2. **Browser Server** (`/lib/client/browser-server.js`)
   - Creates and broadcasts game state tokens
   - Synchronizes game state between clients
   - Manages token update intervals

3. **Client-side Token Service** (`/lib/client/uniquake-token-service.js`)
   - Verifies received tokens
   - Maintains consistent hashing with server
   - Handles token flow imports

## What is Hashed

### Minimal State Approach

To ensure consistency between client and server, only a minimal subset of the game state is hashed:

```javascript
const minimalState = {
  frame: parseInt(gameState?.frame || 0, 10),  // Game frame number as integer
  gameId: String(gameState?.gameId || '')       // Unique game identifier as string
};
```

**Key Design Decision**: The system deliberately excludes volatile data (players, items, scores) from the hash to prevent client/server synchronization issues.

### Hashing Process

1. **Normalization**: Game state is normalized to the minimal state structure
2. **Serialization**: `JSON.stringify(minimalState)` creates a deterministic string
3. **Hashing**: SHA256 hash via `TXF.getHashOf(serialized)`
4. **Result**: 256-bit hexadecimal hash string

## Token Data Structure

### Immutable Data (Stored in Token)

When a game state token is created, the following immutable data is recorded:

```javascript
{
  "state_hash": "64-character-sha256-hash",  // Hash of minimal game state
  "timestamp": 1703123456789,                // Unix timestamp of creation
  "frame": 42,                               // Game frame number
  "game_id": "game-1703123456789"           // Unique game identifier
}
```

### Token Metadata

```javascript
{
  "token_id": "256-bit-random-hex",          // Unique token identifier
  "token_class_id": "quake_game_state",      // Token type identifier
  "token_value": "1",                        // Nominal value
  "sign_alg": "secp256k1",                   // Signature algorithm
  "hash_alg": "sha256"                       // Hash algorithm
}
```

## Full Game State Structure

While only minimal data is hashed, the complete game state maintained by the server includes:

```javascript
{
  "gameId": "game-1703123456789",
  "frame": 42,
  "timestamp": 1703123456789,
  "players": {
    "player_pubkey_or_id": {
      "id": "player_pubkey_or_id",
      "name": "PlayerName",
      "connected": true,
      "pubkey": "player_public_key",
      "clientId": "websocket_connection_id",
      "username": "player_username",
      "joinTime": 1703123456789,
      "lastActive": 1703123456789,
      "health": 100,
      "position": {
        "x": 100.5,
        "y": 200.3,
        "z": 50.0
      }
    }
  },
  "score": {
    "player_pubkey_or_id": 150
  },
  "items": {
    "item-unique-id": {
      "type": "health|ammo|weapon|armor",
      "position": {"x": 300, "y": 400, "z": 100},
      "value": 50
    }
  }
}
```

## Token Update Workflow

### 1. Initial Token Creation

```javascript
// Server starts or game begins
const token = await tokenService.createGameStateToken(gameState);
```

- Mints a new token with initial state hash
- Stores in `tokenService.lastStateToken`
- Returns token for broadcasting

### 2. Regular Updates

```javascript
// Every game state change
const updatedToken = await tokenService.updateGameStateToken(
  tokenService.lastStateToken,
  newGameState
);
```

- Creates a transaction recording the state change
- Appends to token's transition history
- Updates `lastStateToken` reference

### 3. Frame-Based Reset System

Every 10 frames, the token is completely reset:

```javascript
if (currentFrame > 0 && currentFrame % 10 === 0) {
  return await this.resetGameStateToken(newState);
}
```

**Purpose**: Prevents token size growth from accumulated transactions

### 4. Broadcast Schedule

- **Interval**: Every 10 seconds
- **Method**: WebSocket broadcast to all connected clients
- **Message Format**:
```javascript
{
  "type": "game:state:token",
  "tokenFlow": "serialized_token_with_transitions",
  "frame": 42,
  "serverInfo": {
    "playerCount": 4,
    "itemCount": 12,
    "timestamp": 1703123456789
  }
}
```

## Performance Optimizations

### 1. Token Reset Strategy
- **Frequency**: Every 10 frames
- **Benefit**: Prevents unbounded transaction history growth
- **Trade-off**: Loses transaction history but maintains current state integrity

### 2. State Hash History
- **Limit**: Last 50 records kept
- **Structure**:
```javascript
{
  "frame": 42,
  "stateHash": "sha256_hash",
  "timestamp": 1703123456789
}
```
- **Purpose**: Performance monitoring and debugging

### 3. Minimal Hashing
- **Data**: Only frame and gameId
- **Benefit**: Fast, consistent hashing
- **Result**: Reduced computational overhead

## Token Verification Process

### Client-Side Verification

```javascript
const result = await tokenService.verifyGameStateToken(tokenFlow);
// Returns:
{
  "verified": true,
  "stateHash": "sha256_hash",
  "timestamp": 1703123456789,
  "frame": 42,
  "gameId": "game-1703123456789"
}
```

### Verification Steps

1. Import token flow without secret (for verification only)
2. Check token validity via blockchain
3. Extract and validate state hash
4. Update local verification state

## Integration Points

### Server-Side Integration

1. **Game Instance**: Provides current game state via `getGameState()`
2. **Client Registry**: Maintains player connection mappings
3. **WebSocket Server**: Handles token broadcasting
4. **Master Server**: Manages game server lifecycle

### Client-Side Integration

1. **Token Service**: Verifies received tokens
2. **Game Client**: Updates local state based on verification
3. **UI Components**: Display verification status
4. **WebSocket Client**: Receives token broadcasts

## Security Considerations

### Token Integrity
- Cryptographic signatures ensure token authenticity
- Blockchain verification prevents tampering
- State hashes provide content integrity

### Access Control
- Token verification doesn't require ownership
- Empty secret parameter for public verification
- Separate token pools for game tokens vs state tokens

## Known Limitations

1. **History Loss**: Token resets every 10 frames lose transaction history
2. **Minimal State**: Only frame and gameId are cryptographically verified
3. **Synchronization**: Full game state relies on WebSocket reliability
4. **Scalability**: State hash history limited to 50 records

## Future Improvements

1. **Merkle Trees**: Hash complete game state efficiently
2. **Compression**: Reduce token size for network efficiency
3. **Selective Updates**: Only broadcast changed state components
4. **Persistent History**: Archive token history before resets

## Conclusion

The UniQuake game state token system balances blockchain integrity with real-time performance requirements. By hashing only essential state components and implementing periodic resets, the system maintains verifiability while preventing performance degradation. The architecture supports both server authority and client verification, enabling a trustless gaming environment within the Unicity framework.