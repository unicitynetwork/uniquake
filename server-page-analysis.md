# Server Page Analysis Report

## Overview

The server page (`server.html`) is a browser-based interface that acts as a proxy controller for a dedicated Quake server process. 
It does not run the Quake server directly in the browser, but rather communicates with a remote dedicated server through the master 
server using WebSocket connections.

## Architecture

### Connection Flow
1. **Browser → Master Server**: WebSocket connection for control and signaling
2. **Master Server → Dedicated Server**: Process management and RCON forwarding
3. **Dedicated Server → Master Server → Browser**: Status updates and RCON responses

### Key Components
- **server.html**: Browser interface with embedded JavaScript
- **Master Server**: WebSocket server that manages dedicated server processes
- **Dedicated Server**: Node.js Quake server process (ioq3ded.js)

## Initialization Process

### 1. Page Load Sequence
```javascript
window.addEventListener('load', async () => {
  setupUIHandlers();
  await connectToMasterServer();
  initQuakeGame();
});
```

### 2. Master Server Connection
- Connects to WebSocket server at configured master server URL
- Default: `ws://localhost:27950` (can be overridden via URL parameter)
- Handles connection lifecycle with automatic reconnection
- Stores connection in global `serverConnection` variable

### 3. Server Registration Process
The server page acts as a "browser server" that registers with the master:
- Sends `register_server` message with server info
- Receives `server_registered` confirmation with peer ID
- Starts sending heartbeats every 30 seconds
- Updates UI to show "Registered" status

### 4. Dedicated Server Startup
Instead of running Quake in an iframe, it requests a remote server:
```javascript
startRemoteServer() {
  // Sends start_game_server message to master
  // Master spawns dedicated server process
  // Returns gameId for tracking
}
```

## Communication Protocol

### Message Types Sent to Master Server

1. **Server Management**
   - `register_server`: Register as a game server
   - `unregister_server`: Unregister from master
   - `heartbeat`: Keep-alive signal with server info
   - `update_server`: Update server name/info

2. **Dedicated Server Control**
   - `start_game_server`: Request to spawn dedicated server
   - `stop_game_server`: Stop dedicated server process
   - `rcon_command`: Execute RCON command on dedicated server

3. **Client Management**
   - `proxy_connection`: Accept client connection
   - `proxy_data`: Forward data to/from clients
   - `kick_client`: Disconnect a client

4. **Token/Game State**
   - `game:state:token`: Broadcast game state tokens
   - `request_scores`: Get current match scores

### Message Types Received from Master Server

1. **Connection Status**
   - `connected`: Initial connection confirmation
   - `server_registered`: Registration successful
   - `heartbeat_ack`: Heartbeat acknowledged

2. **Client Events**
   - `connection_request`: New client wants to connect
   - `proxy_data`: Data from connected client
   - `client_disconnected`: Client left

3. **Server Events**
   - `game_server_started`: Dedicated server is running
   - `game_server_stopped`: Dedicated server stopped
   - `rcon_response`: RCON command output
   - `server_list`: List of active servers

## Game State Management

### 1. Player Statistics Updates
- Polls dedicated server via RCON every 5 seconds
- Executes `status` command for player list and scores
- Executes `serverinfo` for server configuration
- Parses fixed-width RCON output format
- Stores in `latestPlayerScores` for distribution

### 2. Match Control System
- Monitors match progress via RCON polling
- Detects match end conditions:
  - Time limit reached
  - Frag limit reached
  - Manual "End Match" button
- Initiates 30-second restart countdown // Currently disabled
- Handles automatic server restart cycle // Currently disabled

### 3. Game State Tokens
- Creates blockchain-verifiable state tokens
- Token creation process:
  ```javascript
  createGameStateToken() {
    // Gather current game state
    // Create token with Unicity service
    // Broadcast to all clients
  }
  ```
- Broadcasts tokens every 10 seconds
- Resets tokens every 10 frames for performance
- Includes: gameId, frame, timestamp, player states

### 4. Token Entry System
- Requires entry fee tokens from connecting clients
- Validates tokens via Unicity service
- Stores collected fees for winner distribution
- Prevents double-spending with transaction tracking

## RCON (Remote Console) System

