# UniQuake Browser API Interface

This document outlines the API interface for the browser-compatible implementation of the UniQuake token integration. The API will enable the creation of web client and server pages that can connect to the same master server as our Node.js implementations, while maintaining all token functionality.

## Core Components

The browser implementation will consist of the following core components:

1. **UniQuakeTokenService** - Browser-compatible token management service
2. **BrowserGameClient** - Client implementation for browser environment
3. **BrowserGameServer** - Server implementation for browser environment 
4. **P2PConnection** - WebRTC/WebSocket connection wrapper
5. **MasterServerConnector** - Interface to the master server
6. **GameIntegration** - Interface for actual game integration
7. **MockGame** - Mock game implementation for testing

## 1. UniQuakeTokenService API

```javascript
class UniQuakeTokenService {
  /**
   * Create a new token service instance
   * @param {Object} config - Configuration options
   * @param {string} [config.secret] - Secret key (generated if not provided)
   * @param {string} [config.username] - Username (generated if not provided)
   * @param {string} [config.gateway] - Unicity gateway URL (uses default if not provided)
   */
  constructor(config = {});

  /**
   * Initialize the token service asynchronously
   * @returns {Promise<boolean>} - Whether initialization succeeded
   */
  async init();

  /**
   * Get identity information
   * @returns {Object} - Contains username and pubkey
   */
  getIdentity();

  /**
   * Mint new tokens
   * @param {number} [count=1] - Number of tokens to mint
   * @param {string} [value='1'] - Value for each token
   * @returns {Promise<Array>} - Array of minted tokens
   */
  async mintCoins(count, value);

  /**
   * Send an entry token to join a game
   * @param {string} recipientPubkey - Recipient's public key
   * @returns {Promise<Object>} - Token flow for transmission
   */
  async sendEntryToken(recipientPubkey);

  /**
   * Process a received token
   * @param {Object|string} tokenFlow - Token flow to process
   * @returns {Promise<Object>} - Result of token processing
   */
  async receiveToken(tokenFlow);

  /**
   * Get list of spendable tokens
   * @param {string} tokenClassId - Token class ID to filter by
   * @returns {Promise<Array>} - Array of spendable tokens
   */
  async getSpendableTokens(tokenClassId);

  /**
   * Create a game state token
   * @param {Object} gameState - Game state to tokenize
   * @returns {Promise<Object>} - Created state token
   */
  async createGameStateToken(gameState);

  /**
   * Update an existing game state token
   * @param {Object} stateToken - Current state token
   * @param {Object} newState - New game state
   * @returns {Promise<Object>} - Updated token
   */
  async updateGameStateToken(stateToken, newState);

  /**
   * Verify a game state token
   * @param {Object} tokenFlow - Token flow to verify
   * @returns {Promise<Object>} - Verification result
   */
  async verifyGameStateToken(tokenFlow);

  /**
   * Verify if local game state matches the verified state
   * @param {Object} localState - Local game state to verify
   * @returns {boolean} - True if state matches
   */
  verifyLocalGameState(localState);

  /**
   * Get token status and inventory information
   * @returns {Object} - Status of token pool and game state
   */
  getTokenStatus();

  /**
   * Send tokens to a recipient (for reward distribution)
   * @param {Array} tokens - Array of tokens to send
   * @param {string} recipientPubkey - Recipient's public key
   * @returns {Promise<Array>} - Array of token flows
   */
  async sendTokensToRecipient(tokens, recipientPubkey);
}
```

## 2. BrowserGameClient API

