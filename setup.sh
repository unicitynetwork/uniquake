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
git submodule update --init --recursive
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

echo "Starting dedicated server to download base game files..."
echo "When the EULA appears, press ENTER to scroll through it, then type 'y' to accept."
echo "After the files finish downloading, press Ctrl+C to continue setup."
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

# Return to main directory
cd ..
echo ""

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

echo "GAME_SERVER_IP=${server_ip}" > .env
echo "Environment configuration created with GAME_SERVER_IP=${server_ip}"
echo ""

echo "===== Setup Complete ====="
echo ""
echo "You can now run the following commands to start the system:"
echo "1. Start master server: npm run master-quake"
echo "2. Start content server: npm run content"
echo "3. Start web server: npm start"
echo ""
echo "For development, you can use: npm run browser-mock-all"
echo ""
echo "Refer to README.md for more information."