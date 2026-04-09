'use strict';

/**
 * PayoutRetryQueue — In-memory retry queue with exponential backoff
 *
 * Retries failed payouts using the Sphere SDK invoicing system.
 * Each retry attempt calls sphere.payments.receive() first (S10),
 * then re-attempts the full invoice cycle (create -> pay -> close).
 *
 * On final failure (maxRetries exhausted), logs a CRITICAL error,
 * transitions the escrow state from 'failed' to 'cancelled', and
 * cancels entry fee invoices with autoReturn to refund players (T38).
 *
 * Security mitigations implemented:
 *   S10 — Calls sphere.payments.receive() before each retry attempt
 *   T38 — Failed-to-cancelled transition with auto-return refund
 *
 * @module payout-retry-queue
 */

const logger = require('winston');

/** Backoff schedule in milliseconds: 30s, 60s, 2m, 4m, 8m */
const DEFAULT_BACKOFF_MS = [30000, 60000, 120000, 240000, 480000];

/** Maximum number of retry attempts per payout */
const DEFAULT_MAX_RETRIES = 5;

/** Queue processing interval in milliseconds (15 seconds) */
const PROCESS_INTERVAL_MS = 15000;

class PayoutRetryQueue {
  /**
   * Create a new PayoutRetryQueue
   * @param {Object} sphere - Initialized Sphere SDK instance
   */
  constructor(sphere) {
    this.sphere = sphere;

    /** @type {Array<RetryItem>} Pending retry items */
    this.queue = [];

    /** @type {NodeJS.Timer|null} Processing interval timer */
    this.timer = null;

    this.maxRetries = DEFAULT_MAX_RETRIES;
    this.backoffMs = DEFAULT_BACKOFF_MS;
  }

  /**
   * Add a failed payout to the retry queue.
   * Schedules the first retry after the initial backoff delay.
   *
   * @param {Object} payoutInfo - Payout details
   * @param {string} payoutInfo.sessionId - Session identifier
   * @param {string} payoutInfo.recipientNametag - Recipient nametag
   * @param {string|null} payoutInfo.recipientAddress - Resolved recipient address (may be null)
   * @param {string} payoutInfo.amount - Payout amount in smallest units
   * @param {string} payoutInfo.coinId - Coin identifier (e.g. 'UCT')
   * @param {string} payoutInfo.memo - Invoice memo
   * @param {SessionEscrow} payoutInfo.escrow - Associated session escrow
   */
  add(payoutInfo) {
    const item = {
      sessionId: payoutInfo.sessionId,
      recipientNametag: payoutInfo.recipientNametag,
      recipientAddress: payoutInfo.recipientAddress,
      amount: payoutInfo.amount,
      coinId: payoutInfo.coinId,
      memo: payoutInfo.memo,
      escrow: payoutInfo.escrow,
      attempt: 1,
      nextRetryAt: Date.now() + this.backoffMs[0],
    };

    this.queue.push(item);

    logger.info(
      '[PayoutRetryQueue] Enqueued payout for session %s, recipient %s — ' +
      'attempt 1 scheduled at %s',
      item.sessionId,
      item.recipientNametag,
      new Date(item.nextRetryAt).toISOString()
    );
  }

  /**
   * Start the periodic queue processing timer.
   * Processes due items every 15 seconds.
   */
  start() {
    if (this.timer) {
      return;
    }

    this.timer = setInterval(() => {
      this.processQueue().catch((err) => {
        logger.error(
          '[PayoutRetryQueue] Unexpected error in processQueue: %s',
          err.message
        );
      });
    }, PROCESS_INTERVAL_MS);

    // Prevent the timer from keeping the process alive
    if (this.timer.unref) {
      this.timer.unref();
    }

    logger.info('[PayoutRetryQueue] Started — processing every %ds', PROCESS_INTERVAL_MS / 1000);
  }

