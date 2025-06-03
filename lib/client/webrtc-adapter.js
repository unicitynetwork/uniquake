/**
 * WebRTC adapter for UniQuake client
 * 
 * This adapter provides a WebSocket-compatible interface over WebRTC data channels,
 * allowing the game to communicate via P2P connections while maintaining the same API.
 */

(function(window) {
  'use strict';

  /**
   * Polyfill for WebRTC
   */
  const RTCPeerConnection = window.RTCPeerConnection || 
                           window.webkitRTCPeerConnection || 
                           window.mozRTCPeerConnection;
                           
  const RTCSessionDescription = window.RTCSessionDescription || 
                               window.webkitRTCSessionDescription || 
                               window.mozRTCSessionDescription;
                               
  const RTCIceCandidate = window.RTCIceCandidate || 
                         window.webkitRTCIceCandidate || 
                         window.mozRTCIceCandidate;

  /**
   * Generate a random ID
   */
  function generateId() {
    return Math.random().toString(36).substring(2, 15) + 
           Math.random().toString(36).substring(2, 15);
  }

  /**
   * WebRTC adapter that mimics the WebSocket interface
   */
  class WebRTCSocket {
    /**
     * Create a new WebRTC socket
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
      this.peerConnection = null;
      this.dataChannel = null;
      this.signaling = null;
      this.connectionId = null;
      this.clientId = generateId();
      this.iceServers = [];
      
      // Queue messages until connected
      this.messageQueue = [];
      
      // Config
      this.config = {
        iceServers: [
          { urls: 'stun:stun.l.google.com:19302' },
          { urls: 'stun:stun1.l.google.com:19302' }
        ],
        sdpSemantics: 'unified-plan',
        iceTransportPolicy: 'all'
      };
      
      // Check if we should auto-connect
      if (!window.UNIQUAKE_CONFIG || !window.UNIQUAKE_CONFIG.noAutoConnect) {
        // Connect to signaling server and initiate connection
        this.connectToSignaling();
      } else {
        console.log('Auto-connection disabled by noAutoConnect flag');
      }
    }
    
    /**
     * Extract peer ID from WebSocket URL
     * WebSocket URLs are typically ws://hostname:port
     * We convert this to a peer ID for WebRTC
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
     * Connect to the signaling server
     */
    connectToSignaling() {
      // Check if we already have a shared signaling connection
      if (window.uniquakeSignaling && 
          window.uniquakeSignaling.readyState === WebSocket.OPEN) {
        this.signaling = window.uniquakeSignaling;
        this.setupSignalingHandlers();
        return;
      }
      
      // Master server URL (hardcoded for now, should come from config)
      const masterServer = window.UNIQUAKE_CONFIG?.masterServer || 
                         'ws://localhost:27950';
      
      // Connect to master server for signaling
      try {
        this.signaling = new window.OriginalWebSocket(masterServer);
        
        // Store for reuse
        window.uniquakeSignaling = this.signaling;
        
        this.signaling.onopen = () => {
          console.log('Connected to signaling server');
          this.setupSignalingHandlers();
        };
        
        this.signaling.onerror = (error) => {
          console.error('Signaling connection error:', error);
          this.emitError('Failed to connect to signaling server');
        };
        
        this.signaling.onclose = () => {
          console.log('Signaling connection closed');
          if (this.readyState === this.CONNECTING) {
            this.emitError('Signaling server disconnected');
            this.close();
          }
        };
      } catch (err) {
        console.error('Failed to connect to signaling server:', err);
        this.emitError(`Signaling connection failed: ${err.message}`);
        this.close();
      }
    }
    
    /**
     * Set up handlers for signaling messages
     */
    setupSignalingHandlers() {
      if (!this.signaling) return;
      
      // Store original handler if it exists
      const originalOnMessage = this.signaling.onmessage;
      
      this.signaling.onmessage = (event) => {
        // Call original handler if it exists
        if (originalOnMessage) {
          originalOnMessage(event);
        }
        
        // Process message for this connection
        this.handleSignalingMessage(event);
      };
      
      // Request connection to server
      this.requestServerConnection();
    }
    
    /**
     * Handle incoming signaling messages
     */
    handleSignalingMessage(event) {
      let message;
      
      try {
        message = JSON.parse(event.data);
      } catch (e) {
        console.warn('Invalid signaling message format');
        return;
      }
      
      // Filter messages for this connection
      if (message.connectionId && 
          this.connectionId && 
          message.connectionId !== this.connectionId) {
        return;
      }
      
      switch (message.type) {
        case 'connected':
          // Initial connection to signaling
          console.log('Signaling connected, client ID:', message.clientId);
          // Store client ID
          this.clientId = message.clientId;
          // Update ICE servers if provided
          if (message.iceServers) {
            this.updateIceServers(message.iceServers);
          }
          break;
          
        case 'ice_config':
          // ICE server configuration
          console.log('Received ICE configuration');
          if (message.iceConfig && message.iceConfig.iceServers) {
            this.updateIceServers(message.iceConfig.iceServers);
          }
          break;
          
        case 'offer':
          // SDP offer from server
          console.log('Received SDP offer');
          this.handleOffer(message);
          break;
          
        case 'answer':
          // SDP answer from server
          console.log('Received SDP answer');
          this.handleAnswer(message);
          break;
          
        case 'ice_candidate':
          // ICE candidate from server
          this.handleIceCandidate(message);
          break;
          
        case 'error':
          // Error message
          console.error('Signaling error:', message.error, 'Full message:', JSON.stringify(message));
          this.emitError(message.error || 'Signaling error');
          break;
          
        default:
          // Unhandled message type
          console.log('Unhandled signaling message:', message.type);
          break;
      }
    }
    
    /**
     * Request connection to game server
     */
    requestServerConnection() {
      if (!this.signaling || !this.peerId) return;
      
      console.log(`Requesting connection to server with peer ID: ${this.peerId}`);
      
      // Send connection request to signaling server
      this.signaling.send(JSON.stringify({
        type: 'connect_to_server',
        peerId: this.peerId
      }));
    }
    
    /**
     * Update ICE server configuration
     */
    updateIceServers(iceServers) {
      if (!iceServers || !Array.isArray(iceServers)) return;
      
      this.iceServers = iceServers;
      
      // Update config
      this.config.iceServers = iceServers;
      
      console.log('Updated ICE servers:', this.iceServers);
    }
    
    /**
     * Create peer connection with ICE config
     */
    createPeerConnection() {
      try {
        this.peerConnection = new RTCPeerConnection(this.config);
        
        // Handle ICE candidates
        this.peerConnection.onicecandidate = (event) => {
          if (event.candidate) {
            this.sendIceCandidate(event.candidate);
          }
        };
        
        // Connection state changes
        this.peerConnection.oniceconnectionstatechange = () => {
          console.log('ICE connection state:', this.peerConnection.iceConnectionState);
          
          if (this.peerConnection.iceConnectionState === 'failed' || 
              this.peerConnection.iceConnectionState === 'disconnected') {
            console.error('ICE connection failed');
            this.emitError('WebRTC connection failed');
            this.close();
          }
        };
        
        // Data channel events
        this.peerConnection.ondatachannel = (event) => {
          this.setupDataChannel(event.channel);
        };
        
        console.log('Created peer connection');
        return true;
      } catch (err) {
        console.error('Failed to create peer connection:', err);
        this.emitError(`Failed to create peer connection: ${err.message}`);
        return false;
      }
    }
    
    /**
     * Handle incoming SDP offer
     */
    async handleOffer(message) {
      try {
        this.connectionId = message.connectionId;
        
        // Create peer connection if needed
        if (!this.peerConnection) {
          if (!this.createPeerConnection()) {
            return;
          }
        }
        
        // Set remote description from offer
        await this.peerConnection.setRemoteDescription(
          new RTCSessionDescription(message.sdp)
        );
        
        // Create answer
        const answer = await this.peerConnection.createAnswer();
        
        // Set local description
        await this.peerConnection.setLocalDescription(answer);
        
        // Send answer to signaling server
        this.signaling.send(JSON.stringify({
          type: 'answer',
          targetId: message.sourceId,
          connectionId: this.connectionId,
          sdp: answer
        }));
        
        console.log('Sent SDP answer');
      } catch (err) {
        console.error('Failed to handle offer:', err);
        this.emitError(`Failed to handle offer: ${err.message}`);
      }
    }
    
    /**
     * Handle incoming SDP answer
     */
    async handleAnswer(message) {
      try {
        // Set remote description from answer
        await this.peerConnection.setRemoteDescription(
          new RTCSessionDescription(message.sdp)
        );
        
        console.log('Applied remote SDP answer');
      } catch (err) {
        console.error('Failed to handle answer:', err);
        this.emitError(`Failed to handle answer: ${err.message}`);
      }
    }
    
    /**
     * Handle incoming ICE candidate
     */
    async handleIceCandidate(message) {
      try {
        if (!this.peerConnection) return;
        
        await this.peerConnection.addIceCandidate(
          new RTCIceCandidate(message.candidate)
        );
      } catch (err) {
        console.error('Failed to add ICE candidate:', err);
      }
    }
    
    /**
     * Send ICE candidate to peer
     */
    sendIceCandidate(candidate) {
      if (!this.signaling || !this.connectionId) return;
      
      this.signaling.send(JSON.stringify({
        type: 'ice_candidate',
        targetId: this.peerId,
        connectionId: this.connectionId,
        candidate: candidate
      }));
    }
    
    /**
     * Create and set up data channel
     */
    createDataChannel() {
      try {
        // Create reliable data channel
        const dataChannel = this.peerConnection.createDataChannel('game', {
          ordered: true,
          maxRetransmits: 3
        });
        
        this.setupDataChannel(dataChannel);
        
        return true;
      } catch (err) {
        console.error('Failed to create data channel:', err);
        this.emitError(`Failed to create data channel: ${err.message}`);
        return false;
      }
    }
    
    /**
     * Set up data channel event handlers
     */
    setupDataChannel(dataChannel) {
      this.dataChannel = dataChannel;
      
      dataChannel.binaryType = 'arraybuffer';
      
      dataChannel.onopen = () => {
        console.log('Data channel open');
        this.readyState = this.OPEN;
        
        // Process any queued messages
        while (this.messageQueue.length > 0 && this.readyState === this.OPEN) {
          const message = this.messageQueue.shift();
          this.send(message);
        }
        
        // Emit open event
        this.emitOpen();
      };
      
      dataChannel.onmessage = (event) => {
        // Emit message event
        this.emitMessage(event.data);
      };
      
      dataChannel.onclose = () => {
        console.log('Data channel closed');
        this.readyState = this.CLOSED;
        this.emitClose();
      };
      
      dataChannel.onerror = (error) => {
        console.error('Data channel error:', error);
        this.emitError(`Data channel error: ${error}`);
      };
    }
    
    /**
     * Send data through the connection
     * @param {string|ArrayBuffer|Blob} data - Data to send
     * @returns {boolean} True if data was sent or queued
     */
    send(data) {
      // If not connected, queue message
      if (this.readyState === this.CONNECTING) {
        this.messageQueue.push(data);
        this.bufferedAmount += data.length || 0;
        return true;
      }
      
      // If closed, fail
      if (this.readyState !== this.OPEN) {
        return false;
      }
      
      // Send through data channel
      try {
        this.dataChannel.send(data);
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
      // If already closed, do nothing
      if (this.readyState === this.CLOSED) {
        return;
      }
      
      this.readyState = this.CLOSING;
      
      // Close data channel
      if (this.dataChannel) {
        this.dataChannel.close();
      }
      
      // Close peer connection
      if (this.peerConnection) {
        this.peerConnection.close();
      }
      
      // Notify signaling of connection closure if still connecting
      if (this.signaling && this.connectionId) {
        try {
          this.signaling.send(JSON.stringify({
            type: 'connection_closed',
            connectionId: this.connectionId
          }));
        } catch (e) {
          // Ignore errors during cleanup
        }
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
   * Initialize WebRTC in the browser
   * This replaces the WebSocket constructor with our WebRTC adapter
   */
  function initWebRTC(config) {
    // Save original WebSocket
    window.OriginalWebSocket = window.WebSocket;
    
    // Store config for access by WebRTCSocket instances
    window.UNIQUAKE_CONFIG = config || {};
    
    // Override WebSocket with our implementation
    window.WebSocket = function(url, protocols) {
      // Only use WebRTC for game server connections, not master server
      if (url.includes('master') || !window.UNIQUAKE_CONFIG.useWebRTC) {
        return new window.OriginalWebSocket(url, protocols);
      }
      
      // Use WebRTC for game connections
      return new WebRTCSocket(url, protocols);
    };
    
    // Add WebRTC Socket to global scope
    window.WebRTCSocket = WebRTCSocket;
    
    console.log('WebRTC adapter initialized');
    
    return {
      WebRTCSocket: WebRTCSocket,
      restore: function() {
        window.WebSocket = window.OriginalWebSocket;
      }
    };
  }
  
  // Export to global scope
  window.initWebRTC = initWebRTC;
  
})(window);