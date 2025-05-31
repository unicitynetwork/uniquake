# Browser-Only WebRTC Migration for UniQuake

## Overview
This document outlines a strategy for implementing WebRTC P2P connections in UniQuake exclusively in the browser environment, without modifying the Node.js server components.

## Current Architecture
- Browser loads minified/compiled `ioquake3.js` containing WebSocket implementations
- Node.js master server brokers connections between clients and servers
- Browser-to-browser connections not directly supported

## Implementation Strategy

### 1. Create WebRTC Adapter Layer
Create a JavaScript library that implements the same interface as WebSocket but uses WebRTC under the hood:

```javascript
class WebRTCSocket {
  // Implement WebSocket-compatible API
  constructor(url) { /* WebRTC setup */ }
  send(data) { /* Send via RTCDataChannel */ }
  close() { /* Close RTCPeerConnection */ }
  // Add event handlers (onopen, onmessage, onclose, onerror)
}
```

### 2. Client-Side Injection
Develop a script that injects our WebRTC adapter before the game initializes:

```javascript
// Override the WebSocket constructor with our own implementation
window.OriginalWebSocket = window.WebSocket;
window.WebSocket = function(url) {
  // For the master server, still use regular WebSockets
  if (url.includes('master')) {
    return new window.OriginalWebSocket(url);
  }
  // For game servers, use our WebRTC implementation
  return new WebRTCSocket(url);
};
```

### 3. Signaling Through Master Server
Use the existing master server connection for WebRTC signaling:

- When a client connects to the master server, include WebRTC capabilities
- When a server registers with the master, include its WebRTC peer ID
- Extend the getserversResponse message to include WebRTC peer IDs
- Use custom messages over the existing WebSocket to exchange SDP and ICE candidates

### 4. Host Game Server in Browser
Enable users to host game servers directly in the browser:

- Use the existing dedicated server code (ioq3ded.js) but run it in the browser
- Register the browser-hosted server with the master server
- Include WebRTC peer ID in registration
- Accept direct WebRTC connections from clients

### 5. Connection Flow
1. Client connects to master server via WebSocket
2. Client requests server list with WebRTC support indicated
3. Master returns list with WebRTC peer IDs
4. Client initiates WebRTC connection setup through master server signaling
5. Once P2P connection is established, game data flows directly between peers

## Technical Implementation

### WebRTC Integration Code
Create a small integration script that loads before ioquake3.js:

```html
<script src="webrtc-adapter.js"></script>
<script>
  // WebRTC initialization and WebSocket override
  initializeWebRTC();
</script>
<script src="ioquake3.js"></script>
```

### WebRTC Signaling Protocol
Extend the existing protocol with WebRTC signaling messages:

- `rtc_offer`: Send SDP offer to a peer
- `rtc_answer`: Send SDP answer to a peer
- `rtc_ice`: Send ICE candidate to a peer
- `rtc_connect`: Request connection to a peer ID

### Preserving Packet Format
Ensure that the binary packet format (OOB format with \xff\xff\xff\xff header) is preserved when sending over RTCDataChannel.

## Advantages of Browser-Only Approach
- No server-side code changes required
- Can be deployed as a client-side script or browser extension
- Maintains compatibility with existing servers
- Allows for gradual adoption
- Works with the current master server implementation

## Challenges and Solutions

### NAT Traversal
- Include STUN server configuration in the WebRTC adapter
- Optionally support TURN server for difficult NAT scenarios

### Fallback Mechanism
- Automatically fall back to WebSocket if WebRTC connection fails
- Monitor connection quality and switch protocols if needed

### Multiple Connections
- Manage multiple peer connections for servers
- Handle connection upgrades mid-game

### Binary Data Compatibility
- Ensure RTCDataChannel correctly handles the binary formats
- Implement packet fragmentation if needed

## Implementation Steps
1. Create WebRTC adapter with WebSocket-compatible API
2. Develop signaling protocol extensions
3. Implement WebSocket override and injection
4. Test P2P connections between browsers
5. Optimize for performance and reliability