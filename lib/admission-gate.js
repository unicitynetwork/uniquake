'use strict';

/**
 * AdmissionGate — Admission token system (S1 + S2)
 *
 * Generates and validates single-use, time-limited admission tokens
 * that bind a player's cryptographic identity (from Sphere DM) to
 * their WebSocket game connection.
 *
 * Security mitigations:
 *   S1 — Cryptographically random tokens, 5-min TTL, single-use
 *   S2 — Token binds nametag identity to WebSocket connection
 */

const crypto = require('crypto');
const logger = require('winston');

/** Token time-to-live in milliseconds (5 minutes) */
const TOKEN_TTL_MS = 5 * 60 * 1000;

/** Cleanup interval in milliseconds (60 seconds) */
const CLEANUP_INTERVAL_MS = 60 * 1000;

class AdmissionGate {
  /**
   * Create a new AdmissionGate instance.
   * Starts a periodic cleanup interval for expired tokens.
   */
  constructor() {
    /** @type {Map<string, TokenRecord>} token -> record */
    this.tokens = new Map();

    this._cleanupInterval = setInterval(() => {
      this.cleanup();
    }, CLEANUP_INTERVAL_MS);

    // Prevent the interval from keeping the process alive
    if (this._cleanupInterval.unref) {
      this._cleanupInterval.unref();
    }
  }

  /**
   * Generate a cryptographically random admission token.
   * @param {string} sessionId - Session the token grants access to
   * @param {string} nametag - Player nametag bound to this token
   * @param {string} role - Player role ('player' or 'spectator')
   * @returns {string} 32-byte hex-encoded token
   */
  generateAdmissionToken(sessionId, nametag, role) {
    const token = crypto.randomBytes(32).toString('hex');

    this.tokens.set(token, {
      sessionId,
      nametag,
      role,
      createdAt: Date.now(),
      used: false,
    });

    logger.info(
      `[AdmissionGate] Token generated for ${nametag} ` +
      `(session=${sessionId}, role=${role})`
    );

    return token;
  }

  /**
   * Validate and consume an admission token.
   *
   * Checks:
   *   - Token exists
   *   - Session ID matches
   *   - Token has not been used
   *   - Token has not expired (5-min TTL)
   *
   * On success, marks the token as used (single-use).
   *
   * @param {string} token - Token to validate
   * @param {string} sessionId - Expected session ID
   * @returns {{ nametag: string, role: string, sessionId: string } | null}
   */
  validateAdmissionToken(token, sessionId) {
    const record = this.tokens.get(token);
    if (!record) {
      logger.warn('[AdmissionGate] Token not found');
      return null;
    }

    if (record.sessionId !== sessionId) {
      logger.warn(
        `[AdmissionGate] Session mismatch: expected ${record.sessionId}, ` +
        `got ${sessionId}`
      );
      return null;
    }

    if (record.used) {
      logger.warn(
        `[AdmissionGate] Token already used (nametag=${record.nametag})`
      );
      return null;
    }

    const age = Date.now() - record.createdAt;
    if (age > TOKEN_TTL_MS) {
      logger.warn(
        `[AdmissionGate] Token expired (nametag=${record.nametag}, ` +
        `age=${Math.round(age / 1000)}s)`
      );
      return null;
    }

    // Mark as used — single-use token
    record.used = true;

    logger.info(
      `[AdmissionGate] Token validated for ${record.nametag} ` +
      `(session=${sessionId}, role=${record.role})`
    );

    return {
      nametag: record.nametag,
      role: record.role,
      sessionId: record.sessionId,
    };
  }

  /**
   * Remove expired tokens (older than 5 minutes).
   * Called automatically every 60 seconds.
   */
  cleanup() {
    const now = Date.now();
    let removed = 0;

    for (const [token, record] of this.tokens) {
      const age = now - record.createdAt;
      if (age > TOKEN_TTL_MS) {
        this.tokens.delete(token);
        removed++;
      }
    }

    if (removed > 0) {
      logger.info(
        `[AdmissionGate] Cleanup: removed ${removed} expired token(s), ` +
        `${this.tokens.size} remaining`
      );
    }
  }

  /**
   * Clear the cleanup interval and release resources.
   * Call this when shutting down the server.
   */
  destroy() {
    if (this._cleanupInterval) {
      clearInterval(this._cleanupInterval);
      this._cleanupInterval = null;
    }
  }
}

module.exports = AdmissionGate;
