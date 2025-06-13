#!/usr/bin/env node

/**
 * Configuration Generator for UniQuake
 * Generates configuration files based on environment variables
 */

const fs = require('fs');
const path = require('path');
const config = require('../lib/config');

// Generate master-config.json
const masterConfigPath = path.join(__dirname, '..', 'master-config.json');
const masterConfig = config.getMasterConfig();
fs.writeFileSync(masterConfigPath, JSON.stringify(masterConfig, null, 2));
console.log(`✓ Generated master-config.json for host: ${config.hostIp}`);

// Generate bin/web.json
const webConfigPath = path.join(__dirname, 'web.json');
const webConfig = config.getWebConfig();
fs.writeFileSync(webConfigPath, JSON.stringify(webConfig, null, 2));
console.log(`✓ Generated bin/web.json for host: ${config.hostIp}`);

// Generate content-config.json
const contentConfigPath = path.join(__dirname, '..', 'content-config.json');
const contentConfig = config.getContentConfig();
fs.writeFileSync(contentConfigPath, JSON.stringify(contentConfig, null, 2));
console.log(`✓ Generated content-config.json for host: ${config.hostIp}`);

// Print current configuration
config.printConfig();