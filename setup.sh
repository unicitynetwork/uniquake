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
echo "Submodules initialized successfully."
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
echo ""

# Run browserify
echo "Running browserify..."
node build/js/browserify.js

# Configure repos and accept EULA
echo ""
echo "Configuring repositories and accepting EULA..."
echo "When prompted, type 'y' to accept the EULA."
node build/js/configure-repos.js

# Download assets
echo ""
echo "Downloading game assets (this may take a while)..."
node build/js/download-assets.js

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