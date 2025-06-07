const express = require('express');
const path = require('path');
const http = require('http');
const fs = require('fs');

const app = express();
const port = 8080;

// Serve static files from root directory
app.use(express.static(__dirname));

// Serve client files from lib/client
app.use('/lib/client', express.static(path.join(__dirname, 'lib/client')));

// Define routes for the application
app.get('/', function(req, res) {
  res.sendfile(path.join(__dirname, 'browser-mock-client.html'));
});

app.get('/client', function(req, res) {
  res.sendfile(path.join(__dirname, 'client.html'));
});

app.get('/server', function(req, res) {
  res.sendfile(path.join(__dirname, 'server.html'));
});

// Serve transport-detector.js
app.get('/transport-detector.js', function(req, res) {
  res.sendfile(path.join(__dirname, 'lib/client/transport-detector.js'));
});

// Serve webrtc-adapter.js
app.get('/webrtc-adapter.js', function(req, res) {
  res.sendfile(path.join(__dirname, 'lib/client/webrtc-adapter.js'));
});

// Serve websocket-fallback.js
app.get('/websocket-fallback.js', function(req, res) {
  res.sendfile(path.join(__dirname, 'lib/client/websocket-fallback.js'));
});

// Serve webrtc-loader.js
app.get('/webrtc-loader.js', function(req, res) {
  res.sendfile(path.join(__dirname, 'lib/client/webrtc-loader.js'));
});

// Serve Quake game files from build directory
app.use('/build', express.static(path.join(__dirname, 'build')));

// Proxy request to game (handle as if we're the web server)
app.get('/ioquake3.js', function(req, res) {
  res.sendfile(path.join(__dirname, 'build/ioquake3.js'));
});

app.get('/ioq3ded.js', function(req, res) {
  res.sendfile(path.join(__dirname, 'build/ioq3ded.js'));
});

// Start server
const server = http.createServer(app);
server.listen(port, function() {
  console.log('Mock server listening on port ' + port);
  console.log('Client URL: http://localhost:' + port + '/client');
  console.log('Server URL: http://localhost:' + port + '/server');
});