### 1. Command Execution
```javascript
sendRCONCommand(command) {
  // Generate unique request ID
  // Send via master server proxy
  // Wait for response with timeout
}
```

### 2. Common RCON Commands
- `status`: Get player list with scores
- `serverinfo`: Get server configuration
- `kick <slot>`: Kick player by slot number
- `say <message>`: Server-wide message
- `map <mapname>`: Change map
- `fraglimit <n>`: Set frag limit
- `timelimit <n>`: Set time limit

### 3. Response Parsing
- Handles multi-line RCON output
- Parses player status lines (fixed-width format)
- Extracts: slot, score, ping, name, IP info
- Updates UI with parsed data

## Client Connection Management

### 1. Connection Flow
- Client requests connection via master server
- Server receives `connection_request` with client ID
- Server accepts via `proxy_connection` response
- All client data flows through master server proxy

### 2. Client State Tracking
```javascript
serverState.clients = new Map() // clientId -> client info
// Tracks: id, username, pubkey, entryTokenReceived, scores
```

### 3. Client Communication
- Chat messages forwarded via proxy
- Game state tokens broadcast to all
- Individual messages via `proxy_data`
- Kick functionality with reason

## Match End and Reward Distribution

### 1. Match End Detection
- Automatic: Time/frag limit via RCON polling
- Manual: "End Match and Pay Rewards" button
- Triggers reward distribution process

### 2. Score Finalization
```javascript
handleGameOver() {
  // Get fresh scores from RCON
  // Stop match control
  // Distribute rewards
  // Start restart countdown
}
```

### 3. Reward Distribution
- Uses latest RCON scores for accuracy
- Determines winners by highest score
- Distributes collected entry fees
- Records distribution to prevent duplicates
- Shows results overlay on UI

### 4. Server Restart Cycle // Currently disabled
- 30-second countdown after match end
- Automatic server restart
- Clients auto-reconnect
- New match begins with fresh state

## UI Components and Updates

### 1. Status Displays
- Server status (registered/unregistered)
- Dedicated server state (running/stopped)
- Connected clients list
- Player statistics table
- Match timer and limits

### 2. Control Elements
- Server name input with update button
- "End Match and Pay Rewards" button
- Client action buttons (kick, message)
- Token information display

### 3. Real-time Updates
- WebSocket message handlers update UI
- Periodic RCON polls refresh stats
- Client connect/disconnect events
- Match progress and countdown timers

## Error Handling and Recovery

### 1. Connection Management
- Automatic reconnection to master server
- Heartbeat monitoring for liveness
- Graceful handling of disconnections

### 2. RCON Timeouts
- 10-second timeout on commands
- Retry logic for critical commands
- Error reporting in UI logs

### 3. Token Validation
- Verifies entry tokens before acceptance
- Handles invalid token rejections
- Tracks spending to prevent reuse

## Security Considerations

### 1. Authentication
- Server identity via Unicity tokens
- Client identity verification
- Entry fee validation

### 2. Access Control
- RCON commands restricted to server page
- Client actions validated server-side
- Token operations cryptographically secured

### 3. Data Validation
- Input sanitization for server names
- RCON output parsing safety
- Message size limits

## Key Global Variables

```javascript
// WebSocket connection to master server
let serverConnection = null;

// Current server configuration
let currentServerName = "";
let dedicatedServerInfo = null;

// Server state tracking
const serverState = {
  registered: false,
  clients: new Map(),
  collectedFees: [],
  gameStateInterval: null,
  restartCycle: null
};

// Latest player scores from RCON
let latestPlayerScores = {
  players: [],
  lastUpdate: null
};

// Match control state
let matchEndDetection = null;
let gameEnded = false;
```

## Summary

The server page provides a complete browser-based interface for managing a dedicated Quake server. It handles:

1. **Server Lifecycle**: Start, stop, register, heartbeat
2. **Player Management**: Connect, disconnect, kick, track
3. **Match Control**: Limits, timing, restart cycles
4. **Token System**: Entry fees, game state, rewards
5. **RCON Integration**: Commands, status, statistics
6. **UI Updates**: Real-time status, controls, displays

All functionality operates through WebSocket proxy to the master server, which manages the actual dedicated server process. This architecture allows browser-based server management while maintaining full game server capabilities.