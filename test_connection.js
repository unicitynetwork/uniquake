
const WebSocket = require("ws");

// Try to connect to the server
const ws = new WebSocket("ws://localhost:27960");

ws.on("open", function open() {
  console.log("Connection established\!");
  ws.close();
});

ws.on("error", function error(err) {
  console.error("WebSocket error:", err.message);
});

// Close after 2 seconds
setTimeout(() => {
  if (ws.readyState \!== WebSocket.CLOSED) {
    console.log("Closing connection after timeout");
    ws.close();
  }
  process.exit(0);
}, 2000);

