#!/usr/bin/env node

/**
 * Mock Game Client for testing WebRTC P2P connections
 * 
 * This script simulates a game client connecting to the master server,
 * retrieving the server list, and connecting to a game server via WebRTC.
 */

const WebSocket = require('ws');
const readline = require('readline');

// Define a simple mock channel for the client side
class MockClientChannel {
  constructor() {
    this.readyState = 'connecting';
    
    // Event handlers
    this.onopen = null;
    this.onmessage = null;
    this.onclose = null;
    this.onerror = null;
  }
  
  // Send a message
  send(data) {
    console.log(`[Client] Channel sent: ${typeof data === 'string' ? (data.substr(0, 30) + '...') : JSON.stringify(data).substr(0, 30) + '...'}`);
    return true;
  }
  
  // Close the channel
  close() {
    this._close();
  }
  
  // Set to open state
  open() {
    this.readyState = 'open';
    if (this.onopen) {
      this.onopen();
    }
  }
  
  // Internal close method
  _close() {
    this.readyState = 'closed';
    if (this.onclose) {
      this.onclose();
    }
  }
  
  // Receive a message
  receiveMessage(data) {
    if (this.onmessage) {
      this.onmessage({ data });
    }
  }
}

// Command line arguments
const argv = require('optimist')
  .usage('Usage: $0 [options]')
  .describe('master', 'Master server address')
  .default('master', 'localhost:27950')
  .describe('name', 'Player name')
  .default('name', 'Player')
  .describe('connect', 'Auto-connect to server with this peer ID')
  .boolean('verbose')
  .describe('verbose', 'Show verbose output')
  .default('verbose', false)
  .argv;

// Create readline interface for command input
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  prompt: 'client> '
});

// Client state
const clientState = {
  clientId: null,
  channel: null,
  signaling: null,
  latencyInterval: null,
  connected: false,
  connectedServerPeerId: null,
  connectionId: null,
  serverList: [],
  pingResults: []
};

// Client info
const clientInfo = {
  name: argv.name
};

// Verbose logging
function log(...args) {
  if (argv.verbose) {
    console.log(...args);
  }
}

/**
 * Connect to the master server for signaling
 */
function connectToMasterServer() {
  const masterUrl = `ws://${argv.master}`;
  console.log(`Connecting to master server at ${masterUrl}...`);
  
  clientState.signaling = new WebSocket(masterUrl);
  
  // Set up event handlers
  clientState.signaling.on('open', () => {
    console.log('Connected to master server');
    
    // Get server list after a short delay
    setTimeout(() => {
      requestServerList();
    }, 1000);
    
    // Auto-connect if specified
    if (argv.connect) {
      setTimeout(() => {
        connectToServer(argv.connect);
      }, 2000);
    }
  });
  
  clientState.signaling.on('message', (data) => {
    try {
      const message = JSON.parse(data);
      handleSignalingMessage(message);
    } catch (err) {
      console.error('Failed to parse message:', err.message);
    }
  });
  
  clientState.signaling.on('close', () => {
    console.log('Disconnected from master server');
    
    // Reset state
    clientState.clientId = null;
    clientState.serverList = [];
    
    // Try to reconnect after a delay
    setTimeout(() => connectToMasterServer(), 5000);
  });
  
  clientState.signaling.on('error', (err) => {
    console.error('WebSocket error:', err.message);
  });
}

/**
 * Request server list from master server
 */
function requestServerList() {
  sendToMaster({
    type: 'get_servers'
  });
}

/**
 * Connect to a game server
 * @param {string} peerId - Server peer ID
 */
function connectToServer(peerId) {
  console.log(`Connecting to server with peer ID: ${peerId}...`);
  
  // Store server peer ID
  clientState.connectedServerPeerId = peerId;
  
  // Create a channel for this connection
  clientState.channel = new MockClientChannel();
  
  // Send connect request with WebSocket fallback flag
  sendToMaster({
    type: 'connect_to_server',
    peerId: peerId,
    useWebSocket: true  // Explicitly request WebSocket fallback
  });
}

/**
 * Handle incoming signaling messages
 */
