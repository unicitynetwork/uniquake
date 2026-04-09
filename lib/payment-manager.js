'use strict';

/**
 * PaymentManager — Central server-side orchestrator for Sphere SDK payments
 *
 * Manages the server Sphere SDK instance with AccountingModule (invoices)
 * and CommunicationsModule (DMs) for all payment and signaling flows.
 *
 * Responsibilities:
 *   - Initialize Sphere SDK with mnemonic-based wallet
 *   - Listen for incoming DMs (join requests, payment notifications)
 *   - Create and track per-session escrows
 *   - Issue entry fee invoices and verify payments
 *   - Generate admission tokens for confirmed players
 *   - Distribute winnings via PayoutEngine on match end
 *   - Cancel sessions with automatic fee refunds
 *   - Periodic receive() to pull pending transfers
 *
 * Security mitigations implemented:
 *   S1  — Admission token gate (via AdmissionGate)
 *   S2  — Identity binding (nametag from DM, not self-asserted)
 *   S3  — Mnemonic protection (via secret-loader, env cleared)
 *   S4  — Payout idempotency (synchronous state guard)
 *   S5  — Join deduplication (via SessionEscrow.addPlayer)
 *   S6  — Spectator lockdown (via PayoutEngine.determineWinner)
 *   S7  — Invoice IDs sent via DM only, never via WebSocket
 *   S8  — Server nametag validated at startup (fail-fast)
 *   S10 — Periodic receive() + receive before payout
 *   S11 — Per-nametag rate limiting on join requests
 *
 * @module payment-manager
 */

const logger = require('winston');
const SessionEscrow = require('./session-escrow');
const PayoutEngine = require('./payout-engine');
const PayoutRetryQueue = require('./payout-retry-queue');
const AdmissionGate = require('./admission-gate');
const RateLimiter = require('./rate-limiter');
const { loadMnemonic, sanitizeConfig } = require('./secret-loader');

/** Periodic receive interval in milliseconds (30 seconds) */
const RECEIVE_INTERVAL_MS = 30000;

/** Payment timeout in milliseconds (60 seconds) */
const PAYMENT_TIMEOUT_MS = 60000;

/** Payment timeout polling interval in milliseconds (10 seconds) */
const PAYMENT_POLL_INTERVAL_MS = 10000;

class PaymentManager {
  /**
   * Create a new PaymentManager
   * @param {Object} config - Configuration options
   * @param {string} [config.network='testnet'] - Sphere network identifier
   * @param {string} [config.defaultPayoutNametag='babaika10'] - Default payout recipient
   * @param {string} [config.entryFee='10'] - Entry fee in human-readable units
   * @param {string} [config.entryCoin='UCT'] - Coin type for entry fees
   * @param {string} [config.walletUrl] - Sphere wallet URL for popup mode
   * @param {string[]} [config.nostrRelays] - Nostr relay URLs for DM transport
   */
  constructor(config) {
    this.config = {
      network: config.network || 'testnet',
      defaultPayoutNametag: config.defaultPayoutNametag || 'babaika10',
      entryFee: config.entryFee || '10',
      entryCoin: config.entryCoin || 'UCT',
      walletUrl: config.walletUrl || 'https://sphere.unicity.network',
      nostrRelays: config.nostrRelays || [
        'wss://nostr-relay.testnet.unicity.network'
      ],
    };

    /** @type {Object|null} Initialized Sphere SDK instance */
    this.sphere = null;

    /** @type {Map<string, SessionEscrow>} sessionId -> SessionEscrow */
    this.sessions = new Map();

    /** @type {AdmissionGate} Token generation and validation */
    this.admissionGate = new AdmissionGate();

    /** @type {RateLimiter} Per-nametag join rate limiting (S11) */
    this.rateLimiter = new RateLimiter(3, 5 * 60 * 1000);

    /** @type {PayoutEngine|null} Winner determination and prize distribution */
    this.payoutEngine = null;

    /** @type {PayoutRetryQueue|null} Exponential backoff retry for failed payouts */
    this.retryQueue = null;

    /** @type {NodeJS.Timer|null} Periodic receive() timer */
    this.receiveInterval = null;

    /** @type {Function|null} Unsubscribe function for DM listener */
    this.unsubscribeDM = null;

    /** @type {string|null} Entry fee converted to smallest units */
    this.entryFeeSmallestUnits = null;
  }

