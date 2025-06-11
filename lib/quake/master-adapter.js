/**
 * QuakeJS Master Server Adapter
 * 
 * This module adapts the WebRTC master server to handle QuakeJS protocol
 * messages, allowing direct integration with the QuakeJS dedicated server.
 */

const http = require("http");
const WebSocketServer = require("ws").Server;
const quakeProtocol = require("../quake-protocol");

class QuakeMasterAdapter {
  /**
   * Create a new QuakeJS master server adapter
   * @param {Object} config - Configuration
   */
  constructor(config = {}) {
    this.config = {
      port: config.port || 27950,
      host: config.host || "0.0.0.0",
      ...config
    };
    
    this.clients = [];
    this.servers = {};
    this.pruneInterval = 350 * 1000; // 350 seconds
    
    console.log("QuakeJS Master Server Adapter initialized");
  }
  
  /**
   * Initialize the adapter with an existing HTTP server
   * @param {http.Server} httpServer - Existing HTTP server
   * @deprecated Use useWebSocketServer instead
   */
  init(httpServer) {
    // Use the provided HTTP server
    this.server = httpServer;
    
    // Create WebSocket server using the existing HTTP server
    // Warning: This can cause conflicts with other WebSocket servers
    this.wss = new WebSocketServer({
      server: this.server,
      noServer: true // Don't handle upgrade events automatically
    });
    
    console.log(`QuakeJS master server adapter initialized on existing server`);
    
    // Start maintenance tasks
    this.startMaintenanceTasks();
    
    return this.server;
  }
  
  /**
   * Use an existing WebSocket server
   * @param {WebSocketServer} wsServer - Existing WebSocket server to use
   */
  useWebSocketServer(wsServer) {
    // Store reference to the WebSocket server
    this.wss = wsServer;
    
    // Set up connection handler
    this.wss.on("connection", (ws) => {
      // Only handle binary messages to avoid conflicts with other handlers
      const handleBinaryMessage = (buffer, isBinary) => {
        // Skip non-binary messages - they're for WebRTC signaling
        if (!isBinary) {
          return;
        }
        
        try {
          // Try to handle as a Quake protocol message
          this.handleQuakeMessage(ws, buffer);
        } catch (err) {
          console.error(`Error handling Quake protocol message: ${err.message}`);
        }
      };
      
      // Add the message handler
      ws.on("message", handleBinaryMessage);
    });
    
    console.log(`QuakeJS master server adapter using shared WebSocket server`);
    
    // Start maintenance tasks
    this.startMaintenanceTasks();
  }
  
  /**
   * Handle a Quake protocol message
   * @param {WebSocket} ws - WebSocket connection
   * @param {Buffer} buffer - Binary message buffer
   */
  handleQuakeMessage(ws, buffer) {
    // Create connection object if needed
    let conn = this.findConnectionBySocket(ws);
    if (!conn) {
      conn = {
        socket: ws,
        addr: this.getRemoteAddress(ws),
        port: this.getRemotePort(ws),
        first: true
      };
      
      // Store connection
      this.connections = this.connections || [];
      this.connections.push(conn);
      
      // Set up cleanup handlers if not already set
      if (!ws._quakeHandlersSet) {
        ws.on("error", (err) => {
          this.removeClient(conn);
        });
        
        ws.on("close", () => {
          this.removeClient(conn);
        });
        
        ws._quakeHandlersSet = true;
      }
    }
    
    // Convert Buffer to ArrayBuffer for protocol handling
    const view = Uint8Array.from(buffer);
    const arrayBuffer = view.buffer;
    
    // Check for port message (first message)
    if (conn.first) {
      conn.first = false;
      if (view.byteLength === 10 &&
          view[0] === 255 && view[1] === 255 && view[2] === 255 && view[3] === 255 &&
          view[4] === "p".charCodeAt(0) && view[5] === "o".charCodeAt(0) && 
          view[6] === "r".charCodeAt(0) && view[7] === "t".charCodeAt(0)) {
        conn.port = ((view[8] << 8) | view[9]);
        console.log(`Connection from ${conn.addr} identified port: ${conn.port}`);
        return;
      }
    }
    
    // Parse OOB message
    const msg = quakeProtocol.stripOOB(arrayBuffer);
    if (!msg) {
      // Not a valid Quake message, ignore
      return;
    }
    
    // Handle message types
    if (msg.indexOf("getservers ") === 0) {
      this.handleGetServers(conn, msg.substr(11));
    } else if (msg.indexOf("heartbeat ") === 0) {
      this.handleHeartbeat(conn, msg.substr(10));
    } else if (msg.indexOf("infoResponse\n") === 0) {
      this.handleInfoResponse(conn, msg.substr(13));
    } else if (msg.indexOf("subscribe") === 0) {
      this.handleSubscribe(conn);
    } else {
      console.log(`Quake message: "${msg}"`);
    }
  }
  
