# UniQuake Sphere SDK Integration — Implementation Plan

## Summary

**Total unique tasks:** 30
**Execution waves:** 6 waves with maximum parallelism
**Three streams:** Server (S), Client (C), Infrastructure/Security (I)
**Key principle:** All 12 security mitigations (S1-S12 from architecture doc) are embedded in the task plan with explicit cross-references.

---

## Wave 1: Foundation (All Parallel — No Dependencies)

All tasks can execute simultaneously. Estimated: 10 parallel tasks.

| ID | Title | Files | Complexity |
|----|-------|-------|------------|
| **T01** | Update package.json (add sphere-sdk, remove old deps) | `package.json` | Small |
| **T02** | Create SessionEscrow class | `lib/session-escrow.js` (NEW) | Medium |
| **T03** | Create secret-loader utility | `lib/secret-loader.js` (NEW) | Small |
| **T04** | Create admission-gate module | `lib/admission-gate.js` (NEW) | Medium |
| **T05** | Create rate-limiter module | `lib/rate-limiter.js` (NEW) | Small |
| **T06** | Refactor server-registry.js (remove token monitoring) | `lib/server-registry.js` | Small |
| **T07** | Update .env.example (Sphere config section) | `.env.example` | Small |
| **T08** | Create sphere-game-bridge.js | `lib/client/sphere-game-bridge.js` (NEW) | Large |
| **T09** | Modify index.ejs template (conditional bridge loading) | `bin/index.ejs` | Small |
| **T10** | Update Docker entrypoint (Sphere env vars + mnemonic file) | `docker/entrypoint.sh` | Small |

### Task Details

**T01: Update package.json**
- Remove `"@unicitylabs/shared": "^1.2.15"` and `"@unicitylabs/tx-flow-engine": "^1.3.9"`
- Add `"@unicitylabs/sphere-sdk": "^0.6.14"`
- Keep `"ws": "~7.2.0"` (fresh_quakejs compatibility)
- Run `npm install`

**T02: Create SessionEscrow** (`lib/session-escrow.js`)
- Constructor: `(sessionId, { creatorNametag, isDefaultSession, entryFee, entryCoin })`
- Players Map: `nametag → { nametag, isBot, isSpectator, invoiceId, paymentStatus, admissionToken }`
- `paymentStatus` states: `pending | confirmed | refunded | exempt`
- Session `state` machine: `open → playing → paying_out → paid_out | cancelled | failed`
- `transitionState(from, to)` with validation (S4 idempotency)
- `addPlayer()` with deduplication check (S5) returning `{ status: 'new' | 'invoice_pending' | 'already_confirmed' }`
- `confirmPayment()`, `get prizePool()`, `get paidPlayerCount()`
- `getPayoutRecipient(winnerNametag, isWinnerBot, defaultPayoutNametag)` — payout decision matrix
- `setAdmissionToken()`, `validateAdmissionToken()` with 5-min TTL (S1)

**T03: Create secret-loader** (`lib/secret-loader.js`)
- `loadMnemonic()`: reads from `UNIQUAKE_MNEMONIC_FILE` (preferred) or `UNIQUAKE_MNEMONIC` env
- Immediately `delete process.env.UNIQUAKE_MNEMONIC` after reading (S3)
- Validates 12 or 24 word format
- `sanitizeConfig(obj)`: replaces mnemonic fields with `'[REDACTED]'` for safe logging

**T04: Create admission-gate** (`lib/admission-gate.js`)
- `generateAdmissionToken(sessionId, nametag, role)`: 32-byte crypto random hex (S1)
- `validateAdmissionToken(token, sessionId)`: checks existence, sessionId match, not used, not expired (5-min TTL). Returns `{ nametag, role }` or null (S2 identity binding)
- Marks token as `used` on validation (single-use)
- Periodic cleanup of expired tokens (every 60s)

**T05: Create rate-limiter** (`lib/rate-limiter.js`)
- Sliding-window rate limiter: key=nametag, window=5min, max=3 requests (S11)
- `check(nametag)` → `{ allowed, retryAfterMs }`

**T06: Refactor server-registry.js**
- Remove `lastGameStateToken` field from server records
- Remove `updateGameStateToken()` method
- Remove `getInactiveGameStateServers()` method
- Keep all other functionality (registration, heartbeat, pruning)

**T07: Update .env.example**
- Add `UNIQUAKE_MNEMONIC`, `UNIQUAKE_MNEMONIC_FILE`, `UNIQUAKE_NETWORK`, `UNIQUAKE_DEFAULT_PAYOUT_NAMETAG`, `UNIQUAKE_ENTRY_FEE`, `UNIQUAKE_ENTRY_COIN`, `UNIQUAKE_WALLET_URL`, `UNIQUAKE_NOSTR_RELAYS`, `UNIQUAKE_SERVER_NAMETAG`
- All commented out with documentation

