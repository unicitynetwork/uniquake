#!/usr/bin/env node

/**
 * UniQuake RCON CLI Tool
 * Command-line interface for sending RCON commands to QuakeJS servers
 */

const optimist = require('optimist');
const WebSocket = require('ws');
const path = require('path');

// Command line argument parsing
const argv = optimist
  .usage('Usage: $0 [options] <command>')
  .describe('server', 'Game server ID to send command to')
  .describe('master', 'Master server WebSocket URL')
  .default('master', 'ws://localhost:27950')
  .describe('list-servers', 'List all available game servers')
  .describe('list-commands', 'Show available RCON commands')
  .boolean('help').describe('help', 'Show this help')
  .alias('h', 'help')
  .alias('s', 'server')
  .alias('m', 'master')
  .argv;

// Show help if requested or no command provided
if (argv.help || (argv._.length === 0 && !argv['list-servers'] && !argv['list-commands'])) {
  optimist.showHelp();
  console.log('\nExamples:');
  console.log('  rcon --list-servers                    # List all game servers');
  console.log('  rcon --list-commands                   # Show available commands');
  console.log('  rcon -s server123 status               # Get server status');
  console.log('  rcon -s server123 "say Hello players"  # Send message');
  console.log('  rcon -s server123 "map q3dm17"         # Change map');
  console.log('  rcon -s server123 players              # List players');
  process.exit(0);
}

class RCONCLIClient {
  constructor(masterServerUrl) {
    this.masterServerUrl = masterServerUrl;
    this.ws = null;
    this.responseHandlers = new Map();
    this.requestId = 0;
  }

  async connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.masterServerUrl);
      
      this.ws.on('open', () => {
        console.log(`Connected to master server: ${this.masterServerUrl}`);
        resolve();
      });

      this.ws.on('error', (error) => {
        reject(new Error(`Failed to connect to master server: ${error.message}`));
      });

      this.ws.on('message', (data) => {
        try {
          const message = JSON.parse(data.toString());
          this.handleMessage(message);
        } catch (error) {
          console.error('Failed to parse WebSocket message:', error.message);
        }
      });
    });
  }

  handleMessage(message) {
    const { type, requestId } = message;
    
    if (requestId && this.responseHandlers.has(requestId)) {
      const handler = this.responseHandlers.get(requestId);
      this.responseHandlers.delete(requestId);
      handler(message);
    } else {
      // Handle unsolicited messages
      console.log('Received message:', message);
    }
  }

  async sendRequest(type, data = {}) {
    return new Promise((resolve, reject) => {
      const requestId = ++this.requestId;
      const message = {
        type,
        requestId,
        ...data
      };

      // Set up response handler
      this.responseHandlers.set(requestId, (response) => {
        if (response.error) {
          reject(new Error(response.error));
        } else {
          resolve(response);
        }
      });

      // Send message
      this.ws.send(JSON.stringify(message));

      // Set timeout
      setTimeout(() => {
        if (this.responseHandlers.has(requestId)) {
          this.responseHandlers.delete(requestId);
          reject(new Error('Request timeout'));
        }
      }, 10000);
    });
  }

  async listServers() {
    try {
      const response = await this.sendRequest('list_servers');
      return response.servers || [];
    } catch (error) {
      throw new Error(`Failed to list servers: ${error.message}`);
    }
  }

  async executeRCON(serverId, command) {
    try {
      const response = await this.sendRequest('rcon_command', {
        gameId: serverId,
        command: command
      });
      return response.result;
    } catch (error) {
      throw new Error(`RCON command failed: ${error.message}`);
    }
  }

  async getAvailableCommands() {
    try {
      const response = await this.sendRequest('rcon_commands');
      return response.commands || [];
    } catch (error) {
      throw new Error(`Failed to get commands: ${error.message}`);
    }
  }

  disconnect() {
    if (this.ws) {
      this.ws.close();
    }
  }
}

async function main() {
  const client = new RCONCLIClient(argv.master);
  
  try {
    await client.connect();

    if (argv['list-servers']) {
      // List all available game servers
      const servers = await client.listServers();
      
      if (servers.length === 0) {
        console.log('No game servers are currently running.');
      } else {
        console.log('\nAvailable Game Servers:');
        console.log('ID'.padEnd(20) + 'Name'.padEnd(25) + 'Map'.padEnd(15) + 'Players'.padEnd(10) + 'Address');
        console.log('-'.repeat(80));
        
        for (const server of servers) {
          const players = `${server.currentPlayers || 0}/${server.maxPlayers || 0}`;
          console.log(
            server.gameId.padEnd(20) +
            (server.name || 'Unknown').padEnd(25) +
            (server.map || 'Unknown').padEnd(15) +
            players.padEnd(10) +
            (server.address || 'Unknown')
          );
        }
      }
    } else if (argv['list-commands']) {
      // List available RCON commands
      const commands = await client.getAvailableCommands();
      
      console.log('\nAvailable RCON Commands:');
      console.log('Command'.padEnd(20) + 'Description');
      console.log('-'.repeat(60));
      
      for (const cmd of commands) {
        console.log(cmd.command.padEnd(20) + cmd.description);
      }
    } else {
      // Execute RCON command
      if (!argv.server) {
        console.error('Error: Server ID is required. Use --server or -s option.');
        console.error('Use --list-servers to see available servers.');
        process.exit(1);
      }

      const command = argv._.join(' ');
      if (!command) {
        console.error('Error: Command is required.');
        console.error('Use --list-commands to see available commands.');
        process.exit(1);
      }

      console.log(`Executing RCON command on server ${argv.server}: ${command}`);
      const result = await client.executeRCON(argv.server, command);
      
      // Format and display result
      if (typeof result === 'string') {
        console.log('\nResult:');
        console.log(result);
      } else if (result) {
        console.log('\nResult:');
        if (result.success !== undefined) {
          console.log(`Success: ${result.success}`);
        }
        if (result.message) {
          console.log(`Message: ${result.message}`);
        }
        if (result.players) {
          console.log('\nPlayers:');
          console.log('Slot'.padEnd(6) + 'Name'.padEnd(20) + 'Score'.padEnd(8) + 'Ping');
          console.log('-'.repeat(40));
          for (const player of result.players) {
            console.log(
              player.clientSlot.toString().padEnd(6) +
              player.name.padEnd(20) +
              player.score.toString().padEnd(8) +
              player.ping.toString()
            );
          }
        }
        if (result.map) {
          console.log(`Map: ${result.map}`);
        }
        if (result.gameId) {
          console.log(`Game ID: ${result.gameId}`);
        }
      }
    }

  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  } finally {
    client.disconnect();
  }
}

// Handle process termination
process.on('SIGINT', () => {
  console.log('\nExiting...');
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\nExiting...');
  process.exit(0);
});

// Run the CLI
main().catch((error) => {
  console.error('Unexpected error:', error.message);
  process.exit(1);
});