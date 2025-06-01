/**
 * WebSocket fallback transport for environments without WebRTC support
 * 
 * This provides a compatibility layer for clients that cannot use WebRTC,
 * allowing them to connect to game servers through the master server as a proxy.
 */

(function(window) {
  'use strict';
  
  /**
   * WebSocket fallback transport
   * Uses a master server as a proxy for game server connections
   */
  class WebSocketTransport {
    /**
     * Create a new WebSocket transport
     * @param {string} url - Server URL (ws://peerId format)
     * @param {Object} protocols - WebSocket protocols (ignored)
     */
    constructor(url, protocols) {
      // Socket state constants (match WebSocket)
      this.CONNECTING = 0;
      this.OPEN = 1;
      this.CLOSING = 2;
      this.CLOSED = 3;
      
      // Current state
      this.readyState = this.CONNECTING;
      this.bufferedAmount = 0;
      
      // Event handlers (will be set by caller)
      this.onopen = null;
      this.onmessage = null;
      this.onclose = null;
      this.onerror = null;
      
      // Extract peer ID from URL
      this.url = url;
      this.peerId = this.extractPeerId(url);
      
      // Connection info
      this.masterConnection = null;
      this.masterUrl = window.UNIQUAKE_CONFIG?.masterServer || 'ws://localhost:27950';
      this.serverPeerId = null;
      this.messageQueue = [];
      this.connected = false;
      
      // Connect to master server
      this.connectToMaster();
    }
    
    /**
     * Extract peer ID from WebSocket URL
     * WebSocket URLs are typically ws://hostname:port
     * We convert this to a peer ID for our transport
     */
    extractPeerId(url) {
      // Look for a peer ID format in the URL
      const peerIdMatch = url.match(/peerId=([^&]+)/);
      if (peerIdMatch) {
        return peerIdMatch[1];
      }
      
      // If no explicit peer ID, extract from hostname:port
      const urlObj = new URL(url.replace('ws://', 'http://'));
      return `${urlObj.hostname}-${urlObj.port}`;
    }
    
    /**
     * Connect to the master server
     */
    connectToMaster() {
      try {
        console.log(`Connecting to master server: ${this.masterUrl}`);
        
        // Create WebSocket connection to master server
        this.masterConnection = new window.OriginalWebSocket(this.masterUrl);
        
        // Set up event handlers
        this.masterConnection.onopen = () => {
          console.log('Connected to master server');
          
          // Request connection to server
          this.requestServerConnection();
        };
        
        this.masterConnection.onmessage = (event) => {
          this.handleMasterMessage(event);
        };
        
        this.masterConnection.onclose = () => {
          console.log('Disconnected from master server');
          
          if (this.readyState === this.CONNECTING || this.readyState === this.OPEN) {
            this.emitError('Master server disconnected');
            this.close();
          }
        };
        
        this.masterConnection.onerror = (error) => {
          console.error('Master connection error:', error);
          this.emitError(`Master connection error: ${error}`);
        };
      } catch (err) {
        console.error('Failed to connect to master server:', err);
        this.emitError(`Failed to connect to master server: ${err.message}`);
        this.close();
      }
    }
    
    /**
     * Request connection to game server
     */
    requestServerConnection() {
      if (!this.masterConnection || this.masterConnection.readyState !== 1) {
        return;
      }
      
      console.log(`Requesting connection to server with peer ID: ${this.peerId}`);
      
      // Send connection request
      this.masterConnection.send(JSON.stringify({
        type: 'connect_to_server',
        peerId: this.peerId,
        useWebSocket: true
      }));
    }
    
    /**
     * Handle messages from the master server
     */
    handleMasterMessage(event) {
      let message;
      
      try {
        message = JSON.parse(event.data);
      } catch (err) {
        console.warn('Invalid message format from master server');
        return;
      }
      
      switch (message.type) {
        case 'connected':
          // Initial connection to master server
          console.log('Received client ID from master:', message.clientId);
          break;
          
        case 'proxy_connection':
          // Successfully created proxy connection to server
          console.log('Proxy connection to server established');
          this.serverPeerId = this.peerId;
          this.readyState = this.OPEN;
          this.connected = true;
          
          // Process queued messages
          this.processQueue();
          
          // Notify connection is open
          this.emitOpen();
          break;
          
        case 'proxy_data':
          // Data from server
          if (message.serverPeerId === this.serverPeerId) {
            // Emit the data to the client application
            this.emitMessage(message.data);
          }
          break;
          
        case 'server_disconnected':
          // Server disconnected
          if (message.serverPeerId === this.serverPeerId) {
            console.log('Server disconnected');
            this.close();
          }
          break;
          
        case 'error':
          // Error message
          console.error('Error from master server:', message.error);
          this.emitError(message.error || 'Error from master server');
          
          if (message.fatal) {
            this.close();
          }
          break;
          
        default:
          console.log('Unhandled message type from master:', message.type);
          break;
      }
    }
    
    /**
     * Process queued messages
     */
    processQueue() {
      if (this.readyState !== this.OPEN) return;
      
      while (this.messageQueue.length > 0) {
        const message = this.messageQueue.shift();
        this.send(message);
      }
    }
    
    /**
     * Send data through the connection
     * @param {string|ArrayBuffer} data - Data to send
     * @returns {boolean} True if sent or queued
     */
    send(data) {
      if (this.readyState === this.CONNECTING) {
        // Queue messages if not yet connected
        this.messageQueue.push(data);
        this.bufferedAmount += data.length || 0;
        return true;
      }
      
      if (this.readyState !== this.OPEN) {
        return false;
      }
      
      try {
        // Send to server via master server proxy
        this.masterConnection.send(JSON.stringify({
          type: 'proxy_message',
          serverPeerId: this.serverPeerId,
          data: data
        }));
        return true;
      } catch (err) {
        console.error('Failed to send data:', err);
        return false;
      }
    }
    
    /**
     * Close the connection
     */
    close() {
      if (this.readyState === this.CLOSED) {
        return;
      }
      
      this.readyState = this.CLOSING;
      
      // Notify master of disconnection if connected
      if (this.connected && this.masterConnection && this.masterConnection.readyState === 1) {
        try {
          this.masterConnection.send(JSON.stringify({
            type: 'disconnect_from_server',
            serverPeerId: this.serverPeerId
          }));
        } catch (e) {
          // Ignore errors during cleanup
        }
      }
      
      // Close master connection
      if (this.masterConnection) {
        this.masterConnection.close();
        this.masterConnection = null;
      }
      
      this.readyState = this.CLOSED;
      this.emitClose();
    }
    
    /**
     * Emit open event
     */
    emitOpen() {
      if (typeof this.onopen === 'function') {
        this.onopen({ target: this });
      }
    }
    
    /**
     * Emit message event
     */
    emitMessage(data) {
      if (typeof this.onmessage === 'function') {
        this.onmessage({ data: data, target: this });
      }
    }
    
    /**
     * Emit close event
     */
    emitClose() {
      if (typeof this.onclose === 'function') {
        this.onclose({ target: this });
      }
    }
    
    /**
     * Emit error event
     */
    emitError(message) {
      if (typeof this.onerror === 'function') {
        this.onerror({ message: message, target: this });
      }
    }
  }
  
  /**
   * Initialize WebSocket fallback transport
   */
  function initWebSocketFallback(config) {
    // Save original WebSocket
    window.OriginalWebSocket = window.WebSocket;
    
    // Store config for access by transport instances
    window.UNIQUAKE_CONFIG = config || {};
    
    // Override WebSocket with our implementation
    window.WebSocket = function(url, protocols) {
      // Only use fallback for game server connections, not master server
      if (url.includes('master')) {
        return new window.OriginalWebSocket(url, protocols);
      }
      
      console.log('Using WebSocket fallback transport for:', url);
      return new WebSocketTransport(url, protocols);
    };
    
    // Add transport to global scope
    window.WebSocketTransport = WebSocketTransport;
    
    console.log('WebSocket fallback transport initialized');
    
    return {
      WebSocketTransport: WebSocketTransport,
      restore: function() {
        window.WebSocket = window.OriginalWebSocket;
      }
    };
  }
  
  // Export to global scope
  window.initWebSocketFallback = initWebSocketFallback;
  
})(window);