```javascript
class BrowserGameClient {
  /**
   * Create a new browser game client
   * @param {Object} config - Client configuration
   * @param {string} [config.masterServer='localhost:27950'] - Master server address
   * @param {string} [config.playerName='Player'] - Player name
   * @param {boolean} [config.autoConnect=false] - Whether to auto-connect to a server
   * @param {string} [config.autoConnectId=null] - Server ID to auto-connect to
   * @param {number} [config.mintTokens=0] - Number of tokens to mint at startup
   * @param {Function} [config.onStatusUpdate] - Callback for status updates
   * @param {Function} [config.onChatMessage] - Callback for chat messages
   * @param {Function} [config.onConnectionChange] - Callback for connection state changes
   * @param {Function} [config.onTokenUpdate] - Callback for token state updates
   * @param {Function} [config.onGameStateVerification] - Callback for game state verification
   */
  constructor(config = {});

  /**
   * Initialize the client and connect to master server
   * @returns {Promise<boolean>} - Whether initialization succeeded
   */
  async init();

  /**
   * Connect to the master server
   * @returns {Promise<boolean>} - Whether connection succeeded
   */
  async connectToMasterServer();

  /**
   * Request server list from master server
   * @returns {Promise<Array>} - List of available servers
   */
  async requestServerList();

  /**
   * Connect to a game server
   * @param {string} peerId - Server peer ID
   * @returns {Promise<boolean>} - Whether connection succeeded
   */
  async connectToServer(peerId);

  /**
   * Disconnect from the current server
   * @returns {Promise<boolean>} - Whether disconnection succeeded
   */
  async disconnect();

  /**
   * Send a chat message to the server
   * @param {string} message - Message to send
   * @returns {boolean} - Whether message was sent
   */
  sendChatMessage(message);

  /**
   * Send a ping to the server
   * @returns {Promise<number>} - Ping time in milliseconds
   */
  async ping();

  /**
   * Get client status information
   * @returns {Object} - Client status
   */
  getStatus();

  /**
   * Get chat history
   * @param {number} [limit=50] - Maximum number of messages to return
   * @returns {Array} - Chat history
   */
  getChatHistory(limit);

  /**
   * Mint new tokens
   * @param {number} [count=1] - Number of tokens to mint
   * @returns {Promise<Array>} - Minted tokens
   */
  async mintTokens(count);

  /**
   * Get token inventory
   * @returns {Object} - Token inventory information
   */
  getTokenInventory();

  /**
   * Request game state verification
   * @returns {Promise<Object>} - Verification result
   */
  async verifyGameState();

  /**
   * Set event handler
   * @param {string} event - Event name
   * @param {Function} handler - Event handler
   */
  on(event, handler);

  /**
   * Remove event handler
   * @param {string} event - Event name
   * @param {Function} handler - Event handler
   */
  off(event, handler);
}
```

## 3. BrowserGameServer API

```javascript
class BrowserGameServer {
  /**
   * Create a new browser game server
   * @param {Object} config - Server configuration
   * @param {string} [config.masterServer='localhost:27950'] - Master server address
   * @param {string} [config.serverName='Browser Game Server'] - Server name
   * @param {string} [config.map='browser_map'] - Map name
   * @param {number} [config.maxPlayers=8] - Maximum number of players
   * @param {boolean} [config.requireEntryToken=true] - Whether to require entry token
   * @param {number} [config.stateTokenInterval=10000] - Interval for game state token updates
   * @param {Function} [config.onClientConnect] - Callback for client connections
   * @param {Function} [config.onClientDisconnect] - Callback for client disconnections
   * @param {Function} [config.onChatMessage] - Callback for chat messages
   * @param {Function} [config.onStatusUpdate] - Callback for status updates
   */
  constructor(config = {});

  /**
   * Initialize the server and register with master server
   * @returns {Promise<boolean>} - Whether initialization succeeded
   */
  async init();

  /**
   * Connect to the master server
   * @returns {Promise<boolean>} - Whether connection succeeded
   */
  async connectToMasterServer();

  /**
   * Register server with master server
   * @returns {Promise<boolean>} - Whether registration succeeded
   */
  async registerServer();

  /**
   * Unregister server from master server
   * @returns {Promise<boolean>} - Whether unregistration succeeded
   */
  async unregisterServer();

  /**
   * Broadcast a message to all connected clients
   * @param {Object} message - Message to broadcast
   * @returns {boolean} - Whether broadcast succeeded
   */
  broadcast(message);

  /**
   * Send a message to a specific client
   * @param {string} clientId - Client ID
   * @param {Object} message - Message to send
   * @returns {boolean} - Whether message was sent
   */
  sendToClient(clientId, message);

  /**
   * Kick a client from the server
   * @param {string} clientId - Client ID
   * @param {string} reason - Reason for kick
   * @returns {boolean} - Whether kick succeeded
   */
  kickClient(clientId, reason);

  /**
   * Get server status information
   * @returns {Object} - Server status
   */
  getStatus();

  /**
   * Get list of connected clients
   * @returns {Array} - List of connected clients
   */
  getClients();

  /**
   * End the game and distribute tokens to winner
   * @param {string} winnerId - ID of the winning client
   * @returns {Promise<boolean>} - Whether game end succeeded
   */
  async endGame(winnerId);

  /**
   * Generate a game state token
   * @returns {Promise<Object>} - Generated token
   */
  async generateGameStateToken();

  /**
   * Start periodic game state verification
   * @param {number} [intervalMs=10000] - Interval in milliseconds
   */
  startStateVerification(intervalMs);

  /**
   * Stop periodic game state verification
   */
  stopStateVerification();

  /**
   * Set event handler
   * @param {string} event - Event name
   * @param {Function} handler - Event handler
   */
  on(event, handler);

  /**
   * Remove event handler
   * @param {string} event - Event name
   * @param {Function} handler - Event handler
   */
  off(event, handler);
}
```

