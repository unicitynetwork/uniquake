#!/usr/bin/env node

const WebSocket = require('ws');

const ws = new WebSocket('ws://localhost:27950');

ws.on('open', () => {
  console.log('Connected to master server');
  
  // List servers first
  ws.send(JSON.stringify({
    type: 'list_servers',
    requestId: 1
  }));
});

ws.on('message', (data) => {
  const msg = JSON.parse(data.toString());
  console.log('Received:', msg);
  
  if (msg.type === 'list_servers_response' && msg.servers && msg.servers.length > 0) {
    const gameId = msg.servers[0].gameId;
    console.log('Testing RCON on server:', gameId);
    
    // Send RCON status command
    ws.send(JSON.stringify({
      type: 'rcon_command',
      requestId: 2,
      gameId: gameId,
      command: 'status'
    }));
  }
});

ws.on('error', (err) => {
  console.error('WebSocket error:', err);
});

setTimeout(() => {
  console.log('Closing connection...');
  ws.close();
}, 15000);