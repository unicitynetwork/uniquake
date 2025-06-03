# UNIQUAKE (QuakeJS) Project Guide

## Build Commands
- Install dependencies: `npm install`
- Start web server: `npm start` or `node bin/web.js --config ./bin/web.json`
- Run master server: `npm run master` or `node bin/webrtc-master.js`
- Run content server: `npm run content` or `node bin/content.js`
- Repackage assets: `npm run repak` or `node bin/repak.js --src <assets_src> --dest <assets>`
- Build engine: `cd ioq3 && make PLATFORM=js EMSCRIPTEN=<path_to_emscripten>`
- Mock server: `npm run mock-server`
- Mock client: `npm run mock-client`

## Code Style Guidelines
- Imports: Node.js require pattern, group external then internal modules
- Classes: ES6 class syntax with JSDoc comments for methods
- Naming: camelCase for variables/functions, PascalCase for classes
- Errors: Use try/catch with logger (winston) for error handling
- Async: Mix of Promises and callbacks (newer code uses async/await)
- Config: Use default values with safe merging (Object spread or _.extend)
- Functions: Prefer modern ES6+ syntax for new code
- Indentation: 2 spaces
- File structure: Modular components with clear responsibility separation

## Project Architecture
- `/bin`: Server executables and configuration files
- `/lib`: Core libraries and services
- `/lib/client`: Browser-side client code for WebRTC