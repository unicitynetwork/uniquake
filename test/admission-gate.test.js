'use strict';

jest.mock('winston', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const AdmissionGate = require('../lib/admission-gate');

describe('AdmissionGate', () => {
  let gate;

  beforeEach(() => {
    jest.useFakeTimers();
    gate = new AdmissionGate();
  });

  afterEach(() => {
    gate.destroy();
    jest.useRealTimers();
  });

  // ── Token Generation ─────────────────────────────────────────

  describe('Token Generation', () => {
    it('AG-01: Generated token is 64 hex characters', () => {
      const token = gate.generateAdmissionToken('sess-1', 'alice', 'player');
      expect(token).toHaveLength(64);
      expect(token).toMatch(/^[0-9a-f]{64}$/);
    });

    it('AG-02: Generated tokens are unique', () => {
      const tokens = new Set();
      for (let i = 0; i < 100; i++) {
        tokens.add(gate.generateAdmissionToken('sess-1', `user${i}`, 'player'));
      }
      expect(tokens.size).toBe(100);
    });

    it('AG-03: Token record stored correctly', () => {
      const token = gate.generateAdmissionToken('sess-1', 'alice', 'player');
      const record = gate.tokens.get(token);
      expect(record).toBeDefined();
      expect(record.sessionId).toBe('sess-1');
      expect(record.nametag).toBe('alice');
      expect(record.role).toBe('player');
      expect(record.createdAt).toBe(Date.now());
      expect(record.used).toBe(false);
    });

    it('AG-04: Token format is lowercase hex', () => {
      const token = gate.generateAdmissionToken('sess-1', 'alice', 'player');
      expect(token).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  // ── Token Validation ─────────────────────────────────────────

  describe('Token Validation', () => {
    it('AG-05: Valid token with matching sessionId', () => {
      const token = gate.generateAdmissionToken('sess-1', 'alice', 'player');
      const result = gate.validateAdmissionToken(token, 'sess-1');
      expect(result).toEqual({
        nametag: 'alice',
        role: 'player',
        sessionId: 'sess-1',
      });
    });

    it('AG-06: Expired token (>5 min)', () => {
      const token = gate.generateAdmissionToken('sess-1', 'alice', 'player');
      jest.advanceTimersByTime(5 * 60 * 1000 + 1);
      const result = gate.validateAdmissionToken(token, 'sess-1');
      expect(result).toBeNull();
    });

    it('AG-07: Already used token', () => {
      const token = gate.generateAdmissionToken('sess-1', 'alice', 'player');
      const first = gate.validateAdmissionToken(token, 'sess-1');
      expect(first).not.toBeNull();
      const second = gate.validateAdmissionToken(token, 'sess-1');
      expect(second).toBeNull();
    });

    it('AG-08: Wrong session ID', () => {
      const token = gate.generateAdmissionToken('sess-1', 'alice', 'player');
      const result = gate.validateAdmissionToken(token, 'sess-2');
      expect(result).toBeNull();
    });

    it('AG-09: Non-existent token', () => {
      const result = gate.validateAdmissionToken(
        'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
        'sess-1'
      );
      expect(result).toBeNull();
    });

    it('AG-10: Token at exactly 5 min boundary', () => {
      const token = gate.generateAdmissionToken('sess-1', 'alice', 'player');
      jest.advanceTimersByTime(5 * 60 * 1000);
      const result = gate.validateAdmissionToken(token, 'sess-1');
      // age === TTL is NOT greater than TTL, so it should be valid
      expect(result).not.toBeNull();
      expect(result.nametag).toBe('alice');
    });

    it('AG-11: Token at 5 min + 1ms', () => {
      const token = gate.generateAdmissionToken('sess-1', 'alice', 'player');
      jest.advanceTimersByTime(5 * 60 * 1000 + 1);
      const result = gate.validateAdmissionToken(token, 'sess-1');
      expect(result).toBeNull();
    });
  });

  // ── Cleanup ──────────────────────────────────────────────────

  describe('Cleanup', () => {
    it('AG-12: Expired tokens removed by cleanup', () => {
      for (let i = 0; i < 5; i++) {
        gate.generateAdmissionToken('sess-1', `user${i}`, 'player');
      }
      expect(gate.tokens.size).toBe(5);
      jest.advanceTimersByTime(5 * 60 * 1000 + 1);
      gate.cleanup();
      expect(gate.tokens.size).toBe(0);
    });

    it('AG-13: Non-expired tokens survive cleanup', () => {
      // Generate 3 tokens at t=0
      for (let i = 0; i < 3; i++) {
        gate.generateAdmissionToken('sess-1', `user${i}`, 'player');
      }
      // Advance to just past expiry for the first 3
      jest.advanceTimersByTime(5 * 60 * 1000 + 1);
      // Generate 2 more tokens at the new time (these are fresh)
      for (let i = 3; i < 5; i++) {
        gate.generateAdmissionToken('sess-1', `user${i}`, 'player');
      }
      expect(gate.tokens.size).toBe(5);
      gate.cleanup();
      expect(gate.tokens.size).toBe(2);
    });

    it('AG-14: Cleanup with empty map', () => {
      expect(() => gate.cleanup()).not.toThrow();
      expect(gate.tokens.size).toBe(0);
    });
  });

  // ── Destroy ──────────────────────────────────────────────────

  describe('Destroy', () => {
    it('AG-15: Destroy clears interval', () => {
      gate.destroy();
      expect(gate._cleanupInterval).toBeNull();
    });

    it('AG-16: Double destroy is safe', () => {
      gate.destroy();
      expect(() => gate.destroy()).not.toThrow();
    });
  });
});
