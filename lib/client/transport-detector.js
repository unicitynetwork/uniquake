/**
 * UniQuake Transport Detector
 * 
 * Detects WebRTC support and loads the appropriate transport adapter
 */

(function(window) {
  'use strict';

  /**
   * Check if WebRTC is supported
   */
  function checkWebRTCSupport() {
    try {
      const RTCPeerConnection = window.RTCPeerConnection || 
                               window.webkitRTCPeerConnection || 
                               window.mozRTCPeerConnection;
                               
      const RTCSessionDescription = window.RTCSessionDescription || 
                                   window.webkitRTCSessionDescription || 
                                   window.mozRTCSessionDescription;
                                   
      const RTCIceCandidate = window.RTCIceCandidate || 
                             window.webkitRTCIceCandidate || 
                             window.mozRTCIceCandidate;
      
      // If all required objects exist, WebRTC is supported
      return !!(RTCPeerConnection && RTCSessionDescription && RTCIceCandidate);
    } catch (e) {
      console.error('Error checking WebRTC support:', e);
      return false;
    }
  }

  /**
   * Load transport adapter script
   */
  function loadTransportAdapter() {
    // Check if WebRTC is supported
    const webrtcSupported = checkWebRTCSupport();
    console.log(`WebRTC ${webrtcSupported ? 'is' : 'is not'} supported`);
    
    // Decide which adapter to load based on support and config
    let adapterScriptSrc = '';
    let useWebRTC = false;
    
    // Get config settings
    const detectWebRTC = window.UNIQUAKE_CONFIG?.detectWebRTC !== false;
    const useWebRTCConfig = window.UNIQUAKE_CONFIG?.useWebRTC !== false;
    const fallbackToWebSocket = window.UNIQUAKE_CONFIG?.fallbackToWebSocket !== false;
    
    // TEMPORARILY FORCED: Always use WebSocket fallback for Unicity traffic
    console.log('WebRTC temporarily disabled for Unicity traffic, forcing WebSocket fallback');
    adapterScriptSrc = '/websocket-fallback.js';
    
    /* Original logic (commented out during WebRTC disable)
    if ((detectWebRTC && webrtcSupported) || (!detectWebRTC && useWebRTCConfig)) {
      // Use WebRTC adapter
      adapterScriptSrc = '/webrtc-adapter.js';
      useWebRTC = true;
    } else if (fallbackToWebSocket) {
      // Use WebSocket fallback
      adapterScriptSrc = '/websocket-fallback.js';
    } else {
      console.error('No transport adapter available - both WebRTC and WebSocket fallback are disabled');
      return;
    }
    */
    
    // Update config
    window.UNIQUAKE_CONFIG.useWebRTC = useWebRTC;
    console.log(`Loading transport adapter: ${adapterScriptSrc}`);
    
    // Load the script
    const script = document.createElement('script');
    script.src = adapterScriptSrc;
    script.onload = () => {
      // Initialize adapter
      if (useWebRTC && window.initWebRTC) {
        window.initWebRTC(window.UNIQUAKE_CONFIG);
        console.log('WebRTC adapter initialized');
      } else if (!useWebRTC && window.initWebSocketFallback) {
        window.initWebSocketFallback(window.UNIQUAKE_CONFIG);
        console.log('WebSocket fallback initialized');
      }
      
      // Dispatch event
      window.dispatchEvent(new CustomEvent('uniquake:transport:ready', {
        detail: {
          transportType: useWebRTC ? 'webrtc' : 'websocket',
          config: window.UNIQUAKE_CONFIG
        }
      }));
    };
    
    script.onerror = (err) => {
      console.error(`Failed to load transport adapter: ${err}`);
      
      // If WebRTC fails and fallback is enabled, try WebSocket
      if (useWebRTC && fallbackToWebSocket) {
        console.log('Falling back to WebSocket transport');
        window.UNIQUAKE_CONFIG.useWebRTC = false;
        loadTransportAdapter();
      } else {
        // Dispatch error event
        window.dispatchEvent(new CustomEvent('uniquake:transport:error', {
          detail: {
            error: `Failed to load transport adapter: ${err}`
          }
        }));
      }
    };
    
    // Add to document
    document.head.appendChild(script);
  }

  // Start detection process
  loadTransportAdapter();

})(window);