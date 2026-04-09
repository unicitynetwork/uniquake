#!/bin/bash
#
# Build the UniQuake Docker image
#
# Usage:
#   ./docker/build.sh                    # Build as uniquake:latest
#   ./docker/build.sh my-registry/uniquake:v1.0   # Build with custom tag
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
IMAGE_TAG="${1:-uniquake:latest}"

echo "Building UniQuake Docker image: $IMAGE_TAG"

# Ensure fresh_quakejs submodule is initialized with game assets
if [ ! -d "$PROJECT_DIR/fresh_quakejs/base" ] || [ ! -f "$PROJECT_DIR/fresh_quakejs/package.json" ]; then
    echo "Initializing fresh_quakejs submodule..."
    cd "$PROJECT_DIR"
    git submodule update --init
    cd fresh_quakejs
    if grep -q "git://" .gitmodules 2>/dev/null; then
        if [[ "${OSTYPE:-linux}" == "darwin"* ]]; then
            sed -i '' 's|git://github.com|https://github.com|g' .gitmodules
        else
            sed -i 's|git://github.com|https://github.com|g' .gitmodules
        fi
        git config --file=.gitmodules submodule.ioq3.url https://github.com/inolen/ioq3.git
        git submodule sync
    fi
    git submodule update --init --recursive
    # Do NOT run npm install here — it runs inside the Dockerfile
    cd "$PROJECT_DIR"
fi

# Build the image
docker build \
    ${NO_CACHE:+--no-cache} \
    -f "$SCRIPT_DIR/Dockerfile" \
    -t "$IMAGE_TAG" \
    "$PROJECT_DIR"

echo ""
echo "Build complete: $IMAGE_TAG"
echo "Run with: ./start-quake.sh --image $IMAGE_TAG"
echo "Clean build: NO_CACHE=1 ./docker/build.sh"
