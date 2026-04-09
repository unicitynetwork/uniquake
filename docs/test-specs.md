# UniQuake Sphere SDK Integration - Test Specifications

**Version:** 1.0
**Date:** 2026-04-01
**Status:** SPECS ONLY - No test code yet
**Scope:** All modules created for the Sphere SDK integration (Wave 1-3 of implementation plan)

---

## Table of Contents

1. [Unit Tests](#1-unit-tests)
   - [SessionEscrow (SE-*)](#11-sessionescrow-se-)
   - [AdmissionGate (AG-*)](#12-admissiongate-ag-)
   - [RateLimiter (RL-*)](#13-ratelimiter-rl-)
   - [SecretLoader (SL-*)](#14-secretloader-sl-)
   - [PayoutEngine (PE-*)](#15-payoutengine-pe-)
   - [PayoutRetryQueue (PQ-*)](#16-payoutretryqueue-pq-)
   - [PaymentManager (PM-*)](#17-paymentmanager-pm-)
   - [SphereGameBridge (SB-*)](#18-spheregamebridge-sb-)
2. [Integration Tests](#2-integration-tests-with-mocked-sphere-sdk)
3. [Security Tests](#3-security-tests)
4. [Edge Cases](#4-edge-cases)

---

## 1. Unit Tests

### 1.1 SessionEscrow (SE-*)

**Module:** `lib/session-escrow.js`
**Depends on:** winston (logger)

#### Constructor

| ID | Description | Input / Setup | Expected Outcome | Security |
|----|-------------|---------------|-------------------|----------|
| SE-01 | Constructor with valid config | `new SessionEscrow('sess-1', { creatorNametag: 'alice', isDefaultSession: false, entryFee: '1000000000', entryCoin: 'UCT' })` | All fields assigned correctly: `sessionId='sess-1'`, `creatorNametag='alice'`, `isDefaultSession=false`, `entryFee='1000000000'`, `entryCoin='UCT'`, `state='open'`, `players` is empty Map, `admissionTokens` is empty Map, `createdAt` is approximately `Date.now()` | - |
| SE-02 | Constructor defaults | `new SessionEscrow('sess-2', { creatorNametag: 'bob' })` | `isDefaultSession=false`, `entryCoin='UCT'`, `entryFee=undefined` (caller must provide), `state='open'` | - |
| SE-03 | Constructor with isDefaultSession true | `new SessionEscrow('sess-3', { creatorNametag: null, isDefaultSession: true, entryFee: '1000000000', entryCoin: 'UCT' })` | `isDefaultSession=true`, `creatorNametag=null` | - |

#### addPlayer

| ID | Description | Input / Setup | Expected Outcome | Security |
|----|-------------|---------------|-------------------|----------|
| SE-04 | Add new human player | `escrow.addPlayer('alice', false, false)` | Returns `{ status: 'new' }`. Player record created with `isBot=false`, `isSpectator=false`, `paymentStatus='pending'`, `invoiceId=null`, `invoiceCreating=true` | - |
| SE-05 | Add new bot player | `escrow.addPlayer('bot_grunt', true, false)` | Returns `{ status: 'new' }`. Player record has `isBot=true`, `paymentStatus='exempt'` | - |
| SE-06 | Add spectator | `escrow.addPlayer('viewer1', false, true)` | Returns `{ status: 'new' }`. Player record has `isSpectator=true`, `paymentStatus='exempt'` | - |
| SE-07 | Duplicate player - already confirmed | First: add player, set invoiceId, confirm payment. Then call `addPlayer('alice', false, false)` again | Returns `{ status: 'already_confirmed' }`. Player record is NOT overwritten | S5 |
| SE-08 | Duplicate player - invoice pending (has invoiceId) | Add player, set invoiceId via `setPlayerInvoice`. Then call `addPlayer('alice', false, false)` again | Returns `{ status: 'invoice_pending' }`. Player record is NOT overwritten | S5 |
| SE-09 | Duplicate player - invoice creating (no invoiceId yet, invoiceCreating=true) | Add player (invoiceCreating is set to true by default). Then call `addPlayer('alice', false, false)` again | Returns `{ status: 'invoice_pending' }`. Prevents race condition where two concurrent `handleJoinRequest` calls both try to create invoices | S5 |
| SE-10 | Re-add player who exists but has no invoice and no invoiceCreating flag | Add player, then manually set `invoiceCreating=false` and `invoiceId=null`. Call `addPlayer` again | Returns `{ status: 'new' }`. Player record is overwritten (fresh attempt) | - |

#### setPlayerInvoice

| ID | Description | Input / Setup | Expected Outcome | Security |
|----|-------------|---------------|-------------------|----------|
| SE-11 | Set invoice for existing player | Add player 'alice', then `setPlayerInvoice('alice', 'inv-123')` | `players.get('alice').invoiceId === 'inv-123'` | - |
| SE-12 | Set invoice for non-existent player | `setPlayerInvoice('unknown', 'inv-456')` | No error thrown, no effect | - |

#### confirmPayment

| ID | Description | Input / Setup | Expected Outcome | Security |
|----|-------------|---------------|-------------------|----------|
| SE-13 | Confirm payment for pending player | Add player 'alice' (status=pending), then `confirmPayment('alice')` | Returns `true`. Player `paymentStatus='confirmed'` | - |
| SE-14 | Confirm payment for already confirmed player | Add player, confirm once, then `confirmPayment('alice')` again | Returns `false`. Status remains 'confirmed' | - |
| SE-15 | Confirm payment for exempt player (bot) | Add bot player, then `confirmPayment('bot_grunt')` | Returns `false`. Status remains 'exempt' | - |
| SE-16 | Confirm payment for exempt player (spectator) | Add spectator, then `confirmPayment('viewer1')` | Returns `false`. Status remains 'exempt' | - |
| SE-17 | Confirm payment for non-existent player | `confirmPayment('nobody')` | Returns `false` | - |

#### prizePool

| ID | Description | Input / Setup | Expected Outcome | Security |
|----|-------------|---------------|-------------------|----------|
| SE-18 | Prize pool with 0 players | Empty escrow | `prizePool === '0'` | - |
| SE-19 | Prize pool with 1 confirmed player | Add 1 player, confirm payment. entryFee='1000000000' | `prizePool === '1000000000'` | - |
| SE-20 | Prize pool with 3 confirmed players | Add 3 players, confirm all. entryFee='1000000000' | `prizePool === '3000000000'` (BigInt arithmetic) | - |
| SE-21 | Prize pool excludes pending players | Add 3 players, confirm only 2 | `prizePool === '2000000000'` | - |
| SE-22 | Prize pool excludes bots | Add 2 humans (confirmed) + 2 bots | `prizePool === '2000000000'` (bots are exempt, not confirmed) | - |
| SE-23 | Prize pool excludes spectators | Add 1 confirmed player + 1 spectator | `prizePool === '1000000000'` | - |
| SE-24 | BigInt correctness with large fee | entryFee='99999999999999999', 3 confirmed players | `prizePool === '299999999999999997'` (BigInt multiplication, no floating point loss) | - |

#### paidPlayerCount

| ID | Description | Input / Setup | Expected Outcome | Security |
|----|-------------|---------------|-------------------|----------|
| SE-25 | Count with no players | Empty escrow | `paidPlayerCount === 0` | - |
| SE-26 | Count with mixed statuses | 2 confirmed, 1 pending, 1 exempt | `paidPlayerCount === 2` | - |

#### getPayoutRecipient

| ID | Description | Input / Setup | Expected Outcome | Security |
|----|-------------|---------------|-------------------|----------|
| SE-27 | Human wins any session | `getPayoutRecipient('alice', false, 'babaika10')` | Returns `'alice'` | - |
| SE-28 | Bot wins custom session | `isDefaultSession=false`, `getPayoutRecipient('bot_grunt', true, 'babaika10')` | Returns `creatorNametag` (the session creator) | - |
| SE-29 | Bot wins default session | `isDefaultSession=true`, `getPayoutRecipient('bot_grunt', true, 'babaika10')` | Returns `'babaika10'` (defaultPayoutNametag) | - |
| SE-30 | Human wins default session | `isDefaultSession=true`, `getPayoutRecipient('alice', false, 'babaika10')` | Returns `'alice'` (human always gets payout regardless of session type) | - |

#### State Machine (transitionState)

| ID | Description | Input / Setup | Expected Outcome | Security |
|----|-------------|---------------|-------------------|----------|
| SE-31 | Valid: open -> lobby | `transitionState('open', 'lobby')` | State becomes 'lobby'. No error | S4 |
| SE-32 | Valid: open -> playing | `transitionState('open', 'playing')` | State becomes 'playing' | S4 |
| SE-33 | Valid: open -> cancelled | `transitionState('open', 'cancelled')` | State becomes 'cancelled' | S4 |
| SE-34 | Valid: lobby -> playing | Transition to lobby first, then `transitionState('lobby', 'playing')` | State becomes 'playing' | S4 |
| SE-35 | Valid: lobby -> cancelled | `transitionState('lobby', 'cancelled')` | State becomes 'cancelled' | S4 |
| SE-36 | Valid: playing -> paying_out | `transitionState('playing', 'paying_out')` | State becomes 'paying_out' | S4 |
| SE-37 | Valid: playing -> cancelled | `transitionState('playing', 'cancelled')` | State becomes 'cancelled' | S4 |
| SE-38 | Valid: paying_out -> paid_out | `transitionState('paying_out', 'paid_out')` | State becomes 'paid_out' | S4 |
| SE-39 | Valid: paying_out -> failed | `transitionState('paying_out', 'failed')` | State becomes 'failed' | S4 |
| SE-40 | Valid: failed -> cancelled | `transitionState('failed', 'cancelled')` | State becomes 'cancelled' | S4 |
| SE-41 | Invalid: open -> paid_out | `transitionState('open', 'paid_out')` | Throws Error with message containing 'Illegal state transition' | S4 |
| SE-42 | Invalid: playing -> open | `transitionState('playing', 'open')` | Throws Error | S4 |
| SE-43 | Invalid: paid_out -> anything | After reaching paid_out, `transitionState('paid_out', 'cancelled')` | Throws Error (paid_out is terminal, not in VALID_TRANSITIONS keys) | S4 |
| SE-44 | Invalid: cancelled -> anything | `transitionState('cancelled', 'open')` | Throws Error (cancelled is terminal) | S4 |
| SE-45 | State mismatch | State is 'open', call `transitionState('playing', 'paying_out')` | Throws Error with message 'state mismatch: expected \'playing\', actual \'open\'' | S4 |
| SE-46 | Invalid: paying_out -> cancelled | `transitionState('paying_out', 'cancelled')` | Throws Error (not in allowed transitions for paying_out) | S4 |

#### Admission Tokens

| ID | Description | Input / Setup | Expected Outcome | Security |
|----|-------------|---------------|-------------------|----------|
| SE-47 | Set and validate admission token | Add player, `setAdmissionToken('alice', 'abc123', 'player')`, then `validateAdmissionToken('abc123')` | Returns `{ nametag: 'alice', role: 'player', sessionId: 'sess-1' }` | S1 |
| SE-48 | Token marked as used after validation | Validate token once, then validate again | First returns identity object, second returns `null` (single-use) | S1 |
| SE-49 | Expired token | Set token, advance time past 5 minutes (mock `Date.now`), validate | Returns `null` | S1 |
| SE-50 | Non-existent token | `validateAdmissionToken('nonexistent')` | Returns `null` | S1 |
| SE-51 | Token stores on player record | `setAdmissionToken('alice', 'tok123', 'player')` | `players.get('alice').admissionToken === 'tok123'` | S1 |
| SE-52 | Spectator token | `setAdmissionToken('viewer', 'tok456', 'spectator')`, validate | Returns `{ role: 'spectator', ... }` | S1, S6 |

---

### 1.2 AdmissionGate (AG-*)

**Module:** `lib/admission-gate.js`
**Depends on:** crypto, winston

#### Token Generation

| ID | Description | Input / Setup | Expected Outcome | Security |
|----|-------------|---------------|-------------------|----------|
| AG-01 | Generated token is 64 hex characters | `generateAdmissionToken('sess-1', 'alice', 'player')` | Token is a string of exactly 64 hex characters (32 bytes) | S1 |
| AG-02 | Generated tokens are unique | Generate 100 tokens | All 100 tokens are distinct (Set.size === 100) | S1 |
| AG-03 | Token record stored correctly | Generate token | Internal `tokens` map has record with `sessionId`, `nametag`, `role`, `createdAt`, `used=false` | S1 |
| AG-04 | Token format is lowercase hex | Generate token | Token matches regex `/^[0-9a-f]{64}$/` | S1 |

#### Token Validation

| ID | Description | Input / Setup | Expected Outcome | Security |
|----|-------------|---------------|-------------------|----------|
| AG-05 | Valid token with matching sessionId | Generate token for session 'sess-1', validate with sessionId='sess-1' | Returns `{ nametag, role, sessionId }` | S1 |
| AG-06 | Expired token (>5 min) | Generate token, mock `Date.now` to advance 5 minutes + 1ms, validate | Returns `null` | S1 |
| AG-07 | Already used token | Generate, validate (marks used), validate again | Second validation returns `null` | S1 |
| AG-08 | Wrong session ID | Generate for 'sess-1', validate with 'sess-2' | Returns `null` | S1 |
| AG-09 | Non-existent token | `validateAdmissionToken('deadbeef...', 'sess-1')` | Returns `null` | S1 |
| AG-10 | Token at exactly 5 min boundary | Generate, advance time to exactly 5 * 60 * 1000 ms | Returns valid result (age === TTL is NOT greater than TTL) | S1 |
| AG-11 | Token at 5 min + 1ms | Generate, advance time to 5 * 60 * 1000 + 1 ms | Returns `null` | S1 |

#### Cleanup

| ID | Description | Input / Setup | Expected Outcome | Security |
|----|-------------|---------------|-------------------|----------|
| AG-12 | Expired tokens removed by cleanup | Generate 5 tokens, advance time past 5 min, call `cleanup()` | `tokens.size === 0`, all 5 removed | - |
| AG-13 | Non-expired tokens survive cleanup | Generate 3 tokens (not expired), generate 2 tokens (advance past 5 min). Call `cleanup()` | 2 expired tokens removed, 3 remain. Verify by checking `tokens.size` | - |
| AG-14 | Cleanup with empty map | `cleanup()` on fresh gate | No errors, `tokens.size === 0` | - |

#### Destroy

| ID | Description | Input / Setup | Expected Outcome | Security |
|----|-------------|---------------|-------------------|----------|
| AG-15 | Destroy clears interval | `destroy()` | `_cleanupInterval` is null. No further cleanup runs | - |
| AG-16 | Double destroy is safe | `destroy()` twice | No error on second call | - |

---

### 1.3 RateLimiter (RL-*)

**Module:** `lib/rate-limiter.js`
**Depends on:** winston

| ID | Description | Input / Setup | Expected Outcome | Security |
|----|-------------|---------------|-------------------|----------|
| RL-01 | First request allowed | `check('alice')` | `{ allowed: true, retryAfterMs: 0 }` | S11 |
| RL-02 | Second request allowed | `check('alice')` twice in succession | Both return `{ allowed: true }` | S11 |
| RL-03 | Third request allowed (at limit) | `check('alice')` three times | All three return `{ allowed: true }` | S11 |
| RL-04 | Fourth request blocked | `check('alice')` four times within window | Fourth returns `{ allowed: false, retryAfterMs: <positive number> }` | S11 |
| RL-05 | Different nametags are independent | `check('alice')` 3x, then `check('bob')` | 'bob' returns `{ allowed: true }` | S11 |
| RL-06 | Allowed after window expires | `check('alice')` 3x, advance time past 5-min window, `check('alice')` | Returns `{ allowed: true }` after window expires | S11 |
| RL-07 | retryAfterMs calculation | 3 requests with known timestamps, then 4th request. Verify `retryAfterMs` equals time until oldest request exits the window | `retryAfterMs` is approximately `(firstTimestamp + windowMs) - now` and is > 0 | S11 |
| RL-08 | Memory eviction of empty entries | `check('alice')` once, advance time past window, call `check('alice')` again (prunes old, records new) | Internal map entry for 'alice' has exactly 1 timestamp (old pruned, new added). No stale entries | - |
| RL-09 | Custom max and window | `new RateLimiter(5, 10000)` (5 requests per 10s) | 5 requests allowed, 6th blocked. After 10s all allowed again | S11 |
| RL-10 | retryAfterMs is never negative | Edge case: timestamps exactly at cutoff boundary | `retryAfterMs >= 0` guaranteed by `Math.max(0, ...)` | - |
| RL-11 | Sliding window behavior | 3 requests: t=0s, t=2s, t=4s. At t=5m+1s (first expired), 4th request | `{ allowed: true }` because only 2 requests remain in window | S11 |

---

### 1.4 SecretLoader (SL-*)

**Module:** `lib/secret-loader.js`
**Depends on:** fs, winston

| ID | Description | Input / Setup | Expected Outcome | Security |
|----|-------------|---------------|-------------------|----------|
| SL-01 | Load from file (UNIQUAKE_MNEMONIC_FILE) | Set `UNIQUAKE_MNEMONIC_FILE` to a temp file containing 12 valid words | Returns the 12-word mnemonic string. `UNIQUAKE_MNEMONIC` env var NOT deleted (deferred to `clearMnemonicEnv()`) | S3 |
| SL-02 | Load from env (UNIQUAKE_MNEMONIC) | Set `UNIQUAKE_MNEMONIC` to 12 valid words, no FILE set | Returns the 12-word mnemonic string | S3 |
| SL-03 | File preferred over env | Set both `UNIQUAKE_MNEMONIC_FILE` (12 words) and `UNIQUAKE_MNEMONIC` (different 12 words) | Returns the file-based mnemonic, not the env-based one | S3 |
| SL-04 | Invalid word count (11 words) | Set `UNIQUAKE_MNEMONIC` to 11 words | Throws Error with message containing 'expected 12 or 24 words, got 11' | S3 |
| SL-05 | Invalid word count (25 words) | Set `UNIQUAKE_MNEMONIC` to 25 words | Throws Error with message containing 'expected 12 or 24 words, got 25' | S3 |
| SL-06 | Valid 24-word mnemonic | Set `UNIQUAKE_MNEMONIC` to 24 words | Returns the 24-word mnemonic string without error | S3 |
| SL-07 | Empty mnemonic (env var set but empty) | `UNIQUAKE_MNEMONIC=''` | Throws Error 'No mnemonic configured' | S3 |
| SL-08 | No mnemonic at all | Neither env var set | Throws Error 'No mnemonic configured. Set UNIQUAKE_MNEMONIC_FILE...' | S3 |
| SL-09 | File does not exist | `UNIQUAKE_MNEMONIC_FILE=/nonexistent/path` | Throws Error containing 'Failed to read mnemonic file' | S3 |
| SL-10 | Mnemonic with extra whitespace | `UNIQUAKE_MNEMONIC='  word1  word2 ... word12  '` | Returns trimmed mnemonic. Word count validation uses `split(/\s+/).filter(Boolean)`, so extra spaces are handled | S3 |
| SL-11 | clearMnemonicEnv deletes env var | Set `UNIQUAKE_MNEMONIC`, call `clearMnemonicEnv()` | `process.env.UNIQUAKE_MNEMONIC` is `undefined` | S3 |
| SL-12 | clearMnemonicEnv when not set | Call `clearMnemonicEnv()` when `UNIQUAKE_MNEMONIC` is not set | No error, no-op | S3 |
| SL-13 | sanitizeConfig redacts mnemonic | `sanitizeConfig({ mnemonic: 'secret words', network: 'testnet' })` | Returns `{ mnemonic: '[REDACTED]', network: 'testnet' }` | S3 |
| SL-14 | sanitizeConfig deep redaction | `sanitizeConfig({ outer: { mnemonic: 'secret', other: 'safe' } })` | Returns `{ outer: { mnemonic: '[REDACTED]', other: 'safe' } }` | S3 |
| SL-15 | sanitizeConfig handles null | `sanitizeConfig(null)` | Returns `null` | - |
| SL-16 | sanitizeConfig handles arrays | `sanitizeConfig([{ mnemonic: 'x' }, { mnemonic: 'y' }])` | Returns `[{ mnemonic: '[REDACTED]' }, { mnemonic: '[REDACTED]' }]` | S3 |
| SL-17 | sanitizeConfig preserves non-object values | `sanitizeConfig('string')` | Returns `'string'` | - |

---

### 1.5 PayoutEngine (PE-*)

**Module:** `lib/payout-engine.js`
**Depends on:** winston, mocked Sphere SDK instance

#### determineWinner

| ID | Description | Input / Setup | Expected Outcome | Security |
|----|-------------|---------------|-------------------|----------|
| PE-01 | Human wins with highest score | Escrow with 'alice' (confirmed), 'bob' (confirmed). Scores: `[{ name: 'alice', score: 15, isBot: false }, { name: 'bob', score: 10, isBot: false }]` | Returns `{ winnerNametag: 'alice', isWinnerBot: false, score: 15 }` | - |
| PE-02 | Bot wins | Escrow with 'alice' (confirmed), bot 'grunt'. Scores: `[{ name: 'grunt', score: 20, isBot: true }, { name: 'alice', score: 5, isBot: false }]` | Returns `{ winnerNametag: 'grunt', isWinnerBot: true, score: 20 }` | - |
| PE-03 | Tied scores - first in sorted order wins | Two players with score 10 each | Returns one of them (implementation sorts descending; stable sort gives the first occurrence in the original array). Verify a valid winner is returned | - |
| PE-04 | No scores provided (null) | `determineWinner(escrow, null)` | Returns `null` | - |
| PE-05 | Empty scores array | `determineWinner(escrow, [])` | Returns `null` | - |
| PE-06 | Spectator excluded from winner | Escrow: 'viewer' (exempt/spectator), 'alice' (confirmed). Scores: `[{ name: 'viewer', score: 99, isBot: false }, { name: 'alice', score: 5, isBot: false }]` | Returns `{ winnerNametag: 'alice', score: 5 }`. 'viewer' excluded because not in confirmedPlayers set | S6 |
| PE-07 | Only confirmed payers eligible | Escrow: 'alice' (pending, not confirmed), 'bob' (confirmed). Scores: `[{ name: 'alice', score: 50, isBot: false }, { name: 'bob', score: 10, isBot: false }]` | Returns `{ winnerNametag: 'bob', score: 10 }`. 'alice' excluded despite higher score | S6 |
| PE-08 | Bots are always eligible | Escrow with no confirmed players. Scores: `[{ name: 'bot', score: 5, isBot: true }]` | Returns `{ winnerNametag: 'bot', isWinnerBot: true, score: 5 }`. Bots don't need confirmed payment | S6 |
| PE-09 | All participants ineligible | Escrow with spectators only. Scores with spectator names only | Returns `null` (no eligible players) | S6 |
| PE-10 | Score with player not in escrow | Scores include 'unknown' who is not in escrow.players | 'unknown' excluded (not in confirmedPlayers, not isBot) | S6 |

#### processPayout

| ID | Description | Input / Setup | Expected Outcome | Security |
|----|-------------|---------------|-------------------|----------|
| PE-11 | Successful payout flow | Escrow with 2 confirmed players, prizePool='2000000000'. Mock sphere: resolve returns address, createInvoice succeeds, payInvoice succeeds, closeInvoice succeeds | Returns `{ status: 'confirmed', recipient, amount: '2000000000', coinId: 'UCT', invoiceId }`. Verify `sphere.payments.receive()` called first (S10) | S10 |
| PE-12 | Zero prize pool | Escrow with no confirmed players (prizePool='0') | Returns `{ status: 'no_prize', reason: 'No paying players' }`. No invoice created | - |
| PE-13 | Nametag resolution failure (resolve returns null) | Mock `sphere.resolve()` returns `{ directAddress: null }` | Returns `{ status: 'failed', reason: 'Cannot resolve nametag: ...' }` | - |
| PE-14 | Nametag resolution throws | Mock `sphere.resolve()` throws Error | Returns `{ status: 'failed', reason: 'Nametag resolution error: ...' }` | - |
| PE-15 | Payout invoice creation failure | Mock `sphere.accounting.createInvoice()` throws | Returns `{ status: 'failed', reason: 'Payout error: ...' }` | - |
| PE-16 | Payout payment failure | Mock `sphere.accounting.payInvoice()` throws | Returns `{ status: 'failed', reason: 'Payout error: ...' }` | - |
| PE-17 | Payout failure delegates to retry queue | Set `retryQueue` on engine. Cause a failure | `retryQueue.add()` called with correct `{ sessionId, recipientNametag, amount, coinId, memo, escrow }` | S10 |
| PE-18 | No retry queue - failure just returns | `retryQueue` is null, cause a failure | Returns `{ status: 'failed' }`. No error thrown from missing queue | - |
| PE-19 | receive() called before payout | Successful payout | Verify `sphere.payments.receive()` called exactly once before `createInvoice()` | S10 |
| PE-20 | Receipt delivery failure is non-fatal | Mock `sendInvoiceReceipts()` throws | Returns `{ status: 'confirmed' }` regardless. Receipt error logged but payout succeeds | - |
| PE-21 | Nametag without @ prefix | Recipient nametag is 'alice' (no @) | `sphere.resolve()` called with '@alice' (@ prefix added) | - |
| PE-22 | Nametag with @ prefix | Recipient nametag is '@alice' | `sphere.resolve()` called with '@alice' (not '@@alice') | - |

---

### 1.6 PayoutRetryQueue (PQ-*)

**Module:** `lib/payout-retry-queue.js`
**Depends on:** winston, mocked Sphere SDK instance

#### add

| ID | Description | Input / Setup | Expected Outcome | Security |
|----|-------------|---------------|-------------------|----------|
| PQ-01 | Item enqueued with correct backoff | `add({ sessionId: 's1', recipientNametag: 'alice', amount: '100', coinId: 'UCT', memo: 'test', escrow })` | `queue.length === 1`. Item has `attempt=1`, `nextRetryAt` approximately `Date.now() + 30000` | - |
| PQ-02 | Multiple items enqueued | Add 3 items | `queue.length === 3`. Each has independent `nextRetryAt` | - |

#### processQueue

| ID | Description | Input / Setup | Expected Outcome | Security |
|----|-------------|---------------|-------------------|----------|
| PQ-03 | Successful retry removes item | Add item, advance time past 30s, mock sphere for success, call `processQueue()` | `queue.length === 0`. sphere.payments.receive() called, invoice created, paid, closed | S10 |
| PQ-04 | Failed retry increments attempt | Add item, advance time, mock sphere to throw on createInvoice, call `processQueue()` | `queue.length === 1`. Item `attempt === 2`. `nextRetryAt` updated with second backoff (60s) | - |
| PQ-05 | Backoff schedule: 30s, 60s, 120s, 240s, 480s | Cause 5 consecutive failures, check `nextRetryAt` after each | Backoff intervals match `[30000, 60000, 120000, 240000, 480000]` | - |
| PQ-06 | Max retries exhausted calls handleFinalFailure | Set `maxRetries=5`. Fail 5 times, then `processQueue()` on 6th attempt (attempt > maxRetries) | Item removed from queue. `_handleFinalFailure` called. Log contains 'CRITICAL' | T38 |
| PQ-07 | Items not yet due are skipped | Add item with `nextRetryAt` in the future, call `processQueue()` | Item remains in queue, no retry attempted | - |
| PQ-08 | Empty queue processing | `processQueue()` with empty queue | Returns immediately, no errors | - |
| PQ-09 | Nametag resolution during retry | Add item with `recipientAddress=null`, mock resolve to succeed | `sphere.resolve()` called, address set on item, invoice created with resolved address | - |
| PQ-10 | Nametag resolution failure during retry | Add item with `recipientAddress=null`, mock resolve to throw | Retry fails, attempt incremented | - |

#### handleFinalFailure

| ID | Description | Input / Setup | Expected Outcome | Security |
|----|-------------|---------------|-------------------|----------|
| PQ-11 | State transition failed -> cancelled | Item with escrow in 'failed' state | `escrow.transitionState('failed', 'cancelled')` called. Escrow state is 'cancelled' | T38 |
| PQ-12 | Auto-return refund for all players with invoices | Escrow has 3 players with invoiceIds | `sphere.accounting.cancelInvoice()` called 3 times with `{ autoReturn: true }` | T38 |
| PQ-13 | Players without invoices skipped | Escrow has 2 players: one with invoiceId, one without (bot) | `cancelInvoice` called once (for the player with invoiceId) | T38 |
| PQ-14 | Cancel invoice failure is non-fatal | Mock `cancelInvoice()` throws for one player | Other players' invoices still cancelled. Error logged but no exception propagated | T38 |
| PQ-15 | Escrow is null | Item with `escrow: null` | `_handleFinalFailure` returns without error | - |
| PQ-16 | State transition failure is non-fatal | Escrow in wrong state (not 'failed'). transitionState throws | Error logged, but invoice cancellation still proceeds | T38 |

#### start / stop

| ID | Description | Input / Setup | Expected Outcome | Security |
|----|-------------|---------------|-------------------|----------|
| PQ-17 | start creates interval timer | `start()` | `timer` is not null | - |
| PQ-18 | start is idempotent | `start()` twice | No second timer created (early return) | - |
| PQ-19 | stop clears timer | `start()` then `stop()` | `timer === null` | - |
| PQ-20 | length getter | Add 2 items, remove 1 via successful retry | `length === 1` | - |

---

### 1.7 PaymentManager (PM-*)

**Module:** `lib/payment-manager.js`
**Depends on:** All other modules, mocked Sphere SDK

All Sphere SDK methods should be mocked for unit tests. Integration tests (Section 2) test with a more complete mock.

#### Constructor and Init

| ID | Description | Input / Setup | Expected Outcome | Security |
|----|-------------|---------------|-------------------|----------|
| PM-01 | Constructor sets config defaults | `new PaymentManager({})` | `config.network === 'testnet'`, `defaultPayoutNametag === 'babaika10'`, `entryFee === '10'`, `entryCoin === 'UCT'` | - |
| PM-02 | Constructor with custom config | `new PaymentManager({ network: 'mainnet', entryFee: '50' })` | Custom values applied | - |
| PM-03 | init: successful initialization | Mock all sphere-sdk functions. Set valid UNIQUAKE_MNEMONIC env | `sphere` is not null. `payoutEngine` is not null. `retryQueue` started. `receiveInterval` active. `clearMnemonicEnv()` called | S3 |
| PM-04 | init: missing mnemonic | No env vars set | Throws Error 'No mnemonic configured' | S3 |
| PM-05 | init: nametag resolution failure | Mock `sphere.resolve()` to throw for default nametag | Throws Error (fail-fast S8/S10). PaymentManager is NOT usable | S8, S10 |
| PM-06 | init: nametag resolves to null | Mock `sphere.resolve()` returns null | Throws Error 'Resolution returned null' | S8 |
| PM-07 | init: clears mnemonic env after success | Set UNIQUAKE_MNEMONIC, mock init to succeed | After init(), `process.env.UNIQUAKE_MNEMONIC` is undefined | S3 |
| PM-08 | init: DM listener registered | Mock sphere SDK | `sphere.communications.onDirectMessage()` called with a handler function. `unsubscribeDM` stores the returned unsubscribe function | - |
| PM-09 | init: periodic receive started | After init | `receiveInterval` is not null (setInterval created) | S10 |

#### handleJoinRequest

| ID | Description | Input / Setup | Expected Outcome | Security |
|----|-------------|---------------|-------------------|----------|
| PM-10 | New player: creates invoice | Create session, send join_request with role='player' from 'alice' | Invoice created via `sphere.accounting.createInvoice()`. DM sent with `type='uniquake:entry_invoice'`. `escrow.players.get('alice')` has invoiceId set | S7 |
| PM-11 | Duplicate player: resends existing invoice | After PM-10, send join_request again from 'alice' | No new invoice created. DM re-sent with same invoiceId (S5 dedup) | S5 |
| PM-12 | Already confirmed player: resends admission token | Player already paid and confirmed. Send join_request again | New admission token generated, DM sent with `type='uniquake:join_confirmed'` and fresh token | S5 |
| PM-13 | Rate limited | Send 4 join requests from same nametag within 5 minutes | Fourth request: DM sent with `type='uniquake:error'`, `code='RATE_LIMITED'`, `retryAfterMs` > 0. No invoice created | S11 |
| PM-14 | Spectator: free admission token | Send join_request with role='spectator' from 'viewer1' | No invoice created. Admission token generated. DM sent with `type='uniquake:join_confirmed'`, `role='spectator'`, `admissionToken` present | S1, S6 |
| PM-15 | Unknown session | Send join_request with sessionId that does not exist | No action taken, no DM sent, no error thrown | - |
| PM-16 | Invoice creation failure | Mock `createInvoice()` to throw | DM sent with `type='uniquake:error'`, `code='INVOICE_FAILED'`. Error logged | - |
| PM-17 | sessionId validation: non-string | Send join_request with `sessionId: 123` (number) | Returns early, no action taken | - |
| PM-18 | sessionId validation: empty string | Send join_request with `sessionId: ''` | Returns early | - |
| PM-19 | sessionId validation: too long (>256 chars) | Send join_request with `sessionId` of 257 characters | Returns early | - |

#### handlePaymentNotification

| ID | Description | Input / Setup | Expected Outcome | Security |
|----|-------------|---------------|-------------------|----------|
| PM-20 | Valid payment: confirms and sends admission token | Create session, add player with invoice, mock invoice status COVERED | `escrow.confirmPayment()` called. Admission token generated. DM sent with `join_confirmed` and `admissionToken` | S1 |
| PM-21 | Wrong invoiceId | Player has invoice 'inv-1', notification has 'inv-2' | No confirmation. Warning logged | S5 |
| PM-22 | Player not in escrow | Payment notification from unknown sender | No action | - |
| PM-23 | Already confirmed player | Player already confirmed, sends payment_notification again | Early return with info log 'Payment already confirmed'. No double-processing | S4 |
| PM-24 | Invoice status not COVERED | Mock invoice status returns 'OPEN' | No confirmation. Info log about status | - |
| PM-25 | Invoice status CLOSED | Mock invoice status returns 'CLOSED' | Payment confirmed (CLOSED is also valid) | - |
| PM-26 | receive() called before status check | Valid payment flow | Verify `sphere.payments.receive()` is called before `getInvoiceStatus()` | S10 |
| PM-27 | receive() failure is non-fatal | Mock `sphere.payments.receive()` throws | Status check still proceeds. Warning logged | S10 |

#### distributeWinnings

| ID | Description | Input / Setup | Expected Outcome | Security |
|----|-------------|---------------|-------------------|----------|
| PM-28 | Human wins: pays winner | Session in 'playing' state with 2 confirmed players. Scores show alice winning | State transitions: playing -> paying_out -> paid_out. PayoutEngine.processPayout called. DMs sent to all players with match_result | - |
| PM-29 | Bot wins default session: pays default nametag | Default session, bot wins | `getPayoutRecipient` returns 'babaika10'. Payout sent to default nametag | - |
| PM-30 | Bot wins custom session: pays creator | Custom session with creator='bob', bot wins | `getPayoutRecipient` returns 'bob' | - |
| PM-31 | Idempotency guard: second call returns already_processed | Call `distributeWinnings` twice for same session | Second call returns `{ status: 'already_processed' }`. No payout attempted | S4 |
| PM-32 | Session not found | `distributeWinnings('nonexistent', scores)` | Returns `{ status: 'error', reason: 'Session not found' }` | - |
| PM-33 | Session already paid_out | Session state is 'paid_out' | Returns `{ status: 'already_processed' }` | S4 |
| PM-34 | Session already cancelled | Session state is 'cancelled' | Returns `{ status: 'already_processed' }` | S4 |
| PM-35 | Payout failure transitions to 'failed' | PayoutEngine returns `{ status: 'failed' }` | State transitions: playing -> paying_out -> failed. Match result DMs still sent | - |
| PM-36 | Entry invoices closed before payout | distributeWinnings called | For each player with invoiceId, `sphere.accounting.closeInvoice()` is called | - |
| PM-37 | Close invoice failure is non-fatal | Mock `closeInvoice()` throws for one player | Other players' invoices still closed. Payout proceeds | - |
| PM-38 | State guard is synchronous | Verify `escrow.transitionState()` is called BEFORE any await in the function | The transition to 'paying_out' is the first operation, before `determineWinner`, `closeInvoice`, or `processPayout` | S4 |

#### cancelSession

| ID | Description | Input / Setup | Expected Outcome | Security |
|----|-------------|---------------|-------------------|----------|
| PM-39 | Cancel session with auto-return fees | Session with 2 paid players | All player invoices cancelled with `{ autoReturn: true }`. Session state becomes 'cancelled'. DMs sent with `match_cancelled` | - |
| PM-40 | Cancel blocked during paying_out | Session state is 'paying_out' | Warning logged. No cancellation performed. State unchanged | S4 |
| PM-41 | Cancel blocked when already paid_out | Session state is 'paid_out' | Warning logged. No cancellation | - |
| PM-42 | Cancel blocked when already cancelled | Session state is 'cancelled' | Warning logged. No action | - |
| PM-43 | Cancel session not found | `cancelSession('nonexistent')` | Returns silently, no error | - |
| PM-44 | Cancel with invoice cancellation failure | Mock `cancelInvoice()` throws for one player | Other players still refunded. Error logged | - |

#### validateAdmissionToken

| ID | Description | Input / Setup | Expected Outcome | Security |
|----|-------------|---------------|-------------------|----------|
| PM-45 | Delegates to AdmissionGate | Call `validateAdmissionToken('sess-1', 'token123')` | Calls `this.admissionGate.validateAdmissionToken('token123', 'sess-1')` (note parameter order) and returns its result | S1 |

#### DM Content Validation (_handleIncomingDM)

| ID | Description | Input / Setup | Expected Outcome | Security |
|----|-------------|---------------|-------------------|----------|
| PM-46 | Oversized DM content rejected | DM with `content.length > 10240` | Returns early, no processing | - |
| PM-47 | Empty content rejected | DM with `content: ''` (falsy) | Returns early | - |
| PM-48 | Non-JSON content ignored | DM with `content: 'hello world'` | Returns early (JSON.parse catch), no error propagated | - |
| PM-49 | Non-uniquake type ignored | DM with `content: '{"type":"other:message"}'` | Returns early (type doesn't start with 'uniquake:') | - |
| PM-50 | Missing type field ignored | DM with `content: '{"sessionId":"s1"}'` | Returns early | - |
| PM-51 | No sender identity | DM with neither `senderNametag` nor `sender` | Warning logged, returns early | - |
| PM-52 | dm_ack type is no-op | DM with `type: 'uniquake:dm_ack'` | No error, no action (explicit case for acknowledgment) | - |
| PM-53 | Unknown uniquake type logged | DM with `type: 'uniquake:unknown_type'` | Debug log with type and sender | - |

#### destroy

| ID | Description | Input / Setup | Expected Outcome | Security |
|----|-------------|---------------|-------------------|----------|
| PM-54 | Destroy cleans up all resources | After init, call `destroy()` | `receiveInterval` cleared, all payment timers cleared, retryQueue stopped, admissionGate destroyed, unsubscribeDM called, `sphere.destroy()` called, `sphere` is null | - |

---

### 1.8 SphereGameBridge (SB-*)

**Module:** `lib/client/sphere-game-bridge.js`
**Environment:** Browser (IIFE, not Node.js module)
**Depends on:** `window.SphereConnect` global (from sphere-connect-bundle.js)

Note: These tests require a browser-like environment (jsdom or similar) with `window` global.

#### Constructor

| ID | Description | Input / Setup | Expected Outcome | Security |
|----|-------------|---------------|-------------------|----------|
| SB-01 | Constructor initializes all fields to null/false | `new SphereGameBridge()` | `client=null`, `connection=null`, `identity=null`, `connected=false`, `transport=null`, `disconnectFn=null`, `serverNametag=null`, `admissionToken=null`, `currentSessionId=null` | - |

#### init

| ID | Description | Input / Setup | Expected Outcome | Security |
|----|-------------|---------------|-------------------|----------|
| SB-02 | Successful init with autoConnect | Mock `window.SphereConnect.autoConnect` to return `{ client, connection: { identity }, transport: 'popup', disconnect: fn }` | `connected=true`, `transport='popup'`, `identity` set, `client` set | - |
| SB-03 | Missing SphereConnect global | `window.SphereConnect = undefined` | Throws Error 'SphereConnect bundle not loaded' | - |
| SB-04 | Missing autoConnect function | `window.SphereConnect = {}` | Throws Error 'SphereConnect bundle not loaded' | - |
| SB-05 | Permissions are minimal | After init | `autoConnect` called with `permissions: ['identity', 'balance', 'invoices']` (no 'payments') | S12 |
| SB-06 | walletUrl passed to autoConnect | `init({ walletUrl: 'https://custom.example.com' })` | `autoConnect` called with `walletUrl: 'https://custom.example.com'` | S9 |
| SB-07 | Default walletUrl | `init({})` | `autoConnect` called with `walletUrl: 'https://sphere.unicity.network'` | S9 |
| SB-08 | Server nametag set from config | `init({ serverNametag: 'gameserver1' })` | `this.serverNametag === 'gameserver1'` | S8 |
| SB-09 | Config from window.UNIQUAKE_CONFIG | Set `window.UNIQUAKE_CONFIG = { walletUrl: 'x', serverNametag: 'y' }`, call `init()` with no args | Uses values from `UNIQUAKE_CONFIG` | - |

#### isFromServer (S8)

| ID | Description | Input / Setup | Expected Outcome | Security |
|----|-------------|---------------|-------------------|----------|
| SB-10 | Matching server nametag | `serverNametag='gameserver'`, `isFromServer('gameserver')` | Returns `true` | S8 |
| SB-11 | Matching with @ prefix on sender | `serverNametag='gameserver'`, `isFromServer('@gameserver')` | Returns `true` (@ stripped) | S8 |
| SB-12 | Matching with @ prefix on pinned | `serverNametag='@gameserver'`, `isFromServer('gameserver')` | Returns `true` | S8 |
| SB-13 | Non-matching nametag | `serverNametag='gameserver'`, `isFromServer('attacker')` | Returns `false` | S8 |
| SB-14 | No server nametag pinned | `serverNametag=null`, `isFromServer('anyone')` | Returns `false`. Console warning about S8 protection | S8 |
| SB-15 | Null sender | `isFromServer(null)` | Returns `false` | S8 |

#### Queries (require connection)

| ID | Description | Input / Setup | Expected Outcome | Security |
|----|-------------|---------------|-------------------|----------|
| SB-16 | getIdentity when connected | Mock `client.query` | Calls `client.query('sphere_getIdentity')` | - |
| SB-17 | getIdentity when not connected | `connected=false` | Throws Error 'Wallet not connected' | - |
| SB-18 | getBalance | Mock `client.query` | Calls `client.query('sphere_getAssets')` | - |
| SB-19 | resolve | Mock `client.query` | Calls `client.query('sphere_resolve', { nametag })` | - |
| SB-20 | getInvoiceStatus | Mock `client.query` | Calls `client.query('sphere_getInvoiceStatus', { invoiceId })` | - |

#### Intents (require connection)

| ID | Description | Input / Setup | Expected Outcome | Security |
|----|-------------|---------------|-------------------|----------|
| SB-21 | payInvoice | Mock `client.intent` | Calls `client.intent('pay_invoice', { invoiceId, targetIndex: 0, assetIndex: 0 })` | - |
| SB-22 | payInvoice when not connected | `connected=false` | Throws Error 'Wallet not connected' | - |
| SB-23 | signMessage | Mock `client.intent` | Calls `client.intent('sign_message', { message })` | - |

#### Admission Token Management

| ID | Description | Input / Setup | Expected Outcome | Security |
|----|-------------|---------------|-------------------|----------|
| SB-24 | setAdmissionToken | `setAdmissionToken('tok123', 'sess-1')` | `admissionToken === 'tok123'`, `currentSessionId === 'sess-1'` | S1 |
| SB-25 | getAdmissionToken | After setting | Returns `'tok123'` | S1 |
| SB-26 | getAdmissionToken when not set | Fresh bridge | Returns `null` | - |
| SB-27 | clearAdmissionToken | Set then clear | `admissionToken === null`, `currentSessionId === null` | - |

#### Disconnect

| ID | Description | Input / Setup | Expected Outcome | Security |
|----|-------------|---------------|-------------------|----------|
| SB-28 | Disconnect clears all state | Connected bridge, call `disconnect()` | `disconnectFn()` called. All fields reset: `client=null`, `connected=false`, `transport=null`, `admissionToken=null`, `currentSessionId=null` | - |
| SB-29 | Disconnect when disconnectFn throws | Mock `disconnectFn` to throw | Warning logged, state still cleared | - |
| SB-30 | Disconnect when no disconnectFn | `disconnectFn=null`, call `disconnect()` | No error, state cleared | - |

#### Auto-init

| ID | Description | Input / Setup | Expected Outcome | Security |
|----|-------------|---------------|-------------------|----------|
| SB-31 | Auto-init when ?sphere=true | Set `window.location.search = '?sphere=true'`, load script | `init()` called on `window.SPHERE_WALLET` | - |
| SB-32 | No auto-init without ?sphere=true | Normal URL without sphere param | `init()` NOT called | - |
| SB-33 | Auto-init reads walletUrl from query | URL: `?sphere=true&walletUrl=https://custom.example.com` | `init()` called with `walletUrl: 'https://custom.example.com'` | - |
| SB-34 | Auto-init failure is non-fatal | Mock `autoConnect` to throw | Console error logged, game continues. `connected === false` | - |

---

## 2. Integration Tests (with mocked Sphere SDK)

These tests verify the interaction between multiple modules working together. The Sphere SDK is mocked at the top level (mock for `Sphere.init`, `sphere.accounting.*`, `sphere.payments.*`, `sphere.communications.*`, `sphere.resolve()`).

| ID | Description | Flow | Expected Outcome |
|----|-------------|------|-------------------|
| IT-01 | Full join flow | 1. `pm.createSession(config)` 2. Simulate DM `join_request` from 'alice' 3. Verify `entry_invoice` DM sent 4. Simulate DM `payment_notification` from 'alice' 5. Mock invoice status COVERED | alice's `paymentStatus='confirmed'`. `join_confirmed` DM sent with `admissionToken`. `validateAdmissionToken` succeeds for alice |
| IT-02 | Full match flow: join -> play -> win -> payout | 1. Create session 2. Two players join and pay (IT-01 x2) 3. `distributeWinnings(sessionId, scores)` with alice winning | Session state: open -> paying_out -> paid_out. `createInvoice` called for payout. `payInvoice` called. `closeInvoice` called. `match_result` DMs sent to both players |
| IT-03 | Cancellation flow | 1. Create session 2. Player joins and pays 3. `cancelSession(sessionId, 'admin cancel')` | Session state becomes 'cancelled'. Player's invoice cancelled with autoReturn. `match_cancelled` DM sent. Player's entry fee refunded |
| IT-04 | Spectator flow | 1. Create session 2. 'viewer1' sends join_request with role='spectator' | No invoice created. `join_confirmed` DM sent with role='spectator' and admissionToken. viewer1 in players map with paymentStatus='exempt'. prizePool='0' |
| IT-05 | Mixed players: 2 humans + 2 bots, human wins | 1. Create session 2. Add 2 humans (join+pay) and 2 bots (addPlayer isBot=true) 3. Scores: human1=20, human2=10, bot1=15, bot2=5 4. distributeWinnings | Winner: human1. Payout to human1's nametag. prizePool='2000000000' (only 2 humans paid). Bots excluded from prize pool but eligible for winning |
| IT-06 | Mixed players: 2 humans + 2 bots, bot wins | 1. Default session 2. 2 humans paid, 2 bots 3. Scores: bot1=30, human1=20, human2=10, bot2=5 4. distributeWinnings | Winner: bot1. Payout to defaultPayoutNametag ('babaika10') since isDefaultSession=true. prizePool='2000000000' |
| IT-07 | Mixed players: bot wins custom session | 1. Custom session with creator='bob' 2. 2 humans paid, bot wins 3. distributeWinnings | Payout to 'bob' (session creator) |
| IT-08 | Retry queue integration | 1. Create session 2. Players join and pay 3. distributeWinnings fails (mock payInvoice throws) 4. Advance time past backoff, processQueue | First attempt: payout fails, state -> 'failed'. Retry queue picks up item. Mock succeeds on retry. Item removed from queue |
| IT-09 | Payment timeout integration | 1. Create session 2. Player joins, invoice created 3. Player does NOT send payment_notification 4. Advance time 60s | After 60s: invoice cancelled with autoReturn. Error DM sent to player with PAYMENT_TIMEOUT code |

---

## 3. Security Tests

For each security mitigation (S1-S12), specific attack scenarios are defined.

### S1: Admission Gate (prevents free-ride attack)

| ID | Description | Attack Scenario | Expected Outcome |
|----|-------------|----------------|-------------------|
| ST-S1-01 | Connect without token | Player connects to WebSocket at `ws://host:27950?session=sess-1` (no admissionToken param) | Connection rejected with code 4001 |
| ST-S1-02 | Connect with expired token | Player gets admission token, waits >5 minutes, then connects to WebSocket | Connection rejected (validateAdmissionToken returns null) |
| ST-S1-03 | Connect with already-used token | Player gets token, connects once (token consumed), disconnects, reconnects with same token | Second connection rejected (token.used=true) |
| ST-S1-04 | Connect with token from wrong session | Player gets token for session A, tries to connect to session B | Rejected because sessionId mismatch in AdmissionGate.validateAdmissionToken |
| ST-S1-05 | Connect with fabricated token | Player sends a random 64-char hex string as admissionToken | Rejected (token not in AdmissionGate.tokens map) |
| ST-S1-06 | Spectator admission token encodes role | Spectator gets token, connects to WebSocket | Connection admitted but role is 'spectator'. Server tracks spectator flag for enforcement |

### S2: Identity Binding (prevents nametag spoofing)

| ID | Description | Attack Scenario | Expected Outcome |
|----|-------------|----------------|-------------------|
| ST-S2-01 | Self-asserted nametag on WS ignored | Player connects to WS claiming nametag='admin' via query param, but admission token binds to 'alice' | Server uses 'alice' (from token), ignores self-asserted nametag |
| ST-S2-02 | Nametag from admission token used for scoring | Player 'alice' wins match. Verify winner determined by token-bound nametag, not any WS-provided name | PayoutEngine uses nametag from escrow.players (populated from DM identity), not from WebSocket |

### S3: Mnemonic Protection

| ID | Description | Attack Scenario | Expected Outcome |
|----|-------------|----------------|-------------------|
| ST-S3-01 | Mnemonic not in env after init | After PaymentManager.init() | `process.env.UNIQUAKE_MNEMONIC` is undefined (deleted by clearMnemonicEnv) |
| ST-S3-02 | Mnemonic not in logs | Capture all logger output during init | No log line contains the actual mnemonic words. Config logged via sanitizeConfig shows '[REDACTED]' |
| ST-S3-03 | sanitizeConfig prevents accidental exposure | Log `JSON.stringify(sanitizeConfig(config))` | mnemonic field shows '[REDACTED]' |

### S4: Payout Idempotency (prevents double-payout)

| ID | Description | Attack Scenario | Expected Outcome |
|----|-------------|----------------|-------------------|
| ST-S4-01 | Call distributeWinnings twice rapidly | Two near-simultaneous calls to `distributeWinnings(sessionId, scores)` (e.g., timelimit + fraglimit in same frame) | First call succeeds (state: playing -> paying_out). Second call returns `{ status: 'already_processed' }` because state is no longer 'playing' |
| ST-S4-02 | State guard is synchronous (before await) | Verify via code inspection or mock timing | `transitionState(state, 'paying_out')` executes before any async operation. In Node.js single-threaded model, this prevents interleaving |
| ST-S4-03 | Cancel during payout blocked | Session is in 'paying_out', call `cancelSession` | `cancelSession` returns early with warning ('Cannot cancel session in state paying_out') |

### S5: Join Deduplication (prevents double-invoice)

| ID | Description | Attack Scenario | Expected Outcome |
|----|-------------|----------------|-------------------|
| ST-S5-01 | Send join_request twice before paying | Player 'alice' sends join_request, then sends it again before paying | Second request returns `invoice_pending`. Only one invoice exists. Same invoiceId re-sent via DM |
| ST-S5-02 | Send join_request after paying | Player 'alice' pays and is confirmed, sends join_request again | Returns `already_confirmed`. No new invoice. Fresh admission token generated and sent |
| ST-S5-03 | Concurrent join requests (invoiceCreating flag) | Two DMs arrive for same player before first invoice is created | First sets `invoiceCreating=true` synchronously. Second sees `invoiceCreating=true`, returns `invoice_pending` |

### S6: Spectator Lockdown

| ID | Description | Attack Scenario | Expected Outcome |
|----|-------------|----------------|-------------------|
| ST-S6-01 | Spectator in scores excluded from winner | Spectator 'viewer' has highest score in match scores array | `determineWinner` excludes 'viewer' (not in confirmedPlayers set). Next eligible player wins |
| ST-S6-02 | Unpaid player in scores excluded | Player 'freeloader' in escrow with paymentStatus='pending', has highest score | `determineWinner` excludes 'freeloader'. Only confirmed payers eligible |
| ST-S6-03 | Bot eligible despite not paying | Bot has highest score, no entry fee | Bot is eligible. Returns `{ isWinnerBot: true }` |

### S7: WSS-only + DM-only Invoices

| ID | Description | Attack Scenario | Expected Outcome |
|----|-------------|----------------|-------------------|
| ST-S7-01 | Invoice IDs never sent via WebSocket | Inspect all `_sendDM` calls vs any WS message sends in PaymentManager | `entry_invoice` messages containing `invoiceId` are only sent via `sphere.communications.sendDM()`, never via WebSocket |

### S8: Server Nametag Pinning

| ID | Description | Attack Scenario | Expected Outcome |
|----|-------------|----------------|-------------------|
| ST-S8-01 | Client validates sender nametag | DM received from 'attacker' but pinned server is 'gameserver' | `isFromServer('attacker')` returns false. Client rejects the DM |
| ST-S8-02 | Server validates nametag on startup | Default payout nametag cannot be resolved | PaymentManager.init() throws (fail-fast) |

### S9: PostMessage Origin Enforcement

| ID | Description | Attack Scenario | Expected Outcome |
|----|-------------|----------------|-------------------|
| ST-S9-01 | walletUrl passed to autoConnect | Verify autoConnect config | `autoConnect` receives specific `walletUrl`, not wildcard. PostMessageTransport uses this for origin validation |

### S10: Server Wallet Balance and Retry

| ID | Description | Attack Scenario | Expected Outcome |
|----|-------------|----------------|-------------------|
| ST-S10-01 | receive() called before payout | PayoutEngine.processPayout called | `sphere.payments.receive()` is the first async call before createInvoice |
| ST-S10-02 | Periodic receive runs every 30s | After init, verify interval | `setInterval` created with 30000ms for receive() |
| ST-S10-03 | receive() called before each retry | PayoutRetryQueue._retryPayout | First line calls `sphere.payments.receive()` |

### S11: Cancellation Rate Limiting

| ID | Description | Attack Scenario | Expected Outcome |
|----|-------------|----------------|-------------------|
| ST-S11-01 | 4th join in 5 minutes rate limited | Player sends 4 join_request DMs within 5 minutes | First 3 proceed normally. 4th receives `uniquake:error` DM with `code='RATE_LIMITED'` and `retryAfterMs` > 0 |
| ST-S11-02 | Rate limit resets after window | 3 requests, wait 5 minutes, 4th request | 4th request is allowed |
| ST-S11-03 | Different players have independent limits | 'alice' sends 3 requests, 'bob' sends 1 request | 'bob' is not rate limited |

### S12: Minimum Permission Scope

| ID | Description | Attack Scenario | Expected Outcome |
|----|-------------|----------------|-------------------|
| ST-S12-01 | Permissions array is minimal | Inspect autoConnect call in sphere-game-bridge.js | Permissions are exactly `['identity', 'balance', 'invoices']`. Does NOT include 'payments' |

---

## 4. Edge Cases

| ID | Description | Setup | Expected Outcome |
|----|-------------|-------|-------------------|
| EC-01 | Empty session (0 players) | Create session, immediately distributeWinnings | prizePool='0'. Result: `{ status: 'no_prize' }`. State transitions: open -> paying_out -> paid_out |
| EC-02 | Session with only bots (0 prize pool) | Add 3 bots to session, distributeWinnings with bot scores | prizePool='0' (bots are exempt). Result: `{ status: 'no_prize' }` |
| EC-03 | Session with only spectators | Add 2 spectators, distributeWinnings with spectator scores | prizePool='0'. determineWinner returns null (spectators excluded). Result: `{ status: 'no_prize' }` |
| EC-04 | Player disconnects mid-payment | Player joins (invoice created), starts payment timeout, player never sends payment_notification | After 60s timeout: invoice cancelled with autoReturn. Player notified via DM with PAYMENT_TIMEOUT |
| EC-05 | Server restart with pending sessions | PaymentManager destroyed mid-session, new PaymentManager created | New instance has empty sessions map. Pending invoices remain on-chain. Manual resolution required. Previous receiveInterval cleared |
| EC-06 | BigInt overflow with very large amounts | entryFee = '99999999999999999999' (20 digits), 100 confirmed players | prizePool correctly computed as BigInt. No floating point precision loss. Result is '9999999999999999999900' |
| EC-07 | Unicode in nametags | Player nametag contains unicode: `addPlayer('\u{1F600}emoji', false, false)` | Player added normally. Map key is the unicode string. DMs sent with unicode nametag. No encoding errors |
| EC-08 | Very long sessionIds | sessionId is 256 characters (max allowed) | Accepted. Session created. Token generation works. All flows proceed normally |
| EC-09 | sessionId exceeds 256 characters | sessionId is 257 characters | `_handleJoinRequest` returns early (validation check: `sessionId.length > 256`) |
| EC-10 | Concurrent session creation and destruction | Create session, immediately cancel it while a join_request is being processed | State machine prevents invalid transitions. Cancel takes effect. Join fails gracefully |
| EC-11 | Entry fee of zero | entryFee='0', 2 confirmed players | prizePool='0'. distributeWinnings returns no_prize. Players admitted but no payout needed |
| EC-12 | Special characters in memo | sessionId contains quotes, backslashes: `"sess'1\"\\` | Invoice memo constructed without injection. JSON.stringify handles escaping |
| EC-13 | RateLimiter with many unique nametags | 10000 unique nametags each making 1 request | Memory usage stays bounded. Each nametag has exactly 1 timestamp entry |
| EC-14 | AdmissionGate cleanup with 10000 tokens | Generate 10000 tokens, advance time, cleanup | All 10000 removed. No performance degradation observable (linear scan acceptable for this scale) |
| EC-15 | PayoutRetryQueue with sphere.resolve returning different address on retry | First attempt: resolve fails. Second attempt: resolve returns valid address | Address updated on item. Invoice created with new address |
| EC-16 | DM handler receives valid JSON that is not an object | DM content is `'"just a string"'` (valid JSON, but not object) | `msg.type` check fails gracefully (typeof undefined !== 'string'). Returns early |
| EC-17 | DM handler receives JSON array | DM content is `'[1,2,3]'` | `msg.type` is undefined on array. Returns early |
| EC-18 | Multiple sessions active simultaneously | Create 3 sessions, players join different sessions | Each session has independent escrow. Rate limiter applies per-nametag across all sessions. Admission tokens scoped to sessionId |

---

## Test Infrastructure Notes

### Mocking Strategy

1. **Sphere SDK Mock**: Create a mock factory that returns an object with:
   - `sphere.payments.receive()` - resolves immediately
   - `sphere.accounting.createInvoice()` - returns `{ invoiceId: 'mock-inv-xxx' }`
   - `sphere.accounting.payInvoice()` - resolves immediately
   - `sphere.accounting.closeInvoice()` - resolves immediately
   - `sphere.accounting.cancelInvoice()` - resolves immediately
   - `sphere.accounting.getInvoiceStatus()` - returns `{ state: 'COVERED' }`
   - `sphere.accounting.sendInvoiceReceipts()` - resolves immediately
   - `sphere.communications.sendDM()` - resolves immediately, captures args
   - `sphere.communications.onDirectMessage()` - returns unsubscribe function, stores handler
   - `sphere.resolve()` - returns `{ directAddress: 'mock-addr-xxx' }`
   - `sphere.getIdentity()` - returns `{ nametag: 'server', directAddress: 'server-addr' }`
   - `sphere.destroy()` - resolves immediately

2. **Time Mocking**: Use `jest.useFakeTimers()` or `sinon.useFakeTimers()` for:
   - Token expiry tests (5-min TTL)
   - Rate limiter window tests (5-min window)
   - Payment timeout tests (60s)
   - Retry queue backoff tests (30s-480s)

3. **Logger Mocking**: Mock winston to capture log output for security assertion tests (S3 mnemonic never logged).

4. **File System Mocking**: Mock `fs.readFileSync` for secret-loader file-based tests.

5. **Environment Variable Management**: Save and restore `process.env` between tests to prevent test pollution.

### Test File Organization

```
tests/
  unit/
    session-escrow.test.js        # SE-01 through SE-52
    admission-gate.test.js        # AG-01 through AG-16
    rate-limiter.test.js           # RL-01 through RL-11
    secret-loader.test.js          # SL-01 through SL-17
    payout-engine.test.js          # PE-01 through PE-22
    payout-retry-queue.test.js     # PQ-01 through PQ-20
    payment-manager.test.js        # PM-01 through PM-54
    sphere-game-bridge.test.js     # SB-01 through SB-34
  integration/
    join-flow.test.js              # IT-01, IT-04
    match-flow.test.js             # IT-02, IT-05, IT-06, IT-07
    cancellation-flow.test.js      # IT-03
    retry-flow.test.js             # IT-08
    timeout-flow.test.js           # IT-09
  security/
    admission-gate-attacks.test.js # ST-S1-*
    identity-binding.test.js       # ST-S2-*
    mnemonic-protection.test.js    # ST-S3-*
    idempotency-attacks.test.js    # ST-S4-*
    dedup-attacks.test.js          # ST-S5-*
    spectator-lockdown.test.js     # ST-S6-*
    channel-security.test.js       # ST-S7-*, ST-S9-*
    nametag-pinning.test.js        # ST-S8-*
    balance-retry.test.js          # ST-S10-*
    rate-limit-attacks.test.js     # ST-S11-*
    permission-scope.test.js       # ST-S12-*
  edge-cases/
    edge-cases.test.js             # EC-01 through EC-18
  helpers/
    sphere-mock.js                 # Shared Sphere SDK mock factory
    time-helpers.js                # Time advancement utilities
```

### Total Test Count

| Category | Count |
|----------|-------|
| SessionEscrow (SE-*) | 52 |
| AdmissionGate (AG-*) | 16 |
| RateLimiter (RL-*) | 11 |
| SecretLoader (SL-*) | 17 |
| PayoutEngine (PE-*) | 22 |
| PayoutRetryQueue (PQ-*) | 20 |
| PaymentManager (PM-*) | 54 |
| SphereGameBridge (SB-*) | 34 |
| Integration Tests (IT-*) | 9 |
| Security Tests (ST-*) | 22 |
| Edge Cases (EC-*) | 18 |
| **Total** | **275** |
