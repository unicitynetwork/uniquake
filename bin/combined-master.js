#!/usr/bin/env node

/**
 * Combined master server for UniQuake
 * Provides both WebRTC signaling and QuakeJS protocol support
 * Includes Unicity Framework integration
 */

const path = require("path");
const logger = require("winston");
const optimist = require("optimist");

// Import our components
const MasterServer = require("../lib/master-server");
const QuakeMasterAdapter = require("../lib/quake/master-adapter");

// Parse command line arguments
const argv = optimist
  .usage("Usage: $0 [options]")
  .describe("config", "Configuration file path")
  .default("config", path.join(__dirname, "..", "master-config.json"))
  .describe("port", "Port to listen on")
  .describe("public-ip", "Public IP address for STUN/TURN")
  .describe("quake-port", "Port for QuakeJS master server")
  .boolean("help").describe("help", "Show this help")
  .alias("h", "help")
  .argv;

// Show help and exit if requested
if (argv.help) {
  optimist.showHelp();
  process.exit(0);
}

// Set up logging
logger.cli();
logger.level = "debug";

// Get config file path
const configPath = argv.config;

// Global server instances
let masterServer = null;
let quakeMaster = null;

// Start servers
async function start() {
  try {
    logger.info("Starting combined master server with Unicity support...");
    
    // Start WebRTC master server
    masterServer = new MasterServer(configPath);
    
    // Override config with command line arguments
    if (argv.port) masterServer.config.port = argv.port;
    if (argv["public-ip"]) masterServer.config.publicIp = argv["public-ip"];
    
    // Get quake port from args or config
    const quakePort = argv["quake-port"] || masterServer.config.port;
    
    // Create QuakeJS master adapter
    quakeMaster = new QuakeMasterAdapter({
      port: quakePort,
      host: masterServer.config.host || "0.0.0.0",
      publicIp: masterServer.config.publicIp
    });
    
    // Register the Quake protocol handler with the master server
    masterServer.registerQuakeProtocolHandler(quakeMaster);
    
    // Start the master server with integrated Quake support
    await masterServer.start();
    
    logger.info(`Combined master server running on port ${masterServer.config.port}`);
    logger.info(`QuakeJS master adapter running on port ${quakePort}`);
    logger.info(`Unicity Framework integration enabled (using same WebSocket endpoint)`);
    
    // Handle graceful shutdown
    process.on("SIGINT", async () => {
      logger.info("Received SIGINT, shutting down...");
      try {
        // Set a shutdown timeout to force exit if graceful shutdown takes too long
        const forceExitTimeout = setTimeout(() => {
          logger.error("Shutdown timed out after 10 seconds, forcing exit");
          process.exit(1);
        }, 10000);
        
        // Attempt graceful shutdown
        await masterServer.stop();
        quakeMaster.stop();
        
        // Clear the force exit timeout
        clearTimeout(forceExitTimeout);
        process.exit(0);
      } catch (err) {
        logger.error(`Error during shutdown: ${err.message}`);
        process.exit(1);
      }
    });
    
    process.on("SIGTERM", async () => {
      logger.info("Received SIGTERM, shutting down...");
      try {
        // Set a shutdown timeout to force exit if graceful shutdown takes too long
        const forceExitTimeout = setTimeout(() => {
          logger.error("Shutdown timed out after 10 seconds, forcing exit");
          process.exit(1);
        }, 10000);
        
        // Attempt graceful shutdown
        await masterServer.stop();
        quakeMaster.stop();
        
        // Clear the force exit timeout
        clearTimeout(forceExitTimeout);
        process.exit(0);
      } catch (err) {
        logger.error(`Error during shutdown: ${err.message}`);
        process.exit(1);
      }
    });
    
    return { masterServer, quakeMaster };
  } catch (err) {
    logger.error(`Failed to start master server: ${err.message}`);
    process.exit(1);
  }
}

// Expose server instances for external access
module.exports = {
  start,
  getMasterServer: () => masterServer,
  getQuakeMaster: () => quakeMaster
};

// Start everything if this is the main module
if (require.main === module) {
  start();
}