## 4. P2PConnection API

```javascript
class P2PConnection {
  /**
   * Create a new P2P connection
   * @param {Object} config - Connection configuration
   * @param {string} [config.connectionId] - Connection ID
   * @param {Object} [config.rtcConfig] - WebRTC configuration
   * @param {boolean} [config.useWebSocket=true] - Whether to use WebSocket fallback
   * @param {Function} [config.onOpen] - Callback for connection open
   * @param {Function} [config.onMessage] - Callback for incoming messages
   * @param {Function} [config.onClose] - Callback for connection close
   * @param {Function} [config.onError] - Callback for errors
   */
  constructor(config = {});

  /**
   * Connect to a peer
   * @param {Object} signaling - Signaling channel
   * @param {string} peerId - Peer ID to connect to
   * @returns {Promise<boolean>} - Whether connection succeeded
   */
  async connect(signaling, peerId);

  /**
   * Close the connection
   */
  close();

  /**
   * Send a message
   * @param {Object|string} message - Message to send
   * @returns {boolean} - Whether message was sent
   */
  send(message);

  /**
   * Check if the connection is open
   * @returns {boolean} - Whether the connection is open
   */
  isOpen();

  /**
   * Get connection information
   * @returns {Object} - Connection information
   */
  getConnectionInfo();

  /**
   * Set event handler
   * @param {string} event - Event name
   * @param {Function} handler - Event handler
   */
  on(event, handler);

  /**
   * Remove event handler
   * @param {string} event - Event name
   * @param {Function} handler - Event handler
   */
  off(event, handler);
}
```

## 5. MasterServerConnector API

```javascript
class MasterServerConnector {
  /**
   * Create a new master server connector
   * @param {Object} config - Connector configuration
   * @param {string} [config.masterServer='localhost:27950'] - Master server address
   * @param {Function} [config.onConnect] - Callback for connection
   * @param {Function} [config.onDisconnect] - Callback for disconnection
   * @param {Function} [config.onError] - Callback for errors
   * @param {Function} [config.onMessage] - Callback for incoming messages
   */
  constructor(config = {});

  /**
   * Connect to the master server
   * @returns {Promise<boolean>} - Whether connection succeeded
   */
  async connect();

  /**
   * Disconnect from the master server
   */
  disconnect();

  /**
   * Send a message to the master server
   * @param {Object} message - Message to send
   * @returns {boolean} - Whether message was sent
   */
  send(message);

  /**
   * Check if connected to the master server
   * @returns {boolean} - Whether connected
   */
  isConnected();

  /**
   * Set event handler
   * @param {string} event - Event name
   * @param {Function} handler - Event handler
   */
  on(event, handler);

  /**
   * Remove event handler
   * @param {string} event - Event name
   * @param {Function} handler - Event handler
   */
  off(event, handler);
}
```

