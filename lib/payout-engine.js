'use strict';

/**
 * PayoutEngine — Winner determination and prize distribution via invoicing
 *
 * Determines the match winner from scores, resolves the payout recipient
 * based on the payout decision matrix, and executes payment via the
 * Sphere SDK invoicing system (createInvoice -> payInvoice -> closeInvoice).
 *
 * Security mitigations implemented:
 *   S6  — Only confirmed payers and bots are eligible for winning
 *   S10 — Calls sphere.payments.receive() before payout attempt
 *
 * @module payout-engine
 */

const logger = require('winston');

class PayoutEngine {
  /**
   * Create a new PayoutEngine
   * @param {Object} sphere - Initialized Sphere SDK instance
   * @param {string} defaultPayoutNametag - Fallback nametag for bot wins on default sessions
   */
  constructor(sphere, defaultPayoutNametag) {
    this.sphere = sphere;
    this.defaultPayoutNametag = defaultPayoutNametag;
    this.retryQueue = null;
  }

  /**
   * Attach a PayoutRetryQueue for failed payout retries
   * @param {PayoutRetryQueue} queue - Retry queue instance
   */
  setRetryQueue(queue) {
    this.retryQueue = queue;
  }

  /**
   * Determine the match winner from scores (S6: spectator lockdown).
   *
   * Only players with paymentStatus === 'confirmed' or bots are eligible.
   * Spectators and unpaid players are excluded from winner consideration.
   *
   * @param {SessionEscrow} escrow - Session escrow with player records
   * @param {Array<{ name: string, score: number, isBot: boolean }>} scores - Match scores
   * @returns {{ winnerNametag: string, isWinnerBot: boolean, score: number } | null}
   */
  determineWinner(escrow, scores) {
    if (!scores || scores.length === 0) {
      logger.warn(
        '[PayoutEngine] No scores provided for session %s',
        escrow.sessionId
      );
      return null;
    }

    // Build set of eligible nametags: confirmed payers only (S6)
    const confirmedPlayers = new Set();
    for (const [nametag, player] of escrow.players) {
      if (player.paymentStatus === 'confirmed') {
        confirmedPlayers.add(nametag);
      }
    }

    // Filter scores to eligible participants: confirmed payers + bots
    const eligible = scores.filter(
      (s) => confirmedPlayers.has(s.name) || s.isBot
    );

    if (eligible.length === 0) {
      logger.warn(
        '[PayoutEngine] No eligible players for session %s',
        escrow.sessionId
      );
      return null;
    }

    // Sort by score descending, pick the top entry
    eligible.sort((a, b) => b.score - a.score);
    const top = eligible[0];

    return {
      winnerNametag: top.name,
      isWinnerBot: top.isBot,
      score: top.score,
    };
  }

