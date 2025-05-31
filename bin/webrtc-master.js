#!/usr/bin/env node

/**
 * WebRTC-enabled master server for UniQuake
 * Provides signaling, STUN, and TURN services
 */

const MasterServer = require('../lib/master-server');
const optimist = require('optimist');
const logger = require('winston');

// Set up logging
logger.cli();
logger.level = process.env.LOG_LEVEL || 'info';

// Parse command line arguments
const argv = optimist
  .usage('Usage: $0 [options]')
  .describe('config', 'Configuration file path')
  .default('config', './master-config.json')
  .describe('port', 'Port to listen on')
  .describe('public-ip', 'Public IP address for STUN/TURN')
  .describe('stun-port', 'STUN server port')
  .describe('turn-port', 'TURN server port')
  .boolean('help').describe('help', 'Show this help')
  .alias('h', 'help')
  .argv;

// Show help and exit if requested
if (argv.help) {
  optimist.showHelp();
  process.exit(0);
}

// Get config file path
const configPath = argv.config;

// Create and start the master server
async function start() {
  try {
    // Create master server instance
    const masterServer = new MasterServer(configPath);
    
    // Override config with command line arguments
    if (argv.port) masterServer.config.port = argv.port;
    if (argv['public-ip']) masterServer.config.publicIp = argv['public-ip'];
    if (argv['stun-port']) masterServer.config.stunPort = argv['stun-port'];
    if (argv['turn-port']) masterServer.config.turnPort = argv['turn-port'];
    
    // Start the server
    await masterServer.start();
    
    // Handle graceful shutdown
    process.on('SIGINT', async () => {
      logger.info('Received SIGINT, shutting down...');
      await masterServer.stop();
      process.exit(0);
    });
    
    process.on('SIGTERM', async () => {
      logger.info('Received SIGTERM, shutting down...');
      await masterServer.stop();
      process.exit(0);
    });
    
    // Periodically log status
    if (process.env.LOG_STATUS === 'true') {
      setInterval(() => {
        const status = masterServer.getStatus();
        logger.info('Server status:', status);
      }, 60000); // Every minute
    }
    
  } catch (err) {
    logger.error(`Failed to start master server: ${err.message}`);
    process.exit(1);
  }
}

// Start the server
start();