## Message Protocol

The browser implementation will use the same message protocol as the Node.js implementation:

### Client to Master Server Messages
- `get_servers` - Request server list
- `connect_to_server` - Request connection to a server
- `disconnect_from_server` - Request disconnection from a server
- `connection_success` - Confirm successful connection
- `proxy_message` - Proxy a message to a server

### Master Server to Client Messages
- `connected` - Confirm connection to master server
- `server_list` - List of available servers
- `proxy_connection` - Connection established to server
- `proxy_data` - Data from server
- `server_disconnected` - Server disconnected
- `disconnect_ack` - Disconnection acknowledged
- `error` - Error message

### Client to Server Messages
- `chat` - Chat message
- `ping` - Ping request
- `token:entry` - Send entry token
- `identity:update` - Update client identity
- `request:game:state:token` - Request game state token

### Server to Client Messages
- `welcome` - Welcome message with server info
- `chat` - Chat message
- `pong` - Ping response
- `kick` - Kick message
- `token:entry:ack` - Entry token acknowledgment
- `token:reward` - Reward tokens
- `identity:update:ack` - Identity update acknowledgment
- `game:state:token` - Game state token

## Event System

Both client and server classes will implement an event system with the following events:

### Client Events
- `connect` - Connected to master server
- `disconnect` - Disconnected from master server
- `serverList` - Received server list
- `serverConnect` - Connected to a game server
- `serverDisconnect` - Disconnected from a game server
- `chat` - Received chat message
- `ping` - Ping response
- `tokenUpdate` - Token state updated
- `gameStateVerification` - Game state verification result
- `error` - Error

### Server Events
- `connect` - Connected to master server
- `disconnect` - Disconnected from master server
- `clientConnect` - Client connected
- `clientDisconnect` - Client disconnected
- `chat` - Received chat message
- `tokenEntry` - Received entry token
- `gameStateUpdate` - Game state updated
- `error` - Error

## 6. GameIntegration API

```javascript
class GameIntegration {
  /**
   * Create a new game integration
   * @param {Object} config - Integration configuration
   * @param {Object} [config.client] - Reference to BrowserGameClient instance
   * @param {Object} [config.server] - Reference to BrowserGameServer instance
   * @param {Function} [config.onGameStateUpdate] - Callback for game state updates
   * @param {Function} [config.onTokenEvent] - Callback for token-related events
   * @param {Function} [config.onPlayerJoin] - Callback for player join events
   * @param {Function} [config.onPlayerLeave] - Callback for player leave events
   * @param {Function} [config.onGameEnd] - Callback for game end
   */
  constructor(config = {});

  /**
   * Initialize the game integration
   * @param {Object} game - Reference to the actual game instance
   * @returns {Promise<boolean>} - Whether initialization succeeded
   */
  async init(game);

  /**
   * Get the current game state
   * @returns {Object} - Game state object
   */
  getGameState();

  /**
   * Update the token service with new game state
   * @param {Object} gameState - New game state
   * @returns {Promise<Object>} - Updated state token
   */
  async updateGameState(gameState);

  /**
   * Handle player join with token verification
   * @param {string} playerId - Player ID
   * @param {Object} tokenFlow - Token flow for validation
   * @returns {Promise<boolean>} - Whether join is allowed
   */
  async handlePlayerJoin(playerId, tokenFlow);

  /**
   * Handle player leave
   * @param {string} playerId - Player ID
   * @returns {Promise<void>}
   */
  async handlePlayerLeave(playerId);

  /**
   * End game and distribute tokens to winner
   * @param {string} winnerId - ID of the winning player
   * @returns {Promise<Object>} - Results of token distribution
   */
  async endGame(winnerId);

  /**
   * Verify game state token
   * @param {Object} tokenFlow - Token flow to verify
   * @returns {Promise<Object>} - Verification result
   */
  async verifyGameStateToken(tokenFlow);

  /**
   * Register an event handler
   * @param {string} event - Event name
   * @param {Function} handler - Event handler
   */
  on(event, handler);

  /**
   * Remove an event handler
   * @param {string} event - Event name
   * @param {Function} handler - Event handler
   */
  off(event, handler);
}
```