  /**
   * Initialize the PaymentManager.
   *
   * Steps:
   *   1. Load mnemonic from file or env (S3)
   *   2. Dynamic import sphere-sdk (ESM-only)
   *   3. Convert entry fee to smallest units
   *   4. Initialize Sphere SDK with accounting + communications
   *   5. Receive pending transfers from previous runs
   *   6. Set up DM listener via onDirectMessage (P4)
   *   7. Validate default payout nametag (S8/S10 fail-fast)
   *   8. Set up PayoutEngine and PayoutRetryQueue
   *   9. Start periodic receive() every 30s (S10)
   *  10. Log identity (never log mnemonic)
   *
   * @throws {Error} If mnemonic is missing, SDK init fails, or nametag validation fails
   */
  async init() {
    // 1. Load mnemonic securely (S3)
    const mnemonic = loadMnemonic();

    // 2. Dynamic import sphere-sdk — ESM-only package
    const { Sphere, toSmallestUnit } = await import('@unicitylabs/sphere-sdk');
    const { createNodeProviders } = await import(
      '@unicitylabs/sphere-sdk/impl/nodejs'
    );

    // 3. Convert human-readable entry fee to smallest units (8 decimal places)
    this.entryFeeSmallestUnits = toSmallestUnit(
      this.config.entryFee, 8
    ).toString();

    // 4. Initialize Sphere SDK with accounting enabled
    const providers = createNodeProviders({
      network: this.config.network,
      transport: { relays: this.config.nostrRelays },
    });

    const { sphere } = await Sphere.init({
      ...providers,
      mnemonic,
      accounting: true,
    });
    this.sphere = sphere;

    // 5. Receive any pending transfers from previous runs
    await sphere.payments.receive();

    // 6. Set up DM listener (P4: onDirectMessage, NOT onDM)
    this.unsubscribeDM = sphere.communications.onDirectMessage((dm) => {
      this._handleIncomingDM(dm).catch((err) => {
        logger.error('[PaymentManager] DM handler error: %s', err.message);
      });
    });

    // 7. Validate default payout nametag — fail-fast (S8/S10)
    try {
      const tag = '@' + this.config.defaultPayoutNametag;
      const peer = await sphere.resolve(tag);
      if (!peer) {
        throw new Error('Resolution returned null');
      }
      logger.info(
        '[PaymentManager] Default payout nametag verified: @%s',
        this.config.defaultPayoutNametag
      );
    } catch (err) {
      logger.error(
        '[PaymentManager] FATAL: Cannot resolve default payout nametag @%s: %s',
        this.config.defaultPayoutNametag,
        err.message
      );
      throw err;
    }

    // 8. Set up PayoutEngine + PayoutRetryQueue
    this.payoutEngine = new PayoutEngine(
      sphere,
      this.config.defaultPayoutNametag
    );
    this.retryQueue = new PayoutRetryQueue(sphere);
    this.payoutEngine.setRetryQueue(this.retryQueue);
    this.retryQueue.start();

    // 9. Start periodic receive() every 30s (S10)
    this.receiveInterval = setInterval(async () => {
      try {
        await sphere.payments.receive();
      } catch (e) {
        logger.warn(
          '[PaymentManager] Periodic receive failed: %s', e.message
        );
      }
    }, RECEIVE_INTERVAL_MS);
    this.receiveInterval.unref();

    // 10. Log identity — never log the mnemonic (S3)
    const identity = sphere.getIdentity();
    logger.info('[PaymentManager] Initialized on %s', this.config.network);
    logger.info(
      '[PaymentManager] Identity: %s',
      identity.nametag || identity.directAddress
    );
    logger.info(
      '[PaymentManager] Entry fee: %s %s (%s smallest units)',
      this.config.entryFee,
      this.config.entryCoin,
      this.entryFeeSmallestUnits
    );
    logger.info(
      '[PaymentManager] Config: %s',
      JSON.stringify(sanitizeConfig(this.config))
    );
  }

