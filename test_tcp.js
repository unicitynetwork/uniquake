console.log("Testing connection to 127.0.0.1:27960");
const net = require("net");
const client = new net.Socket();
client.connect(27960, "127.0.0.1", function() {
    console.log("Connected to server\!");
    // Send a dummy handshake
    client.write("HELLO");
});
client.on("data", function(data) {
    console.log("Received: " + data);
    // Close the connection after receiving data
    client.destroy();
});
client.on("close", function() {
    console.log("Connection closed");
});
client.on("error", function(err) {
    console.log("Error: " + err.message);
});
// Timeout after 3 seconds
setTimeout(() => {
    console.log("Timeout reached, closing connection");
    if (\!client.destroyed) {
        client.destroy();
    }
    process.exit(0);
}, 3000);