## 7. MockGame API

```javascript
class MockGame {
  /**
   * Create a new mock game instance
   * @param {Object} config - Mock game configuration
   * @param {boolean} [config.isServer=false] - Whether this is a server instance
   * @param {number} [config.updateInterval=1000] - Game state update interval in ms
   * @param {number} [config.playerCount=0] - Number of mock players to create
   * @param {Function} [config.onStateChange] - Callback for state changes
   */
  constructor(config = {});

  /**
   * Initialize the mock game
   * @returns {Promise<boolean>} - Whether initialization succeeded
   */
  async init();

  /**
   * Start the mock game simulation
   * @returns {Promise<boolean>} - Whether start succeeded
   */
  async start();

  /**
   * Stop the mock game simulation
   */
  stop();

  /**
   * Add a player to the game
   * @param {Object} player - Player data
   * @returns {string} - Player ID
   */
  addPlayer(player);

  /**
   * Remove a player from the game
   * @param {string} playerId - Player ID
   * @returns {boolean} - Whether removal succeeded
   */
  removePlayer(playerId);

  /**
   * Get the current game state
   * @returns {Object} - Game state
   */
  getGameState();

  /**
   * Update the game state manually
   * @param {Object} updates - State updates to apply
   * @returns {Object} - Updated game state
   */
  updateGameState(updates);

  /**
   * Generate a random game state update
   * @returns {Object} - Random state update
   */
  generateRandomUpdate();

  /**
   * End the game with a specific winner
   * @param {string} [winnerId] - Winner ID (random if not specified)
   * @returns {Object} - Game end result
   */
  endGame(winnerId);

  /**
   * Register an event handler
   * @param {string} event - Event name
   * @param {Function} handler - Event handler
   */
  on(event, handler);

  /**
   * Remove an event handler
   * @param {string} event - Event name
   * @param {Function} handler - Event handler
   */
  off(event, handler);
}
```

## Bundle Structure

The browser library will be bundled as follows:

- `uniquake-web.min.js` - Minified bundle with all components
- `uniquake-web.js` - Non-minified bundle with all components
- `uniquake-web-mock.js` - Bundle including mock implementations for testing
- Source maps for debugging

## Browser Integration

### Mock Client Example