**T08: Create sphere-game-bridge.js** (`lib/client/sphere-game-bridge.js`)
- `autoConnect()` with `walletUrl` and minimal permissions `['identity', 'balance', 'invoices']` (S12)
- PostMessage origin enforcement via `walletUrl` (S9)
- Server nametag pinning: stores pinned nametag, rejects DMs from unknown senders (S8)
- Queries: `getIdentity()`, `getBalance()`, `resolve()`
- Intents: `payInvoice(invoiceId)`, `signMessage(message)`
- Admission token storage: `getAdmissionToken()`
- Auto-init when `?sphere=true` in URL
- Fallback: if autoConnect fails, set `connected=false`, game plays without payments
- Exposed as `window.SPHERE_WALLET`

**T09: Modify index.ejs**
- Conditional `<script>` tag for sphere-game-bridge.js when `sphere` template var is true
- Inject `window.UNIQUAKE_CONFIG = { walletUrl, serverNametag, sphereOrigin, sphereMode: true }`
- Do NOT load old token service scripts

**T10: Update Docker entrypoint**
- Detect mnemonic from `UNIQUAKE_MNEMONIC_FILE` or `UNIQUAKE_MNEMONIC`, log source (not value)
- Export all Sphere env vars with defaults
- Log Sphere config (network, fee, coin) at startup
- Warn if no mnemonic configured

---

## Wave 2: Core Modules (Depends on Wave 1)

| ID | Title | Files | Depends On | Complexity |
|----|-------|-------|-----------|------------|
| **T11** | Create PayoutEngine | `lib/payout-engine.js` (NEW) | T01 | Large |
| **T12** | Create payout-retry-queue | `lib/payout-retry-queue.js` (NEW) | T01 | Medium |
| **T13** | Update start-quake.sh (CLI args) | `start-quake.sh` | T07 | Medium |
| **T14** | Update Dockerfile (sphere-sdk compat) | `docker/Dockerfile` | T01 | Small |
| **T15** | Join session flow in client.html | `client.html` | T08 | Large |
| **T16** | Mock server Sphere mode | `mock-server.js` | T07 | Medium |

### Task Details

**T11: Create PayoutEngine** (`lib/payout-engine.js`)
- `processPayout(escrow, matchResult)`: resolve winner nametag → create payout invoice → pay it → close it → send receipts
- `determineWinner(escrow, scores)`: filters to only `paymentStatus === 'confirmed'` players + bots (S6 spectator lockdown)
- Calls `sphere.payments.receive()` before payout attempt (S10)
- Delegates to retry queue on failure (T12)

**T12: Create payout-retry-queue** (`lib/payout-retry-queue.js`)
- In-memory retry queue with exponential backoff (30s, 60s, 120s, 240s, 480s)
- Max 5 retries per payout
- Periodic timer (every 15s) processes due items
- Calls `sphere.payments.receive()` before each retry
- On final failure: logs full context for manual resolution

**T15: Join session flow in client.html**
- Add payment gate in `connectQuakeToServer()`: if `SPHERE_WALLET.connected`, send `join_session` via WS before connecting Quake iframe
- "Spectator" button alongside "Play" on server cards
- Display UCT balance in header
- Read-only nametag from wallet (replace editable player name input)
- Backwards compatibility: if wallet not connected, existing flow works

**T16: Mock server Sphere mode**
- In `/quake` route: detect `?sphere=true`, pass `sphere`, `walletUrl`, `serverNametag` to EJS template
- Serve `sphere-game-bridge.js` via `/lib/client/` static route
- Serve sphere-sdk browser bundle from `node_modules`
- In `/`, `/client` routes: inject `window.UNIQUAKE_CONFIG` when `?sphere=true`

---

## Wave 3: Integration Layer (Depends on Wave 2)

| ID | Title | Files | Depends On | Complexity |
|----|-------|-------|-----------|------------|
| **T17** | Create PaymentManager | `lib/payment-manager.js` (NEW) | T01,T02,T03,T04,T05,T11,T12 | Large |
| **T18** | WS message handlers for payment flow | `client.html` | T08,T15 | Medium |
| **T19** | Admission token handling (client) | `client.html`, `bin/index.ejs` | T09,T18 | Medium |
| **T20** | Server nametag pinning (client) | `sphere-game-bridge.js`, `client.html` | T08 | Small |

### Task Details