function handleSignalingMessage(message) {
  log(`Received message: ${message.type}`);
  
  switch (message.type) {
    case 'connected':
      console.log(`Connected to signaling server with client ID: ${message.clientId}`);
      clientState.clientId = message.clientId;
      break;
      
    case 'server_list':
      handleServerList(message);
      break;
      
    case 'proxy_connection':
      handleProxyConnection(message);
      break;
      
    case 'proxy_data':
      handleProxyData(message);
      break;
      
    case 'server_disconnected':
      handleServerDisconnected(message);
      break;
      
    case 'disconnect_ack':
      console.log('Disconnected from server successfully');
      handleDisconnect('user_disconnect');
      break;
      
    case 'error':
      console.error(`Signaling error: ${message.error}`);
      break;
      
    default:
      log(`Unhandled message type: ${message.type}`);
      break;
  }
}

/**
 * Handle server list response
 */
function handleServerList(message) {
  const servers = message.servers || [];
  clientState.serverList = servers;
  
  console.log(`\nAvailable servers (${servers.length}):`);
  
  if (servers.length === 0) {
    console.log('  No servers found');
  } else {
    servers.forEach((server, index) => {
      console.log(`  ${index + 1}. ${server.name} - Map: ${server.map} - Players: ${server.players}/${server.maxPlayers} - Peer ID: ${server.peerId}`);
    });
  }
  
  rl.prompt();
}

/**
 * Set up channel for server communication
 */
function setupChannel() {
  if (!clientState.channel) {
    clientState.channel = new MockClientChannel();
  }
  
  clientState.channel.onopen = () => {
    console.log('Channel open');
    clientState.connected = true;
  };
  
  clientState.channel.onmessage = (event) => {
    try {
      const message = JSON.parse(event.data);
      handleChannelMessage(message);
    } catch (err) {
      // If not JSON, treat as raw data
      console.log(`Received raw data: ${event.data}`);
    }
  };
  
  clientState.channel.onclose = () => {
    console.log('Channel closed');
    handleDisconnect('channel_closed');
  };
  
  clientState.channel.onerror = (error) => {
    console.error('Channel error:', error);
  };
  
  return clientState.channel;
}

/**
 * Handle messages received through the channel
 */
function handleChannelMessage(message) {
  switch (message.type) {
    case 'welcome':
      console.log(`\nServer message: ${message.message}`);
      console.log(`Connected to: ${message.serverInfo.name} - Map: ${message.serverInfo.map}`);
      rl.prompt();
      break;
      
    case 'chat':
      console.log(`\n${message.from}: ${message.message}`);
      rl.prompt();
      break;
      
    case 'pong':
      // Calculate ping
      const now = Date.now();
      const ping = now - message.timestamp;
      clientState.pingResults.push(ping);
      
      // Only keep last 10 results
      if (clientState.pingResults.length > 10) {
        clientState.pingResults.shift();
      }
      
      // Calculate average
      const avg = clientState.pingResults.reduce((a, b) => a + b, 0) / clientState.pingResults.length;
      log(`Ping: ${ping}ms (avg: ${Math.round(avg)}ms)`);
      break;
      
    case 'kick':
      console.log(`\nKicked from server: ${message.reason || 'No reason given'}`);
      handleDisconnect('kicked');
      break;
      
    default:
      log(`Unhandled channel message: ${message.type}`);
      break;
  }
}

/**
 * Handle disconnection
 */
function handleDisconnect(reason) {
  if (!clientState.connected) return;
  
  console.log(`Disconnected from server (${reason})`);
  
  // If this is a user-initiated disconnect, notify the server
  if (reason === 'user_disconnect' && 
      clientState.signaling && clientState.signaling.readyState === WebSocket.OPEN) {
    sendToMaster({
      type: 'disconnect_from_server',
      serverPeerId: clientState.connectedServerPeerId
    });
  }
  
  // Stop ping test
  if (clientState.latencyInterval) {
    clearInterval(clientState.latencyInterval);
    clientState.latencyInterval = null;
  }
  
  // Reset connection state
  clientState.connected = false;
  clientState.connectedServerPeerId = null;
  clientState.connectionId = null;
  
  // Close channel
  if (clientState.channel) {
    clientState.channel.close();
    clientState.channel = null;
  }
  
  // Clear ping results
  clientState.pingResults = [];
}

/**
 * Start periodic ping test
 */
