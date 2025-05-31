# UniQuake WebRTC Mock Clients

These mock clients are designed to test the WebRTC peer-to-peer connection functionality of the UniQuake master server. They simulate game servers and game clients connecting and communicating with each other via the master server signaling service.

## Prerequisites

- Node.js 12+ 
- Required NPM packages: `ws`, `optimist`, `uuid`

## Components

1. **mock-server-client.js** - Simulates a game server that registers with the master server and accepts client connections
2. **mock-game-client.js** - Simulates a game client that connects to the master server, retrieves server lists, and connects to game servers

## Usage

### Starting the Master Server

First, start the master server in a separate terminal:

```bash
node bin/webrtc-master.js
```

### Running a Mock Game Server

To start a mock game server:

```bash
node lib/mock-server-client.js --name "Test Server" --map "q3dm17" --game "baseq3"
```

Options:
- `--master` - Master server address (default: `localhost:27950`)
- `--name` - Server name (default: `MockServer`)
- `--map` - Map name (default: `q3dm17`)
- `--game` - Game type (default: `baseq3`)

Server commands:
- `help` - Show help text
- `status` - Show server status
- `broadcast <message>` - Broadcast a message to all clients
- `kick <clientId>` - Kick a client
- `map <mapname>` - Change the current map
- `name <servername>` - Change the server name
- `quit` - Exit the server

### Running a Mock Game Client

To start a mock game client:

```bash
node lib/mock-game-client.js --name "TestPlayer"
```

Options:
- `--master` - Master server address (default: `localhost:27950`)
- `--name` - Player name (default: `Player`)
- `--connect` - Auto-connect to server with this peer ID
- `--verbose` - Show verbose output (default: `false`)

Client commands:
- `help` - Show help text
- `list` - Request server list
- `connect <id/index>` - Connect to server by ID or list index
- `disconnect` - Disconnect from current server
- `status` - Show connection status
- `ping` - Send ping to server
- `say <message>` - Send chat message (or just type the message)
- `quit` - Exit the client

## Testing Workflow

1. Start the master server
2. Start one or more mock game servers
3. Start one or more mock game clients
4. Use the `list` command in the client to see available servers
5. Use the `connect` command in the client to connect to a server
6. Once connected, you can chat between clients and servers
7. Test disconnection and reconnection

## Note on WebRTC Implementation

These mock clients use a simulated WebRTC implementation to avoid native module dependencies. The implementation mimics the WebRTC API behavior but doesn't actually create network connections between peers directly.

The key test functionality is the signaling protocol between clients and servers via the master server, which is fully implemented.