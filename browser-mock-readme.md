# UniQuake Browser Mock Implementation

This implementation provides browser-compatible mock clients and servers for testing the P2P networking and token management framework.

## Components

The browser implementation consists of:

1. **UniQuakeTokenService** - Browser-compatible token management service
2. **BrowserMockClient** - Client implementation for browser environment
3. **BrowserMockServer** - Server implementation for browser environment 
4. **BrowserMockGame** - Mock game implementation for testing
5. **GameIntegration** - Connects the game with the token service and networking
6. **P2PConnection** - WebRTC/WebSocket connection wrapper

## Running the Implementation

### Using NPM Scripts

The easiest way to run the browser mock implementation is using the provided npm scripts:

1. Install dependencies if you haven't already:
```
npm install
```

2. Start both the master server and web server in one command:
```
npm run start-browser-mocks
```

3. Open the client in your browser:
```
http://localhost:8080/client
```

4. Open the server in your browser (in a different window or tab):
```
http://localhost:8080/server
```

### Manual Setup

If you prefer to run the servers separately:

1. Start the master server:
```
npm run master
```
or
```
node bin/webrtc-master.js
```

2. Start the web server:
```
npm run browser-mock
```
or
```
node bin/web.js --config ./bin/web.json
```

3. Open the client and server in your browser as described above.

## Using the Mock Client

The mock client provides:

- Server list retrieval and connection
- Chat messaging
- Game state visualization
- Token management (minting, sending, verifying)
- WebRTC P2P connections with WebSocket fallback

## Using the Mock Server

The mock server provides:

- Registration with master server
- Client connection management
- Game state broadcasting
- Token collection and distribution
- Game state token verification

## Transport Adapters

The implementation includes two transport adapters:

1. **WebRTC Adapter** - Uses WebRTC data channels for P2P connections
2. **WebSocket Fallback** - Uses WebSocket proxy via master server for browsers without WebRTC support

The system automatically detects WebRTC support and chooses the appropriate transport.

## Integration with Real Quake Game

The same components can be used to integrate with the actual Quake game in the browser by:

1. Connecting the token service to the game's state management
2. Using the P2P connection for game data transport
3. Implementing the necessary hooks in the game code to support token functionality

## Testing

The mock implementation provides a complete testing environment for the P2P networking and token management framework without requiring the full Quake game.

## Architecture

The system follows a modular architecture:

```
+--------------------+    +------------------+    +----------------+
| BrowserMockClient  |<-->| P2P Connection   |<-->| Master Server  |
+--------------------+    +------------------+    +----------------+
         ^                                               ^
         |                                               |
         v                                               v
+--------------------+    +------------------+    +----------------+
| Token Service      |<-->| Game Integration |<-->| BrowserMockServer |
+--------------------+    +------------------+    +----------------+
         ^                        ^
         |                        |
         v                        v
+--------------------+    +------------------+
| Token Management   |<-->| BrowserMockGame |
+--------------------+    +------------------+
```

This architecture allows for flexible transport options and clean separation of concerns between networking, token management, and game logic.