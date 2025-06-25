const express = require('express');
const path = require('path');
const http = require('http');
const https = require('https');
const fs = require('fs');
const url = require('url');
const config = require('./lib/config');

const app = express();
let httpsPort = config.httpsPort;
let httpPort = config.httpPort;

// Debug SSL configuration
console.log('SSL Configuration Debug:');
console.log('- SSL Cert Path:', config.sslCertPath);
console.log('- SSL Key Path:', config.sslKeyPath);
console.log('- SSL Available:', config.sslAvailable);
console.log('- SSL Explicitly Disabled:', config.sslExplicitlyDisabled);
console.log('- HTTPS Port:', httpsPort);
console.log('- HTTP Port:', httpPort);

// Determine which port to use based on SSL availability
let port;
if (config.sslAvailable) {
  // When SSL is available, main server will be HTTPS on 443
  port = httpsPort;
} else {
  // No SSL, use HTTP port 80 by default
  port = httpPort;
}

// Add compression middleware (matching original content server)
app.use(function (req, res, next) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  next();
});

// Trust proxy headers when behind a reverse proxy
app.set('trust proxy', true);

// Get master server URL from environment variable or use default
const DEFAULT_MASTER_SERVER = process.env.MASTER_SERVER_URL || config.masterServerWs;
const DEFAULT_MASTER_SERVER_WSS = process.env.MASTER_SERVER_URL_WSS || config.masterServerWss;

console.log(`Using default master server: ${DEFAULT_MASTER_SERVER}`);
console.log(`Using secure master server: ${DEFAULT_MASTER_SERVER_WSS}`);
console.log(`You can override this by setting the MASTER_SERVER_URL environment variable`);
console.log(`Example: MASTER_SERVER_URL=ws://your-server-ip:27950 npm run browser-mock`);




// Serve static files from root directory
app.use(express.static(__dirname));

// Serve client files from lib/client
app.use('/lib/client', express.static(path.join(__dirname, 'lib/client')));