function startPingTest() {
  // Clear any existing interval
  if (clientState.latencyInterval) {
    clearInterval(clientState.latencyInterval);
  }
  
  // Start a new interval
  clientState.latencyInterval = setInterval(() => {
    if (clientState.connected) {
      sendMessage({
        type: 'ping',
        timestamp: Date.now()
      });
    }
  }, 5000); // every 5 seconds
}

/**
 * Handle incoming SDP offer
 */
async function handleOffer(message) {
  try {
    const { connectionId, sourceId, sdp } = message;
    
    console.log(`Received offer from server ${sourceId}`);
    
    // Store the server peer ID
    clientState.connectedServerPeerId = sourceId;
    
    // Create a new connection if we don't have one
    if (!clientState.peerConnection) {
      clientState.peerConnection = createPeerConnection(connectionId);
    }
    
    // Store connection details
    clientState.connection = {
      id: connectionId,
      serverId: sourceId
    };
    
    // Apply the remote description
    await clientState.peerConnection.setRemoteDescription(
      new RTCSessionDescription(sdp)
    );
    
    // Create answer
    const answer = await clientState.peerConnection.createAnswer();
    
    // Set local description
    await clientState.peerConnection.setLocalDescription(answer);
    
    // Send answer
    sendToMaster({
      type: 'answer',
      targetId: sourceId,
      connectionId: connectionId,
      sdp: answer
    });
    
    console.log('Sent answer to server');
  } catch (err) {
    console.error('Failed to handle offer:', err);
  }
}

/**
 * Handle incoming SDP answer
 */
async function handleAnswer(message) {
  try {
    const { connectionId, sourceId, sdp } = message;
    
    console.log(`Received answer from server ${sourceId}`);
    
    if (!clientState.peerConnection) {
      console.warn('No peer connection available');
      return;
    }
    
    // Apply the remote description
    await clientState.peerConnection.setRemoteDescription(
      new RTCSessionDescription(sdp)
    );
    
    console.log('Applied server answer');
  } catch (err) {
    console.error('Failed to handle answer:', err);
  }
}

/**
 * Handle incoming ICE candidate
 */
async function handleIceCandidate(message) {
  try {
    const { candidate } = message;
    
    if (!clientState.peerConnection) return;
    
    await clientState.peerConnection.addIceCandidate(
      new RTCIceCandidate(candidate)
    );
  } catch (err) {
    console.error('Failed to add ICE candidate:', err);
  }
}

/**
 * Handle proxy connection to server
 */
function handleProxyConnection(message) {
  const { serverPeerId, connectionId } = message;
  
  console.log(`Connection established to server ${serverPeerId} with connection ID: ${connectionId || 'unknown'}`);
  
  // Update client state
  clientState.connected = true;
  clientState.connectedServerPeerId = serverPeerId;
  
  // Ensure we have a connection ID (use the one from message or generate a mock one)
  clientState.connectionId = connectionId || `mock-${Date.now()}`;
  
  // Set up channel if not already done
  if (!clientState.channel) {
    setupChannel();
  }
  
  // Open the channel
  clientState.channel.open();
  
  // Start ping test
  startPingTest();
  
  // Notify connection success
  sendToMaster({
    type: 'connection_success',
    connectionId: clientState.connectionId,
    serverPeerId: serverPeerId
  });
}

/**
 * Handle proxy data from server
 */
function handleProxyData(message) {
  const { serverPeerId, data } = message;
  
  // Make sure we're connected to this server
  if (clientState.connectedServerPeerId !== serverPeerId) {
    console.warn(`Received data from unexpected server: ${serverPeerId}`);
    return;
  }
  
  // Forward to the channel
  if (clientState.channel) {
    clientState.channel.receiveMessage(data);
  }
}

/**
 * Handle server disconnection
 */
function handleServerDisconnected(message) {
  const { serverPeerId, connectionId } = message;
  
  if (clientState.connectedServerPeerId === serverPeerId || 
      (connectionId && clientState.connectionId === connectionId)) {
    console.log(`Server ${serverPeerId} disconnected`);
    handleDisconnect('server_disconnected');
  }
}

/**
 * Send a message to the master server
 */
