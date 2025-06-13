# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

# UNIQUAKE (QuakeJS with Dedicated Server Support)

## Project Setup
- Clone with submodules: `git clone --recursive <repo_url>` 
- Update submodules: `git submodule update --init --recursive`
- Fix submodule URLs: 
  ```
  cd fresh_quakejs
  # Check and fix git:// URLs to use https:// instead
  sed -i 's|git://github.com|https://github.com|g' .gitmodules
  git config --file=.gitmodules submodule.ioq3.url https://github.com/inolen/ioq3.git
  git submodule sync
  git submodule update --init --recursive
  cd ..
  ```
- Main project installation: `npm install`
- Dedicated server setup:
  ```
  cd fresh_quakejs
  npm install
  # Run dedicated server to download game files (requires ~1GB RAM)
  node build/ioq3ded.js +set fs_game baseq3 +set dedicated 2
  # Press ENTER to scroll through EULA, type 'y' to accept
  # Press Ctrl+C after files download
  ```
- Environment config: Create `.env` file with `GAME_SERVER_IP=your_server_ip`

## Build & Run Commands
- Install dependencies: `npm install`
- Start web server: `npm start` or `node bin/web.js --config ./bin/web.json`
- Run QuakeJS master server: `npm run master` (uses fresh_quakejs submodule)
- Run WebRTC master server: `npm run webrtc-master` or `node bin/webrtc-master.js`
- Run combined master: `npm run master-quake` or `node bin/combined-master.js`
- Run content server: `npm run content` or `node bin/content.js`
- Run browser mocks:
  - All components: `npm run start-browser-mocks`
  - Individual: `npm run mock-server`, `npm run mock-client`, `npm run browser-mock`
- Development server: `npm run browser-mock-all` (runs master server + browser mock)
- Configure master server in browser mocks:
  - Via env var: `MASTER_SERVER_URL=ws://your-server-ip:27950 npm run browser-mock`
  - Via URL: `http://localhost:8080/client?master=ws://your-server-ip:27950`
- Build engine: `cd ioq3 && make PLATFORM=js EMSCRIPTEN=<path_to_emscripten>`
- Repackage assets: `npm run repak` or `node bin/repak.js`
- Testing: Manual testing through browser mocks (no automated tests found)
- Manage dedicated servers:
  - Check running servers: `ps aux | grep node | grep quakejs`
  - Kill server: `kill <pid>`

## Code Style Guidelines
- Imports: Node.js require pattern; group external modules first, then internal
- Classes: ES6 class syntax with JSDoc comments for methods
- Variables: camelCase for variables/functions, PascalCase for classes
- String quotes: Single quotes preferred, template literals for interpolation
- Indentation: 2 spaces, no tabs
- Line length: Soft limit of 80 characters
- Error handling: Use try/catch with winston logger (`const logger = require('winston')`)
- Asynchronous code: Mix of Promise chains and callbacks; newer code uses async/await
- Configuration: Use default values with safe merging (Object.assign or _.extend)
- Dependencies: Leverage existing deps (async, underscore, winston, express, ws)
- WebRTC: Use simple-peer library with compatibility handling

## Architecture Overview

This project extends QuakeJS with WebRTC capabilities and dedicated server management:

### Core Components
- **Master Server** (`lib/master-server.js`): Main WebRTC signaling server that handles peer connections and server registry
- **Combined Master** (`bin/combined-master.js`): Unified server combining WebRTC master with traditional QuakeJS master protocol
- **Game Server Manager** (`lib/game-server-manager.js`): Spawns and manages dedicated server processes using Node.js child processes (ports 27961+)
- **Transport Services** (`lib/transport-service.js`): Handles WebRTC peer connections and WebSocket fallback
- **Signaling Service** (`lib/signaling-service.js`): WebRTC connection negotiation and peer management
- **Server Registry** (`lib/server-registry.js`): Tracks available game servers with heartbeat monitoring
- **STUN/TURN Servers** (`lib/stun-server.js`, `lib/turn-server.js`): NAT traversal support for WebRTC
- **Quake Protocol Adapter** (`lib/quake/master-adapter.js`): Bridges WebRTC master with traditional QuakeJS protocol
- **Browser Mocks** (`lib/client/`): Development interfaces for testing client/server interactions

### Key Architecture Patterns
- **Dual Transport**: WebRTC for peer-to-peer connections with WebSocket fallback for compatibility
- **Server Registry**: Centralized tracking of available game servers with heartbeat monitoring
- **Process Management**: Dedicated servers run as separate Node.js processes, managed by the main server
- **Signaling Protocol**: Custom WebSocket-based signaling for WebRTC negotiation
- **Unicity Integration**: Support for @unicitylabs packages for advanced networking features

### Server Lifecycle
1. Combined master starts and initializes both WebRTC and QuakeJS protocol handlers
2. Game Server Manager spawns dedicated servers on demand (ports 27961+)
3. Servers register with master server and send periodic heartbeats
4. Clients connect via WebRTC (preferred) or WebSocket fallback
5. Master server handles signaling between peers and maintains server list

### Development Workflow
- Branch naming: feature/*, bugfix/*, refactor/*
- Testing: Use browser mocks first (`npm run start-browser-mocks`), then integrate with main game
- Debugging: Browser dev tools for client-side WebRTC connections, server logs for backend
- Logging: Use winston logger throughout the codebase

## Important Notes

### Submodule Management
- The project uses nested submodules: `fresh_quakejs` contains the `ioq3` submodule
- Always use `git clone --recursive` or `git submodule update --init --recursive`
- Fix git:// URLs to https:// in fresh_quakejs/.gitmodules if needed

### WebSocket Library Compatibility
- Main project uses ws v7.2.5+
- fresh_quakejs submodule uses ws v0.4.32 (do not update)
- These different versions are intentional for compatibility

### Port Management
- Master server: 27950 (WebSocket)
- Dedicated servers: 27961+ (auto-assigned)
- Web server: 8080 (default)
- Content server: varies (configured in content.js)

### Memory Requirements
- Downloading game assets requires ~1GB RAM
- Dedicated servers require moderate memory per instance

### Required Installer Files
- The content server requires QuakeJS installer files to function properly
- These are automatically downloaded by setup.sh: 
  - `linuxq3ademo-1.11-6.x86.gz.sh` (demo installer)
  - `linuxq3apoint-1.32b-3.x86.run` (point release installer)
- Without these files, the QuakeJS client will encounter "callback is not defined" errors
- Files are downloaded from official content.quakejs.com during setup