**T17: Create PaymentManager** (`lib/payment-manager.js`) — Central orchestrator
- `init()`: load mnemonic (T03), init Sphere SDK with accounting + communications, resolve default payout nametag (fail-fast), start periodic `receive()` every 30s, set up DM listener
- `handleIncomingDM()`: route `uniquake:*` messages to handlers
- `handleJoinRequest()`: rate limit check (T05, S11), deduplication check (S5), spectators get free admission token, players get invoice
- `handlePaymentNotification()`: verify invoice status, generate admission token (T04, S1), send `join_confirmed` DM with token
- `createSession()`: create SessionEscrow
- `distributeWinnings()`: synchronous state guard (S4, `paying_out` before any await), close entry invoice, delegate to PayoutEngine (T11)
- `cancelSession()`: cancel all invoices with `autoReturn: true`, send `match_cancelled` DMs
- `validateAdmissionToken()`: delegate to AdmissionGate (T04)
- `destroy()`: clear intervals, call `sphere.destroy()`
- All DMs: invoice IDs sent via DM only, never via WS (S7)

---

## Wave 4: Wiring (Depends on Wave 3)

| ID | Title | Files | Depends On | Complexity |
|----|-------|-------|-----------|------------|
| **T21** | Refactor signaling-service.js | `lib/signaling-service.js` | T04,T06,T17 | Large |
| **T22** | Refactor game-server-manager.js | `lib/game-server-manager.js` | T06 | Small |

### Task Details

**T21: Refactor signaling-service.js** — Heaviest change
- **Remove:** `startTokenMonitoring()`, `stopTokenMonitoring()`, `checkInactiveGameServers()`, `terminateInactiveServer()`, `handleGameStateToken()`, `handleUnicityTokenTransaction()`, token-related message cases
- **Add:** `setPaymentManager(pm)` method
- **Add admission gate (S1):** Extract `session` and `admissionToken` from WS connection URL query params. Call `paymentManager.validateAdmissionToken()`. Reject if invalid. Set client nametag from token (S2 — never trust self-asserted nametag).
- **Add session hooks:** On `startGameServer` → `paymentManager.createSession()`. On `stopGameServer` → `paymentManager.cancelSession()`. On game over → `paymentManager.distributeWinnings()`.
- **Role tracking:** Store `role` from admission token on client record. Spectators get restricted access.

**T22: Refactor game-server-manager.js**
- Remove `updateServerActivity()` method (was for token-based activity tracking)
- Remove any token-service references
- Keep process spawning intact

---

## Wave 5: Assembly + Cleanup (Depends on Wave 4)

| ID | Title | Files | Depends On | Complexity |
|----|-------|-------|-----------|------------|
| **T23** | Refactor master-server.js | `lib/master-server.js` | T17,T21 | Medium |
| **T24** | Update combined-master.js | `bin/combined-master.js` | T23 | Small |
| **T25** | Delete old server token-service | `lib/token-service.js` (DELETE) | T21,T22 | Medium |
| **T26** | Delete old client token files | `lib/client/uniquake-token-service.js` (DELETE), `lib/client/game-integration.js` (DELETE) | T08,T15,T18 | Large |

### Task Details

**T23: Refactor master-server.js**
- Import PaymentManager, instantiate with config from env vars
- Call `paymentManager.init()` in `start()` (fail-fast if mnemonic missing but log warning)
- Call `signalingService.setPaymentManager(paymentManager)`
- Call `paymentManager.destroy()` in `stop()`

**T24: Update combined-master.js**
- Add Sphere CLI args (`--mnemonic`, `--network`, `--wallet-url`, etc.)
- Pass through to MasterServer config
- Log Sphere integration status at startup
- Production TLS warning (S7)

**T25: Delete old server token-service**
- Delete `lib/token-service.js`
- Remove all `require('./token-service')` from `bin/server-cli.js`, `lib/mock-game-client.js`, `lib/mock-server-client.js`
- Remove token-related code paths in consumers

**T26: Delete old client token files**
- Delete `lib/client/uniquake-token-service.js` and `lib/client/game-integration.js`
- Remove `<script>` tags from `client.html` and `server.html`
- Remove all `tokenService` references from `client.html` (~30 locations)
- Remove token-related UI elements (token panel, token counts)
- Remove token-related event handling

---

## Wave 6: Polish (Depends on Wave 5)

| ID | Title | Files | Depends On | Complexity |
|----|-------|-------|-----------|------------|
| **T27** | UI updates for Sphere paradigm | `client.html`, `server.html` | T26 | Medium |
| **T28** | Backwards compatibility | `client.html`, `sphere-game-bridge.js` | T08,T15 | Small |
| **T29** | Sphere health check in start-quake.sh | `start-quake.sh` | T17,T24 | Small |
| **T30** | Update CLAUDE.md documentation | `CLAUDE.md` | All | Medium |