  /**
   * Execute payout for a completed match (S10: receive before pay).
   *
   * Flow:
   *   1. Check if prize pool is non-zero
   *   2. Determine payout recipient via escrow decision matrix
   *   3. Call sphere.payments.receive() to pull pending transfers
   *   4. Resolve recipient nametag to a direct address
   *   5. Create payout invoice targeting the recipient
   *   6. Pay the invoice from the server wallet
   *   7. Close the invoice
   *   8. Send receipts (best-effort)
   *   9. On failure: enqueue in retry queue if available
   *
   * @param {SessionEscrow} escrow - Session escrow
   * @param {{ winnerNametag: string, isWinnerBot: boolean, score: number }} matchResult - Winner info
   * @returns {Promise<{ status: string, recipient?: string, amount?: string, coinId?: string, invoiceId?: string, reason?: string }>}
   */
  async processPayout(escrow, matchResult) {
    const prizePool = escrow.prizePool;

    // 1. No prize pool — nothing to pay out
    if (prizePool === '0') {
      logger.info(
        '[PayoutEngine] No prize pool for session %s — skipping payout',
        escrow.sessionId
      );
      return { status: 'no_prize', reason: 'No paying players' };
    }

    // 2. Determine recipient via the payout decision matrix
    const { winnerNametag, isWinnerBot } = matchResult;
    const recipient = escrow.getPayoutRecipient(
      winnerNametag,
      isWinnerBot,
      this.defaultPayoutNametag
    );

    logger.info(
      '[PayoutEngine] Session %s — paying %s %s to %s (winner: %s, isBot: %s)',
      escrow.sessionId,
      prizePool,
      escrow.entryCoin,
      recipient,
      winnerNametag,
      isWinnerBot
    );

    try {
      // 3. Pull pending transfers before payout attempt (S10)
      await this.sphere.payments.receive();

      // 4. Resolve recipient nametag to direct address
      const recipientTag = recipient.startsWith('@') ? recipient : `@${recipient}`;
      let recipientAddress = null;
      try {
        const peer = await this.sphere.resolve(recipientTag);
        if (!peer || !peer.directAddress) {
          const reason = `Cannot resolve nametag: ${recipient}`;
          logger.error('[PayoutEngine] %s', reason);
          return this._handleFailure(escrow, recipient, null, prizePool, reason);
        }
        recipientAddress = peer.directAddress;
      } catch (resolveErr) {
        const reason = `Nametag resolution error: ${resolveErr.message}`;
        logger.error('[PayoutEngine] %s', reason);
        return this._handleFailure(escrow, recipient, null, prizePool, reason);
      }

      // 5. Create payout invoice
      const invoice = await this.sphere.accounting.createInvoice({
        targets: [{
          address: recipientAddress,
          assets: [{ coin: [escrow.entryCoin, prizePool] }],
        }],
        memo: `UniQuake winnings - Session ${escrow.sessionId} - Winner: ${recipient}`,
      });

      logger.info(
        '[PayoutEngine] Invoice created: %s for session %s',
        invoice.invoiceId,
        escrow.sessionId
      );

      // 6. Pay the invoice from server wallet
      await this.sphere.accounting.payInvoice(invoice.invoiceId, {
        targetIndex: 0,
        assetIndex: 0,
      });

      // 7. Close the invoice
      await this.sphere.accounting.closeInvoice(invoice.invoiceId);

      // 8. Send receipts (best-effort, do not fail on error)
      try {
        await this.sphere.accounting.sendInvoiceReceipts(invoice.invoiceId);
      } catch (receiptErr) {
        logger.warn(
          '[PayoutEngine] Receipt delivery failed for invoice %s: %s',
          invoice.invoiceId,
          receiptErr.message
        );
      }

      logger.info(
        '[PayoutEngine] Payout confirmed — session %s, recipient %s, amount %s %s',
        escrow.sessionId,
        recipient,
        prizePool,
        escrow.entryCoin
      );

      return {
        status: 'confirmed',
        recipient,
        amount: prizePool,
        coinId: escrow.entryCoin,
        invoiceId: invoice.invoiceId,
      };
    } catch (err) {
      const reason = `Payout error: ${err.message}`;
      logger.error(
        '[PayoutEngine] Failed for session %s: %s',
        escrow.sessionId,
        reason
      );
      return this._handleFailure(escrow, recipient, recipientAddress, prizePool, reason);
    }
  }

  /**
   * Handle a payout failure — enqueue for retry if a retry queue is available.
   * @param {SessionEscrow} escrow - Session escrow
   * @param {string} recipient - Recipient nametag
   * @param {string|null} recipientAddress - Resolved address (may be null if resolution failed)
   * @param {string} amount - Payout amount
   * @param {string} reason - Failure reason
   * @returns {{ status: string, reason: string }}
   * @private
   */
  _handleFailure(escrow, recipient, recipientAddress, amount, reason) {
    if (this.retryQueue) {
      logger.info(
        '[PayoutEngine] Enqueueing failed payout for retry — session %s',
        escrow.sessionId
      );
      this.retryQueue.add({
        sessionId: escrow.sessionId,
        recipientNametag: recipient,
        recipientAddress: recipientAddress,
        amount: amount,
        coinId: escrow.entryCoin,
        memo: `UniQuake winnings - Session ${escrow.sessionId} - Winner: ${recipient}`,
        escrow: escrow,
      });
    }

    return { status: 'failed', reason };
  }
}

module.exports = PayoutEngine;