```html
<!DOCTYPE html>
<html>
<head>
  <title>UniQuake Web Mock Client</title>
  <script src="uniquake-web-mock.js"></script>
</head>
<body>
  <div id="server-list"></div>
  <div id="chat"></div>
  <div id="token-status"></div>
  <div id="game-state"></div>
  <button id="mint">Mint Tokens</button>
  <button id="verify">Verify Game State</button>
  <button id="connect">Connect to Server</button>
  <input id="message" type="text" placeholder="Chat message...">
  <button id="send">Send</button>
  
  <script>
    // Initialize mock game
    const mockGame = new UniQuake.MockGame({
      isServer: false,
      updateInterval: 2000,
      onStateChange: (state) => {
        document.getElementById('game-state').textContent = JSON.stringify(state, null, 2);
      }
    });
    
    // Initialize client
    const client = new UniQuake.BrowserGameClient({
      masterServer: 'localhost:27950',
      playerName: 'WebPlayer',
      mintTokens: 5,
      onStatusUpdate: (status) => {
        // Update UI with status
        console.log('Status update:', status);
      },
      onChatMessage: (message) => {
        // Update chat UI
        const chatDiv = document.getElementById('chat');
        chatDiv.innerHTML += `<p><strong>${message.from}:</strong> ${message.message}</p>`;
      },
      onTokenUpdate: (tokens) => {
        // Update token UI
        document.getElementById('token-status').textContent = 
          `Tokens: ${tokens.coins} (Value: ${tokens.value})`;
      }
    });
    
    // Initialize game integration
    const gameIntegration = new UniQuake.GameIntegration({
      client: client,
      onGameStateUpdate: (state) => {
        console.log('Game state updated:', state);
      },
      onTokenEvent: (event) => {
        console.log('Token event:', event);
      }
    });
    
    // Initialize everything
    async function initialize() {
      await mockGame.init();
      await client.init();
      await gameIntegration.init(mockGame);
      
      console.log('Client initialized with mock game');
      
      // Start mock game simulation
      mockGame.start();
      
      // Request server list
      client.requestServerList().then((servers) => {
        const serverListDiv = document.getElementById('server-list');
        serverListDiv.innerHTML = '';
        
        servers.forEach((server, index) => {
          const serverItem = document.createElement('div');
          serverItem.textContent = `${index + 1}. ${server.name} - Players: ${server.players}/${server.maxPlayers}`;
          serverItem.setAttribute('data-server-id', server.peerId);
          serverItem.addEventListener('click', () => {
            client.connectToServer(server.peerId);
          });
          serverListDiv.appendChild(serverItem);
        });
      });
    }
    
    initialize();
    
    // Event handlers for UI
    document.getElementById('mint').addEventListener('click', () => {
      client.mintTokens(1).then((result) => {
        console.log('Minted token:', result);
      });
    });
    
    document.getElementById('verify').addEventListener('click', () => {
      gameIntegration.verifyGameStateToken().then((result) => {
        console.log('Verification result:', result);
        alert(`Game state verification: ${result.verified ? 'Valid' : 'Invalid'}`);
      });
    });
    
    document.getElementById('connect').addEventListener('click', () => {
      // Connect to the first server in the list
      client.requestServerList().then((servers) => {
        if (servers.length > 0) {
          client.connectToServer(servers[0].peerId);
        } else {
          alert('No servers available');
        }
      });
    });
    
    document.getElementById('send').addEventListener('click', () => {
      const message = document.getElementById('message').value;
      client.sendChatMessage(message);
      document.getElementById('message').value = '';
    });
  </script>
</body>
</html>
```

### Mock Server Example

