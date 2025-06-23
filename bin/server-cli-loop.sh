#!/bin/bash

# UniQuake Server CLI Loop Runner
# Keeps server-cli running continuously, restarting after each match ends

# Get the directory where this script is located
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
SERVER_CLI="$SCRIPT_DIR/server-cli.js"

# Default values (can be overridden by command line arguments)
MASTER_SERVER="ws://localhost:27950"
SERVER_NAME="DEMO_GAME"
MAP="q3dm1"
MAX_PLAYERS=16
ENTRY_FEE=1
RESTART_DELAY=2

# Check if server-cli.js exists
if [ ! -f "$SERVER_CLI" ]; then
    echo "Error: server-cli.js not found at $SERVER_CLI"
    exit 1
fi

# Parse command line arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        --master)
            MASTER_SERVER="$2"
            shift 2
            ;;
        --name)
            SERVER_NAME="$2"
            shift 2
            ;;
        --map)
            MAP="$2"
            shift 2
            ;;
        --max-players)
            MAX_PLAYERS="$2"
            shift 2
            ;;
        --entry-fee)
            ENTRY_FEE="$2"
            shift 2
            ;;
        --no-tokens)
            NO_TOKENS="--no-tokens"
            shift
            ;;
        --debug)
            DEBUG="--debug"
            shift
            ;;
        --restart-delay)
            RESTART_DELAY="$2"
            shift 2
            ;;
        --help|-h)
            echo "Usage: $0 [options]"
            echo ""
            echo "Options:"
            echo "  --master <url>        Master server URL (default: ws://localhost:27950)"
            echo "  --name <name>         Server name (default: UniQuake Server)"
            echo "  --map <map>           Map name (default: q3dm1)"
            echo "  --max-players <num>   Maximum players (default: 16)"
            echo "  --entry-fee <num>     Entry fee in tokens (default: 1)"
            echo "  --no-tokens           Disable token system"
            echo "  --debug               Enable debug logging"
            echo "  --restart-delay <sec> Delay between restarts in seconds (default: 2)"
            echo "  --help, -h            Show this help message"
            echo ""
            echo "Example:"
            echo "  $0 --master ws://192.168.1.100:27950 --name \"My Tournament Server\" --entry-fee 5"
            exit 0
            ;;
        *)
            echo "Unknown option: $1"
            echo "Use --help for usage information"
            exit 1
            ;;
    esac
done

# Function to handle script termination
cleanup() {
    echo -e "\n\nStopping server loop..."
    # Kill any running server-cli process
    pkill -f "node.*server-cli.js"
    exit 0
}

# Set up signal handlers
trap cleanup SIGINT SIGTERM

# Display configuration
echo "=== UniQuake Server CLI Loop Runner ==="
echo "Configuration:"
echo "  Master Server: $MASTER_SERVER"
echo "  Server Name: $SERVER_NAME"
echo "  Map: $MAP"
echo "  Max Players: $MAX_PLAYERS"
echo "  Entry Fee: $ENTRY_FEE"
echo "  Tokens: ${NO_TOKENS:+Disabled}${NO_TOKENS:-Enabled}"
echo "  Debug: ${DEBUG:+Enabled}${DEBUG:-Disabled}"
echo "  Restart Delay: $RESTART_DELAY seconds"
echo ""
echo "Press Ctrl+C to stop the server loop"
echo "======================================="
echo ""

# Counter for number of matches
MATCH_COUNT=0

# Infinite loop
while true; do
    MATCH_COUNT=$((MATCH_COUNT + 1))
    echo -e "\n🎮 Starting match #$MATCH_COUNT at $(date)"
    echo "----------------------------------------"
    
    # Run server-cli with all the arguments
    node "$SERVER_CLI" \
        --master "$MASTER_SERVER" \
        --name "$SERVER_NAME" \
        --map "$MAP" \
        --max-players "$MAX_PLAYERS" \
        --entry-fee "$ENTRY_FEE" \
        $NO_TOKENS \
        $DEBUG
    
    # Check exit code
    EXIT_CODE=$?
    
    if [ $EXIT_CODE -eq 0 ]; then
        echo -e "\n✅ Match #$MATCH_COUNT completed successfully"
    else
        echo -e "\n❌ Match #$MATCH_COUNT ended with error (exit code: $EXIT_CODE)"
    fi
    
    echo "⏳ Restarting in $RESTART_DELAY seconds..."
    sleep $RESTART_DELAY
done