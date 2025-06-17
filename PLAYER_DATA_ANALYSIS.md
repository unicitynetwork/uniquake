# Player Data Extraction Analysis for UniQuake

## Overview

This document analyzes the feasibility of extracting real player statistics from QuakeJS dedicated servers in the UniQuake system, replacing the current mock game engine data with authentic gameplay information.

## Current State

### Mock Data Source
Currently, player health and score data comes from a **mock game engine** located in:
- **File**: `/home/vrogojin/uniquake/lib/client/browser-mock-game.js`
- **Lines**: 180-186 (health), ~240 (score)

### Mock Data Behavior
1. **Health**: Starts at 100, randomly fluctuates between 0-100 (10% chance per update)
2. **Score**: Starts at 0, randomly increases by 0-10 points (20% chance per update)  
3. **Update Frequency**: Every 10 seconds (configurable via `updateInterval`)

### Mock Code Implementation
```javascript
// Health fluctuation (10% chance)
if (Math.random() < 0.1) {
    player.health = Math.max(0, Math.min(100, player.health + (Math.random() - 0.5) * 40));
}

// Score increase (20% chance)
if (Math.random() < 0.2) {
    this.gameState.score[playerId] = (this.gameState.score[playerId] || 0) + Math.floor(Math.random() * 10);
}
```

## Real Player Data Extraction Analysis

### 1. Available Data from QuakeJS Servers

QuakeJS dedicated servers output comprehensive player information through multiple channels:

#### Server Process Logs (`/logs/game-*.log`)
- Detailed server startup and runtime information
- Player connection events with timestamps
- Game initialization parameters and configuration

#### Game Activity Logs (`/fresh_quakejs/base/baseq3/games.log`)
- Structured game events with timestamps
- Player connections, disconnections, and state changes
- End-of-match statistics and scores

#### Real-time Server Output
Captured via `stdout` from server processes.

### 2. Player Data Formats Available

#### Player Connection Events
```
ClientConnect: 0
ClientUserinfoChanged: 0 n\UnnamedPlayer\t\0\model\sarge\hmodel\sarge\g_redteam\\g_blueteam\\c1\4\c2\5\hc\100\w\0\l\0\tt\0\tl\0
ClientBegin: 0
ClientDisconnect: 0
```

#### Player Statistics at Game End
```
15:00 score: 0  ping: 190  client: 0 UnnamedPlayer
```

#### Real-time Server Messages
```
Client 0 connecting with 200 challenge ping
broadcast: print "UnnamedPlayer^7 connected\n"
broadcast: print "UnnamedPlayer^7 entered the game\n" 
broadcast: print "UnnamedPlayer^7 timed out\n"
```

#### Server Heartbeat Information
```
135:00 Resolving localhost:27950 (IPv4)
136:00 localhost:27950 resolved to 172.29.2.0:27950
137:00 Sending heartbeat to localhost:27950
```

### 3. Existing Infrastructure

#### Current parseServerOutput Implementation
Location: `/home/vrogojin/uniquake/lib/game-server-manager.js` lines 360-391

```javascript
parseServerOutput(gameId, output) {
  const server = this.servers.get(gameId);
  if (!server) return;

  // Update last activity
  server.lastActivity = Date.now();

  // Check for player count info - this is a simplified example
  const playerMatch = output.match(/(\d+) players/i);
  if (playerMatch) {
    const count = parseInt(playerMatch[1]);
    // Update player count in server info
    server.players = Array(count).fill({ dummy: true });
  }

  // Check for map change
  const mapMatch = output.match(/Loading map: (\w+)/i);
  if (mapMatch) {
    server.serverInfo.map = mapMatch[1];
  }

  // Look for player joins/leaves - this is a placeholder
  if (output.includes('connected')) {
    // Placeholder implementation
  }

  if (output.includes('disconnected')) {
    // Placeholder implementation
  }
}
```

#### QuakeJS Master Adapter Integration
Location: `/home/vrogojin/uniquake/lib/quake/master-adapter.js`

- Handles `getservers`, `heartbeat`, `infoResponse` messages
- Integrates with server registry for heartbeat updates
- Uses QuakeJS binary protocol for communication
- Currently does not extract detailed player information

#### QuakeJS Protocol Support
Location: `/home/vrogojin/uniquake/lib/quake-protocol.js`

- `formatOOB()` and `stripOOB()` for out-of-band messages
- `parseInfoString()` for parsing key\value server info
- `buildChallenge()` for server queries
- Supports standard QuakeJS server information exchange

### 4. Integration Points for Real Player Data

#### A. Enhanced parseServerOutput Method (Primary Integration Point)
Location: `/home/vrogojin/uniquake/lib/game-server-manager.js` lines 360-391

This method receives real-time server output and can be enhanced to extract:
- Player connections/disconnections with exact timestamps
- Player names and client IDs
- Ping times and connection quality
- End-of-match scores and statistics