  // ────────────────────────────────────────────────────────────────
  // DM handling
  // ────────────────────────────────────────────────────────────────

  /**
   * Route incoming DM messages to appropriate handlers.
   * Ignores non-JSON messages and messages without a 'uniquake:' type prefix.
   *
   * @param {Object} dm - Incoming direct message
   * @param {string} dm.content - JSON-encoded message body
   * @param {string} [dm.senderNametag] - Sender's nametag
   * @param {string} [dm.sender] - Sender's direct address (fallback)
   * @private
   */
  async _handleIncomingDM(dm) {
    let msg;
    try {
      msg = JSON.parse(dm.content);
    } catch (e) {
      return; // Non-JSON DM — ignore
    }

    if (!msg.type || !msg.type.startsWith('uniquake:')) {
      return;
    }

    const sender = dm.senderNametag || dm.sender;
    if (!sender) {
      logger.warn('[PaymentManager] DM received with no sender identity');
      return;
    }

    switch (msg.type) {
      case 'uniquake:join_request':
        await this._handleJoinRequest(sender, msg);
        break;
      case 'uniquake:payment_notification':
        await this._handlePaymentNotification(sender, msg);
        break;
      case 'uniquake:dm_ack':
        // Acknowledgment from client — no action needed
        break;
      default:
        logger.debug(
          '[PaymentManager] Unhandled DM type: %s from %s',
          msg.type, sender
        );
        break;
    }
  }

  // ────────────────────────────────────────────────────────────────
  // Session management
  // ────────────────────────────────────────────────────────────────

  /**
   * Create a new session escrow.
   *
   * @param {Object} sessionConfig - Session configuration
   * @param {string} sessionConfig.sessionId - Unique session identifier
   * @param {string} [sessionConfig.creatorNametag] - Session creator's nametag
   * @param {boolean} [sessionConfig.isDefaultSession=false] - Whether this is a default session
   * @returns {SessionEscrow} The created escrow instance
   */
  createSession(sessionConfig) {
    const escrow = new SessionEscrow(sessionConfig.sessionId, {
      creatorNametag: sessionConfig.creatorNametag || null,
      isDefaultSession: sessionConfig.isDefaultSession || false,
      entryFee: this.entryFeeSmallestUnits,
      entryCoin: this.config.entryCoin,
    });

    this.sessions.set(sessionConfig.sessionId, escrow);

    logger.info(
      '[PaymentManager] Session created: %s (default=%s, creator=%s)',
      sessionConfig.sessionId,
      escrow.isDefaultSession,
      escrow.creatorNametag
    );

    return escrow;
  }

  /**
   * Retrieve a session escrow by ID.
   * @param {string} sessionId - Session identifier
   * @returns {SessionEscrow|null} The escrow or null if not found
   */
  getSession(sessionId) {
    return this.sessions.get(sessionId) || null;
  }

  // ────────────────────────────────────────────────────────────────
  // Join request handling (S5 dedup, S11 rate limit)
  // ────────────────────────────────────────────────────────────────

