/**
 * UniQuake Transport Loader
 * 
 * Loads the appropriate transport adapter based on WebRTC support
 * Provides both WebRTC for P2P connections and WebSocket fallback
 */
(function() {
  'use strict';
  
  // Configuration - will be injected by the server
  window.UNIQUAKE_CONFIG = {
    // Enable WebRTC by default
    useWebRTC: true,
    
    // Enable WebRTC detection
    detectWebRTC: true,
    
    // Enable WebSocket fallback
    fallbackToWebSocket: true,
    
    // Master server URL for signaling
    masterServer: 'ws://localhost:27950',
    
    // Default ICE servers (will be updated from master server)
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun1.l.google.com:19302' }
    ]
  };
  
  /**
   * Initialize transport when the page loads
   */
  function initializeOnLoad() {
    // Inject transport detector script
    const script = document.createElement('script');
    script.src = '/transport-detector.js';
    script.onerror = (err) => {
      console.error('Failed to load transport detector:', err);
      
      // Fall back to direct WebRTC loading if detector fails
      loadWebRTCAdapter();
    };
    
    // Add to document
    document.head.appendChild(script);
  }
  
  /**
   * Load WebRTC adapter directly (fallback if detector fails)
   */
  function loadWebRTCAdapter() {
    const script = document.createElement('script');
    script.src = '/webrtc-adapter.js';
    script.onload = () => {
      console.log('WebRTC adapter loaded');
      
      // Initialize WebRTC with configuration
      if (window.initWebRTC) {
        window.initWebRTC(window.UNIQUAKE_CONFIG);
        console.log('WebRTC initialized with P2P enabled');
      }
    };
    script.onerror = (err) => {
      console.error('Failed to load WebRTC adapter:', err);
    };
    
    // Add to document
    document.head.appendChild(script);
  }
  
  // Initialize when page loads
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initializeOnLoad);
  } else {
    initializeOnLoad();
  }
  
  // Expose transport toggle functions
  window.toggleWebRTC = function(enabled) {
    window.UNIQUAKE_CONFIG.useWebRTC = enabled !== false;
    return window.UNIQUAKE_CONFIG.useWebRTC;
  };
  
  window.setTransportMode = function(mode) {
    if (mode === 'webrtc') {
      window.UNIQUAKE_CONFIG.useWebRTC = true;
      window.UNIQUAKE_CONFIG.fallbackToWebSocket = false;
    } else if (mode === 'websocket') {
      window.UNIQUAKE_CONFIG.useWebRTC = false;
      window.UNIQUAKE_CONFIG.fallbackToWebSocket = true;
    } else if (mode === 'auto') {
      window.UNIQUAKE_CONFIG.useWebRTC = true;
      window.UNIQUAKE_CONFIG.fallbackToWebSocket = true;
      window.UNIQUAKE_CONFIG.detectWebRTC = true;
    }
    return window.UNIQUAKE_CONFIG;
  };
})();