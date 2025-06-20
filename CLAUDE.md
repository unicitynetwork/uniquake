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
- Environment config: Run `./setup.sh` or copy `.env.example` to `.env` and configure `HOST_IP`

## Build & Run Commands

### Essential Setup Commands
- **Initial setup**: `./setup.sh` (handles submodules, dependencies, and game assets)
- **Manual setup**: `npm install` then configure submodules (see Project Setup)
- **Environment config**: `npm run config` (generates configs from .env after changes)

### Server Commands
- **Production**: `npm run master-quake` (recommended - unified master server)
- **Development**: `npm run start-browser-mocks` (master + browser interface)
- **Individual services**:
  - Web server: `npm start`
  - Content server: `npm run content`
  - WebRTC master only: `npm run webrtc-master`
  - QuakeJS master only: `npm run master`

### Development & Testing
- **Browser mocks**: Individual components available via `npm run mock-server`, `npm run mock-client`, `npm run browser-mock`
- **Debug mode**: `npm run master-quake-debug` (enables debug logging)
- **Configure master server in browser mocks**:
  - Via env var: `MASTER_SERVER_URL=ws://your-server-ip:27950 npm run browser-mock`
  - Via URL: `http://localhost:8080/client?master=ws://your-server-ip:27950`

### Asset Management
- **Repackage assets**: `npm run repak` or `node bin/repak.js`
- **Manual engine build**: `cd fresh_quakejs/ioq3 && make PLATFORM=js EMSCRIPTEN=<path>`

### Process Management
- **Check servers**: `ps aux | grep node | grep ioq3ded` (dedicated) or `ps aux | grep node | grep master` (master)
- **Kill servers**: `kill <pid>`

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

### Server Lifecycle & Game State Management
1. Combined master starts and initializes both WebRTC and QuakeJS protocol handlers
2. Game Server Manager spawns dedicated servers on demand (ports 27961+)
3. Servers register with master server and send periodic heartbeats
4. Clients connect via WebRTC (preferred) or WebSocket fallback
5. Master server handles signaling between peers and maintains server list
6. **Automatic match restart cycle**: When matches end via timeout/score cap → 30s countdown → server restart → client auto-reconnect
7. **Manual match end**: "End Match and Pay Rewards" button → complete server stop (no restart)
8. **Game state tokens**: Servers send periodic state tokens for verification; inactive servers (>1min without tokens) are automatically terminated

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

## Configuration System

### Environment-Based Configuration
- Configuration is managed through `.env` file and environment variables
- Key setting: `HOST_IP` - sets the public IP/hostname for all services
- All npm scripts automatically generate configs based on current .env settings
- Run `npm run config` to regenerate config files after changing .env

### IP vs URL Usage
- **QuakeJS configs**: Use `host:port` format (no protocol)
  - `content: "192.168.1.100:9000"`
  - `masterServer: "192.168.1.100:27950"`
- **WebSocket connections**: Use full `ws://` URLs
  - `ws://192.168.1.100:27950`
- **STUN/TURN**: Use raw IP addresses
  - `publicIp: "192.168.1.100"`

### Quick Host Change
1. Edit `HOST_IP` in `.env` file
2. Run `npm run config` to regenerate all configs
3. Restart services

## Game State Token Management

### Token Reset System
- Game state tokens are automatically reset every 10 frames to prevent size growth
- When frame number is divisible by 10, a fresh token is created (old transactions discarded)
- State hashes are recorded for performance tracking (last 50 records kept)
- 10-second periodic token updates are sent to all clients
- This maintains performance while preserving game state verification

### Token Update Workflow
1. Server updates game state every frame
2. At frames 10, 20, 30, etc. - token is reset to prevent growth
3. Every 10 seconds - current token is broadcast to all clients
4. Clients verify received tokens and update their state

## Debugging and Development Commands

### Process Management
- Check running game servers: `ps aux | grep node | grep ioq3ded`
- Check running master servers: `ps aux | grep node | grep master`  
- Kill specific process: `kill <pid>`
- Check port usage: `netstat -tlnp | grep :27950` (master) or `netstat -tlnp | grep :2796` (game servers)

### Log Monitoring
- View master server logs: `tail -f master.log`
- View game server logs: `tail -f logs/game-*.log`
- Debug mode for master: `npm run master-quake-debug`

### Configuration Debugging
- Test configuration generation: `npm run config`
- Verify environment setup: `cat .env`
- Check generated configs: `cat master-config.json` and `cat content-config.json`

## Testing and Quality Assurance

### Browser Mock Testing
- Start all mocks: `npm run start-browser-mocks`
- Individual components: `npm run mock-server`, `npm run mock-client`, `npm run browser-mock`
- Test with custom master server: `MASTER_SERVER_URL=ws://ip:27950 npm run browser-mock`
- Access test interfaces:
  - Client mock: `http://localhost:8080/client`
  - Server mock: `http://localhost:8080/server`
  - Main game: `http://localhost:8080/quake`

### Manual Testing Workflow
1. Start master server (`npm run master-quake`)
2. Start content server (`npm run content`) 
3. Start web server (`npm start`)
4. Use browser mocks to test connectivity
5. Verify server registration and client connections
6. Test WebRTC and WebSocket fallback paths

## Error Handling and Troubleshooting

### Common Issues
- **"callback is not defined" errors**: Missing QuakeJS installer files (run `./setup.sh`)
- **Port conflicts**: Check for other services using ports 27950, 27961+, 8080, 9000
- **Submodule issues**: Run `git submodule update --init --recursive`
- **Memory issues during setup**: Requires ~1GB RAM for asset download
- **Server not registering**: Check `GAME_SERVER_IP` in `.env` matches public IP

### Git Workflow  
- **Branch naming**: `feature/*`, `bugfix/*`, `refactor/*`
- **Submodule updates**: Always use `git submodule update --init --recursive`
- **Fresh QuakeJS compatibility**: Never update ws library in fresh_quakejs submodule

## Server State Management

### Dedicated Server States
- `not_running`: Server process not active
- `starting`: Server process spawning, waiting for first heartbeat
- `running`: Server active and receiving heartbeats  
- `game_over`: Match ended, server in 30s countdown before restart

### Client UI States
- **Running servers**: Green, clickable connect button
- **Game Over servers**: Orange, disabled connect button, shows countdown
- **Starting servers**: Yellow, disabled connect button
- **Not Running servers**: Gray, disabled connect button
- **Malformed servers**: Red, always disabled (invalid address data)

### Token Monitoring & Server Termination
- Servers must send game state tokens at least every 60 seconds
- Token monitoring runs every 30 seconds checking for inactive servers
- Inactive servers are automatically terminated (separate from 2-hour session timeout)
- Session timeout (2 hours) handles general connection cleanup