  /**
   * Handle a join request from a player.
   *
   * Flow:
   *   1. Validate session exists
   *   2. Rate limit check (S11)
   *   3. Spectators get free admission token
   *   4. Active players: deduplication check (S5)
   *   5. Create entry fee invoice (S7: invoice ID via DM only)
   *   6. Start payment timeout polling (T32: 60s)
   *
   * @param {string} senderNametag - Sender's verified nametag from DM
   * @param {Object} msg - Join request message
   * @param {string} msg.sessionId - Session to join
   * @param {string} [msg.role='player'] - Requested role
   * @private
   */
  async _handleJoinRequest(senderNametag, msg) {
    const { sessionId, role } = msg;
    const escrow = this.sessions.get(sessionId);

    if (!escrow) {
      logger.warn(
        '[PaymentManager] Join request for unknown session: %s from %s',
        sessionId, senderNametag
      );
      return;
    }

    // S11: Per-nametag rate limiting
    const rateCheck = this.rateLimiter.check(senderNametag);
    if (!rateCheck.allowed) {
      await this._sendDM(senderNametag, {
        type: 'uniquake:error',
        code: 'RATE_LIMITED',
        retryAfterMs: rateCheck.retryAfterMs,
      });
      return;
    }

    // ── Spectator: free admission ──
    if (role === 'spectator') {
      escrow.addPlayer(senderNametag, false, true);
      const token = this.admissionGate.generateAdmissionToken(
        sessionId, senderNametag, 'spectator'
      );
      escrow.setAdmissionToken(senderNametag, token, 'spectator');

      await this._sendDM(senderNametag, {
        type: 'uniquake:join_confirmed',
        sessionId,
        role: 'spectator',
        admissionToken: token,
      });
      return;
    }

    // ── Active player: deduplication check (S5) ──
    const addResult = escrow.addPlayer(senderNametag, false, false);

    if (addResult.status === 'already_confirmed') {
      // Already paid — re-send admission token
      const token = this.admissionGate.generateAdmissionToken(
        sessionId, senderNametag, 'player'
      );
      escrow.setAdmissionToken(senderNametag, token, 'player');

      await this._sendDM(senderNametag, {
        type: 'uniquake:join_confirmed',
        sessionId,
        role: 'player',
        admissionToken: token,
      });
      return;
    }

    if (addResult.status === 'invoice_pending') {
      // Invoice already issued — re-send the same invoiceId (S5 dedup)
      const player = escrow.players.get(senderNametag);
      if (player && player.invoiceId) {
        await this._sendDM(senderNametag, {
          type: 'uniquake:entry_invoice',
          sessionId,
          invoiceId: player.invoiceId,
          amount: this.entryFeeSmallestUnits,
          coinId: this.config.entryCoin,
        });
      }
      return;
    }

    // ── New player: create entry fee invoice (S7: via DM only) ──
    try {
      const identity = this.sphere.getIdentity();
      const invoice = await this.sphere.accounting.createInvoice({
        targets: [{
          address: identity.directAddress,
          assets: [{ coin: [this.config.entryCoin, this.config.entryFee] }],
        }],
        memo: 'UniQuake entry fee - Session ' + sessionId,
      });

      escrow.setPlayerInvoice(senderNametag, invoice.invoiceId);

      // Send invoice ID via encrypted DM (S7: never via WebSocket)
      await this._sendDM(senderNametag, {
        type: 'uniquake:entry_invoice',
        sessionId,
        invoiceId: invoice.invoiceId,
        amount: this.entryFeeSmallestUnits,
        coinId: this.config.entryCoin,
      });

      // T32: Start payment timeout polling (60s)
      this._startPaymentTimeout(sessionId, senderNametag, invoice.invoiceId);

      logger.info(
        '[PaymentManager] Invoice created for %s in session %s: %s',
        senderNametag, sessionId, invoice.invoiceId
      );
    } catch (err) {
      logger.error(
        '[PaymentManager] Failed to create invoice for %s: %s',
        senderNametag, err.message
      );
      await this._sendDM(senderNametag, {
        type: 'uniquake:error',
        code: 'INVOICE_FAILED',
        message: 'Failed to create entry fee invoice. Please try again.',
      });
    }
  }

  // ────────────────────────────────────────────────────────────────
  // Payment confirmation
  // ────────────────────────────────────────────────────────────────