function sendToMaster(message) {
  if (!clientState.signaling || clientState.signaling.readyState !== WebSocket.OPEN) {
    console.warn('Cannot send message: not connected to master server');
    return false;
  }
  
  try {
    clientState.signaling.send(JSON.stringify(message));
    return true;
  } catch (err) {
    console.error('Failed to send message to master server:', err);
    return false;
  }
}

/**
 * Send a message to the game server
 */
function sendMessage(message) {
  if (!clientState.connected) {
    console.warn('Cannot send message: not connected to a server');
    return false;
  }
  
  if (!clientState.signaling || clientState.signaling.readyState !== WebSocket.OPEN) {
    console.warn('Cannot send message: signaling connection not open');
    return false;
  }
  
  try {
    // Send message via master server
    sendToMaster({
      type: 'proxy_message',
      serverPeerId: clientState.connectedServerPeerId,
      connectionId: clientState.connectionId,
      data: message
    });
    return true;
  } catch (err) {
    console.error('Failed to send message to game server:', err);
    return false;
  }
}

/**
 * Process command line input
 */
function processCommand(line) {
  const args = line.trim().split(' ');
  const command = args[0].toLowerCase();
  
  switch (command) {
    case 'help':
      showHelp();
      break;
      
    case 'list':
      requestServerList();
      break;
      
    case 'connect':
      const serverArg = args[1];
      
      // If numeric, treat as server list index
      if (/^\d+$/.test(serverArg)) {
        const index = parseInt(serverArg, 10) - 1;
        if (index >= 0 && index < clientState.serverList.length) {
          const server = clientState.serverList[index];
          connectToServer(server.peerId);
        } else {
          console.log('Invalid server index');
        }
      } else {
        // Treat as peer ID
        connectToServer(serverArg);
      }
      break;
      
    case 'disconnect':
      if (clientState.connected) {
        handleDisconnect('user_disconnect');
        console.log('Disconnected from server');
      } else {
        console.log('Not connected to a server');
      }
      break;
      
    case 'status':
      showStatus();
      break;
      
    case 'ping':
      if (clientState.connected) {
        console.log('Sending ping...');
        sendMessage({
          type: 'ping',
          timestamp: Date.now()
        });
      } else {
        console.log('Not connected to a server');
      }
      break;
      
    case 'say':
    case 'chat':
      if (clientState.connected) {
        const message = args.slice(1).join(' ');
        if (message) {
          sendMessage({
            type: 'chat',
            message: message
          });
        } else {
          console.log('Message cannot be empty');
        }
      } else {
        console.log('Not connected to a server');
      }
      break;
      
    case 'quit':
    case 'exit':
      console.log('Shutting down...');
      process.exit(0);
      break;
      
    default:
      if (command) {
        // If connected and not a recognized command, treat as chat
        if (clientState.connected) {
          sendMessage({
            type: 'chat',
            message: line
          });
        } else {
          console.log(`Unknown command: ${command}`);
          showHelp();
        }
      }
      break;
  }
}

/**
 * Show help text
 */
function showHelp() {
  console.log(`
Commands:
  help                  - Show this help text
  list                  - Request server list
  connect <id/index>    - Connect to server by ID or list index
  disconnect            - Disconnect from current server
  status                - Show connection status
  ping                  - Send ping to server
  say <message>         - Send chat message (or just type the message)
  quit                  - Exit the client
  `);
}

/**
 * Show connection status
 */
function showStatus() {
  console.log(`
Client Status:
  Client ID: ${clientState.clientId || 'Not connected'}
  Connected to server: ${clientState.connected ? 'Yes' : 'No'}
  Transport: WebSocket
  Server ID: ${clientState.connectedServerPeerId || 'N/A'}
  Ping: ${clientState.pingResults.length > 0 
    ? `${Math.round(clientState.pingResults.reduce((a, b) => a + b, 0) / clientState.pingResults.length)}ms` 
    : 'N/A'}
  `);
}

// Start client
console.log(`Starting WebSocket game client: ${clientInfo.name}`);
connectToMasterServer();

// Set up command line interface
rl.on('line', (line) => {
  processCommand(line);
  rl.prompt();
}).on('close', () => {
  console.log('Shutting down...');
  process.exit(0);
});

console.log('Type "help" for a list of commands');
rl.prompt();