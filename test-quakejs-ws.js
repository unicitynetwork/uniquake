#!/usr/bin/env node

const WebSocket = require('ws');

const host = process.argv[2] || 'uniquake-dev.dyndns.org';
const port = process.argv[3] || '27961';

console.log(`Connecting to ws://${host}:${port}...`);

// Use the same options as QuakeJS
const ws = new WebSocket(`ws://${host}:${port}`, {
  headers: { 'websocket-protocol': ['binary'] }
});

ws.binaryType = 'arraybuffer';

// Helper to format OOB packets
function formatOOB(data) {
  const str = '\xff\xff\xff\xff' + data + '\x00';
  const buffer = new ArrayBuffer(str.length);
  const view = new Uint8Array(buffer);
  
  for (let i = 0; i < str.length; i++) {
    view[i] = str.charCodeAt(i);
  }
  
  return buffer;
}

// Helper to strip OOB header
function stripOOB(buffer) {
  const view = new DataView(buffer);
  
  if (view.getInt32(0) !== -1) {
    return null;
  }
  
  let str = '';
  for (let i = 4; i < buffer.byteLength - 1; i++) {
    const c = String.fromCharCode(view.getUint8(i));
    str += c;
  }
  
  return str;
}

ws.on('open', () => {
  console.log('Connected!');
  
  // Send a port identifier first (optional)
  const portMsg = new ArrayBuffer(10);
  const portView = new Uint8Array(portMsg);
  portView[0] = 255; portView[1] = 255; portView[2] = 255; portView[3] = 255;
  portView[4] = 'p'.charCodeAt(0);
  portView[5] = 'o'.charCodeAt(0);
  portView[6] = 'r'.charCodeAt(0);
  portView[7] = 't'.charCodeAt(0);
  portView[8] = (parseInt(port) >> 8) & 0xff;
  portView[9] = parseInt(port) & 0xff;
  
  ws.send(portMsg);
  console.log('Sent port identifier');
  
  // Try sending a getinfo request
  setTimeout(() => {
    const getinfo = formatOOB('getinfo xxx');
    ws.send(getinfo);
    console.log('Sent getinfo request');
  }, 100);
  
  // Try sending a getstatus request
  setTimeout(() => {
    const getstatus = formatOOB('getstatus');
    ws.send(getstatus);
    console.log('Sent getstatus request');
  }, 200);
});

ws.on('message', (data) => {
  console.log('Received message:', data);
  
  // Handle both Buffer and ArrayBuffer
  let buffer;
  if (data instanceof ArrayBuffer) {
    buffer = data;
  } else if (Buffer.isBuffer(data)) {
    // Convert Node Buffer to ArrayBuffer
    buffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
  } else {
    console.log('Unknown data type:', typeof data);
    return;
  }
  
  const msg = stripOOB(buffer);
  
  if (msg) {
    console.log('OOB message:', msg);
  } else {
    console.log('Non-OOB data:', new Uint8Array(buffer));
  }
});

ws.on('error', (err) => {
  console.error('WebSocket error:', err);
});

ws.on('close', (code, reason) => {
  console.log(`Connection closed: ${code} ${reason}`);
});

// Try more commands
setTimeout(() => {
  // Send a connect request
  const connect = formatOOB('connect');
  ws.send(connect);
  console.log('Sent connect request');
}, 300);

setTimeout(() => {
  // Send a getchallenge request  
  const getchallenge = formatOOB('getchallenge');
  ws.send(getchallenge);
  console.log('Sent getchallenge request');
}, 400);

// Keep the script running
setTimeout(() => {
  console.log('Closing connection...');
  ws.close();
}, 10000);