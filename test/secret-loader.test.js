'use strict';

jest.mock('winston', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

jest.mock('fs');

const fs = require('fs');
const { loadMnemonic, sanitizeConfig, clearMnemonicEnv } = require('../lib/secret-loader');

const VALID_12 = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const VALID_24 = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art';
const ALT_12 = 'zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong';

describe('SecretLoader', () => {
  beforeEach(() => {
    delete process.env.UNIQUAKE_MNEMONIC_FILE;
    delete process.env.UNIQUAKE_MNEMONIC;
    jest.resetAllMocks();
  });

  // ── loadMnemonic ─────────────────────────────────────────────

  describe('loadMnemonic', () => {
    it('SL-01: Load from file (UNIQUAKE_MNEMONIC_FILE)', () => {
      process.env.UNIQUAKE_MNEMONIC_FILE = '/secrets/mnemonic.txt';
      fs.readFileSync.mockReturnValue(VALID_12 + '\n');
      const result = loadMnemonic();
      expect(result).toBe(VALID_12);
      expect(fs.readFileSync).toHaveBeenCalledWith('/secrets/mnemonic.txt', 'utf8');
    });

    it('SL-02: Load from env (UNIQUAKE_MNEMONIC)', () => {
      process.env.UNIQUAKE_MNEMONIC = VALID_12;
      const result = loadMnemonic();
      expect(result).toBe(VALID_12);
      // env var should NOT be deleted yet (deferred to clearMnemonicEnv)
      expect(process.env.UNIQUAKE_MNEMONIC).toBe(VALID_12);
    });

    it('SL-03: File preferred over env', () => {
      process.env.UNIQUAKE_MNEMONIC_FILE = '/secrets/mnemonic.txt';
      process.env.UNIQUAKE_MNEMONIC = ALT_12;
      fs.readFileSync.mockReturnValue(VALID_12);
      const result = loadMnemonic();
      expect(result).toBe(VALID_12);
    });

    it('SL-04: Invalid word count (11 words)', () => {
      const words11 = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon';
      process.env.UNIQUAKE_MNEMONIC = words11;
      expect(() => loadMnemonic()).toThrow(/expected 12 or 24 words, got 11/);
    });

    it('SL-05: Invalid word count (25 words)', () => {
      const words25 = VALID_24 + ' extra';
      process.env.UNIQUAKE_MNEMONIC = words25;
      expect(() => loadMnemonic()).toThrow(/expected 12 or 24 words, got 25/);
    });

    it('SL-06: Valid 24-word mnemonic', () => {
      process.env.UNIQUAKE_MNEMONIC = VALID_24;
      const result = loadMnemonic();
      expect(result).toBe(VALID_24);
    });

    it('SL-07: Empty mnemonic (env var set but empty)', () => {
      process.env.UNIQUAKE_MNEMONIC = '';
      expect(() => loadMnemonic()).toThrow(/No mnemonic configured/);
    });

    it('SL-08: No mnemonic at all', () => {
      expect(() => loadMnemonic()).toThrow(
        /No mnemonic configured\. Set UNIQUAKE_MNEMONIC_FILE/
      );
    });

    it('SL-09: File does not exist', () => {
      process.env.UNIQUAKE_MNEMONIC_FILE = '/nonexistent/path';
      fs.readFileSync.mockImplementation(() => {
        throw new Error('ENOENT: no such file or directory');
      });
      expect(() => loadMnemonic()).toThrow(/Failed to read mnemonic file/);
    });

    it('SL-10: Mnemonic with extra whitespace', () => {
      const padded = '  abandon  abandon  abandon  abandon  abandon  abandon  abandon  abandon  abandon  abandon  abandon  about  ';
      process.env.UNIQUAKE_MNEMONIC = padded;
      const result = loadMnemonic();
      expect(result).toBe(padded.trim());
    });
  });

  // ── clearMnemonicEnv ─────────────────────────────────────────

  describe('clearMnemonicEnv', () => {
    it('SL-11: clearMnemonicEnv deletes env var', () => {
      process.env.UNIQUAKE_MNEMONIC = VALID_12;
      clearMnemonicEnv();
      expect(process.env.UNIQUAKE_MNEMONIC).toBeUndefined();
    });

    it('SL-12: clearMnemonicEnv when not set', () => {
      expect(() => clearMnemonicEnv()).not.toThrow();
    });
  });

  // ── sanitizeConfig ───────────────────────────────────────────

  describe('sanitizeConfig', () => {
    it('SL-13: sanitizeConfig redacts mnemonic', () => {
      const result = sanitizeConfig({
        mnemonic: 'secret words',
        network: 'testnet',
      });
      expect(result).toEqual({
        mnemonic: '[REDACTED]',
        network: 'testnet',
      });
    });

    it('SL-14: sanitizeConfig deep redaction', () => {
      const result = sanitizeConfig({
        outer: { mnemonic: 'secret', other: 'safe' },
      });
      expect(result).toEqual({
        outer: { mnemonic: '[REDACTED]', other: 'safe' },
      });
    });

    it('SL-15: sanitizeConfig handles null', () => {
      expect(sanitizeConfig(null)).toBeNull();
    });

    it('SL-16: sanitizeConfig handles arrays', () => {
      const result = sanitizeConfig([
        { mnemonic: 'x' },
        { mnemonic: 'y' },
      ]);
      expect(result).toEqual([
        { mnemonic: '[REDACTED]' },
        { mnemonic: '[REDACTED]' },
      ]);
    });

    it('SL-17: sanitizeConfig preserves non-object values', () => {
      expect(sanitizeConfig('string')).toBe('string');
    });
  });
});