  /**
   * Stop the periodic queue processing timer.
   */
  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      logger.info('[PayoutRetryQueue] Stopped');
    }
  }

  /**
   * Process all due items in the retry queue.
   *
   * For each item past its nextRetryAt:
   *   1. Call sphere.payments.receive() to pull pending transfers (S10)
   *   2. Resolve recipient address if not already resolved
   *   3. Create a payout invoice
   *   4. Pay the invoice from the server wallet
   *   5. Close the invoice
   *   6. On success: remove from queue, log confirmation
   *   7. On failure: increment attempt, calculate next backoff
   *   8. If attempt > maxRetries: log CRITICAL, transition escrow to
   *      'cancelled', cancel entry invoices with autoReturn (T38)
   */
  async processQueue() {
    const now = Date.now();
    const dueItems = this.queue.filter((item) => item.nextRetryAt <= now);

    if (dueItems.length === 0) {
      return;
    }

    logger.info(
      '[PayoutRetryQueue] Processing %d due item(s)',
      dueItems.length
    );

    for (const item of dueItems) {
      try {
        await this._retryPayout(item);
        // Success — remove from queue
        this._removeItem(item);
        logger.info(
          '[PayoutRetryQueue] Payout succeeded for session %s on attempt %d',
          item.sessionId,
          item.attempt
        );
      } catch (err) {
        logger.error(
          '[PayoutRetryQueue] Retry attempt %d failed for session %s: %s',
          item.attempt,
          item.sessionId,
          err.message
        );

        item.attempt++;

        if (item.attempt > this.maxRetries) {
          // Final failure — exhaust retries
          logger.error(
            '[PayoutRetryQueue] CRITICAL: All %d retries exhausted for ' +
            'session %s, recipient %s, amount %s %s. ' +
            'Manual resolution required.',
            this.maxRetries,
            item.sessionId,
            item.recipientNametag,
            item.amount,
            item.coinId
          );

          // T38: Transition escrow to cancelled and refund players
          await this._handleFinalFailure(item);

          this._removeItem(item);
        } else {
          // Schedule next retry with backoff
          const backoffIndex = Math.min(
            item.attempt - 1,
            this.backoffMs.length - 1
          );
          item.nextRetryAt = Date.now() + this.backoffMs[backoffIndex];

          logger.info(
            '[PayoutRetryQueue] Session %s — next retry (attempt %d) at %s',
            item.sessionId,
            item.attempt,
            new Date(item.nextRetryAt).toISOString()
          );
        }
      }
    }
  }

  /**
   * Attempt a single payout retry via the invoicing cycle.
   * @param {RetryItem} item - Retry queue item
   * @throws {Error} If any step in the payout cycle fails
   * @private
   */
  async _retryPayout(item) {
    // 1. Pull pending transfers before payout attempt (S10)
    await this.sphere.payments.receive();

    // 2. Resolve recipient address if not already available
    if (!item.recipientAddress) {
      const recipientTag = item.recipientNametag.startsWith('@')
        ? item.recipientNametag
        : `@${item.recipientNametag}`;
      const peer = await this.sphere.resolve(recipientTag);
      if (!peer || !peer.directAddress) {
        throw new Error(`Cannot resolve nametag: ${item.recipientNametag}`);
      }
      item.recipientAddress = peer.directAddress;
    }

    // 3. Create payout invoice
    const invoice = await this.sphere.accounting.createInvoice({
      targets: [{
        address: item.recipientAddress,
        assets: [{ coin: [item.coinId, item.amount] }],
      }],
      memo: item.memo,
    });

    // 4. Pay the invoice from server wallet
    await this.sphere.accounting.payInvoice(invoice.invoiceId, {
      targetIndex: 0,
      assetIndex: 0,
    });

    // 5. Close the invoice
    await this.sphere.accounting.closeInvoice(invoice.invoiceId);

    logger.info(
      '[PayoutRetryQueue] Invoice %s paid and closed for session %s',
      invoice.invoiceId,
      item.sessionId
    );
  }

  /**
   * Handle final failure after all retries are exhausted (T38).
   * Transitions the escrow state from 'failed' to 'cancelled' and
   * cancels entry fee invoices with autoReturn to refund players.
   *
   * @param {RetryItem} item - The exhausted retry item
   * @private
   */
  async _handleFinalFailure(item) {
    const escrow = item.escrow;
    if (!escrow) {
      return;
    }

    // Transition escrow to cancelled (T38: failed -> cancelled)
    try {
      escrow.transitionState('failed', 'cancelled');
    } catch (stateErr) {
      logger.warn(
        '[PayoutRetryQueue] Could not transition session %s to cancelled: %s',
        item.sessionId,
        stateErr.message
      );
    }

    // Cancel all entry fee invoices with autoReturn to refund players
    for (const [nametag, player] of escrow.players) {
      if (player.invoiceId) {
        try {
          await this.sphere.accounting.cancelInvoice(
            player.invoiceId,
            { autoReturn: true }
          );
          logger.info(
            '[PayoutRetryQueue] Cancelled invoice %s for player %s ' +
            '(session %s) with auto-return',
            player.invoiceId,
            nametag,
            item.sessionId
          );
        } catch (cancelErr) {
          logger.error(
            '[PayoutRetryQueue] Failed to cancel invoice %s for player %s: %s',
            player.invoiceId,
            nametag,
            cancelErr.message
          );
        }
      }
    }
  }

  /**
   * Remove an item from the queue.
   * @param {RetryItem} item - Item to remove
   * @private
   */
  _removeItem(item) {
    const index = this.queue.indexOf(item);
    if (index !== -1) {
      this.queue.splice(index, 1);
    }
  }

  /**
   * Get the current queue length (useful for monitoring).
   * @returns {number}
   */
  get length() {
    return this.queue.length;
  }
}

module.exports = PayoutRetryQueue;
