# Remote Delegated Game Server Implementation Plan

## Overview

Note: This is an interim workaround for the sake of quick deployment of the demo. Once this plan is implemented and tested, the demo is demonstrated to the intended parties, we will proceed with proper implementation of the solution running a dedicated server in the browser.

This document outlines the step-by-step implementation plan for modifying the UniQuake system to support delegated remote game server launching. 
For the momenta and as an interim solution, instead of running the Quake dedicated server directly in the browser, the server webpage will request the master server to launch and host a dedicated server instance. This allows for a quick deployment of the PoC.

## Current Architecture

- **Browser Server Page**: Loads game server in an iframe using `/quake?cmdline=+set%20...+dedicated%201`
- **Master Server**: Handles matchmaking but not game server spawning
- **In-Browser Dedicated Server**: Needs innovative solution to be connected automatically to the intended in-browser clients

## Interim Architecture

- **Browser Server Page**: Requests master server to start a dedicated game server
- **Master Server**: Spawns and manages dedicated server processes (via normal system command line calls)
- **Remote Dedicated Server**: Runs natively on the master server's host
- **Unicity Framework**: Continues to handle tokenization and game state tracking

## Implementation Steps

### 1. Master Server Enhancements

1. Create a game server manager module in the master server:
   - Add functionality to spawn dedicated server processes (via system cli) and a method to read their logs for the further analysis
   - Track running game server instances
   - Manage port assignment for each server
   - Handle graceful shutdown of game servers

2. Implement new message handlers in the signaling service:
   - `start_game_server`: Start a new dedicated server
   - `stop_game_server`: Stop a specific dedicated server
   - `get_server_status`: Get status of a specific server

3. Add configuration options for server management:
   - Path to dedicated server executable (ioq3ded.js)
   - Base port number for dedicated servers
   - Maximum number of concurrent servers
   - Default server settings

### 2. Server Webpage Modifications

1. Comment out the existing code for launching in-browser dedicated server
2. Add new UI elements:
   - Server status indicator showing if remote server is running
   - Game ID field (auto-generated)
   - Map selection dropdown
   - Other server configuration options

3. Implement server request functionality:
   - Send `start_game_server` request to master server
   - Handle response with server details (ip, port, etc.)
   - Update UI based on server status (do not show ip and port neither on server, nor on client gui)
   - Implement proper error handling and feedback

4. Modify the server management flow:
   - On "Start Server" click, send request to master
   - On successful launch, track the remote server's status
   - On "Stop Server" click, request server shutdown

5. Integrate with tokenization system (note: master is hosting dedicated game servers on behalf of the server page. Neither server or client pages users should experience a difference):
   - Update game state tracking for remote servers
   - Maintain ability to end game and award tokens (can master read the winner from the remote dedicated game server logs and forward this data to the server page?)

### 3. Game Server Instance Management

1. Implement dedicated server process spawning:
   - Use Node.js child_process to spawn ioq3ded.js instances
   - Configure server with appropriate command-line arguments
   - Set unique ports for each server instance
   - Configure server to report to the master server

2. Add server instance tracking:
   - Create unique game IDs for correlation
   - Track process state, port, map, player count
   - Monitor health through heartbeats
   - Implement automatic cleanup for inactive servers

3. Update server list distribution:
   - Include full connection details in server list
   - Add metadata about game session (game ID, map, etc.)

### 4. Client Connection Updates

1. Modify client code to connect to remote servers:
   - Update connection logic to use server IP and port from list
   - Maintain correlation between game and tokenization system
   - Handle connection errors appropriately

2. Enhance server list display (note: client and server gui should not mention anyhow that the actual game server is being hosted by master server host):
   - Do not show server IP and port
   - Display server status (online, starting, etc.)
   - Show current players and map

### 5. Tokenization Integration

1. Ensure token distribution works with remote servers:
   - Update game state acquisition for remote servers (master server should read the dedicated server logs if possible)
   - If receiving states from master, the server page should include the obtained state into the state token transaction update

2. Adapt game state monitoring:
   - Update UI to reflect remote server state
   - Enable token awarding based on game events (if we can extract this info from the game server logs by the master)

### 6. Testing and Validation

1. Test server spawning:
   - Verify servers start correctly with requested parameters
   - Confirm master server properly tracks spawned instances
   - Test handling of multiple simultaneous game servers

2. Test client connections:
   - Verify clients can connect to spawned servers
   - Ensure game plays correctly
   - Confirm multiple clients can connect to the same server

3. Test tokenization:
   - Verify token distribution works with remote servers
   - Confirm game state tokens are valid
   - Test end-game token awarding

4. Test error handling:
   - Server fails to start
   - Server crashes during gameplay
   - Network connectivity issues
   - Master server restart during active games

## Technical Details

### Game Server Spawn Command

The master server will spawn dedicated servers using a command similar to:

```javascript
const childProcess = require('child_process');

const serverProcess = childProcess.spawn('node', [
  'build/ioq3ded.js',
  '+set', 'fs_game', 'baseq3',
  '+set', 'dedicated', '2',
  '+set', 'sv_master1', 'localhost:27950',
  '+set', 'net_port', port.toString(),
  '+set', 'net_ip', '0.0.0.0',
  '+set', 'sv_hostname', serverName,
  '+map', mapName,
  '+exec', 'server.cfg'
], {
  stdio: 'pipe', // Capture output
  detached: false // Keep process attached for easier management
});
```

### Server-Master Communication Protocol

#### Start Game Server Request
```json
{
  "unicity": true,
  "type": "start_game_server",
  "serverInfo": {
    "name": "Tournament Server #1",
    "gameId": "unique-game-id-123",
    "map": "q3dm1",
    "maxPlayers": 16,
    "private": false
  }
}
```

#### Start Game Server Response
```json
{
  "unicity": true,
  "type": "game_server_started",
  "gameId": "unique-game-id-123",
  "serverInfo": {
    "name": "Tournament Server #1",
    "address": "localhost:27961",
    "map": "q3dm1",
    "maxPlayers": 16
  },
  "success": true
}
```

### Game ID and Server Correlation

To maintain the connection between the Unicity tokenization system and the game server:

1. Generate a unique Game ID for each server instance
2. Include this ID in both the Quake server registration and Unicity server registration
3. Use this ID to correlate events and state between systems

## Implementation Sequence

1. Create the game server manager on the master server
2. Implement the spawning and management logic for the dedicated game servers
3. Add the necessary message handlers to the signaling service
4. Modify the server webpage to request remote server spawning
5. Update clients to connect to remote dedicated game servers
6. Ensure tokenization still works as before
7. Perform comprehensive testing

## Rollback Plan

If issues arise with the remote server implementation:
- Revert to in-browser dedicated server by uncommenting the iframe code
- Add configuration option to choose between remote and in-browser modes
- Document any incompatibilities or limitations discovered
