# UNIQUAKE (QuakeJS) Project Guide

## Project Setup
- Clone with submodules: `git clone --recursive <repo_url>` 
- Update submodules: `git submodule update --init --recursive`
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
- Run master server: `npm run master` or `node bin/webrtc-master.js`
- Run combined master: `npm run master-quake` or `node bin/combined-master.js`
- Run content server: `npm run content` or `node bin/content.js`
- Run browser mocks:
  - All components: `npm run start-browser-mocks`
  - Individual: `npm run mock-server`, `npm run mock-client`, `npm run browser-mock`
- Development server: `npm run browser-mock-all` (runs master server + browser mock)
- Build engine: `cd ioq3 && make PLATFORM=js EMSCRIPTEN=<path_to_emscripten>`
- Repackage assets: `npm run repak` or `node bin/repak.js --src <assets_src> --dest <assets>`
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

## Development Workflow
- Branch naming: feature/*, bugfix/*, refactor/*
- Testing: First in browser mocks, then integrate with the main game
- Servers: Run multiple concurrently with `npm run start-browser-mocks`
- Debugging: Browser dev tools for client-side (check WebRTC connections)
- Logging: Use winston logger throughout the codebase