```html
<!DOCTYPE html>
<html>
<head>
  <title>UniQuake Web Mock Server</title>
  <script src="uniquake-web-mock.js"></script>
</head>
<body>
  <div id="server-status"></div>
  <div id="client-list"></div>
  <div id="token-pool"></div>
  <div id="game-state"></div>
  <button id="start">Start Server</button>
  <button id="stop">Stop Server</button>
  <button id="end-game">End Game</button>
  <button id="update-state">Update Game State</button>
  
  <script>
    // Initialize mock game
    const mockGame = new UniQuake.MockGame({
      isServer: true,
      updateInterval: 5000,
      playerCount: 0, // Players will be added as clients connect
      onStateChange: (state) => {
        document.getElementById('game-state').textContent = JSON.stringify(state, null, 2);
      }
    });
    
    // Initialize server
    const server = new UniQuake.BrowserGameServer({
      masterServer: 'localhost:27950',
      serverName: 'Web Mock Server',
      map: 'web_mock',
      maxPlayers: 8,
      requireEntryToken: true,
      stateTokenInterval: 10000,
      onClientConnect: (client) => {
        console.log('Client connected:', client);
        
        // Add player to mock game
        mockGame.addPlayer({
          id: client.id,
          name: client.name || 'Player',
          position: { x: Math.random() * 100, y: Math.random() * 100, z: Math.random() * 100 }
        });
        
        // Update UI
        updateClientList();
      },
      onClientDisconnect: (client) => {
        console.log('Client disconnected:', client);
        
        // Remove player from mock game
        mockGame.removePlayer(client.id);
        
        // Update UI
        updateClientList();
      },
      onChatMessage: (clientId, message) => {
        console.log(`Chat from ${clientId}: ${message}`);
        // Add to chat log in UI
        const clientList = document.getElementById('client-list');
        clientList.innerHTML += `<p><strong>${clientId}:</strong> ${message}</p>`;
      }
    });
    
    // Initialize game integration
    const gameIntegration = new UniQuake.GameIntegration({
      server: server,
      onGameStateUpdate: (state) => {
        // Update token state when game state changes
        console.log('Game state updated for token:', state);
      },
      onPlayerJoin: (playerId, tokenResult) => {
        console.log(`Player ${playerId} joined with token:`, tokenResult);
      }
    });
    
    // Initialize everything
    async function initialize() {
      await mockGame.init();
      await server.init();
      await gameIntegration.init(mockGame);
      
      console.log('Server initialized with mock game');
      updateServerStatus();
    }
    
    // Update client list in UI
    function updateClientList() {
      const clients = server.getClients();
      const clientList = document.getElementById('client-list');
      clientList.innerHTML = '<h3>Connected Clients</h3>';
      
      clients.forEach(client => {
        clientList.innerHTML += `<div>ID: ${client.id} - Name: ${client.name}</div>`;
      });
    }
    
    // Update server status in UI
    function updateServerStatus() {
      const status = server.getStatus();
      const statusDiv = document.getElementById('server-status');
      statusDiv.innerHTML = `
        <h3>Server Status</h3>
        <div>Name: ${status.name}</div>
        <div>Map: ${status.map}</div>
        <div>Players: ${status.players}/${status.maxPlayers}</div>
        <div>Registered: ${status.registered ? 'Yes' : 'No'}</div>
      `;
      
      // Update token pool info
      const tokenPool = document.getElementById('token-pool');
      tokenPool.innerHTML = `
        <h3>Token Pool</h3>
        <div>Entry Tokens: ${status.tokens?.entry || 0}</div>
        <div>Total Value: ${status.tokens?.totalValue || '0'}</div>
      `;
    }
    
    // Event handlers for UI
    document.getElementById('start').addEventListener('click', () => {
      if (!server.isRegistered()) {
        server.registerServer().then(() => {
          console.log('Server started and registered');
          mockGame.start();
          updateServerStatus();
        });
      } else {
        alert('Server already registered');
      }
    });
    
    document.getElementById('stop').addEventListener('click', () => {
      server.unregisterServer().then(() => {
        console.log('Server stopped');
        mockGame.stop();
        updateServerStatus();
      });
    });
    
    document.getElementById('end-game').addEventListener('click', () => {
      // Get clients
      const clients = server.getClients();
      
      // Select a winner (first client for demo)
      if (clients.length > 0) {
        gameIntegration.endGame(clients[0].id).then((result) => {
          console.log('Game ended, tokens distributed:', result);
          alert(`Game ended. Winner: ${clients[0].id}. Tokens distributed: ${result.tokenCount}`);
          updateServerStatus();
        });
      } else {
        alert('No clients connected to select a winner');
      }
    });
    
    document.getElementById('update-state').addEventListener('click', () => {
      // Generate random state update
      const update = mockGame.generateRandomUpdate();
      
      // Apply update
      mockGame.updateGameState(update);
      
      // This will trigger onStateChange and update the UI
      console.log('Manual state update applied');
    });
    
    // Initialize the server
    initialize();
  </script>
</body>
</html>
```

### Real Game Integration Example

```javascript
// Example of integrating with an actual game (Quake)

// Assume we have access to the game's global object
const quakeGame = window.quakeGame || {};

// Initialize our token components
const tokenService = new UniQuake.UniQuakeTokenService({
  username: quakeGame.playerName || 'QuakePlayer'
});

const client = new UniQuake.BrowserGameClient({
  masterServer: quakeGame.masterServerAddress || 'localhost:27950',
  playerName: quakeGame.playerName || 'QuakePlayer',
  mintTokens: 5
});

// Create game integration
const gameIntegration = new UniQuake.GameIntegration({
  client: client,
  onGameStateUpdate: (state) => {
    // This will be called when the token service updates game state
    console.log('Token state updated for game state:', state);
  },
  onTokenEvent: (event) => {
    if (event.type === 'entry_token_required') {
      // Show UI to the player explaining token requirement
      quakeGame.showNotification('This server requires an entry token. Sending token...');
    } else if (event.type === 'reward_received') {
      // Show UI to the player that they received tokens
      quakeGame.showNotification(`You received ${event.tokenCount} tokens for winning!`);
    }
  }
});

// Initialize components
async function initializeTokenSystem() {
  await tokenService.init();
  await client.init();
  await gameIntegration.init(quakeGame);
  
  console.log('Token system initialized for Quake');
  
  // Register hooks into the game's lifecycle events
  
  // When player joins a server
  quakeGame.on('server_connect', async (serverInfo) => {
    // Connect our client to the same server
    await client.connectToServer(serverInfo.peerId);
  });
  
  // When game state updates (happens many times per second)
  // We'll throttle this to every 2 seconds to avoid excessive token updates
  let lastUpdate = 0;
  quakeGame.on('game_state_update', (gameState) => {
    const now = Date.now();
    if (now - lastUpdate > 2000) {
      lastUpdate = now;
      gameIntegration.updateGameState(gameState);
    }
  });
  
  // When game ends
  quakeGame.on('game_end', (result) => {
    if (result.isServer) {
      // If we're the server, handle end game token distribution
      gameIntegration.endGame(result.winnerId);
    }
  });
}

// Start initialization when the game is ready
if (quakeGame.isReady) {
  initializeTokenSystem();
} else {
  quakeGame.on('ready', initializeTokenSystem);
}
```