  /**
   * Find a connection by its WebSocket
   * @param {WebSocket} ws - WebSocket to find
   * @returns {Object|null} Connection object or null if not found
   */
  findConnectionBySocket(ws) {
    this.connections = this.connections || [];
    return this.connections.find(conn => conn.socket === ws) || null;
  }
  
  /**
   * Start the master server on its own HTTP server
   * This is used when not sharing an HTTP server with another component
   */
  start() {
    // Create HTTP server
    this.server = http.createServer();
    
    // Create WebSocket server
    this.wss = new WebSocketServer({
      server: this.server
    });
    
    // Set up connection handler for dedicated mode
    this.wss.on("connection", (ws) => {
      // Create connection object
      const conn = {
        socket: ws,
        addr: this.getRemoteAddress(ws),
        port: this.getRemotePort(ws),
        first: true
      };
      
      // Add to connections
      this.connections = this.connections || [];
      this.connections.push(conn);
      
      // Handle messages
      ws.on("message", (buffer, isBinary) => {
        if (!isBinary) return;
        this.handleQuakeMessage(ws, buffer);
      });
      
      // Handle disconnection
      ws.on("error", (err) => {
        this.removeClient(conn);
      });
      
      ws.on("close", () => {
        this.removeClient(conn);
      });
    });
    
    // Start server
    this.server.listen(this.config.port, this.config.host, () => {
      console.log(`QuakeJS master server adapter listening on ${this.config.host}:${this.config.port}`);
    });
    
    // Start maintenance tasks
    this.startMaintenanceTasks();
    
    return this.server;
  }
  
  /**
   * Start maintenance tasks
   */
  startMaintenanceTasks() {
    // Start maintenance interval for server pruning
    this.maintenanceInterval = setInterval(() => {
      this.pruneServers();
    }, this.pruneInterval);
    
    console.log("QuakeJS master server maintenance tasks scheduled");
  }

  /**
   * Stop the master server
   */
  stop() {
    if (this.maintenanceInterval) {
      clearInterval(this.maintenanceInterval);
    }
    
    // Force close any connections we're tracking
    if (this.connections && this.connections.length > 0) {
      console.log(`Forcibly closing ${this.connections.length} Quake client connections`);
      
      // Close all WebSocket connections
      for (const conn of this.connections) {
        try {
          if (conn.socket) {
            conn.socket.terminate(); // Force immediate closure
          }
        } catch (err) {
          console.error(`Error closing Quake client connection: ${err.message}`);
        }
      }
      
      // Clear the connections array
      this.connections = [];
    }
    
    // Also clear the clients array
    if (this.clients && this.clients.length > 0) {
      this.clients = [];
    }
    
    console.log('Quake master adapter stopped');
    
    // Don't close the server since we didn't create it
    // The parent code will handle closing the HTTP server
  }
  
  /**
   * Handle getservers request
   */
  handleGetServers(conn, data) {
    console.log(`${conn.addr}:${conn.port} ---> getservers`);
    this.sendGetServersResponse(conn, this.servers);
  }
  
  /**
   * Handle heartbeat
   */
  handleHeartbeat(conn, data) {
    console.log(`${conn.addr}:${conn.port} ---> heartbeat`);
    this.sendGetInfo(conn);
  }
  
  /**
   * Handle info response
   */
  handleInfoResponse(conn, data) {
    console.log(`${conn.addr}:${conn.port} ---> infoResponse`);
    
    // Parse server info
    const info = quakeProtocol.parseInfoString(data);
    
    // Update server in registry
    this.updateServer(conn.addr, conn.port);
  }
  
  /**
   * Handle subscribe request
   */
  handleSubscribe(conn) {
    console.log(`${conn.addr}:${conn.port} ---> subscribe`);
    this.addClient(conn);
    this.sendGetServersResponse(conn, this.servers);
  }
  
