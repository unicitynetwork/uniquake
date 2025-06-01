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
    
    // Handle WebSocket fallback transport
    if (req.path === '/websocket-fallback.js') {
      const filePath = path.join(clientPath, 'websocket-fallback.js');
      
      fs.readFile(filePath, 'utf8', (err, data) => {
        if (err) {
          console.error('Error serving WebSocket fallback transport:', err);
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
            useWebRTC: config.useWebRTC !== false,
            masterServer: config.masterServer || 'ws://localhost:27950',
            detectWebRTC: config.detectWebRTC !== false,
            fallbackToWebSocket: config.fallbackToWebSocket !== false,
            iceServers: [
              { urls: 'stun:stun.l.google.com:19302' },
              { urls: 'stun1.l.google.com:19302' }
            ]
          })}`
        );
        
        res.setHeader('Content-Type', 'application/javascript');
        res.send(configuredData);
      });
      return;
    }
    
    // Handle transport detector script
    if (req.path === '/transport-detector.js') {
      res.setHeader('Content-Type', 'application/javascript');
      res.send(`
        /**
         * Transport detector for UniQuake
         * Detects WebRTC support and loads the appropriate transport
         */
        (function() {
          // Check if WebRTC is supported
          function detectWebRTC() {
            return (
              typeof RTCPeerConnection !== 'undefined' &&
              typeof RTCSessionDescription !== 'undefined' &&
              typeof RTCIceCandidate !== 'undefined'
            );
          }
          
          // Initialize the appropriate transport
          function initTransport() {
            var hasWebRTC = detectWebRTC();
            console.log('WebRTC support detected:', hasWebRTC);
            
            // Load the appropriate script
            var script = document.createElement('script');
            
            if (hasWebRTC && window.UNIQUAKE_CONFIG.useWebRTC) {
              script.src = '/webrtc-adapter.js';
              script.onload = function() {
                console.log('WebRTC adapter loaded');
                if (window.initWebRTC) {
                  window.initWebRTC(window.UNIQUAKE_CONFIG);
                }
              };
            } else {
              script.src = '/websocket-fallback.js';
              script.onload = function() {
                console.log('WebSocket fallback transport loaded');
                if (window.initWebSocketFallback) {
                  window.initWebSocketFallback(window.UNIQUAKE_CONFIG);
                }
              };
            }
            
            // Handle errors
            script.onerror = function(err) {
              console.error('Failed to load transport adapter:', err);
            };
            
            // Add to document
            document.head.appendChild(script);
          }
          
          // Initialize when config is loaded
          if (window.UNIQUAKE_CONFIG) {
            initTransport();
          } else {
            // Wait for config to be loaded
            var checkInterval = setInterval(function() {
              if (window.UNIQUAKE_CONFIG) {
                clearInterval(checkInterval);
                initTransport();
              }
            }, 50);
          }
        })();
      `);
      return;
    }
    
    next();
  };
};