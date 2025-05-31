/**
 * Express middleware for serving WebRTC client files
 */

const fs = require('fs');
const path = require('path');

/**
 * Create middleware for serving WebRTC client files
 * @param {Object} config - Configuration options
 * @returns {Function} Express middleware
 */
module.exports = function createClientFilesMiddleware(config = {}) {
  const clientPath = path.join(__dirname, 'client');
  
  return function(req, res, next) {
    // Handle WebRTC adapter
    if (req.path === '/webrtc-adapter.js') {
      const filePath = path.join(clientPath, 'webrtc-adapter.js');
      
      fs.readFile(filePath, 'utf8', (err, data) => {
        if (err) {
          console.error('Error serving WebRTC adapter:', err);
          return next();
        }
        
        res.setHeader('Content-Type', 'application/javascript');
        res.send(data);
      });
      return;
    }
    
    // Handle WebRTC loader
    if (req.path === '/webrtc-loader.js') {
      const filePath = path.join(clientPath, 'webrtc-loader.js');
      
      fs.readFile(filePath, 'utf8', (err, data) => {
        if (err) {
          console.error('Error serving WebRTC loader:', err);
          return next();
        }
        
        // Replace configuration placeholders
        const configuredData = data.replace(
          /window\.UNIQUAKE_CONFIG\s*=\s*\{[^}]*\}/,
          `window.UNIQUAKE_CONFIG = ${JSON.stringify({
            useWebRTC: true,
            masterServer: config.masterServer || 'ws://localhost:27950',
            iceServers: [
              { urls: 'stun:stun.l.google.com:19302' },
              { urls: 'stun:stun1.l.google.com:19302' }
            ]
          })}`
        );
        
        res.setHeader('Content-Type', 'application/javascript');
        res.send(configuredData);
      });
      return;
    }
    
    next();
  };
};