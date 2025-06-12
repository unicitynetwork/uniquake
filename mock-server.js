const express = require('express');
const path = require('path');
const http = require('http');
const fs = require('fs');
const url = require('url');
const async = require('async');
const crc32 = require('buffer-crc32');
const zlib = require('zlib');
const send = require('send');

const app = express();
const port = 8080;

// Get master server URL from environment variable or use default
const DEFAULT_MASTER_SERVER = process.env.MASTER_SERVER_URL || 'ws://localhost:27950';

console.log(`Using default master server: ${DEFAULT_MASTER_SERVER}`);
console.log(`You can override this by setting the MASTER_SERVER_URL environment variable`);
console.log(`Example: MASTER_SERVER_URL=ws://your-server-ip:27950 npm run browser-mock`);

// Content server configuration
const ASSETS_ROOT = path.join(__dirname, 'fresh_quakejs/base');
const validAssets = ['.pk3', '.run', '.sh'];
let currentManifest = null;
let currentManifestTimestamp = new Date();

// Content server functions
function getAssets() {
  const wrench = require('wrench');
  try {
    return wrench.readdirSyncRecursive(ASSETS_ROOT).filter(function (file) {
      const ext = path.extname(file);
      return validAssets.indexOf(ext) !== -1;
    }).map(function (file) {
      return path.join(ASSETS_ROOT, file);
    });
  } catch (err) {
    console.warn('Assets directory not found, returning empty array:', err.message);
    return [];
  }
}

function generateManifest(callback) {
  console.log('Generating asset manifest from', ASSETS_ROOT);
  
  const assets = getAssets();
  const start = Date.now();

  if (assets.length === 0) {
    console.warn('No assets found, creating empty manifest');
    return callback(null, []);
  }

  async.map(assets, function (file, cb) {
    console.log('Processing', file);

    const name = path.relative(ASSETS_ROOT, file);
    let crc = crc32.unsigned('');
    let compressed = 0;
    let size = 0;

    const stream = fs.createReadStream(file);
    const gzip = zlib.createGzip();

    stream.on('error', function (err) {
      cb(err);
    });
    stream.on('data', function (data) {
      crc = crc32.unsigned(data, crc);
      size += data.length;
      gzip.write(data);
    });
    stream.on('end', function () {
      gzip.end();
    });

    gzip.on('data', function (data) {
      compressed += data.length;
    });
    gzip.on('end', function () {
      cb(null, {
        name: name,
        compressed: compressed,
        checksum: crc
      });
    });
  }, function (err, entries) {
    if (err) return callback(err);
    console.log(`Generated manifest (${entries.length} entries) in ${(Date.now() - start) / 1000} seconds`);
    callback(err, entries);
  });
}

// Initialize manifest
generateManifest(function(err, manifest) {
  if (err) {
    console.error('Failed to generate manifest:', err);
    currentManifest = [];
  } else {
    currentManifest = manifest;
    currentManifestTimestamp = new Date();
    console.log('Asset manifest ready with', manifest.length, 'entries');
  }
});

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

// Asset serving routes (content server functionality)
// Serve manifest at both /assets/ and root paths
app.get('/manifest.json', function(req, res) {
  console.log('Serving manifest to', req.ip, 'via', req.path);
  
  res.setHeader('Cache-Control', 'public, max-age=60, must-revalidate');
  res.setHeader('Last-Modified', currentManifestTimestamp.toUTCString());
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  res.json(currentManifest || []);
});

app.get('/assets/manifest.json', function(req, res) {
  console.log('Serving manifest to', req.ip, 'via', req.path);
  
  res.setHeader('Cache-Control', 'public, max-age=60, must-revalidate');
  res.setHeader('Last-Modified', currentManifestTimestamp.toUTCString());
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  res.json(currentManifest || []);
});

// Serve assets from /assets/* path
app.get('/assets/*', function(req, res) {
  const assetPath = req.params[0]; // This will be like "baseq3/pak0.pk3"
  const fullPath = path.join(ASSETS_ROOT, assetPath);
  
  console.log('Serving asset:', assetPath, 'to', req.ip);
  
  // Set CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  // Check if file exists
  if (!fs.existsSync(fullPath)) {
    return res.status(404).send('Asset not found');
  }
  
  // Use send module to serve the file with proper headers
  send(req, assetPath, { root: ASSETS_ROOT })
    .on('error', function(err) {
      console.error('Error serving asset:', err);
      res.status(err.status || 500).send('Error serving asset');
    })
    .pipe(res);
});

// Serve assets with checksum validation (original content server format)
app.get(/^\/assets\/(.+\/|)(\d+)-(.+?)$/, function(req, res) {
  const basedir = req.params[0] || '';
  const checksum = parseInt(req.params[1], 10);
  const basename = req.params[2];
  const relativePath = path.join(basedir, basename);
  const absolutePath = path.join(ASSETS_ROOT, relativePath);

  console.log('Serving asset with checksum validation:', relativePath, 'checksum:', checksum, 'to', req.ip);

  // Validate asset against manifest
  let asset = null;
  for (let i = 0; i < (currentManifest || []).length; i++) {
    const entry = currentManifest[i];
    if (entry.name === relativePath && entry.checksum === checksum) {
      asset = entry;
      break;
    }
  }

  if (!asset) {
    console.log('Asset not found in manifest or checksum mismatch:', relativePath, checksum);
    return res.status(400).send('Invalid asset or checksum');
  }

  // Set CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'public, max-age=31536000'); // 1 year cache

  // Check if file exists
  if (!fs.existsSync(absolutePath)) {
    return res.status(404).send('Asset file not found');
  }

  // Send the file
  res.sendFile(absolutePath);
});

// Serve assets from /baseq3/* path (fallback for direct access)
app.get('/baseq3/*', function(req, res) {
  const fileName = req.params[0]; // This will be like "pak0.pk3"
  const assetPath = 'baseq3/' + fileName; // Make it "baseq3/pak0.pk3"
  const fullPath = path.join(ASSETS_ROOT, assetPath);
  
  console.log('Serving asset (direct):', assetPath, 'to', req.ip);
  
  // Set CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  // Check if file exists
  if (!fs.existsSync(fullPath)) {
    return res.status(404).send('Asset not found');
  }
  
  // Use send module to serve the file with proper headers
  send(req, assetPath, { root: ASSETS_ROOT })
    .on('error', function(err) {
      console.error('Error serving asset:', err);
      res.status(err.status || 500).send('Error serving asset');
    })
    .pipe(res);
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
  let masterServer = 'localhost:27950';
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
  
  // Get the current host from the request to serve assets locally
  const currentHost = req.get('host') || 'localhost:8080';
  
  // Set up locals for template rendering
  res.locals = {
    content: currentHost,  // Use current host without /assets path - let Quake handle the pathing
    useWebRTC: false,  // Disable WebRTC, use plain WebSockets
    masterServer: masterServer,
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