#### B. Master Server Info Response Enhancement
Location: `/home/vrogojin/uniquake/lib/quake/master-adapter.js` line 316-324

The `handleInfoResponse()` method can be extended to include player data in server queries.

#### C. Server Registry Player Tracking
Location: `/home/vrogojin/uniquake/lib/server-registry.js`

Can be enhanced to maintain real-time player lists and statistics.

## Implementation Strategy

### Phase 1: Enhanced Log Parsing (Immediate)

Replace basic parsing with comprehensive player data extraction:

```javascript
// Enhanced parseServerOutput implementation
parseServerOutput(gameId, output) {
  const server = this.servers.get(gameId);
  if (!server) return;

  server.lastActivity = Date.now();

  // Parse ClientConnect events
  const connectMatch = output.match(/ClientConnect: (\d+)/);
  if (connectMatch) {
    const clientId = parseInt(connectMatch[1]);
    this.addPlayer(gameId, clientId);
  }

  // Parse ClientUserinfoChanged for player details
  const userinfoMatch = output.match(/ClientUserinfoChanged: (\d+) (.+)/);
  if (userinfoMatch) {
    const clientId = parseInt(userinfoMatch[1]);
    const userinfo = this.parseUserinfo(userinfoMatch[2]);
    this.updatePlayer(gameId, clientId, userinfo);
  }

  // Parse ClientDisconnect events
  const disconnectMatch = output.match(/ClientDisconnect: (\d+)/);
  if (disconnectMatch) {
    const clientId = parseInt(disconnectMatch[1]);
    this.removePlayer(gameId, clientId);
  }

  // Parse end-of-match scores
  const scoreMatch = output.match(/score: (\d+)\s+ping: (\d+)\s+client: (\d+) (.+)/);
  if (scoreMatch) {
    const [, score, ping, clientId, playerName] = scoreMatch;
    this.recordPlayerStats(gameId, {
      clientId: parseInt(clientId),
      score: parseInt(score),
      ping: parseInt(ping),
      name: playerName.trim()
    });
  }

  // Parse real-time health/damage events
  const healthMatch = output.match(/Client (\d+) health: (\d+)/);
  if (healthMatch) {
    const [, clientId, health] = healthMatch;
    this.updatePlayerHealth(gameId, parseInt(clientId), parseInt(health));
  }

  // Parse kill/death events
  const killMatch = output.match(/Kill: (\d+) (\d+) (\d+): (.+) killed (.+)/);
  if (killMatch) {
    const [, killer, victim, weapon, killerName, victimName] = killMatch;
    this.recordKill(gameId, {
      killer: parseInt(killer),
      victim: parseInt(victim),
      weapon: parseInt(weapon),
      killerName,
      victimName
    });
  }
}
```

#### Supporting Methods to Add:

```javascript
// Add to GameServerManager class
addPlayer(gameId, clientId) {
  const server = this.servers.get(gameId);
  if (!server) return;
  
  server.players[clientId] = {
    id: clientId,
    name: 'Unknown',
    score: 0,
    health: 100,
    ping: 0,
    connectTime: Date.now(),
    kills: 0,
    deaths: 0
  };
}

updatePlayer(gameId, clientId, userinfo) {
  const server = this.servers.get(gameId);
  if (!server || !server.players[clientId]) return;
  
  const player = server.players[clientId];
  player.name = userinfo.name || player.name;
  player.team = userinfo.team;
  player.model = userinfo.model;
}

updatePlayerHealth(gameId, clientId, health) {
  const server = this.servers.get(gameId);
  if (!server || !server.players[clientId]) return;
  
  server.players[clientId].health = health;
  this.broadcastPlayerUpdate(gameId, clientId);
}

recordPlayerStats(gameId, stats) {
  const server = this.servers.get(gameId);
  if (!server || !server.players[stats.clientId]) return;
  
  const player = server.players[stats.clientId];
  player.score = stats.score;
  player.ping = stats.ping;
  player.name = stats.name;
}

parseUserinfo(userinfoString) {
  // Parse QuakeJS userinfo string format: n\name\t\team\model\sarge...
  const pairs = userinfoString.split('\\');
  const userinfo = {};
  
  for (let i = 0; i < pairs.length - 1; i += 2) {
    const key = pairs[i];
    const value = pairs[i + 1];
    userinfo[key] = value;
  }
  
  return {
    name: userinfo.n,
    team: userinfo.t,
    model: userinfo.model,
    headModel: userinfo.hmodel
  };
}
```

### Phase 2: Real-time Player API (Next)

Add comprehensive player data API to GameServerManager:

