/**
 * UniQuake WebRTC Loader
 * 
 * Injects the WebRTC adapter into the page before the game loads
 * Replaces WebSocket with WebRTC for P2P connections
 */
(function() {
  'use strict';
  
  // Configuration - will be injected by the server
  window.UNIQUAKE_CONFIG = {
    // Enable WebRTC by default
    useWebRTC: true,
    
    // Master server URL for signaling
    masterServer: 'ws://localhost:27950',
    
    // Default ICE servers (will be updated from master server)
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' }
    ]
  };
  
  /**
   * Initialize WebRTC when the page loads
   */
  function initializeOnLoad() {
    // Inject WebRTC adapter script
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
  
  // Expose WebRTC toggle function
  window.toggleWebRTC = function(enabled) {
    window.UNIQUAKE_CONFIG.useWebRTC = enabled !== false;
    return window.UNIQUAKE_CONFIG.useWebRTC;
  };
})();