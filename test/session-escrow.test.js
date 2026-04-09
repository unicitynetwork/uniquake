'use strict';

jest.mock('winston', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const SessionEscrow = require('../lib/session-escrow');

describe('SessionEscrow', () => {
  let escrow;

  beforeEach(() => {
    escrow = new SessionEscrow('sess-1', {
      creatorNametag: 'alice',
      isDefaultSession: false,
      entryFee: '1000000000',
      entryCoin: 'UCT',
    });
  });

  // ── Constructor ──────────────────────────────────────────────

  describe('Constructor', () => {
    it('SE-01: Constructor with valid config', () => {
      expect(escrow.sessionId).toBe('sess-1');
      expect(escrow.creatorNametag).toBe('alice');
      expect(escrow.isDefaultSession).toBe(false);
      expect(escrow.entryFee).toBe('1000000000');
      expect(escrow.entryCoin).toBe('UCT');
      expect(escrow.state).toBe('open');
      expect(escrow.players).toBeInstanceOf(Map);
      expect(escrow.players.size).toBe(0);
      expect(escrow.admissionTokens).toBeInstanceOf(Map);
      expect(escrow.admissionTokens.size).toBe(0);
      expect(escrow.createdAt).toBeCloseTo(Date.now(), -2);
    });

    it('SE-02: Constructor defaults', () => {
      const e = new SessionEscrow('sess-2', { creatorNametag: 'bob' });
      expect(e.isDefaultSession).toBe(false);
      expect(e.entryCoin).toBe('UCT');
      expect(e.entryFee).toBeUndefined();
      expect(e.state).toBe('open');
    });

    it('SE-03: Constructor with isDefaultSession true', () => {
      const e = new SessionEscrow('sess-3', {
        creatorNametag: null,
        isDefaultSession: true,
        entryFee: '1000000000',
        entryCoin: 'UCT',
      });
      expect(e.isDefaultSession).toBe(true);
      expect(e.creatorNametag).toBeNull();
    });
  });

  // ── addPlayer ────────────────────────────────────────────────

  describe('addPlayer', () => {
    it('SE-04: Add new human player', () => {
      const result = escrow.addPlayer('alice', false, false);
      expect(result).toEqual({ status: 'new' });
      const player = escrow.players.get('alice');
      expect(player.isBot).toBe(false);
      expect(player.isSpectator).toBe(false);
      expect(player.paymentStatus).toBe('pending');
      expect(player.invoiceId).toBeNull();
      expect(player.invoiceCreating).toBe(true);
    });

    it('SE-05: Add new bot player', () => {
      const result = escrow.addPlayer('bot_grunt', true, false);
      expect(result).toEqual({ status: 'new' });
      const player = escrow.players.get('bot_grunt');
      expect(player.isBot).toBe(true);
      expect(player.paymentStatus).toBe('exempt');
    });

    it('SE-06: Add spectator', () => {
      const result = escrow.addPlayer('viewer1', false, true);
      expect(result).toEqual({ status: 'new' });
      const player = escrow.players.get('viewer1');
      expect(player.isSpectator).toBe(true);
      expect(player.paymentStatus).toBe('exempt');
    });

    it('SE-07: Duplicate player - already confirmed', () => {
      escrow.addPlayer('alice', false, false);
      escrow.setPlayerInvoice('alice', 'inv-1');
      escrow.confirmPayment('alice');
      const result = escrow.addPlayer('alice', false, false);
      expect(result).toEqual({ status: 'already_confirmed' });
      expect(escrow.players.get('alice').paymentStatus).toBe('confirmed');
    });

    it('SE-08: Duplicate player - invoice pending (has invoiceId)', () => {
      escrow.addPlayer('alice', false, false);
      escrow.setPlayerInvoice('alice', 'inv-1');
      const result = escrow.addPlayer('alice', false, false);
      expect(result).toEqual({ status: 'invoice_pending' });
    });

    it('SE-09: Duplicate player - invoice creating (no invoiceId yet, invoiceCreating=true)', () => {
      escrow.addPlayer('alice', false, false);
      // invoiceCreating is true by default from addPlayer
      const result = escrow.addPlayer('alice', false, false);
      expect(result).toEqual({ status: 'invoice_pending' });
    });

    it('SE-10: Re-add player who exists but has no invoice and no invoiceCreating flag', () => {
      escrow.addPlayer('alice', false, false);
      const player = escrow.players.get('alice');
      player.invoiceCreating = false;
      player.invoiceId = null;
      const result = escrow.addPlayer('alice', false, false);
      expect(result).toEqual({ status: 'new' });
      // Player record should be overwritten with fresh state
      const updated = escrow.players.get('alice');
      expect(updated.invoiceCreating).toBe(true);
    });
  });

  // ── setPlayerInvoice ─────────────────────────────────────────

  describe('setPlayerInvoice', () => {
    it('SE-11: Set invoice for existing player', () => {
      escrow.addPlayer('alice', false, false);
      escrow.setPlayerInvoice('alice', 'inv-123');
      expect(escrow.players.get('alice').invoiceId).toBe('inv-123');
    });

    it('SE-12: Set invoice for non-existent player', () => {
      expect(() => {
        escrow.setPlayerInvoice('unknown', 'inv-456');
      }).not.toThrow();
      // Verify no phantom player record was created
      expect(escrow.players.has('unknown')).toBe(false);
    });
  });

  // ── prizePool edge case ─────────────────────────────────────

  describe('prizePool edge: undefined entryFee', () => {
    it('SE-24b: prizePool returns 0 when entryFee is undefined', () => {
      const noFeeEscrow = new SessionEscrow('test-nofee', {
        creatorNametag: '@creator',
        isDefaultSession: false,
      });
      noFeeEscrow.addPlayer('@alice', false, false);
      noFeeEscrow.confirmPayment('@alice');
      expect(noFeeEscrow.prizePool).toBe('0');
    });
  });

  // ── confirmPayment ───────────────────────────────────────────

  describe('confirmPayment', () => {
    it('SE-13: Confirm payment for pending player', () => {
      escrow.addPlayer('alice', false, false);
      const result = escrow.confirmPayment('alice');
      expect(result).toBe(true);
      expect(escrow.players.get('alice').paymentStatus).toBe('confirmed');
    });

    it('SE-14: Confirm payment for already confirmed player', () => {
      escrow.addPlayer('alice', false, false);
      escrow.confirmPayment('alice');
      const result = escrow.confirmPayment('alice');
      expect(result).toBe(false);
      expect(escrow.players.get('alice').paymentStatus).toBe('confirmed');
    });

    it('SE-15: Confirm payment for exempt player (bot)', () => {
      escrow.addPlayer('bot_grunt', true, false);
      const result = escrow.confirmPayment('bot_grunt');
      expect(result).toBe(false);
      expect(escrow.players.get('bot_grunt').paymentStatus).toBe('exempt');
    });

    it('SE-16: Confirm payment for exempt player (spectator)', () => {
      escrow.addPlayer('viewer1', false, true);
      const result = escrow.confirmPayment('viewer1');
      expect(result).toBe(false);
      expect(escrow.players.get('viewer1').paymentStatus).toBe('exempt');
    });

    it('SE-17: Confirm payment for non-existent player', () => {
      const result = escrow.confirmPayment('nobody');
      expect(result).toBe(false);
    });
  });

  // ── prizePool ────────────────────────────────────────────────

  describe('prizePool', () => {
    it('SE-18: Prize pool with 0 players', () => {
      expect(escrow.prizePool).toBe('0');
    });

    it('SE-19: Prize pool with 1 confirmed player', () => {
      escrow.addPlayer('alice', false, false);
      escrow.confirmPayment('alice');
      expect(escrow.prizePool).toBe('1000000000');
    });

    it('SE-20: Prize pool with 3 confirmed players', () => {
      escrow.addPlayer('alice', false, false);
      escrow.addPlayer('bob', false, false);
      escrow.addPlayer('carol', false, false);
      escrow.confirmPayment('alice');
      escrow.confirmPayment('bob');
      escrow.confirmPayment('carol');
      expect(escrow.prizePool).toBe('3000000000');
    });

    it('SE-21: Prize pool excludes pending players', () => {
      escrow.addPlayer('alice', false, false);
      escrow.addPlayer('bob', false, false);
      escrow.addPlayer('carol', false, false);
      escrow.confirmPayment('alice');
      escrow.confirmPayment('bob');
      // carol remains pending
      expect(escrow.prizePool).toBe('2000000000');
    });

    it('SE-22: Prize pool excludes bots', () => {
      escrow.addPlayer('alice', false, false);
      escrow.addPlayer('bob', false, false);
      escrow.addPlayer('bot1', true, false);
      escrow.addPlayer('bot2', true, false);
      escrow.confirmPayment('alice');
      escrow.confirmPayment('bob');
      expect(escrow.prizePool).toBe('2000000000');
    });

    it('SE-23: Prize pool excludes spectators', () => {
      escrow.addPlayer('alice', false, false);
      escrow.addPlayer('viewer', false, true);
      escrow.confirmPayment('alice');
      expect(escrow.prizePool).toBe('1000000000');
    });

    it('SE-24: BigInt correctness with large fee', () => {
      const bigEscrow = new SessionEscrow('sess-big', {
        creatorNametag: 'alice',
        isDefaultSession: false,
        entryFee: '99999999999999999',
        entryCoin: 'UCT',
      });
      bigEscrow.addPlayer('a', false, false);
      bigEscrow.addPlayer('b', false, false);
      bigEscrow.addPlayer('c', false, false);
      bigEscrow.confirmPayment('a');
      bigEscrow.confirmPayment('b');
      bigEscrow.confirmPayment('c');
      expect(bigEscrow.prizePool).toBe('299999999999999997');
    });
  });

  // ── paidPlayerCount ──────────────────────────────────────────

  describe('paidPlayerCount', () => {
    it('SE-25: Count with no players', () => {
      expect(escrow.paidPlayerCount).toBe(0);
    });

    it('SE-26: Count with mixed statuses', () => {
      escrow.addPlayer('alice', false, false);
      escrow.addPlayer('bob', false, false);
      escrow.addPlayer('carol', false, false);
      escrow.addPlayer('bot1', true, false);
      escrow.confirmPayment('alice');
      escrow.confirmPayment('bob');
      // carol is pending, bot1 is exempt
      expect(escrow.paidPlayerCount).toBe(2);
    });
  });

  // ── getPayoutRecipient ───────────────────────────────────────

  describe('getPayoutRecipient', () => {
    it('SE-27: Human wins any session', () => {
      const result = escrow.getPayoutRecipient('alice', false, 'babaika10');
      expect(result).toBe('alice');
    });

    it('SE-28: Bot wins custom session', () => {
      // isDefaultSession = false (custom)
      const result = escrow.getPayoutRecipient('bot_grunt', true, 'babaika10');
      expect(result).toBe('alice'); // creatorNametag
    });

    it('SE-29: Bot wins default session', () => {
      const defEscrow = new SessionEscrow('sess-def', {
        creatorNametag: 'creator',
        isDefaultSession: true,
        entryFee: '1000000000',
        entryCoin: 'UCT',
      });
      const result = defEscrow.getPayoutRecipient('bot_grunt', true, 'babaika10');
      expect(result).toBe('babaika10');
    });

    it('SE-30: Human wins default session', () => {
      const defEscrow = new SessionEscrow('sess-def', {
        creatorNametag: 'creator',
        isDefaultSession: true,
        entryFee: '1000000000',
        entryCoin: 'UCT',
      });
      const result = defEscrow.getPayoutRecipient('alice', false, 'babaika10');
      expect(result).toBe('alice');
    });
  });

  // ── State Machine (transitionState) ──────────────────────────

  describe('transitionState', () => {
    it('SE-31: Valid: open -> lobby', () => {
      escrow.transitionState('open', 'lobby');
      expect(escrow.state).toBe('lobby');
    });

    it('SE-32: Valid: open -> playing', () => {
      escrow.transitionState('open', 'playing');
      expect(escrow.state).toBe('playing');
    });

    it('SE-33: Valid: open -> cancelled', () => {
      escrow.transitionState('open', 'cancelled');
      expect(escrow.state).toBe('cancelled');
    });

    it('SE-34: Valid: lobby -> playing', () => {
      escrow.transitionState('open', 'lobby');
      escrow.transitionState('lobby', 'playing');
      expect(escrow.state).toBe('playing');
    });

    it('SE-35: Valid: lobby -> cancelled', () => {
      escrow.transitionState('open', 'lobby');
      escrow.transitionState('lobby', 'cancelled');
      expect(escrow.state).toBe('cancelled');
    });

    it('SE-36: Valid: playing -> paying_out', () => {
      escrow.transitionState('open', 'playing');
      escrow.transitionState('playing', 'paying_out');
      expect(escrow.state).toBe('paying_out');
    });

    it('SE-37: Valid: playing -> cancelled', () => {
      escrow.transitionState('open', 'playing');
      escrow.transitionState('playing', 'cancelled');
      expect(escrow.state).toBe('cancelled');
    });

    it('SE-38: Valid: paying_out -> paid_out', () => {
      escrow.transitionState('open', 'playing');
      escrow.transitionState('playing', 'paying_out');
      escrow.transitionState('paying_out', 'paid_out');
      expect(escrow.state).toBe('paid_out');
    });

    it('SE-39: Valid: paying_out -> failed', () => {
      escrow.transitionState('open', 'playing');
      escrow.transitionState('playing', 'paying_out');
      escrow.transitionState('paying_out', 'failed');
      expect(escrow.state).toBe('failed');
    });

    it('SE-40: Valid: failed -> cancelled', () => {
      escrow.transitionState('open', 'playing');
      escrow.transitionState('playing', 'paying_out');
      escrow.transitionState('paying_out', 'failed');
      escrow.transitionState('failed', 'cancelled');
      expect(escrow.state).toBe('cancelled');
    });

    it('SE-41: Invalid: open -> paid_out', () => {
      expect(() => {
        escrow.transitionState('open', 'paid_out');
      }).toThrow(/Illegal state transition/);
    });

    it('SE-42: Invalid: playing -> open', () => {
      escrow.transitionState('open', 'playing');
      expect(() => {
        escrow.transitionState('playing', 'open');
      }).toThrow(/Illegal state transition/);
    });

    it('SE-43: Invalid: paid_out -> anything', () => {
      escrow.transitionState('open', 'playing');
      escrow.transitionState('playing', 'paying_out');
      escrow.transitionState('paying_out', 'paid_out');
      expect(() => {
        escrow.transitionState('paid_out', 'cancelled');
      }).toThrow(/Illegal state transition/);
    });

    it('SE-44: Invalid: cancelled -> anything', () => {
      escrow.transitionState('open', 'cancelled');
      expect(() => {
        escrow.transitionState('cancelled', 'open');
      }).toThrow(/Illegal state transition/);
    });

    it('SE-45: State mismatch', () => {
      // State is 'open', but we claim it is 'playing'
      expect(() => {
        escrow.transitionState('playing', 'paying_out');
      }).toThrow(/state mismatch.*expected 'playing'.*actual 'open'/);
    });

    it('SE-46: Invalid: paying_out -> cancelled', () => {
      escrow.transitionState('open', 'playing');
      escrow.transitionState('playing', 'paying_out');
      expect(() => {
        escrow.transitionState('paying_out', 'cancelled');
      }).toThrow(/Illegal state transition/);
    });
  });

  // ── Admission Tokens ─────────────────────────────────────────

  describe('Admission Tokens', () => {
    it('SE-47: Set and validate admission token', () => {
      escrow.addPlayer('alice', false, false);
      escrow.setAdmissionToken('alice', 'abc123', 'player');
      const result = escrow.validateAdmissionToken('abc123');
      expect(result).toEqual({
        nametag: 'alice',
        role: 'player',
        sessionId: 'sess-1',
      });
    });

    it('SE-48: Token marked as used after validation', () => {
      escrow.addPlayer('alice', false, false);
      escrow.setAdmissionToken('alice', 'abc123', 'player');
      const first = escrow.validateAdmissionToken('abc123');
      expect(first).not.toBeNull();
      const second = escrow.validateAdmissionToken('abc123');
      expect(second).toBeNull();
    });

    it('SE-49: Expired token', () => {
      escrow.addPlayer('alice', false, false);
      const realNow = Date.now;
      const baseTime = Date.now();
      Date.now = jest.fn(() => baseTime);
      escrow.setAdmissionToken('alice', 'abc123', 'player');
      // Advance past 5 minutes
      Date.now = jest.fn(() => baseTime + 5 * 60 * 1000 + 1);
      const result = escrow.validateAdmissionToken('abc123');
      expect(result).toBeNull();
      Date.now = realNow;
    });

    it('SE-50: Non-existent token', () => {
      const result = escrow.validateAdmissionToken('nonexistent');
      expect(result).toBeNull();
    });

    it('SE-51: Token stores on player record', () => {
      escrow.addPlayer('alice', false, false);
      escrow.setAdmissionToken('alice', 'tok123', 'player');
      expect(escrow.players.get('alice').admissionToken).toBe('tok123');
    });

    it('SE-52: Spectator token', () => {
      escrow.addPlayer('viewer', false, true);
      escrow.setAdmissionToken('viewer', 'tok456', 'spectator');
      const result = escrow.validateAdmissionToken('tok456');
      expect(result).toEqual({
        nametag: 'viewer',
        role: 'spectator',
        sessionId: 'sess-1',
      });
    });
  });
});
