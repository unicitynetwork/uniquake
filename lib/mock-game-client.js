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
      debug(`MockClientChannel received message: ${typeof data} data`);
      
      // Create a proper message event object
      const event = { 
        data: data,
        type: 'message' 
      };
      
      // Call the message handler
      this.onmessage(event);
    } else {
      console.warn('No message handler defined for channel');
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
  .boolean('debug')
  .describe('debug', 'Show detailed debug messages')
  .default('debug', false)
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
  pingResults: [],
  chatHistory: [],
  lastPingTime: null,
  lastPing: null,
  lastPingWasManual: false,
  serverInfo: null
};

// Client info
const clientInfo = {
  name: argv.name
};

// Verbose and debug logging
function log(...args) {
  if (argv.verbose) {
    console.log(...args);
  }
}

function debug(...args) {
  if (argv.debug) {
    console.log('[DEBUG]', ...args);
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
  
  // Create and setup a channel for this connection with all event handlers
  clientState.channel = setupChannel();
  
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
 * @returns {MockClientChannel} The configured channel
 */
function setupChannel() {
  // Always create a fresh channel to ensure handlers are properly set
  const channel = new MockClientChannel();
  debug('Creating and setting up new MockClientChannel');
  
  channel.onopen = () => {
    console.log('Channel open');
    clientState.connected = true;
  };
  
  channel.onmessage = (event) => {
    try {
      debug(`Received channel message type: ${typeof event.data}`);
      debug(`Message data: ${typeof event.data === 'string' ? event.data : JSON.stringify(event.data, null, 2)}`);
      
      let message;
      if (typeof event.data === 'string') {
        try {
          message = JSON.parse(event.data);
          debug(`Successfully parsed string message into object`);
        } catch (parseErr) {
          console.error(`Failed to parse string as JSON: ${parseErr.message}`);
          debug(`Raw data that failed to parse: ${event.data}`);
          return; // Can't proceed without valid message
        }
      } else if (typeof event.data === 'object') {
        message = event.data;
        debug(`Using object message directly`);
      } else {
        throw new Error(`Unexpected data type: ${typeof event.data}`);
      }
      
      if (!message || !message.type) {
        console.error(`Invalid message format: missing 'type' property`);
        debug(`Problematic message: ${JSON.stringify(message, null, 2)}`);
        return;
      }
      
      debug(`Processing message of type: ${message.type}`);
      handleChannelMessage(message);
    } catch (err) {
      // If processing fails, log the error and raw data
      console.error(`Failed to process message: ${err.message}`);
      console.error(err.stack);
      debug(`Raw data: ${JSON.stringify(event.data, null, 2)}`);
    }
  };
  
  channel.onclose = () => {
    console.log('Channel closed');
    handleDisconnect('channel_closed');
  };
  
  channel.onerror = (error) => {
    console.error('Channel error:', error);
  };
  
  return channel;
}

/**
 * Handle messages received through the channel
 */
function handleChannelMessage(message) {
  switch (message.type) {
    case 'welcome':
      console.log(`\nConnected to: ${message.serverInfo.name} - Map: ${message.serverInfo.map}`);
      console.log(`Server message: ${message.message}`);
      
      // Store server info in client state
      clientState.serverInfo = {
        name: message.serverInfo.name,
        map: message.serverInfo.map,
        game: message.serverInfo.game,
        players: message.serverInfo.players,
        maxPlayers: message.serverInfo.maxPlayers
      };
      
      debug('Server info updated:');
      debug(JSON.stringify(clientState.serverInfo, null, 2));
      
      rl.prompt();
      break;
      
    case 'chat':
      // Add to chat history
      if (!clientState.chatHistory) {
        clientState.chatHistory = [];
      }
      
      const chatEntry = {
        from: message.from,
        message: message.message,
        timestamp: Date.now()
      };
      
      clientState.chatHistory.push(chatEntry);
      
      // Only keep last 50 messages
      if (clientState.chatHistory.length > 50) {
        clientState.chatHistory.shift();
      }
      
      // Format sender for display
      let sender = message.from;
      if (sender === 'SERVER') {
        sender = '\x1b[1;33mSERVER\x1b[0m'; // Yellow bold text
      } else if (sender === clientState.clientId) {
        sender = '\x1b[1;36mYOU\x1b[0m'; // Cyan bold text
      }
      
      // Format time
      const time = new Date().toLocaleTimeString();
      
      console.log(`\n[${time}] ${sender}: ${message.message}`);
      rl.prompt();
      break;
      
    case 'pong':
      debug(`Received pong response from server`);
      
      // Calculate ping
      const now = Date.now();
      const ping = now - message.timestamp;
      
      // Store last ping time
      clientState.lastPingTime = now;
      clientState.lastPing = ping;
      
      // Add to ping history
      clientState.pingResults.push(ping);
      
      // Only keep last 10 results
      if (clientState.pingResults.length > 10) {
        clientState.pingResults.shift();
      }
      
      // Only show ping results when explicitly requested or in debug mode
      if (clientState.lastPingWasManual || argv.debug) {
        console.log(`Ping: ${ping}ms`);
        
        // Calculate average
        const avg = clientState.pingResults.reduce((a, b) => a + b, 0) / clientState.pingResults.length;
        console.log(`Average ping: ${Math.round(avg)}ms`);
        
        // Reset the manual ping flag
        clientState.lastPingWasManual = false;
      }
      
      rl.prompt();
      break;
      
    case 'kick':
      console.log(`\nKicked from server: ${message.reason || 'No reason given'}`);
      handleDisconnect('kicked');
      break;
      
    default:
      debug(`Unhandled channel message: ${message.type}`);
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
      // Save current cursor position and preserve command line input
      const currentInput = rl.line;
      const cursorPos = rl.cursor;
      
      // Send ping without setting the manual flag
      sendMessage({
        type: 'ping',
        timestamp: Date.now()
      });
      
      // This is a background ping, don't log it
      clientState.lastPingWasManual = false;
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
  
  // Always setup the channel to ensure handlers are properly set
  // This is critical because we need onmessage handler
  clientState.channel = setupChannel();
  
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
  
  debug(`Received proxy data from server ${serverPeerId}`);
  
  // Make sure we're connected to this server
  if (clientState.connectedServerPeerId !== serverPeerId) {
    console.warn(`Received data from unexpected server: ${serverPeerId}`);
    return;
  }
  
  // Print the full data for debugging
  debug('Received data content:');
  debug(JSON.stringify(data, null, 2));
  
  // Forward to the channel
  if (clientState.channel) {
    try {
      // Send the data as is to the channel
      // This ensures we don't lose the object structure
      if (typeof data === 'string') {
        // If it's already a string, try to parse it as JSON first
        try {
          const parsedData = JSON.parse(data);
          debug(`Forwarding parsed object to channel`);
          clientState.channel.receiveMessage(parsedData);
        } catch (parseErr) {
          // If parsing fails, it's a plain string message
          debug(`Forwarding string data to channel: ${data.substring(0, 50)}${data.length > 50 ? '...' : ''}`);
          clientState.channel.receiveMessage(data);
        }
      } else {
        // If it's an object, send it directly without stringifying
        debug(`Forwarding object to channel: ${JSON.stringify(data).substring(0, 50)}...`);
        clientState.channel.receiveMessage(data);
      }
    } catch (err) {
      console.error('Failed to forward data to channel:', err);
      console.error(err.stack);
    }
  } else {
    console.warn('Cannot forward data: channel not initialized');
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
    // Determine if this is a background ping (automatic, not manual)
    const isBackgroundPing = message.type === 'ping' && !clientState.lastPingWasManual;
    
    // Only log if it's not a background ping or we're in debug mode
    if (!isBackgroundPing || argv.debug) {
      debug(`Sending message to server: ${JSON.stringify(message)}`);
    }
    
    // Send message via master server
    const proxyMessage = {
      type: 'proxy_message',
      serverPeerId: clientState.connectedServerPeerId,
      connectionId: clientState.connectionId,
      data: message
    };
    
    // Only log if it's not a background ping or we're in debug mode
    if (!isBackgroundPing || argv.debug) {
      debug(`Wrapped in proxy message: ${JSON.stringify(proxyMessage).substring(0, 100)}${JSON.stringify(proxyMessage).length > 100 ? '...' : ''}`);
    }
    
    sendToMaster(proxyMessage);
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
        // Set flag to indicate this was a manual ping request
        clientState.lastPingWasManual = true;
        sendMessage({
          type: 'ping',
          timestamp: Date.now()
        });
      } else {
        console.log('Not connected to a server');
      }
      break;
      
    case 'history':
      showChatHistory();
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
  history               - Show full chat history
  quit                  - Exit the client
  
Run with --debug to show detailed connection messages
  `);
}

/**
 * Show full chat history
 */
function showChatHistory() {
  if (!clientState.chatHistory || clientState.chatHistory.length === 0) {
    console.log('No chat messages received yet.');
    return;
  }
  
  console.log('\nChat History:');
  console.log('=============');
  
  clientState.chatHistory.forEach((entry, index) => {
    const date = new Date(entry.timestamp);
    const timeStr = date.toLocaleTimeString();
    
    // Format sender
    let sender = entry.from;
    if (sender === 'SERVER') {
      sender = '\x1b[1;33mSERVER\x1b[0m'; // Yellow bold text
    } else if (sender === clientState.clientId) {
      sender = '\x1b[1;36mYOU\x1b[0m'; // Cyan bold text
    }
    
    console.log(`${index + 1}. [${timeStr}] ${sender}: ${entry.message}`);
  });
  
  console.log('=============');
}

/**
 * Show connection status
 */
function showStatus() {
  // Calculate time since last ping if available
  let pingTimeAgo = 'N/A';
  if (clientState.lastPingTime) {
    const seconds = Math.round((Date.now() - clientState.lastPingTime) / 1000);
    pingTimeAgo = `${seconds}s ago`;
  }
  
  // Get server info if connected
  const serverInfo = clientState.serverInfo || {};
  
  // Status output
  console.log(`
Client Status:
  Client ID: ${clientState.clientId || 'Not connected'}
  Player Name: ${clientInfo.name}
  Connected to server: ${clientState.connected ? 'Yes' : 'No'}
  Transport: WebSocket
  Server ID: ${clientState.connectedServerPeerId || 'N/A'}
  Connection ID: ${clientState.connectionId || 'N/A'}
  
Server Info:
  Name: ${serverInfo.name || 'N/A'}
  Map: ${serverInfo.map || 'N/A'}
  Game: ${serverInfo.game || 'N/A'}
  Players: ${serverInfo.players || '0'}/${serverInfo.maxPlayers || '0'}
  
Connection:
  Last Ping: ${clientState.lastPing ? clientState.lastPing + 'ms' : 'N/A'} (${pingTimeAgo})
  Avg Ping: ${clientState.pingResults.length > 0 
    ? `${Math.round(clientState.pingResults.reduce((a, b) => a + b, 0) / clientState.pingResults.length)}ms` 
    : 'N/A'}
  `);
  
  // Show recent chat if available and connected
  if (clientState.connected && clientState.chatHistory && clientState.chatHistory.length > 0) {
    console.log('Recent Chat:');
    
    // Display last 5 chat messages
    const recentMessages = clientState.chatHistory.slice(-5);
    recentMessages.forEach(entry => {
      const timeAgo = Math.round((Date.now() - entry.timestamp) / 1000);
      
      // Format sender
      let sender = entry.from;
      if (sender === 'SERVER') {
        sender = '\x1b[1;33mSERVER\x1b[0m'; // Yellow bold text
      } else if (sender === clientState.clientId) {
        sender = '\x1b[1;36mYOU\x1b[0m'; // Cyan bold text
      }
      
      console.log(`  ${sender}: ${entry.message} (${timeAgo}s ago)`);
    });
  }
}

// Helper function to preserve the command line state when logging
function safeLog(message) {
  // Save current line and cursor position
  const currentLine = rl.line;
  const cursorPos = rl.cursor;
  
  // Clear current line
  readline.clearLine(process.stdout, 0);
  readline.cursorTo(process.stdout, 0);
  
  // Print the message
  console.log(message);
  
  // Restore the prompt and current line
  rl.prompt(true);
  rl.write(currentLine);
  
  // Restore cursor position
  readline.cursorTo(process.stdout, cursorPos);
}

// Replace console.log with safeLog for specific message types
const originalConsoleLog = console.log;
console.log = function() {
  const args = Array.from(arguments);
  const message = args.join(' ');
  
  // Check if we're in an interactive context (readline is active)
  if (rl && rl.line && process.stdin.isTTY) {
    safeLog(message);
  } else {
    originalConsoleLog.apply(console, args);
  }
};

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