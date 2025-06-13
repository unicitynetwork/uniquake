const express = require('express');
const path = require('path');
const http = require('http');
const fs = require('fs');
const url = require('url');
const config = require('./lib/config');

const app = express();
const port = config.mockPort;

// Add compression middleware (matching original content server)
app.use(function (req, res, next) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  next();
});

// Get master server URL from environment variable or use default
const DEFAULT_MASTER_SERVER = process.env.MASTER_SERVER_URL || config.masterServerWs;

console.log(`Using default master server: ${DEFAULT_MASTER_SERVER}`);
console.log(`You can override this by setting the MASTER_SERVER_URL environment variable`);
console.log(`Example: MASTER_SERVER_URL=ws://your-server-ip:27950 npm run browser-mock`);




// Serve static files from root directory
app.use(express.static(__dirname));

// Serve client files from lib/client
app.use('/lib/client', express.static(path.join(__dirname, 'lib/client')));

// Define routes for the application
app.get('/', function(req, res) {
  res.sendfile(path.join(__dirname, 'browser-mock-client.html'));
});

// Modified client route to support master server URL parameter
app.get('/client', function(req, res) {
  // Get the master server URL from query parameter or use default
  const masterServer = req.query.master || DEFAULT_MASTER_SERVER;
  
  // Read the client.html file
  fs.readFile(path.join(__dirname, 'client.html'), 'utf8', function(err, data) {
    if (err) {
      return res.status(500).send('Error loading client page');
    }
    
    // Replace the default master server URL with the provided one
    const modifiedHtml = data.replace(
      /masterServer: ['"]ws:\/\/localhost:27950['"]/g, 
      `masterServer: '${masterServer}'`
    );
    
    // Send the modified HTML
    res.send(modifiedHtml);
  });
});

// Modified server route to support master server URL parameter
app.get('/server', function(req, res) {
  // Get the master server URL from query parameter or use default
  const masterServer = req.query.master || DEFAULT_MASTER_SERVER;
  
  // Read the server.html file
  fs.readFile(path.join(__dirname, 'server.html'), 'utf8', function(err, data) {
    if (err) {
      return res.status(500).send('Error loading server page');
    }
    
    // Replace the default master server URL with the provided one
    const modifiedHtml = data.replace(
      /masterServer: ['"]ws:\/\/localhost:27950['"]/g, 
      `masterServer: '${masterServer}'`
    );
    
    // Send the modified HTML
    res.send(modifiedHtml);
  });
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

// Add a route to serve the web.json configuration file
app.get('/web.json', function(req, res) {
  res.sendfile(path.join(__dirname, 'bin/web.json'));
});

// Add a route to serve the index.ejs file
app.get('/index.ejs', function(req, res) {
  res.sendfile(path.join(__dirname, 'bin/index.ejs'));
});

// Handle the root path for the Quake game
app.get('/quake', function(req, res) {
  // Extract cmdline parameter from query string
  const cmdline = req.query.cmdline || '';
  
  // Get the master server URL from query parameter or use default
  const rawMaster = req.query.master || DEFAULT_MASTER_SERVER;
  
  // Convert from WebSocket URL format (ws://host:port) to Quake format (host:port)
  let masterServer = config.masterServerAddress;
  try {
    // Extract hostname and port from WebSocket URL
    if (rawMaster.startsWith('ws://') || rawMaster.startsWith('wss://')) {
      const parsedUrl = new URL(rawMaster);
      masterServer = parsedUrl.host; // host includes hostname and port
    } else {
      // If it's already in host:port format, use it directly
      masterServer = rawMaster;
    }
  } catch (e) {
    console.error('Error parsing master server URL:', e);
  }
  
  console.log(`Using master server ${masterServer} for Quake game`);
  
  // Set up locals for template rendering
  res.locals = {
    content: config.contentServerAddress,  // QuakeJS expects host:port (no protocol)
    useWebRTC: false,  // Disable WebRTC, use plain WebSockets
    masterServer: masterServer,           // QuakeJS expects host:port (no protocol)
    // Pass any command line parameters directly to the template
    cmdline: cmdline
  };
  
  // Convert the EJS template to HTML and send it with proper content type
  const fs = require('fs');
  const ejs = require('ejs');
  const template = fs.readFileSync(path.join(__dirname, 'bin/index.ejs'), 'utf8');
  
  // Render the EJS template with the locals
  const html = ejs.render(template, res.locals, {
    filename: path.join(__dirname, 'bin/index.ejs')
  });
  
  // Set the content type to HTML and send the rendered template
  res.setHeader('Content-Type', 'text/html');
  res.send(html);
});

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
  console.log('======================================================');
  console.log('Mock server listening on port ' + port);
  console.log('Client URL: http://localhost:' + port + '/client');
  console.log('Server URL: http://localhost:' + port + '/server');
  console.log('');
  console.log('Master server configuration:');
  console.log(`- Default (from env): ${DEFAULT_MASTER_SERVER}`);
  console.log('- Override via URL: append ?master=ws://host:port to the URLs');
  console.log('Example: http://localhost:' + port + '/client?master=ws://example.com:27950');
  console.log('Example: http://localhost:' + port + '/server?master=ws://example.com:27950');
  console.log('======================================================');
});