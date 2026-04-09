#!/bin/bash
# Builds a browser-compatible bundle from sphere-sdk's CJS connect/browser module
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
OUTPUT="${PROJECT_DIR}/public/sphere-connect-bundle.js"

# Find the CJS bundle — try npm-installed first, then source checkout
SDK_CJS="${PROJECT_DIR}/node_modules/@unicitylabs/sphere-sdk/dist/impl/browser/connect/index.cjs"
if [ ! -f "$SDK_CJS" ]; then
    SDK_CJS="/home/vrogojin/sphere-sdk/dist/impl/browser/connect/index.cjs"
fi
if [ ! -f "$SDK_CJS" ]; then
    echo "ERROR: sphere-sdk connect browser bundle not found" >&2
    echo "Install with: npm install @unicitylabs/sphere-sdk" >&2
    exit 1
fi

mkdir -p "$(dirname "$OUTPUT")"

# Wrap the CJS module in an IIFE that exposes window.SphereConnect
{
    cat << 'HEADER'
/**
 * Sphere SDK Connect Browser Bundle (auto-generated)
 * Provides: window.SphereConnect = { autoConnect, ConnectClient, PostMessageTransport, ExtensionTransport, ... }
 * Do not edit — regenerate with: npm run build:sphere-bridge
 */
(function(window) {
  'use strict';
  var module = { exports: {} };
  var exports = module.exports;

HEADER
    cat "$SDK_CJS"
    cat << 'FOOTER'

  // Expose as global
  window.SphereConnect = module.exports;
})(typeof window !== 'undefined' ? window : globalThis);
FOOTER
} > "$OUTPUT"

echo "Built: $OUTPUT ($(wc -l < "$OUTPUT") lines)"
