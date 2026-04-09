'use strict';

jest.mock('winston', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const RateLimiter = require('../lib/rate-limiter');

describe('RateLimiter', () => {
  let limiter;
  let realDateNow;

  beforeEach(() => {
    realDateNow = Date.now;
    limiter = new RateLimiter();
  });

  afterEach(() => {
    Date.now = realDateNow;
  });

  it('RL-01: First request allowed', () => {
    const result = limiter.check('alice');
    expect(result).toEqual({ allowed: true, retryAfterMs: 0 });
  });

  it('RL-02: Second request allowed', () => {
    limiter.check('alice');
    const result = limiter.check('alice');
    expect(result.allowed).toBe(true);
    expect(result.retryAfterMs).toBe(0);
  });

  it('RL-03: Third request allowed (at limit)', () => {
    limiter.check('alice');
    limiter.check('alice');
    const result = limiter.check('alice');
    expect(result.allowed).toBe(true);
    expect(result.retryAfterMs).toBe(0);
  });

  it('RL-04: Fourth request blocked', () => {
    limiter.check('alice');
    limiter.check('alice');
    limiter.check('alice');
    const result = limiter.check('alice');
    expect(result.allowed).toBe(false);
    expect(result.retryAfterMs).toBeGreaterThan(0);
  });

  it('RL-05: Different nametags are independent', () => {
    limiter.check('alice');
    limiter.check('alice');
    limiter.check('alice');
    const result = limiter.check('bob');
    expect(result).toEqual({ allowed: true, retryAfterMs: 0 });
  });

  it('RL-06: Allowed after window expires', () => {
    const baseTime = 1000000;
    Date.now = jest.fn(() => baseTime);
    limiter.check('alice');
    limiter.check('alice');
    limiter.check('alice');
    // Advance past 5-min window
    Date.now = jest.fn(() => baseTime + 5 * 60 * 1000 + 1);
    const result = limiter.check('alice');
    expect(result.allowed).toBe(true);
    expect(result.retryAfterMs).toBe(0);
  });

  it('RL-07: retryAfterMs calculation', () => {
    const baseTime = 1000000;
    const windowMs = 5 * 60 * 1000;
    Date.now = jest.fn(() => baseTime);
    limiter.check('alice'); // t=baseTime
    Date.now = jest.fn(() => baseTime + 1000);
    limiter.check('alice'); // t=baseTime+1000
    Date.now = jest.fn(() => baseTime + 2000);
    limiter.check('alice'); // t=baseTime+2000
    Date.now = jest.fn(() => baseTime + 3000);
    const result = limiter.check('alice'); // 4th request at t=baseTime+3000
    expect(result.allowed).toBe(false);
    // retryAfterMs = (firstTimestamp + windowMs) - now
    // = (baseTime + windowMs) - (baseTime + 3000) = windowMs - 3000
    expect(result.retryAfterMs).toBe(windowMs - 3000);
    expect(result.retryAfterMs).toBeGreaterThan(0);
  });

  it('RL-08: Memory eviction of empty entries', () => {
    const baseTime = 1000000;
    const windowMs = 5 * 60 * 1000;
    Date.now = jest.fn(() => baseTime);
    limiter.check('alice'); // 1 request at baseTime
    // Advance past window so old entry is pruned
    Date.now = jest.fn(() => baseTime + windowMs + 1);
    limiter.check('alice'); // prunes old, records new
    const timestamps = limiter.requests.get('alice');
    expect(timestamps).toHaveLength(1);
    expect(timestamps[0]).toBe(baseTime + windowMs + 1);
  });

  it('RL-09: Custom max and window', () => {
    const custom = new RateLimiter(5, 10000);
    for (let i = 0; i < 5; i++) {
      const result = custom.check('alice');
      expect(result.allowed).toBe(true);
    }
    const blocked = custom.check('alice');
    expect(blocked.allowed).toBe(false);

    // After 10s all allowed again
    const baseTime = Date.now();
    Date.now = jest.fn(() => baseTime + 10001);
    const afterWindow = custom.check('alice');
    expect(afterWindow.allowed).toBe(true);
  });

  it('RL-10: retryAfterMs is never negative', () => {
    const baseTime = 1000000;
    const windowMs = 5 * 60 * 1000;
    Date.now = jest.fn(() => baseTime);
    limiter.check('alice');
    limiter.check('alice');
    limiter.check('alice');
    // Set time exactly at cutoff boundary (timestamps should be at edge)
    Date.now = jest.fn(() => baseTime + windowMs);
    const result = limiter.check('alice');
    // Whether allowed or not, retryAfterMs must be >= 0
    expect(result.retryAfterMs).toBeGreaterThanOrEqual(0);
  });

  it('RL-11: Sliding window behavior', () => {
    const baseTime = 1000000;
    const windowMs = 5 * 60 * 1000;
    // 3 requests: t=0s, t=2s, t=4s
    Date.now = jest.fn(() => baseTime);
    limiter.check('alice');
    Date.now = jest.fn(() => baseTime + 2000);
    limiter.check('alice');
    Date.now = jest.fn(() => baseTime + 4000);
    limiter.check('alice');
    // At t=5m+1ms, first request has expired, only 2 remain in window
    Date.now = jest.fn(() => baseTime + windowMs + 1);
    const result = limiter.check('alice');
    expect(result.allowed).toBe(true);
  });
});
