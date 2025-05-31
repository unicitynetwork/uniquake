# UNIQUAKE (QuakeJS) Project Guide

## Build Commands
- Build binaries: `cd ioq3 && make PLATFORM=js EMSCRIPTEN=<path_to_emscripten>`
- Install dependencies: `npm install`
- Run web server: `node bin/web.js --config ./web.json`
- Run dedicated server: `node build/ioq3ded.js +set fs_game baseq3 +set dedicated 2 +exec server.cfg`
- Repackage assets: `node bin/repak.js --src <assets_src> --dest <assets>`
- Run content server: `node bin/content.js`

## Code Style Guidelines
- Indentation: Tabs (not spaces)
- Naming: camelCase for variables and functions
- File naming: lowercase with .js extension
- Module pattern: CommonJS with `module.exports`
- Error handling: Use logger (winston) for errors
- Async: Callback-based pattern (not Promise)
- Config: Load with defaults and graceful error handling
- Functions: Traditional function declarations/expressions (not arrow functions)
- Object methods: Use prototype pattern for classes

## Project Structure
- `/bin`: Server executables and configuration
- `/build`: Compiled QuakeJS binaries
- `/ioq3`: ioquake3 source code
- `/lib`: Utility libraries