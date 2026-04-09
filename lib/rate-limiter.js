'use strict';

/**
 * RateLimiter — Per-nametag join rate limiting (S11)
 *
 * Implements a sliding-window rate limiter to prevent abuse of
 * join/cancel cycles that consume server resources and on-chain
 * transaction fees.
 *
 * Default: 3 requests per 5 minutes per nametag.
 */

const logger = require('winston');

/** Default maximum requests per window */
const DEFAULT_MAX_REQUESTS = 3;

/** Default window size in milliseconds (5 minutes) */
const DEFAULT_WINDOW_MS = 5 * 60 * 1000;

class RateLimiter {
  /**
   * Create a new RateLimiter
   * @param {number} [maxRequests=3] - Maximum requests allowed per window
   * @param {number} [windowMs=300000] - Window duration in milliseconds
   */
  constructor(maxRequests, windowMs) {
    this.maxRequests = maxRequests || DEFAULT_MAX_REQUESTS;
    this.windowMs = windowMs || DEFAULT_WINDOW_MS;

    /** @type {Map<string, number[]>} nametag -> array of request timestamps */
    this.requests = new Map();
  }

  /**
   * Check whether a nametag is allowed to make a request.
   * Prunes expired entries before checking.
   *
   * @param {string} nametag - The nametag to check
   * @returns {{ allowed: boolean, retryAfterMs: number }}
   *   - allowed: true if the request is within limits
   *   - retryAfterMs: 0 if allowed, otherwise ms until the next slot opens
   */
  check(nametag) {
    const now = Date.now();
    const cutoff = now - this.windowMs;

    // Get or create the timestamp array for this nametag
    let timestamps = this.requests.get(nametag);

    if (timestamps) {
      // Prune expired entries
      timestamps = timestamps.filter(ts => ts > cutoff);
      this.requests.set(nametag, timestamps);
    } else {
      timestamps = [];
      this.requests.set(nametag, timestamps);
    }

    if (timestamps.length >= this.maxRequests) {
      // Rate limited — calculate when the oldest entry expires
      const oldestInWindow = timestamps[0];
      const retryAfterMs = (oldestInWindow + this.windowMs) - now;

      logger.warn(
        `[RateLimiter] Rate limited: ${nametag} ` +
        `(${timestamps.length}/${this.maxRequests} in window, ` +
        `retry after ${Math.ceil(retryAfterMs / 1000)}s)`
      );

      return {
        allowed: false,
        retryAfterMs: Math.max(0, retryAfterMs),
      };
    }

    // Allowed — record the request
    timestamps.push(now);

    return {
      allowed: true,
      retryAfterMs: 0,
    };
  }
}

module.exports = RateLimiter;
