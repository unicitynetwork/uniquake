#!/usr/bin/env node

/**
 * Test cross-protocol message relay between WS and WSS with fixed relay logic
 */

const WebSocket = require('ws');
// Simple console logger
const logger = {
  info: (msg) => console.log(`[INFO] ${msg}`),
  error: (msg) => console.error(`[ERROR] ${msg}`),
  warn: (msg) => console.warn(`[WARN] ${msg}`)
};

// Configuration
const WS_URL = 'ws://uniquake-dev.dyndns.org:27950';
const WSS_URL = 'wss://uniquake-dev.dyndns.org:27951';

// Test state
let wsServer = null;
let wssClient = null;
let wsServerPeerId = null;
let serverRegistered = false;
let clientConnected = false;
let proxyEstablished = false;

// Track connected clients for the server
const connectedClients = new Map();

/**
 * Connect WS server (simulating server-cli)
 */
async function connectWSServer() {
  return new Promise((resolve, reject) => {
    logger.info('Connecting WS server to master...');
    
    wsServer = new WebSocket(WS_URL);
    
    wsServer.on('open', () => {
      logger.info('WS server connected to master');
      resolve();
    });
    
    wsServer.on('message', (data) => {
      try {
        const message = JSON.parse(data);
        logger.info(`WS server received: ${message.type}`);
        
        switch (message.type) {
          case 'connected':
            // Register as server
            wsServer.send(JSON.stringify({
              type: 'register_server',
              serverInfo: {
                name: 'Test Cross-Protocol Server',
                map: 'q3dm1',
                maxPlayers: 16,
                game: 'baseq3'
              }
            }));
            break;
            
          case 'server_registered':
            wsServerPeerId = message.peerId;
            serverRegistered = true;
            logger.info(`WS server registered with peer ID: ${wsServerPeerId}`);
            break;
            
          case 'proxy_connection':
            const clientId = message.clientId;
            logger.info(`WS server received proxy connection from client: ${clientId}`);
            connectedClients.set(clientId, { connected: true });
            proxyEstablished = true;
            
            // Send proxy_connection acknowledgment
            wsServer.send(JSON.stringify({
              type: 'proxy_connection',
              clientId: clientId,
              connectionId: message.connectionId
            }));
            break;
            
          case 'proxy_data':
            logger.info(`WS server received proxy data from client ${message.clientId}: ${JSON.stringify(message.data)}`);
            break;
        }
      } catch (err) {
        logger.error(`WS server message parse error: ${err.message}`);
      }
    });
    
    wsServer.on('error', (err) => {
      logger.error(`WS server error: ${err.message}`);
      reject(err);
    });
    
    wsServer.on('close', () => {
      logger.info('WS server disconnected');
    });
  });
}

/**
 * Connect WSS client
 */
async function connectWSSClient() {
  return new Promise((resolve, reject) => {
    logger.info('Connecting WSS client to master...');
    
    // Allow self-signed certificates for testing
    const options = {
      rejectUnauthorized: false
    };
    
    wssClient = new WebSocket(WSS_URL, options);
    let clientId = null;
    
    wssClient.on('open', () => {
      logger.info('WSS client connected to master');
      clientConnected = true;
      resolve();
    });
    
    wssClient.on('message', (data) => {
      try {
        const message = JSON.parse(data);
        logger.info(`WSS client received: ${message.type}`);
        
        switch (message.type) {
          case 'connected':
            clientId = message.clientId;
            logger.info(`WSS client assigned ID: ${clientId}`);
            
            // Get server list
            wssClient.send(JSON.stringify({
              type: 'get_servers'
            }));
            break;
            
          case 'server_list':
            logger.info(`WSS client received ${message.servers.length} servers`);
            
            // Find our test server
            const testServer = message.servers.find(s => s.peerId === wsServerPeerId);
            if (testServer) {
              logger.info(`Found test server, connecting with WebSocket fallback...`);
              
              // Connect to server using WebSocket fallback
              wssClient.send(JSON.stringify({
                type: 'connect_to_server',
                peerId: wsServerPeerId,
                useWebSocket: true
              }));
            }
            break;
            
          case 'proxy_connection':
            logger.info(`WSS client established proxy connection to server ${message.serverPeerId}`);
            break;
            
          case 'proxy_data':
            const data = message.data;
            logger.info(`WSS client received proxy data from server: ${JSON.stringify(data)}`);
            
            // Check if it's a score update
            if (data.type === 'player_score_update') {
              logger.info('✅ SUCCESS: WSS client received score update from WS server!');
              logger.info(`Score update details: ${data.players.length} players, countdown: ${data.countdown.timeText}`);
            }
            break;
            
          case 'error':
            logger.error(`WSS client received error: ${message.error}`);
            break;
        }
      } catch (err) {
        logger.error(`WSS client message parse error: ${err.message}`);
      }
    });
    
    wssClient.on('error', (err) => {
      logger.error(`WSS client error: ${err.message}`);
      reject(err);
    });
    
    wssClient.on('close', () => {
      logger.info('WSS client disconnected');
    });
  });
}

/**
 * Wait for condition with timeout
 */
async function waitFor(condition, timeout = 5000, checkInterval = 100) {
  const startTime = Date.now();
  
  while (!condition()) {
    if (Date.now() - startTime > timeout) {
      throw new Error('Timeout waiting for condition');
    }
    await new Promise(resolve => setTimeout(resolve, checkInterval));
  }
}

/**
 * Broadcast score update from server
 */
function broadcastScoreUpdate() {
  logger.info('Broadcasting score update from WS server...');
  
  const scoreUpdate = {
    type: 'player_score_update',
    players: [
      { name: 'Player1', score: 10, ping: 50 },
      { name: 'Player2', score: 8, ping: 60 }
    ],
    countdown: {
      totalSeconds: 300,
      timeText: '5:00',
      isActive: true
    },
    timestamp: Date.now()
  };
  
  // Broadcast to all connected clients
  for (const [clientId, client] of connectedClients) {
    if (client.connected) {
      logger.info(`Sending score update to client ${clientId}`);
      
      wsServer.send(JSON.stringify({
        type: 'proxy_data',
        clientId: clientId,
        data: scoreUpdate
      }));
    }
  }
}

/**
 * Run the test
 */
async function runTest() {
  try {
    logger.info('=== Cross-Protocol Message Relay Test v2 ===\n');
    
    // Step 1: Connect WS server
    await connectWSServer();
    await waitFor(() => serverRegistered, 5000);
    logger.info('✓ WS server connected and registered\n');
    
    // Step 2: Connect WSS client  
    await connectWSSClient();
    await waitFor(() => clientConnected, 5000);
    logger.info('✓ WSS client connected\n');
    
    // Step 3: Wait for proxy connection
    await waitFor(() => proxyEstablished, 5000);
    logger.info('✓ Proxy connection established\n');
    
    // Step 4: Broadcast score update from server
    await new Promise(resolve => setTimeout(resolve, 1000)); // Give it a moment
    broadcastScoreUpdate();
    
    // Step 5: Wait for client to receive the update
    await new Promise(resolve => setTimeout(resolve, 3000));
    
    logger.info('\n=== Test completed ===');
    
  } catch (err) {
    logger.error(`Test failed: ${err.message}`);
  } finally {
    // Cleanup
    if (wsServer) wsServer.close();
    if (wssClient) wssClient.close();
    
    setTimeout(() => process.exit(0), 1000);
  }
}

// Run the test
runTest().catch(err => {
  logger.error(`Fatal error: ${err.message}`);
  process.exit(1);
});