### Task Details

**T27: UI updates**
- Sphere wallet status indicator (connected/disconnected, nametag, UCT balance)
- "Connect Wallet" button for manual init
- Read-only nametag when connected
- Server management page: show payment manager status, active sessions, fee collection

**T28: Backwards compatibility**
- Gate all Sphere behavior behind `window.SPHERE_WALLET?.connected`
- Legacy mode (no `?sphere=true`): existing flow works unchanged
- If `autoConnect()` fails: graceful fallback, game playable without payments

**T29: Sphere health check**
- Add to `app_health_check()`: verify Sphere wallet is initialized (query master server status)
- Report network, nametag, balance status

**T30: Update CLAUDE.md**
- Add PaymentManager, SessionEscrow, PayoutEngine to Architecture Overview
- Add sphere-game-bridge.js to client components
- Update dependency notes
- Add Sphere env vars to Configuration section
- Add S1-S12 security summary

---

## Security Mitigations Cross-Reference

| Mitigation | Task(s) |
|-----------|---------|
| S1: Admission token gate | T04 (module), T17 (generation), T21 (validation), T19 (client) |
| S2: Identity binding | T04 (token→nametag), T21 (WS gate uses token nametag) |
| S3: Mnemonic protection | T03 (secret-loader), T10 (Docker entrypoint), T14 (Dockerfile) |
| S4: Payout idempotency | T02 (state machine), T17 (state guard in distributeWinnings) |
| S5: Join deduplication | T02 (addPlayer check), T17 (handleJoinRequest) |
| S6: Spectator lockdown | T04 (role in token), T11 (winner filter), T21 (role tracking) |
| S7: WSS-only + DM-only invoices | T17 (DM-only invoices), T24 (TLS warning) |
| S8: Server nametag pinning | T08 (client pinning), T16 (config injection), T17 (server validation) |
| S9: PostMessage origin | T08 (autoConnect walletUrl), T16 (sphereOrigin config) |
| S10: Balance + retry | T11 (receive-before-pay), T12 (retry queue), T17 (periodic receive) |
| S11: Rate limiting | T05 (rate-limiter), T17 (join handler) |
| S12: Minimal permissions | T08 (identity, balance, invoices only) |

---

## Files Summary

### Created (10 new files)
| File | Task | Purpose |
|------|------|---------|
| `lib/payment-manager.js` | T17 | Central Sphere SDK orchestrator |
| `lib/session-escrow.js` | T02 | Per-session payment state |
| `lib/payout-engine.js` | T11 | Winner determination + prize distribution |
| `lib/payout-retry-queue.js` | T12 | Exponential backoff retry for failed payouts |
| `lib/secret-loader.js` | T03 | Mnemonic file/env reading with cleanup |
| `lib/admission-gate.js` | T04 | Admission token generation/validation |
| `lib/rate-limiter.js` | T05 | Per-nametag join rate limiting |
| `lib/client/sphere-game-bridge.js` | T08 | Browser-side wallet bridge |

### Deleted (3 files)
| File | Task | Reason |
|------|------|--------|
| `lib/token-service.js` | T25 | Replaced by PaymentManager |
| `lib/client/uniquake-token-service.js` | T26 | Replaced by sphere-game-bridge.js |
| `lib/client/game-integration.js` | T26 | Functionality in PaymentManager |

### Modified (14 files)
| File | Tasks |
|------|-------|
| `package.json` | T01 |
| `lib/signaling-service.js` | T21 |
| `lib/game-server-manager.js` | T22 |
| `lib/server-registry.js` | T06 |
| `lib/master-server.js` | T23 |
| `bin/combined-master.js` | T24 |
| `client.html` | T15,T18,T19,T26,T27 |
| `server.html` | T26,T27 |
| `bin/index.ejs` | T09,T19 |
| `mock-server.js` | T16 |
| `docker/entrypoint.sh` | T10 |
| `start-quake.sh` | T13,T29 |
| `.env.example` | T07 |
| `docker/Dockerfile` | T14 |
| `CLAUDE.md` | T30 |

---

## Parallel Execution Capacity

| Wave | Tasks | Max Parallel | Bottleneck |
|------|-------|-------------|------------|
| 1 | T01-T10 | 10 | T08 (sphere-game-bridge, Large) |
| 2 | T11-T16 | 6 | T11 (PayoutEngine, Large), T15 (client join flow, Large) |
| 3 | T17-T20 | 4 | T17 (PaymentManager, Large) |
| 4 | T21-T22 | 2 | T21 (SignalingService refactor, Large) |
| 5 | T23-T26 | 4 | T26 (remove old client code, Large) |
| 6 | T27-T30 | 4 | None |