  /**
   * Handle a payment notification from a player.
   *
   * Verifies the invoice ID matches what was issued, pulls latest
   * transfers, checks invoice status, and if covered, generates an
   * admission token and sends join_confirmed.
   *
   * @param {string} senderNametag - Sender's verified nametag from DM
   * @param {Object} msg - Payment notification message
   * @param {string} msg.sessionId - Session identifier
   * @param {string} msg.invoiceId - Invoice that was paid
   * @private
   */
  async _handlePaymentNotification(senderNametag, msg) {
    const { sessionId, invoiceId } = msg;
    const escrow = this.sessions.get(sessionId);

    if (!escrow) {
      logger.warn(
        '[PaymentManager] Payment notification for unknown session: %s',
        sessionId
      );
      return;
    }

    // Verify invoiceId matches what we issued to this player (S5)
    const player = escrow.players.get(senderNametag);
    if (!player || player.invoiceId !== invoiceId) {
      logger.warn(
        '[PaymentManager] Invoice mismatch for %s (expected %s, got %s)',
        senderNametag,
        player ? player.invoiceId : '<no player>',
        invoiceId
      );
      return;
    }

    // Already confirmed — no double-processing
    if (player.paymentStatus === 'confirmed') {
      logger.info(
        '[PaymentManager] Payment already confirmed for %s in session %s',
        senderNametag, sessionId
      );
      return;
    }

    // Pull latest transfers before checking invoice status (S10)
    try {
      await this.sphere.payments.receive();
    } catch (e) {
      logger.warn(
        '[PaymentManager] Receive failed before payment check: %s', e.message
      );
    }

    // Check invoice status
    try {
      const status = await this.sphere.accounting.getInvoiceStatus(invoiceId);

      if (status.state === 'COVERED' || status.state === 'CLOSED') {
        escrow.confirmPayment(senderNametag);

        // Generate admission token (S1: single-use, 5-min TTL)
        const token = this.admissionGate.generateAdmissionToken(
          sessionId, senderNametag, 'player'
        );
        escrow.setAdmissionToken(senderNametag, token, 'player');

        // Send join_confirmed with admission token via DM (S1, S7)
        await this._sendDM(senderNametag, {
          type: 'uniquake:join_confirmed',
          sessionId,
          role: 'player',
          admissionToken: token,
        });

        logger.info(
          '[PaymentManager] Payment confirmed for %s in session %s',
          senderNametag, sessionId
        );
      } else {
        logger.info(
          '[PaymentManager] Invoice %s not yet covered (state=%s)',
          invoiceId, status.state
        );
      }
    } catch (err) {
      logger.error(
        '[PaymentManager] Failed to check invoice %s status: %s',
        invoiceId, err.message
      );
    }
  }

  // ────────────────────────────────────────────────────────────────
  // T32: Payment timeout (60s polling)
  // ────────────────────────────────────────────────────────────────

  /**
   * Start a payment timeout timer that polls invoice status every 10s.
   * If payment is not received within 60s, the player's invoice is
   * cancelled with auto-return and the player is notified.
   *
   * @param {string} sessionId - Session identifier
   * @param {string} nametag - Player nametag
   * @param {string} invoiceId - Invoice to monitor
   * @private
   */
  _startPaymentTimeout(sessionId, nametag, invoiceId) {
    let elapsed = 0;

    const timer = setInterval(async () => {
      elapsed += PAYMENT_POLL_INTERVAL_MS;

      const escrow = this.sessions.get(sessionId);
      if (!escrow) {
        clearInterval(timer);
        return;
      }

      const player = escrow.players.get(nametag);
      if (!player || player.paymentStatus === 'confirmed') {
        clearInterval(timer);
        return;
      }

      // Poll invoice status
      try {
        await this.sphere.payments.receive();
        const status = await this.sphere.accounting.getInvoiceStatus(
          invoiceId
        );
        if (status.state === 'COVERED' || status.state === 'CLOSED') {
          clearInterval(timer);
          // Confirmed via polling — trigger confirmation flow
          escrow.confirmPayment(nametag);

          const token = this.admissionGate.generateAdmissionToken(
            sessionId, nametag, 'player'
          );
          escrow.setAdmissionToken(nametag, token, 'player');

          await this._sendDM(nametag, {
            type: 'uniquake:join_confirmed',
            sessionId,
            role: 'player',
            admissionToken: token,
          });

          logger.info(
            '[PaymentManager] Payment confirmed via polling for %s in ' +
            'session %s', nametag, sessionId
          );
          return;
        }
      } catch (e) {
        // Ignore individual polling errors
      }

      // T32: Timeout reached — cancel invoice and notify player
      if (elapsed >= PAYMENT_TIMEOUT_MS) {
        clearInterval(timer);
        logger.warn(
          '[PaymentManager] Payment timeout for %s in session %s ' +
          '(invoiceId=%s)', nametag, sessionId, invoiceId
        );

        // Cancel invoice with auto-return
        try {
          await this.sphere.accounting.cancelInvoice(invoiceId, {
            autoReturn: true,
          });
        } catch (cancelErr) {
          logger.error(
            '[PaymentManager] Failed to cancel timed-out invoice %s: %s',
            invoiceId, cancelErr.message
          );
        }

        // Notify player
        await this._sendDM(nametag, {
          type: 'uniquake:error',
          code: 'PAYMENT_TIMEOUT',
          message: 'Payment not received within 60 seconds. ' +
            'Entry fee returned if already sent.',
          sessionId,
        });
      }
    }, PAYMENT_POLL_INTERVAL_MS);

    timer.unref();
  }

