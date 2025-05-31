# UniQuake WebRTC P2P Migration Plan

## Overview
This document outlines the steps required to convert UniQuake (QuakeJS) from a traditional client/server WebSocket model to a WebRTC-based peer-to-peer system. The game will maintain its client/server architecture, but will use WebRTC as the transport layer instead of TCP WebSockets.

## Current Architecture
- Master server (master.js) handles server registration and client discovery
- Game servers connect to the master server via WebSockets
- Clients connect to game servers via WebSockets
- Binary packet format with OOB (out-of-band) headers

## Target Architecture
- Master server will act as a WebRTC signaling server
- Game servers register with WebRTC peer IDs
- Clients establish direct P2P connections to game servers via WebRTC
- Same game protocol but transmitted over WebRTC data channels

## Implementation Tasks

### 1. Add WebRTC Signaling to Master Server
- Modify `bin/master.js` to handle WebRTC signaling
- Implement SDP offer/answer exchange
- Add ICE candidate exchange endpoints
- Update server registration to include WebRTC peer IDs
- Maintain backward compatibility with WebSockets

### 2. Client-Side WebRTC Implementation
- Add WebRTC library (e.g., simple-peer) to the project
- Implement peer connection establishment in `build/ioquake3.js`
- Create RTCDataChannel adapters for game packet transmission
- Modify client connection code to use WebRTC when available

### 3. Game Server WebRTC Integration
- Update `build/ioq3ded.js` to support WebRTC connections
- Implement peer ID generation and registration with master server
- Create data channel handlers for client connections
- Maintain compatibility with existing game protocol

### 4. Network Protocol Adaptation
- Create a WebRTC transport adapter for the network layer
- Ensure binary packet format compatibility
- Implement both reliable and unreliable data transmission options
- Adapt the OOB packet format for WebRTC data channels

### 5. Connection Management
- Implement NAT traversal using STUN/TURN servers
- Create fallback mechanisms when WebRTC fails
- Handle peer disconnects and reconnects
- Manage multiple peer connections for the server

## Technical Considerations

### WebRTC Configuration
- STUN/TURN server configuration for NAT traversal
- ICE candidate gathering and exchange
- Reliable vs. unreliable data channel options
- Connection timeout and retry mechanisms

### Game Protocol Compatibility
- Maintain the same packet format and protocol
- Adapt WebSocket-specific code to work with WebRTC
- Handle packet ordering and delivery guarantees

### Performance Optimization
- Optimize for low latency
- Minimize signaling overhead
- Efficient binary data transmission
- Handle peer connection quality issues

## Testing Strategy
- Test WebRTC signaling with simple echo server
- Verify P2P connections between browsers
- Test with various network conditions (NAT, firewalls)
- Benchmark performance against WebSocket implementation

## Implementation Phases
1. Set up WebRTC signaling in master server
2. Implement basic P2P connection establishment
3. Adapt network protocol for WebRTC data channels
4. Integrate with game server and client code
5. Test and optimize performance