  /**
   * Send getinfo request
   */
  sendGetInfo(conn) {
    const challenge = quakeProtocol.buildChallenge();
    
    console.log(`${conn.addr}:${conn.port} <--- getinfo with challenge "${challenge}"`);
    
    const buffer = quakeProtocol.formatOOB("getinfo " + challenge);
    conn.socket.send(buffer, { binary: true });
  }
  
  /**
   * Send getserversResponse
   */
  sendGetServersResponse(conn, servers) {
    let msg = "getserversResponse";
    
    for (const id in servers) {
      if (!servers.hasOwnProperty(id)) {
        continue;
      }
      
      const server = servers[id];
      const octets = server.addr.split(".").map(n => parseInt(n, 10));
      
      msg += "\\";
      msg += String.fromCharCode(octets[0] & 0xff);
      msg += String.fromCharCode(octets[1] & 0xff);
      msg += String.fromCharCode(octets[2] & 0xff);
      msg += String.fromCharCode(octets[3] & 0xff);
      msg += String.fromCharCode((server.port & 0xff00) >> 8);
      msg += String.fromCharCode(server.port & 0xff);
    }
    
    msg += "\\EOT";
    
    console.log(`${conn.addr}:${conn.port} <--- getserversResponse with ${Object.keys(servers).length} server(s)`);
    
    const buffer = quakeProtocol.formatOOB(msg);
    conn.socket.send(buffer, { binary: true });
  }
  
  /**
   * Add client to registry
   */
  addClient(conn) {
    const idx = this.clients.indexOf(conn);
    if (idx !== -1) {
      return; // Already subscribed
    }
    
    console.log(`${conn.addr}:${conn.port} ---> subscribe`);
    this.clients.push(conn);
  }
  
  /**
   * Remove client from registry
   */
  removeClient(conn) {
    // Remove from clients list if present
    const clientIdx = this.clients.indexOf(conn);
    if (clientIdx !== -1) {
      console.log(`${conn.addr}:${conn.port} ---> unsubscribe`);
      this.clients.splice(clientIdx, 1);
    }
    
    // Remove from connections list if present
    if (this.connections) {
      const connIdx = this.connections.indexOf(conn);
      if (connIdx !== -1) {
        this.connections.splice(connIdx, 1);
        console.log(`${conn.addr}:${conn.port} ---> disconnected`);
      }
    }
  }
  
  /**
   * Update server in registry
   */
  updateServer(addr, port) {
    const id = `${addr}:${port}`;
    let server = this.servers[id];
    
    if (!server) {
      server = this.servers[id] = { addr, port };
    }
    
    server.lastUpdate = Date.now();
    
    console.log(`${addr}:${port} registered, ${Object.keys(this.servers).length} server(s) currently registered`);
    
    // Send partial update to all clients
    for (let i = 0; i < this.clients.length; i++) {
      this.sendGetServersResponse(this.clients[i], { [id]: server });
    }
  }
  
  /**
   * Remove server from registry
   */
  removeServer(id) {
    const server = this.servers[id];
    if (!server) return;
    
    delete this.servers[id];
    
    console.log(`${server.addr}:${server.port} timed out, ${Object.keys(this.servers).length} server(s) currently registered`);
  }
  
  /**
   * Prune inactive servers
   */
  pruneServers() {
    const now = Date.now();
    
    for (const id in this.servers) {
      if (!this.servers.hasOwnProperty(id)) {
        continue;
      }
      
      const server = this.servers[id];
      const delta = now - server.lastUpdate;
      
      if (delta > this.pruneInterval) {
        this.removeServer(id);
      }
    }
  }
  
  /**
   * Get remote address from WebSocket
   */
  getRemoteAddress(ws) {
    if (ws.upgradeReq && ws.upgradeReq.headers["x-forwarded-for"]) {
      return ws.upgradeReq.headers["x-forwarded-for"];
    }
    
    return ws._socket.remoteAddress;
  }
  
  /**
   * Get remote port from WebSocket
   */
  getRemotePort(ws) {
    if (ws.upgradeReq && ws.upgradeReq.headers["x-forwarded-port"]) {
      return parseInt(ws.upgradeReq.headers["x-forwarded-port"], 10);
    }
    
    return ws._socket.remotePort;
  }
}

module.exports = QuakeMasterAdapter;