  // ────────────────────────────────────────────────────────────────
  // Winnings distribution (S4 idempotency)
  // ────────────────────────────────────────────────────────────────

  /**
   * Distribute winnings for a completed match.
   *
   * S4 idempotency: the state is transitioned to 'paying_out'
   * SYNCHRONOUSLY (before any await) to prevent double-payout
   * from concurrent calls in the single-threaded event loop.
   *
   * @param {string} sessionId - Session identifier
   * @param {Array<{ name: string, score: number, isBot: boolean }>} scores - Match scores
   * @returns {Promise<{ status: string, reason?: string, recipient?: string }>}
   */
  async distributeWinnings(sessionId, scores) {
    const escrow = this.sessions.get(sessionId);
    if (!escrow) {
      return { status: 'error', reason: 'Session not found' };
    }

    // S4: Synchronous state guard — BEFORE any await
    // Only 'open', 'lobby', or 'playing' sessions can transition to payout
    if (
      escrow.state !== 'playing' &&
      escrow.state !== 'open' &&
      escrow.state !== 'lobby'
    ) {
      return {
        status: 'already_processed',
        reason: 'Session state: ' + escrow.state,
      };
    }
    escrow.transitionState(escrow.state, 'paying_out');

    // Determine winner (S6: only confirmed payers + bots eligible)
    const matchResult = this.payoutEngine.determineWinner(escrow, scores);

    // Close entry fee invoices (best-effort)
    for (const [nametag, player] of escrow.players) {
      if (player.invoiceId) {
        try {
          await this.sphere.accounting.closeInvoice(player.invoiceId);
        } catch (e) {
          logger.warn(
            '[PaymentManager] Failed to close invoice for %s: %s',
            nametag, e.message
          );
        }
      }
    }

    // Process payout via PayoutEngine
    const payoutTarget = matchResult || {
      winnerNametag: null,
      isWinnerBot: true,
      score: 0,
    };
    const result = await this.payoutEngine.processPayout(escrow, payoutTarget);

    // Transition to final state based on payout result
    if (result.status === 'confirmed' || result.status === 'no_prize') {
      try {
        escrow.transitionState('paying_out', 'paid_out');
      } catch (e) {
        logger.warn(
          '[PaymentManager] State transition to paid_out failed: %s',
          e.message
        );
      }
    } else if (result.status === 'failed') {
      try {
        escrow.transitionState('paying_out', 'failed');
      } catch (e) {
        logger.warn(
          '[PaymentManager] State transition to failed: %s', e.message
        );
      }
    }

    // Notify all players via DM (best-effort)
    for (const [nametag] of escrow.players) {
      try {
        await this._sendDM(nametag, {
          type: 'uniquake:match_result',
          sessionId,
          winner: matchResult ? matchResult.winnerNametag : 'none',
          isBot: matchResult ? matchResult.isWinnerBot : true,
          prizePool: escrow.prizePool,
          payoutStatus: result.status,
        });
      } catch (e) {
        // Best-effort notification — do not fail the payout
      }
    }

    return result;
  }

  // ────────────────────────────────────────────────────────────────
  // Session cancellation
  // ────────────────────────────────────────────────────────────────

