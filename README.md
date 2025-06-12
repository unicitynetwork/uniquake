# UNIQUAKE (QuakeJS with Dedicated Server Support)

This project extends QuakeJS with remote dedicated server management capabilities, allowing for improved scaling, resource management, and a more realistic network topology while maintaining integration with the Unicity Framework.

## Prerequisites

- Node.js (v14+ recommended)
- Git
- Emscripten (only needed if rebuilding the engine)

## Setup Instructions

### 1. Clone the Repository with Submodules

```bash
git clone --recursive https://your-repository-url.git uniquake
cd uniquake
```

If you already cloned without `--recursive`:

```bash
git submodule update --init --recursive
# Also ensure the nested ioq3 submodule in fresh_quakejs is initialized
cd fresh_quakejs
git submodule update --init --recursive
cd ..
```

Note: The project uses nested submodules:
- `fresh_quakejs`: QuakeJS game server (https://github.com/inolen/quakejs.git)
- `fresh_quakejs/ioq3`: ioquake3 engine (https://github.com/inolen/ioq3.git)

Important: The fresh_quakejs submodule might reference ioq3 using the git:// protocol, which can cause issues with firewalls. The setup script automatically fixes this to use https:// instead. If you're setting up manually, check and update fresh_quakejs/.gitmodules to use https:// URLs.

### 2. Install Dependencies for Main Project

```bash
npm install
```

### 3. Set Up Dedicated Server (fresh_quakejs)

```bash
cd fresh_quakejs
npm install
```

### 4. Download Game Assets

Due to licensing restrictions, you need to accept the EULA and download game assets. This process requires approximately 1GB of RAM:

```bash
cd fresh_quakejs
# Run the dedicated server to trigger EULA and file download
node build/ioq3ded.js +set fs_game baseq3 +set dedicated 2
# Press ENTER to scroll through the EULA, then type 'y' to accept
# After files download, press Ctrl+C to exit
```

If the server exits with "Killed" message, your system needs more memory.

### 5. Build Content (if needed)

If you need to repackage the assets:

```bash
cd ..  # Back to main project
npm run repak
```

### 6. Environment Configuration

Create a `.env` file in the project root with:

```
GAME_SERVER_IP=your_server_ip
```

Replace `your_server_ip` with your public-facing IP address or domain name.

## Running the System

### 1. Start the Combined Master Server

```bash
npm run master-quake
# or
node bin/combined-master.js
```

### 2. Start the Content Server

In a separate terminal:

```bash
npm run content
# or
node bin/content.js
```

### 3. Start the Web Server

In a separate terminal:

```bash
npm start
# or
node bin/web.js --config ./bin/web.json
```

## Browser Mocks for Development

For development and testing:

```bash
npm run browser-mock-all
```

This runs both the master server and the browser mock interface.

### Configuring Master Server URL

When using the browser mocks, you can specify a different master server URL:

```
http://localhost:8080/client?master=ws://your-server-ip:27950
http://localhost:8080/server?master=ws://your-server-ip:27950
```

This allows you to run the browser mock interface on one machine while connecting to a master server running on another machine.

## Usage

1. Access the web interface at `http://localhost:8080` (default)
2. Use the server interface to spawn dedicated game servers
3. Connect to the servers through the client interface

## Architecture

- **Master Server**: Handles signaling, server registration, and game server management
- **Game Server Manager**: Spawns and manages dedicated server processes
- **Client Interface**: Connects to game servers through WebRTC or WebSocket fallback
- **Dedicated Servers**: Run as standalone processes on the server

## Troubleshooting

### Port Conflicts

Dedicated servers start from port 27961. If you encounter port conflicts:

```bash
# Check running servers
ps aux | grep node | grep quakejs

# Kill specific server
kill <pid>
```

### WebSocket Compatibility

The system uses two different WebSocket libraries:
- Main project: ws v7.2.5+
- Dedicated servers: ws v0.4.32 (from fresh_quakejs submodule)

Do not update the WebSocket library in fresh_quakejs as it may break compatibility.

### Server Registration

If servers are not appearing in the server list, check:
1. The GAME_SERVER_IP environment variable is set correctly
2. The master server is running
3. There are no firewall issues blocking WebSocket connections

## License

This project contains code from QuakeJS and ioquake3, both under GPL license. See individual submodules for specific license details.