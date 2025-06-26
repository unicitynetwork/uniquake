#!/bin/bash

# UNIQUAKE Setup Script
# This script sets up the UNIQUAKE project, including all submodules and dependencies

echo "===== UNIQUAKE Setup Script ====="
echo "This script will set up UNIQUAKE and all its dependencies."
echo "Make sure you have Node.js and Git installed."
echo ""

# Function to check if command exists
command_exists() {
  command -v "$1" >/dev/null 2>&1
}

# Check for required commands
if ! command_exists node; then
  echo "Error: Node.js is not installed. Please install Node.js before continuing."
  exit 1
fi

if ! command_exists git; then
  echo "Error: Git is not installed. Please install Git before continuing."
  exit 1
fi

# Print Node and npm versions
echo "Using Node.js $(node -v)"
echo "Using npm $(npm -v)"
echo ""

# Ensure submodules are initialized
echo "=== Initializing Git submodules ==="
#git submodule update --init --recursive
git submodule update --init
echo "Main submodules initialized successfully."
echo ""

# Explicitly ensure the nested ioq3 submodule is initialized
echo "=== Initializing nested ioq3 submodule ==="
cd fresh_quakejs

# Check if .gitmodules uses git:// protocol and fix it to use https:// if needed
if grep -q "git://" .gitmodules; then
  echo "Updating submodule URL from git:// to https:// protocol..."
  sed -i 's|git://github.com|https://github.com|g' .gitmodules
  git config --file=.gitmodules submodule.ioq3.url https://github.com/inolen/ioq3.git
  git submodule sync
fi

# Initialize the submodule
git submodule update --init --recursive
cd ..
echo "Nested ioq3 submodule initialized successfully."
echo ""

# Install main project dependencies
echo "=== Installing main project dependencies ==="
npm install
echo "Main project dependencies installed successfully."
echo ""

# Set up dedicated server (fresh_quakejs)
echo "=== Setting up dedicated server (fresh_quakejs) ==="
cd fresh_quakejs
npm install
echo "Dedicated server dependencies installed successfully."
echo ""

# Prepare QuakeJS dedicated server
echo "=== Preparing QuakeJS dedicated server ==="
echo "This step will download game assets after accepting the EULA."
echo "IMPORTANT: You will need to accept the EULA to download game assets."
echo "Note: You'll need approximately 1GB of RAM for this step."
echo ""

# Create baseq3 directory if it doesn't exist
echo "Creating baseq3 directory..."
mkdir -p base/baseq3

# Copy server.cfg to baseq3 directory
echo "Copying server.cfg to baseq3 directory..."
cp ../server.cfg base/baseq3/

# Download required QuakeJS installer files
echo "=== Downloading required QuakeJS installer files ==="
echo "Downloading linuxq3ademo-1.11-6.x86.gz.sh..."
if [ ! -f "base/linuxq3ademo-1.11-6.x86.gz.sh" ]; then
  wget -q http://content.quakejs.com/assets/857908472-linuxq3ademo-1.11-6.x86.gz.sh -O base/linuxq3ademo-1.11-6.x86.gz.sh
  if [ $? -eq 0 ]; then
    echo "✓ linuxq3ademo-1.11-6.x86.gz.sh downloaded successfully"
  else
    echo "✗ Failed to download linuxq3ademo-1.11-6.x86.gz.sh"
  fi
else
  echo "✓ linuxq3ademo-1.11-6.x86.gz.sh already exists"
fi

echo "Downloading linuxq3apoint-1.32b-3.x86.run..."
if [ ! -f "base/linuxq3apoint-1.32b-3.x86.run" ]; then
  wget -q http://content.quakejs.com/assets/296843703-linuxq3apoint-1.32b-3.x86.run -O base/linuxq3apoint-1.32b-3.x86.run
  if [ $? -eq 0 ]; then
    echo "✓ linuxq3apoint-1.32b-3.x86.run downloaded successfully"
  else
    echo "✗ Failed to download linuxq3apoint-1.32b-3.x86.run"
  fi
else
  echo "✓ linuxq3apoint-1.32b-3.x86.run already exists"
fi
echo ""

# Return to main directory for environment setup
cd ..

# Create logs directory if it doesn't exist
if [ ! -d "logs" ]; then
  echo "Creating logs directory..."
  mkdir -p logs
fi

# Create .env file with default configuration
echo "=== Creating environment configuration ==="
echo "What is the public IP or hostname of your server?"
read -p "Server IP/hostname (default: localhost): " server_ip
server_ip=${server_ip:-localhost}

# Create comprehensive .env file
cat > .env << EOF
# UniQuake Configuration
# Public server IP or hostname (required)
HOST_IP=${server_ip}

# Port configurations
MASTER_PORT=27950
CONTENT_PORT=9000
WEB_PORT=8080
MOCK_PORT=8080

# Game server configuration
GAME_SERVER_IP=${server_ip}
GAME_SERVER_BASE_PORT=27961

# STUN/TURN configuration  
STUN_PORT=3478
STUN_PORT_SECONDARY=3479
TURN_PORT=3478
TURN_REALM=uniquake.com

# Logging
LOG_LEVEL=info
EOF

echo "Environment configuration created with HOST_IP=${server_ip}"
echo ""

# Generate configuration files
echo "=== Generating configuration files ==="
npm run config
echo ""

# Go back to fresh_quakejs for final step
cd fresh_quakejs

echo "Starting dedicated server to download base game files..."
echo "When the EULA appears, press ENTER to scroll through it, then type 'y' to accept."
echo "After the files finish downloading, press Ctrl+C to exit."
echo "NOTE: Ctrl+C will stop the server but setup is already complete!"
echo ""
echo "Press ENTER to continue..."
read

# Run dedicated server in baseq3 mode to trigger EULA and file download
node build/ioq3ded.js +set fs_game baseq3 +set dedicated 2

echo ""
echo "Game files should now be downloaded. If you encountered any errors or didn't"
echo "see the EULA prompt, please try running the dedicated server manually:"
echo "  cd fresh_quakejs"
echo "  node build/ioq3ded.js +set fs_game baseq3 +set dedicated 2"

echo "===== Setup Complete ====="
echo ""
echo "You can now run the following commands to start the system:"
echo "1. Start master server: npm run master-quake"
echo "2. Start content server: npm run content"
echo "3. Start web server: npm start"
echo ""
echo "For development, you can use: npm run browser-mock-all"
echo ""
echo "Your server will be accessible at:"
echo "- Web interface: http://${server_ip}:8080"
echo "- Client mock: http://${server_ip}:8080/client"
echo "- Server mock: http://${server_ip}:8080/server"
echo "- Game: http://${server_ip}:8080/quake"
echo ""
echo "To change the host IP later, edit the .env file and run 'npm run config'"
echo ""
echo "Refer to README.md for more information."