```javascript
// Add to GameServerManager class

/**
 * Get all connected players for a server
 * @param {string} gameId - Game ID
 * @returns {Array} Array of player objects
 */
getPlayerList(gameId) {
  const server = this.servers.get(gameId);
  if (!server) return [];
  
  return Object.values(server.players || {});
}

/**
 * Get specific player statistics
 * @param {string} gameId - Game ID
 * @param {number} clientId - Client ID
 * @returns {Object|null} Player stats or null
 */
getPlayerStats(gameId, clientId) {
  const server = this.servers.get(gameId);
  if (!server || !server.players[clientId]) return null;
  
  return {
    ...server.players[clientId],
    uptime: Date.now() - server.players[clientId].connectTime
  };
}

/**
 * Get comprehensive server player data
 * @param {string} gameId - Game ID
 * @returns {Object} Complete server player information
 */
getServerPlayerData(gameId) {
  const server = this.servers.get(gameId);
  if (!server) return null;
  
  const players = this.getPlayerList(gameId);
  
  return {
    gameId,
    playerCount: players.length,
    maxPlayers: server.serverInfo.maxPlayers,
    players: players,
    serverUptime: Date.now() - server.startTime,
    lastActivity: server.lastActivity
  };
}

/**
 * Broadcast player update to connected clients
 * @param {string} gameId - Game ID
 * @param {number} clientId - Client ID (optional, broadcasts all if not specified)
 */
broadcastPlayerUpdate(gameId, clientId = null) {
  // Emit event that can be caught by server registry or signaling service
  this.emit('playerUpdate', {
    gameId,
    clientId,
    playerData: clientId ? this.getPlayerStats(gameId, clientId) : this.getServerPlayerData(gameId)
  });
}
```

### Phase 3: Live Data Integration (Final)

#### Replace Mock Game Engine

1. **Update browser-mock-game.js**:
   - Replace random data generation with real server data API calls
   - Connect to GameServerManager player data streams
   - Maintain same interface for backward compatibility

2. **Enhance Server Registry**:
   - Store real-time player data alongside server information
   - Broadcast player updates via WebRTC/WebSocket connections
   - Include player data in server list responses

3. **Update UI Components**:
   - Modify `client.html` and `server.html` to display real player statistics
   - Add real-time player list updates
   - Show authentic game state verification using actual server data

#### Integration with Existing Systems

```javascript
// In server-registry.js - add player data tracking
updateServerPlayerData(peerId, playerData) {
  const server = this.servers[peerId];
  if (!server) return;
  
  server.playerData = playerData;
  server.lastPlayerUpdate = Date.now();
  
  // Broadcast to connected clients
  this.emit('serverPlayerUpdate', {
    peerId,
    playerData
  });
}

// In signaling-service.js - broadcast player updates
handlePlayerUpdate(data) {
  // Broadcast player data updates to connected clients
  this.broadcast({
    type: 'player_data_update',
    gameId: data.gameId,
    playerData: data.playerData
  });
}
```

## Benefits of Real Player Data Integration

### 1. Authentic Gameplay Experience
- **Real player statistics** instead of mock random data
- **Accurate game state** reflecting actual QuakeJS server status
- **Live player tracking** across multiple dedicated servers

### 2. Enhanced Multiplayer Features
- **Real-time player lists** with actual connection status
- **Authentic scoring systems** based on actual game performance
- **Live leaderboards** and statistics tracking

### 3. Improved Verification System
- **Game state verification** using actual server data
- **Player data consistency** between client and server
- **Authentic token verification** based on real gameplay

### 4. Better Server Management
- **Live server monitoring** with real player counts
- **Performance tracking** based on actual server load
- **Automatic scaling** based on real player activity

## Technical Considerations

### 1. Performance Impact
- **Log parsing overhead**: Real-time parsing of server output
- **Memory usage**: Storing player data for multiple servers
- **Network traffic**: Broadcasting player updates to clients

### 2. Reliability
- **Server crashes**: Handle graceful degradation when servers fail
- **Data persistence**: Consider storing player statistics
- **Error handling**: Robust parsing of variable server output formats

### 3. Scalability
- **Multiple servers**: Handle player data from many concurrent servers
- **High player counts**: Efficient data structures for large player lists
- **Update frequency**: Balance real-time updates with performance

## Migration Path

### 1. Backward Compatibility
- Maintain existing mock game engine as fallback
- Gradual migration with feature flags
- Preserve existing API interfaces

### 2. Testing Strategy
- Unit tests for log parsing functions
- Integration tests with real QuakeJS servers
- Performance testing with multiple concurrent servers

### 3. Deployment Strategy
- Phase 1: Enhanced log parsing (no UI changes)
- Phase 2: Real-time API (internal data improvements)
- Phase 3: UI integration (user-visible improvements)

## Conclusion

The UniQuake system has excellent infrastructure for extracting real player data from QuakeJS dedicated servers. The transition from mock to authentic player statistics is not only feasible but would significantly enhance the gaming experience while maintaining all existing token verification and WebRTC functionality.

The comprehensive player data available from QuakeJS servers, combined with the existing log capture and parsing infrastructure, provides a solid foundation for implementing real-time player statistics and authentic gameplay verification.

**Recommendation**: Proceed with Phase 1 implementation to begin capturing real player data, followed by gradual integration with the existing UI and verification systems.