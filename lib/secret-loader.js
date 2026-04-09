'use strict';

/**
 * Secret Loader — Mnemonic protection utility (S3)
 *
 * Provides secure loading of the server wallet mnemonic from either
 * a file path (UNIQUAKE_MNEMONIC_FILE) or an environment variable
 * (UNIQUAKE_MNEMONIC). The env var is deleted immediately after reading
 * to reduce exposure surface.
 *
 * Also provides config sanitization to prevent accidental mnemonic logging.
 */

const fs = require('fs');
const logger = require('winston');

/**
 * Load the server wallet mnemonic from file or environment variable.
 *
 * Priority:
 *   1. UNIQUAKE_MNEMONIC_FILE env var (path to file containing mnemonic)
 *   2. UNIQUAKE_MNEMONIC env var (mnemonic string directly)
 *
 * The UNIQUAKE_MNEMONIC env var is deleted after reading (S3).
 *
 * @returns {string} The validated mnemonic string
 * @throws {Error} If no mnemonic source is available or validation fails
 */
function loadMnemonic() {
  let mnemonic = null;
  let source = null;

  const mnemonicFile = process.env.UNIQUAKE_MNEMONIC_FILE;
  if (mnemonicFile) {
    try {
      mnemonic = fs.readFileSync(mnemonicFile, 'utf8').trim();
      source = 'file';
      logger.info('[secret-loader] Mnemonic loaded from file');
    } catch (err) {
      throw new Error(
        `Failed to read mnemonic file at ${mnemonicFile}: ${err.message}`
      );
    }
  }

  if (!mnemonic) {
    mnemonic = process.env.UNIQUAKE_MNEMONIC;
    if (mnemonic) {
      mnemonic = mnemonic.trim();
      source = 'env';
      logger.info('[secret-loader] Mnemonic loaded from environment variable');
      // Clear the env var immediately to reduce exposure (S3)
      delete process.env.UNIQUAKE_MNEMONIC;
    }
  }

  if (!mnemonic) {
    throw new Error(
      'No mnemonic configured. Set UNIQUAKE_MNEMONIC_FILE (preferred) ' +
      'or UNIQUAKE_MNEMONIC environment variable.'
    );
  }

  // Validate word count (BIP-39: 12 or 24 words)
  const words = mnemonic.split(/\s+/).filter(Boolean);
  if (words.length !== 12 && words.length !== 24) {
    throw new Error(
      `Invalid mnemonic: expected 12 or 24 words, got ${words.length}. ` +
      `Source: ${source}`
    );
  }

  return mnemonic;
}

/**
 * Deep-copy a configuration object and redact any mnemonic fields.
 * Prevents accidental logging of sensitive data.
 *
 * @param {Object} configObj - Configuration object to sanitize
 * @returns {Object} A deep copy with all `mnemonic` fields replaced by '[REDACTED]'
 */
function sanitizeConfig(configObj) {
  if (configObj === null || typeof configObj !== 'object') {
    return configObj;
  }

  if (Array.isArray(configObj)) {
    return configObj.map(item => sanitizeConfig(item));
  }

  const copy = {};
  for (const key of Object.keys(configObj)) {
    if (key === 'mnemonic') {
      copy[key] = '[REDACTED]';
    } else if (typeof configObj[key] === 'object' && configObj[key] !== null) {
      copy[key] = sanitizeConfig(configObj[key]);
    } else {
      copy[key] = configObj[key];
    }
  }
  return copy;
}

module.exports = {
  loadMnemonic,
  sanitizeConfig,
};