  /**
   * Cancel a session, refunding all entry fees via cancelInvoice
   * with autoReturn.
   *
   * @param {string} sessionId - Session identifier
   * @param {string} [reason] - Cancellation reason for player notification
   */
  async cancelSession(sessionId, reason) {
    const escrow = this.sessions.get(sessionId);
    if (!escrow) {
      return;
    }

    // Already terminal — no action
    if (escrow.state === 'paid_out' || escrow.state === 'cancelled') {
      return;
    }

    // Transition to cancelled (force if state machine rejects)
    try {
      escrow.transitionState(escrow.state, 'cancelled');
    } catch (e) {
      logger.warn(
        '[PaymentManager] Forcing cancelled state for session %s: %s',
        sessionId, e.message
      );
      escrow.state = 'cancelled';
    }

    // Cancel all entry fee invoices with auto-return
    for (const [nametag, player] of escrow.players) {
      if (player.invoiceId) {
        try {
          await this.sphere.accounting.cancelInvoice(player.invoiceId, {
            autoReturn: true,
          });
          logger.info(
            '[PaymentManager] Cancelled invoice for %s: %s (auto-return)',
            nametag, player.invoiceId
          );
        } catch (e) {
          logger.error(
            '[PaymentManager] Failed to cancel invoice for %s: %s',
            nametag, e.message
          );
        }
      }
    }

    // Notify all players via DM (best-effort)
    for (const [nametag] of escrow.players) {
      try {
        await this._sendDM(nametag, {
          type: 'uniquake:match_cancelled',
          sessionId,
          reason: reason || 'Session cancelled',
        });
      } catch (e) {
        // Best-effort notification
      }
    }

    logger.info(
      '[PaymentManager] Session %s cancelled: %s',
      sessionId, reason || 'no reason given'
    );
  }

  // ────────────────────────────────────────────────────────────────
  // Admission token validation (delegated to AdmissionGate)
  // ────────────────────────────────────────────────────────────────

  /**
   * Validate an admission token for a given session.
   * Delegated to the AdmissionGate module (S1, S2).
   *
   * @param {string} sessionId - Expected session ID
   * @param {string} token - Admission token to validate
   * @returns {{ nametag: string, role: string, sessionId: string } | null}
   */
  validateAdmissionToken(sessionId, token) {
    return this.admissionGate.validateAdmissionToken(token, sessionId);
  }

  // ────────────────────────────────────────────────────────────────
  // DM helper (S7: sensitive data via DM only)
  // ────────────────────────────────────────────────────────────────

  /**
   * Send a JSON-encoded DM to a recipient nametag.
   * Ensures the nametag is prefixed with '@' as required by the SDK.
   *
   * @param {string} recipientNametag - Recipient's nametag
   * @param {Object} message - Message object to JSON-encode
   * @throws {Error} If DM delivery fails
   * @private
   */
  async _sendDM(recipientNametag, message) {
    const tag = recipientNametag.startsWith('@')
      ? recipientNametag
      : '@' + recipientNametag;
    try {
      await this.sphere.communications.sendDM(tag, JSON.stringify(message));
    } catch (err) {
      logger.error(
        '[PaymentManager] DM delivery failed to %s: %s', tag, err.message
      );
      throw err;
    }
  }

  // ────────────────────────────────────────────────────────────────
  // Cleanup
  // ────────────────────────────────────────────────────────────────

  /**
   * Destroy the PaymentManager and release all resources.
   * Stops timers, retry queue, admission gate, and the Sphere SDK instance.
   */
  async destroy() {
    if (this.receiveInterval) {
      clearInterval(this.receiveInterval);
      this.receiveInterval = null;
    }

    if (this.retryQueue) {
      this.retryQueue.stop();
    }

    if (this.admissionGate) {
      this.admissionGate.destroy();
    }

    if (this.unsubscribeDM) {
      this.unsubscribeDM();
      this.unsubscribeDM = null;
    }

    if (this.sphere) {
      await this.sphere.destroy();
      this.sphere = null;
    }

    logger.info('[PaymentManager] Destroyed');
  }
}

module.exports = PaymentManager;
