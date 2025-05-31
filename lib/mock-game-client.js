#!/usr/bin/env node

/**
 * Mock Game Client for testing WebRTC P2P connections
 * 
 * This script simulates a game client connecting to the master server,
 * retrieving the server list, and connecting to a game server via WebRTC.
 */

const WebSocket = require('ws');
const readline = require('readline');

// Mock WebRTC - We'll simulate WebRTC behavior for testing
const MockRTC = {
  RTCPeerConnection: class MockRTCPeerConnection {
    constructor(config) {
      this.config = config;
      this.localDescription = null;
      this.remoteDescription = null;
      this.iceConnectionState = 'new';
      this.dataChannels = [];
      
      // Event handlers
      this.onicecandidate = null;
      this.oniceconnectionstatechange = null;
      this.ondatachannel = null;
      
      // Simulate ICE candidates after a delay
      setTimeout(() => this._generateIceCandidates(), 500);
    }
    
    // Create a data channel
    createDataChannel(label, options) {
      const channel = new MockRTC.RTCDataChannel(label, options);
      this.dataChannels.push(channel);
      return channel;
    }
    
    // Set local description
    async setLocalDescription(description) {
      this.localDescription = description;
      return Promise.resolve();
    }
    
    // Set remote description
    async setRemoteDescription(description) {
      this.remoteDescription = description;
      
      // When we have both local and remote descriptions, simulate connection
      if (this.localDescription && this.remoteDescription) {
        setTimeout(() => {
          this._simulateConnection();
        }, 1000);
        
        // Also simulate a data channel if we're answering
        if (description.type === 'offer' && this.ondatachannel) {
          const channel = new MockRTC.RTCDataChannel('game', {});
          setTimeout(() => {
            this.ondatachannel({ channel });
          }, 200);
        }
      }
      
      return Promise.resolve();
    }
    
    // Create an offer
    async createOffer() {
      return Promise.resolve({ type: 'offer', sdp: 'mock-sdp-offer-' + Date.now() });
    }
    
    // Create an answer
    async createAnswer() {
      return Promise.resolve({ type: 'answer', sdp: 'mock-sdp-answer-' + Date.now() });
    }
    
    // Add ICE candidate
    async addIceCandidate(candidate) {
      return Promise.resolve();
    }
    
    // Close the connection
    close() {
      this._updateIceConnectionState('closed');
      this.dataChannels.forEach(channel => channel._close());
    }
    
    // Generate mock ICE candidates
    _generateIceCandidates() {
      if (this.onicecandidate) {
        // Generate a few candidates
        for (let i = 0; i < 3; i++) {
          setTimeout(() => {
            this.onicecandidate({
              candidate: {
                candidate: `mock-ice-candidate-${i}`,
                sdpMid: 'data',
                sdpMLineIndex: 0
              }
            });
          }, i * 200);
        }
        
        // Signal end of candidates
        setTimeout(() => {
          this.onicecandidate({ candidate: null });
        }, 800);
      }
    }
    
    // Simulate connection state changes
    _simulateConnection() {
      this._updateIceConnectionState('checking');
      
      setTimeout(() => {
        this._updateIceConnectionState('connected');
        
        // Open all data channels
        this.dataChannels.forEach(channel => channel._open());
      }, 1500);
    }
    
    // Update ICE connection state
    _updateIceConnectionState(state) {
      this.iceConnectionState = state;
      if (this.oniceconnectionstatechange) {
        this.oniceconnectionstatechange();
      }
    }
  },
  
  RTCSessionDescription: class MockRTCSessionDescription {
    constructor(init) {
      this.type = init.type;
      this.sdp = init.sdp;
    }
  },
  
  RTCIceCandidate: class MockRTCIceCandidate {
    constructor(init) {
      this.candidate = init.candidate;
      this.sdpMid = init.sdpMid;
      this.sdpMLineIndex = init.sdpMLineIndex;
    }
  },
  
  RTCDataChannel: class MockRTCDataChannel {
    constructor(label, options) {
      this.label = label;
      this.options = options;
      this.readyState = 'connecting';
      
      // Event handlers
      this.onopen = null;
      this.onmessage = null;
      this.onclose = null;
      this.onerror = null;
    }
    
    // Send a message
    send(data) {
      console.log(`[Mock] DataChannel sent: ${data.substr ? data.substr(0, 30) + '...' : data}`);
      return true;
    }
    
    // Close the channel
    close() {
      this._close();
    }
    
    // Internal open method
    _open() {
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
    
    // Simulate receiving a message
    _receiveMessage(data) {
      if (this.onmessage) {
        this.onmessage({ data });
      }
    }
  }
};

// Use the mock WebRTC classes
const { RTCPeerConnection, RTCSessionDescription, RTCIceCandidate } = MockRTC;

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
  connection: null,
  peerConnection: null,
  dataChannel: null,
  signaling: null,
  latencyInterval: null,
  connected: false,
  connectedServerPeerId: null,
  serverList: [],
  pingResults: [],
  iceServers: null
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
  
  sendToMaster({
    type: 'connect_to_server',
    peerId: peerId
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
      
      // Store ice servers if provided
      if (message.iceServers) {
        clientState.iceServers = message.iceServers;
        log('ICE servers:', clientState.iceServers);
      }
      break;
      
    case 'server_list':
      handleServerList(message);
      break;
      
    case 'ice_config':
      // Update ICE servers config
      if (message.iceServers) {
        clientState.iceServers = message.iceServers;
        log('Updated ICE servers:', clientState.iceServers);
      }
      break;
      
    case 'offer':
      handleOffer(message);
      break;
      
    case 'answer':
      handleAnswer(message);
      break;
      
    case 'ice_candidate':
      handleIceCandidate(message);
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
 * Create RTCPeerConnection
 */
function createPeerConnection(connectionId) {
  // Use provided ICE servers or fallback to default
  const config = {
    iceServers: clientState.iceServers?.iceServers || [
      { urls: 'stun:stun.l.google.com:19302' }
    ]
  };
  
  const peerConnection = new RTCPeerConnection(config);
  
  // Handle ICE candidates
  peerConnection.onicecandidate = (event) => {
    if (event.candidate) {
      sendToMaster({
        type: 'ice_candidate',
        targetId: clientState.connectedServerPeerId,
        connectionId: connectionId,
        candidate: event.candidate
      });
    }
  };
  
  // Connection state changes
  peerConnection.oniceconnectionstatechange = () => {
    log(`ICE connection state: ${peerConnection.iceConnectionState}`);
    
    if (peerConnection.iceConnectionState === 'connected' || 
        peerConnection.iceConnectionState === 'completed') {
      // Connection established
      clientState.connected = true;
      console.log('WebRTC connection established');
      
      // Notify master server of successful connection
      sendToMaster({
        type: 'connection_success',
        connectionId: connectionId
      });
      
      // Start ping test
      startPingTest();
    } else if (peerConnection.iceConnectionState === 'failed' || 
               peerConnection.iceConnectionState === 'disconnected' || 
               peerConnection.iceConnectionState === 'closed') {
      // Connection failed or closed
      handleDisconnect(peerConnection.iceConnectionState);
      
      // Notify master server if failed
      if (peerConnection.iceConnectionState === 'failed') {
        sendToMaster({
          type: 'connection_failed',
          connectionId: connectionId,
          error: 'ICE connection failed'
        });
      }
    }
  };
  
  // Handle data channels
  peerConnection.ondatachannel = (event) => {
    setupDataChannel(event.channel);
  };
  
  return peerConnection;
}

/**
 * Set up data channel handlers
 */
function setupDataChannel(dataChannel) {
  clientState.dataChannel = dataChannel;
  
  dataChannel.onopen = () => {
    console.log('Data channel open');
    clientState.connected = true;
  };
  
  dataChannel.onmessage = (event) => {
    try {
      const message = JSON.parse(event.data);
      handleDataChannelMessage(message);
    } catch (err) {
      // If not JSON, treat as raw data
      console.log(`Received raw data: ${event.data}`);
    }
  };
  
  dataChannel.onclose = () => {
    console.log('Data channel closed');
    handleDisconnect('channel_closed');
  };
  
  dataChannel.onerror = (error) => {
    console.error('Data channel error:', error);
  };
}

/**
 * Handle messages received through the data channel
 */
function handleDataChannelMessage(message) {
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
      log(`Unhandled data channel message: ${message.type}`);
      break;
  }
}

/**
 * Handle disconnection
 */
function handleDisconnect(reason) {
  if (!clientState.connected) return;
  
  console.log(`Disconnected from server (${reason})`);
  
  // Stop ping test
  if (clientState.latencyInterval) {
    clearInterval(clientState.latencyInterval);
    clientState.latencyInterval = null;
  }
  
  // Reset connection state
  clientState.connected = false;
  clientState.connectedServerPeerId = null;
  clientState.connection = null;
  
  // Close peer connection
  if (clientState.peerConnection) {
    clientState.peerConnection.close();
    clientState.peerConnection = null;
  }
  
  // Clear data channel
  clientState.dataChannel = null;
  
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
    if (clientState.dataChannel && clientState.dataChannel.readyState === 'open') {
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
 * Send a message to the game server via data channel
 */
function sendMessage(message) {
  if (!clientState.dataChannel || clientState.dataChannel.readyState !== 'open') {
    console.warn('Cannot send message: data channel not open');
    return false;
  }
  
  try {
    clientState.dataChannel.send(JSON.stringify(message));
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
  Server ID: ${clientState.connectedServerPeerId || 'N/A'}
  Ping: ${clientState.pingResults.length > 0 
    ? `${Math.round(clientState.pingResults.reduce((a, b) => a + b, 0) / clientState.pingResults.length)}ms` 
    : 'N/A'}
  `);
}

// Start client
console.log(`Starting WebRTC game client: ${clientInfo.name}`);
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