## Dependencies

The browser implementation will have the following dependencies:

1. **Unicity SDK Browser Bundle** - Browser-compatible version of the Unicity tx-flow-engine SDK
2. **SimplePeer** (or similar WebRTC library) - For WebRTC peer connections
3. **EventEmitter** - For event handling
4. **CryptoJS** - For cryptographic operations in the browser

All dependencies will be included in the bundled library for ease of use.

## Compatibility

The library will be compatible with:
- Chrome 80+
- Firefox 75+
- Safari 13+
- Edge 80+

WebRTC fallback to WebSocket will be automatic for environments where WebRTC is not available.

## Size and Performance Considerations

To ensure good performance and reasonable bundle size:

1. The library will be modular, allowing users to import only needed components
2. All code will be minified and tree-shaken to reduce bundle size
3. Async operations will be used for all network and crypto operations
4. Web Workers will be used for intensive cryptographic operations
5. IndexedDB will be used for token storage to avoid memory constraints

The target bundle size is under 500KB minified and gzipped.

## Integration with Real Quake Game

For integrating with the actual Quake game in the browser, additional considerations include:

1. **Non-Intrusive Integration**: The token system should not modify the core game code but rather hook into existing events and APIs.

2. **Performance Impact**: Token operations should be performed off the main thread when possible to avoid impacting the game's frame rate.

3. **User Experience**: Token interactions should be minimally disruptive to gameplay (e.g., notifications that don't block the screen).

4. **Game State Extraction**: We'll need to define a standard way to extract the relevant game state for token operations without requiring deep game engine modifications.

5. **Fallback Mechanisms**: If token operations fail, the game should continue to function normally.

### Game State Interface

For the game integration to work properly, the game should expose:

```javascript
interface GameState {
  gameId: string;           // Unique identifier for this game session
  frame: number;            // Current frame number
  timestamp: number;        // Current timestamp
  players: {                // Map of player information
    [playerId: string]: {
      position: {x: number, y: number, z: number};
      health: number;
      score: number;
      // Other relevant player state
    }
  };
  // Other game-specific state that needs verification
}
```

### Event Hooks

The game should provide hooks for these events:

1. **Game Initialization**: When the game is ready for token integration
2. **Server Connection**: When connecting to a game server
3. **Player Join/Leave**: When players enter or exit the game
4. **Game State Update**: Regular updates to the game state
5. **Game End**: When a match or round ends, including the winner information

## Development and Testing Process

For development and testing, we'll follow this process:

1. **Mock-First Development**: Create and test the token system with mock implementations first
2. **Standalone Testing**: Build standalone web pages that use the mock implementations
3. **API Validation**: Validate the API design with mock implementations
4. **Game Integration**: Once validated, integrate with the actual game
5. **Performance Testing**: Test performance in the context of the actual game
6. **User Testing**: Test the entire flow with real users

This approach allows us to develop and test the token functionality independently of the game, reducing development complexity and ensuring the system works correctly before integrating with the game.