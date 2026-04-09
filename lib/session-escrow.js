'use strict';

/**
 * SessionEscrow — Per-session payment state tracking
 *
 * Manages player registration, payment status, admission tokens,
 * and prize pool calculation for a single game session.
 *
 * Security mitigations implemented:
 *   S4 — State machine with validated transitions (payout idempotency)
 *   S5 — Player deduplication (prevents double-invoice)
 *   S1 — Admission token storage with 5-min TTL (single-use)
 */

const logger = require('winston');

/**
 * Valid state transitions for the session lifecycle.
 * Each key maps to an array of states it may transition to.
 */
const VALID_TRANSITIONS = {
  open: ['lobby', 'playing', 'cancelled'],
  lobby: ['playing', 'cancelled'],
  playing: ['paying_out', 'cancelled'],
  paying_out: ['paid_out', 'failed'],
  failed: ['cancelled'],
};

/** Admission token time-to-live in milliseconds (5 minutes) */
const TOKEN_TTL_MS = 5 * 60 * 1000;

class SessionEscrow {
  /**
   * Create a new session escrow
   * @param {string} sessionId - Unique session identifier
   * @param {Object} config - Session configuration
   * @param {string} config.creatorNametag - Nametag of the session creator
   * @param {boolean} config.isDefaultSession - Whether this is a default session
   * @param {string} config.entryFee - Entry fee in smallest units (string for BigInt safety)
   * @param {string} config.entryCoin - Coin identifier (e.g. 'UCT')
   */
  constructor(sessionId, config) {
    this.sessionId = sessionId;
    this.creatorNametag = config.creatorNametag;
    this.isDefaultSession = config.isDefaultSession || false;
    this.entryFee = config.entryFee;
    this.entryCoin = config.entryCoin || 'UCT';
    this.state = 'open';
    this.createdAt = Date.now();

    /** @type {Map<string, PlayerRecord>} nametag -> player record */
    this.players = new Map();

    /** @type {Map<string, AdmissionTokenRecord>} token -> token record */
    this.admissionTokens = new Map();
  }

  /**
   * Transition the session state with validation (S4).
   * Throws if the transition is not allowed.
   * @param {string} from - Expected current state
   * @param {string} to - Target state
   * @throws {Error} If current state does not match `from` or transition is illegal
   */
  transitionState(from, to) {
    if (this.state !== from) {
      throw new Error(
        `SessionEscrow state mismatch: expected '${from}', ` +
        `actual '${this.state}' (sessionId=${this.sessionId})`
      );
    }
    const allowed = VALID_TRANSITIONS[from];
    if (!allowed || !allowed.includes(to)) {
      throw new Error(
        `Illegal state transition '${from}' -> '${to}' ` +
        `(sessionId=${this.sessionId})`
      );
    }
    logger.info(
      `[SessionEscrow] ${this.sessionId}: ${from} -> ${to}`
    );
    this.state = to;
  }

  /**
   * Add a player to the session with deduplication (S5).
   * Bots and spectators are marked as payment-exempt.
   * @param {string} nametag - Player nametag
   * @param {boolean} isBot - Whether the player is a bot
   * @param {boolean} isSpectator - Whether the player is a spectator
   * @returns {{ status: 'new' | 'invoice_pending' | 'already_confirmed' }}
   */
  addPlayer(nametag, isBot, isSpectator) {
    const existing = this.players.get(nametag);
    if (existing) {
      if (existing.paymentStatus === 'confirmed') {
        return { status: 'already_confirmed' };
      }
      if (existing.invoiceId) {
        return { status: 'invoice_pending' };
      }
      // Player exists but no invoice yet — treat as new attempt
    }

    this.players.set(nametag, {
      nametag,
      isBot,
      isSpectator,
      invoiceId: null,
      paymentStatus: (isBot || isSpectator) ? 'exempt' : 'pending',
      admissionToken: null,
    });

    return { status: 'new' };
  }

  /**
   * Associate an invoice ID with a player
   * @param {string} nametag - Player nametag
   * @param {string} invoiceId - Invoice identifier
   */
  setPlayerInvoice(nametag, invoiceId) {
    const player = this.players.get(nametag);
    if (player) {
      player.invoiceId = invoiceId;
    }
  }

  /**
   * Confirm a player's payment
   * @param {string} nametag - Player nametag
   * @returns {boolean} true if payment was confirmed, false if not pending
   */
  confirmPayment(nametag) {
    const player = this.players.get(nametag);
    if (player && player.paymentStatus === 'pending') {
      player.paymentStatus = 'confirmed';
      return true;
    }
    return false;
  }

  /**
   * Calculate the total prize pool from confirmed players' entry fees.
   * Returns a string representation of the BigInt sum.
   * @returns {string} Prize pool in smallest units
   */
  get prizePool() {
    let pool = BigInt(0);
    for (const player of this.players.values()) {
      if (player.paymentStatus === 'confirmed') {
        pool += BigInt(this.entryFee);
      }
    }
    return pool.toString();
  }

  /**
   * Count the number of players who have confirmed payment
   * @returns {number}
   */
  get paidPlayerCount() {
    let count = 0;
    for (const player of this.players.values()) {
      if (player.paymentStatus === 'confirmed') {
        count++;
      }
    }
    return count;
  }

  /**
   * Determine who should receive the payout based on the payout decision matrix.
   *
   * | Winner  | Session Type    | Recipient              |
   * |---------|----------------|------------------------|
   * | Human   | Any            | Winner's nametag       |
   * | Bot     | Custom session | Session creator        |
   * | Bot     | Default session| defaultPayoutNametag   |
   *
   * @param {string} winnerNametag - Nametag of the match winner
   * @param {boolean} isWinnerBot - Whether the winner is a bot
   * @param {string} defaultPayoutNametag - Fallback payout nametag
   * @returns {string} Nametag that should receive the payout
   */
  getPayoutRecipient(winnerNametag, isWinnerBot, defaultPayoutNametag) {
    if (!isWinnerBot) {
      return winnerNametag;
    }
    if (this.isDefaultSession) {
      return defaultPayoutNametag;
    }
    return this.creatorNametag;
  }

  /**
   * Store an admission token for a player (S1).
   * Tokens have a 5-minute TTL and are single-use.
   * @param {string} nametag - Player nametag
   * @param {string} token - Admission token (hex string)
   * @param {string} role - Player role ('player' or 'spectator')
   */
  setAdmissionToken(nametag, token, role) {
    const player = this.players.get(nametag);
    if (player) {
      player.admissionToken = token;
    }

    this.admissionTokens.set(token, {
      nametag,
      role,
      sessionId: this.sessionId,
      createdAt: Date.now(),
      used: false,
    });
  }

  /**
   * Validate and consume an admission token.
   * Returns the associated identity on success, null on failure.
   * Token is marked as used (single-use) on successful validation.
   * @param {string} token - Admission token to validate
   * @returns {{ nametag: string, role: string, sessionId: string } | null}
   */
  validateAdmissionToken(token) {
    const record = this.admissionTokens.get(token);
    if (!record) {
      return null;
    }

    if (record.used) {
      return null;
    }

    const age = Date.now() - record.createdAt;
    if (age > TOKEN_TTL_MS) {
      return null;
    }

    record.used = true;

    return {
      nametag: record.nametag,
      role: record.role,
      sessionId: record.sessionId,
    };
  }
}

module.exports = SessionEscrow;