// Define routes for the application
app.get('/', function(req, res) {
  // Determine if we're serving over HTTPS
  const isSecure = req.secure || req.headers['x-forwarded-proto'] === 'https';
  
  // Get the master server URL from query parameter or use default based on protocol
  let masterServer;
  if (req.query.master) {
    masterServer = req.query.master;
  } else if (isSecure && DEFAULT_MASTER_SERVER_WSS) {
    masterServer = DEFAULT_MASTER_SERVER_WSS;
  } else {
    masterServer = DEFAULT_MASTER_SERVER;
  }
  
  // Read the client.html file
  fs.readFile(path.join(__dirname, 'client.html'), 'utf8', function(err, data) {
    if (err) {
      return res.status(500).send('Error loading client page');
    }
    
    // Replace the default master server URL with the provided one
    // This matches the pattern in window.UNIQUAKE_CONFIG
    let modifiedHtml = data.replace(
      /masterServer:\s*['"]ws:\/\/localhost:27950['"]/g, 
      `masterServer: '${masterServer}'`
    );
    
    // Also update serverAddress if using HTTPS
    if (isSecure && DEFAULT_MASTER_SERVER_WSS) {
      modifiedHtml = modifiedHtml.replace(
        /serverAddress:\s*['"]ws:\/\/localhost:27960['"]/g,
        `serverAddress: 'wss://${config.hostIp}:28960'`
      );
    }
    
    // Send the modified HTML
    res.send(modifiedHtml);
  });
});

// Modified client route to support master server URL parameter
app.get('/client', function(req, res) {
  // Determine if we're serving over HTTPS
  const isSecure = req.secure || req.headers['x-forwarded-proto'] === 'https';
  
  // Get the master server URL from query parameter or use default based on protocol
  let masterServer;
  if (req.query.master) {
    masterServer = req.query.master;
  } else if (isSecure && DEFAULT_MASTER_SERVER_WSS) {
    masterServer = DEFAULT_MASTER_SERVER_WSS;
  } else {
    masterServer = DEFAULT_MASTER_SERVER;
  }
  
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
  // Determine if we're serving over HTTPS
  const isSecure = req.secure || req.headers['x-forwarded-proto'] === 'https';
  
  // Get the master server URL from query parameter or use default based on protocol
  let masterServer;
  if (req.query.master) {
    masterServer = req.query.master;
  } else if (isSecure && DEFAULT_MASTER_SERVER_WSS) {
    masterServer = DEFAULT_MASTER_SERVER_WSS;
  } else {
    masterServer = DEFAULT_MASTER_SERVER;
  }
  
  // Read the server.html file
  fs.readFile(path.join(__dirname, 'server.html'), 'utf8', function(err, data) {
    if (err) {
      return res.status(500).send('Error loading server page');
    }
    
    // Replace the default master server URL with the provided one
    let modifiedHtml = data.replace(
      /masterServer: ['"]ws:\/\/localhost:27950['"]/g, 
      `masterServer: '${masterServer}'`
    );
    
    // Also replace the fallback pattern in BrowserMockServer constructor
    modifiedHtml = modifiedHtml.replace(
      /window\.UNIQUAKE_CONFIG\.masterServer \|\| ['"]ws:\/\/localhost:27950['"]/g,
      `window.UNIQUAKE_CONFIG.masterServer || '${masterServer}'`
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
  // Determine if we're serving over HTTPS
  const isSecure = req.secure || req.headers['x-forwarded-proto'] === 'https';
  
  // Read the web.json file
  fs.readFile(path.join(__dirname, 'bin/web.json'), 'utf8', function(err, data) {
    if (err) {
      return res.status(500).send('Error loading web.json');
    }
    
    // Parse the JSON
    let webConfig = JSON.parse(data);
    
    // Update content server port if using HTTPS
    if (isSecure && config.sslAvailable) {
      // Change port 9000 to 9001 for HTTPS
      webConfig.content = webConfig.content.replace(':9000', ':9001');
      // Update master server to use secure port
      webConfig.masterServer = webConfig.masterServer.replace(':27950', ':27951');
    }
    
    // Send the modified JSON
    res.json(webConfig);
  });
});

// Add a route to serve the index.ejs file
app.get('/index.ejs', function(req, res) {
  res.sendfile(path.join(__dirname, 'bin/index.ejs'));
});

// Handle the root path for the Quake game
app.get('/quake', function(req, res) {
  // Determine if we're serving over HTTPS
  const isSecure = req.secure || req.headers['x-forwarded-proto'] === 'https';
  
  // Extract cmdline parameter from query string
  const cmdline = req.query.cmdline || '';
  
  // Get the master server URL from query parameter or use default based on protocol
  let rawMaster;
  if (req.query.master) {
    rawMaster = req.query.master;
  } else if (isSecure && DEFAULT_MASTER_SERVER_WSS) {
    rawMaster = DEFAULT_MASTER_SERVER_WSS;
  } else {
    rawMaster = DEFAULT_MASTER_SERVER;
  }
  
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
  
  // Determine content server address based on protocol
  let contentServer = config.contentServerAddress;
  if (isSecure && config.sslAvailable) {
    // Use HTTPS content server port (9001 instead of 9000)
    contentServer = contentServer.replace(':9000', ':9001');
  }
  
  // Set up locals for template rendering
  res.locals = {
    content: contentServer,  // QuakeJS expects host:port (no protocol)
    useWebRTC: false,  // Disable WebRTC, use plain WebSockets
    masterServer: masterServer,           // QuakeJS expects host:port (no protocol)
    // Pass any command line parameters directly to the template
    cmdline: cmdline,
    // Pass protocol info for the game to use
    isSecure: isSecure && config.sslAvailable
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

// RCON Console route
app.get('/rcon', function(req, res) {
  // Determine if we're serving over HTTPS
  const isSecure = req.secure || req.headers['x-forwarded-proto'] === 'https';
  
  // Get the master server URL from query parameter or use default based on protocol
  let masterServer;
  if (req.query.master) {
    masterServer = req.query.master;
  } else if (isSecure && DEFAULT_MASTER_SERVER_WSS) {
    masterServer = DEFAULT_MASTER_SERVER_WSS;
  } else {
    masterServer = DEFAULT_MASTER_SERVER;
  }
  
  // Read the rcon.html file
  fs.readFile(path.join(__dirname, 'rcon.html'), 'utf8', function(err, data) {
    if (err) {
      return res.status(500).send('Error loading RCON console page');
    }
    
    // Replace the default master server URL with the provided one
    const modifiedHtml = data.replace(
      /value="ws:\/\/localhost:27950"/g, 
      `value="${masterServer}"`
    );
    
    // Send the modified HTML
    res.send(modifiedHtml);
  });
});

// Proxy request to game (handle as if we're the web server)
app.get('/ioquake3.js', function(req, res) {
  res.sendfile(path.join(__dirname, 'build/ioquake3.js'));
});

app.get('/ioq3ded.js', function(req, res) {
  res.sendfile(path.join(__dirname, 'build/ioq3ded.js'));
});

// Start server
if (config.sslAvailable) {
  // Create HTTPS server with SSL certificates
  const httpsOptions = {
    cert: fs.readFileSync(config.sslCertPath),
    key: fs.readFileSync(config.sslKeyPath)
  };
  
  const httpsServer = https.createServer(httpsOptions, app);
  httpsServer.listen(httpsPort, function() {
    console.log('======================================================');
    console.log('Mock server listening on HTTPS port ' + httpsPort);
    console.log('Client URL: https://' + config.hostIp + (httpsPort !== 443 ? ':' + httpsPort : '') + '/client');
    console.log('Server URL: https://' + config.hostIp + (httpsPort !== 443 ? ':' + httpsPort : '') + '/server');
    console.log('RCON Console: https://' + config.hostIp + (httpsPort !== 443 ? ':' + httpsPort : '') + '/rcon');
    console.log('Quake Game: https://' + config.hostIp + (httpsPort !== 443 ? ':' + httpsPort : '') + '/quake');
    console.log('');
    console.log('SSL Certificates loaded from:');
    console.log('- Certificate: ' + config.sslCertPath);
    console.log('- Private Key: ' + config.sslKeyPath);
    console.log('');
    console.log('Master server configuration:');
    console.log(`- HTTP/WS: ${DEFAULT_MASTER_SERVER}`);
    console.log(`- HTTPS/WSS: ${DEFAULT_MASTER_SERVER_WSS || 'Not available'}`);
    console.log('- Override via URL: append ?master=wss://host:port to the URLs');
    console.log('Example: https://' + config.hostIp + '/client?master=wss://example.com:27951');
    console.log('Example: https://' + config.hostIp + '/server?master=wss://example.com:27951');
    console.log('Example: https://' + config.hostIp + '/rcon?master=wss://example.com:27951');
    console.log('');
    console.log('Content server configuration:');
    console.log(`- HTTP: ${config.contentServerAddress}`);
    console.log(`- HTTPS: ${config.contentServerAddress.replace(':9000', ':9001')}`);
    console.log('======================================================');
  });
  
  // Create HTTP redirect server on port 80
  const redirectApp = express();
  redirectApp.use((req, res) => {
    const httpsUrl = 'https://' + req.headers.host.split(':')[0] + 
                     (httpsPort !== 443 ? ':' + httpsPort : '') + 
                     req.originalUrl;
    res.redirect(301, httpsUrl);
  });
  
  const httpServer = http.createServer(redirectApp);
  httpServer.listen(httpPort, function() {
    console.log('HTTP redirect server listening on port ' + httpPort + ' -> redirecting to HTTPS');
  });
  
} else {
  // No SSL available, create standard HTTP server
  const server = http.createServer(app);
  server.listen(port, function() {
    const baseUrl = 'http://' + config.hostIp + (port !== 80 ? ':' + port : '');
    console.log('======================================================');
    console.log('Mock server listening on HTTP port ' + port);
    console.log('Client URL: ' + baseUrl + '/client');
    console.log('Server URL: ' + baseUrl + '/server');
    console.log('RCON Console: ' + baseUrl + '/rcon');
    console.log('Quake Game: ' + baseUrl + '/quake');
    console.log('');
    console.log('SSL not enabled. To enable HTTPS:');
    console.log('1. Install SSL certificates (e.g., using Let\'s Encrypt)');
    console.log('2. Set SSL_CERT_PATH and SSL_KEY_PATH in .env file');
    console.log('3. Or place certificates at default location:');
    console.log('   - ' + config.sslCertPath);
    console.log('   - ' + config.sslKeyPath);
    console.log('');
    console.log('Master server configuration:');
    console.log(`- HTTP/WS: ${DEFAULT_MASTER_SERVER}`);
    console.log('- Override via URL: append ?master=ws://host:port to the URLs');
    console.log('Example: ' + baseUrl + '/client?master=ws://example.com:27950');
    console.log('Example: ' + baseUrl + '/server?master=ws://example.com:27950');
    console.log('Example: ' + baseUrl + '/rcon?master=ws://example.com:27950');
    console.log('');
    console.log('Content server configuration:');
    console.log(`- HTTP: ${config.contentServerAddress}`);
    console.log('======================================================');
  });
}