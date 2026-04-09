# UniQuake x Sphere Integration Architecture

## Overview

This document describes the architecture for integrating UniQuake with the Sphere wallet ecosystem, replacing the current `@unicitylabs/tx-flow-engine` + `@unicitylabs/shared` integration with `@unicitylabs/sphere-sdk`.

**Key principle:** UniQuake is a standalone, self-contained web application. It produces an **integrable artifact** — it does NOT modify the Sphere codebase. Sphere can embed UniQuake via any of its three integration approaches.

### Goals

1. UniQuake game client connects to the player's Sphere wallet for identity and payments
2. Collect a **10 UCT entry fee** via the **invoicing system** when active players join a game session
3. Spectators join free (no fee)
4. Distribute winnings via invoicing: human winner gets the pot; bot winner sends pot to session creator
5. Default sessions send unclaimed winnings to a configurable nametag (default: `babaika10`)
6. All player-server communication (except native Quake protocol) uses **Sphere SDK DM module** (NIP-17)
7. Refund entry fees via `cancelInvoice({ autoReturn: true })` if a match is cancelled
8. Fully remove the old `@unicitylabs/tx-flow-engine` and `@unicitylabs/shared` dependencies
9. Work with all three Sphere integration modes (iframe, popup, extension)
10. **Testnet** deployment initially

### Non-Goals (this phase)

- Modifying the Sphere app codebase (Sphere team handles their side)
- L1 (ALPHA blockchain) payment integration
- Multi-coin support (UCT only)
- Platform fee (no percentage taken from prize pool)
- Tournament bracket system

---

## Sphere Connect Integration Model

UniQuake uses the **Sphere Connect protocol** — a JSON-RPC-like message system for dApp-wallet communication. The SDK provides `autoConnect()` which auto-detects the best available transport.

### Three Integration Modes

```
Mode 1: IFRAME                    Mode 2: POPUP                   Mode 3: EXTENSION
(Sphere embeds UniQuake)          (UniQuake standalone)            (UniQuake standalone)

+---------------------------+     +---------------------------+    +---------------------------+
|  Sphere Web App           |     |  UniQuake (own tab)       |    |  UniQuake (own tab)       |
|  +---------------------+ |     |                           |    |                           |
|  | UniQuake iframe      | |     |  sphere-game-bridge.js    |    |  sphere-game-bridge.js    |
|  | sphere-game-bridge.js| |     |  ConnectClient            |    |  ConnectClient            |
|  | ConnectClient        | |     |                           |    |                           |
|  +----------+-----------+ |     +------------+--------------+    +------------+--------------+
|             |PostMessage  |                   |PostMessage                     |window.postMessage
|  +----------+-----------+ |     +------------+--------------+    +------------+--------------+
|  | ConnectHost          | |     | Sphere Wallet Popup       |    | Sphere Extension          |
|  | (wallet bridge)      | |     | ConnectHost               |    | Content Script -> BG      |
|  +---------------------+ |     | (420x720 window)          |    | ConnectHost (background)  |
+---------------------------+     +---------------------------+    +---------------------------+
```

**UniQuake's code is identical across all three modes.** The `autoConnect()` function detects the environment:

| Priority | Detection | Transport | How it works |
|----------|-----------|-----------|-------------|
| P1 | `window.parent !== window` | **iframe** | PostMessage to parent Sphere app |
| P2 | `window.sphere.isInstalled()` | **extension** | Chrome messaging API via content script |
| P3 | (fallback) | **popup** | Opens Sphere wallet as popup window, PostMessage |

### What UniQuake Delivers

UniQuake is the **ConnectClient** (dApp) side. It delivers:

1. **A game page** at `/quake?sphere=true` that loads the Sphere wallet bridge
2. **`sphere-game-bridge.js`** — uses `autoConnect()` to connect to the wallet regardless of mode
3. **Server-side payment management** — collects fees and distributes winnings via Node.js sphere-sdk invoicing

### What Sphere Provides (not our responsibility)

The Sphere team implements the **ConnectHost** (wallet) side. The integration contract is the Sphere Connect protocol documented in `sphere-sdk/docs/CONNECT.md`.

---

## System Architecture

```
+----------------------------------------------------------------------+
|  BROWSER                                                              |
|                                                                       |
|  UniQuake Game Page (/quake?sphere=true)                              |
|  +------------------------------------------------------------------+|
|  |  QuakeJS Engine (ioquake3.js, WebGL canvas, audio)               ||
|  |                                                                   ||
|  |  sphere-game-bridge.js                                           ||
|  |    +-- autoConnect({ dapp, walletUrl, permissions })             ||
|  |    |     P1: iframe -> PostMessage to parent                     ||
|  |    |     P2: extension -> Chrome messaging                       ||
|  |    |     P3: popup -> window.open(walletUrl/connect)             ||
|  |    +-- ConnectClient                                              ||
|  |         Queries: sphere_getIdentity, sphere_getAssets             ||
|  |         Intents: pay_invoice (entry fee), sign_message            ||
|  +------------------------------------------------------------------+|
|                              |                                        |
|     Quake protocol: WebSocket (ws://host:27950 or wss://host:27951)   |
|     Signaling/payments: Sphere DMs (NIP-17 via Nostr relays)          |
+----------------------------------------------------------------------+
                               |
+----------------------------------------------------------------------+
|  UNIQUAKE SERVER (Docker container)                                   |
|                                                                       |
|  +------------------+  +------------------+  +---------------------+ |
|  |  Master Server   |  |  Content Server  |  |  Web Server         | |
|  |  (WS :27950)     |  |  (HTTP :9000)    |  |  (HTTP :8080)       | |
|  |  (WSS :27951)    |  |  (HTTPS :9001)   |  |  (HTTPS :443)       | |
|  +--------+---------+  +------------------+  +---------------------+ |
|           |                                                           |
|  +--------+---------+  +------------------------------------------+ |
|  |  Game Session     |  |  Payment Manager (sphere-sdk Node.js)    | |
|  |  Manager          |  |                                          | |
|  |  - Spawns ioq3ded |  |  Sphere instance with:                   | |
|  |  - Tracks scores  |  |    - AccountingModule (invoices)          | |
|  |  - Manages state  |  |    - CommunicationsModule (DMs)           | |
|  +-------------------+  |    - PaymentsModule (balance/tokens)      | |
|                          |                                          | |
|                          |  SessionEscrow (per game):               | |
|                          |    - Creates entry fee invoice            | |
|                          |    - Tracks player payments               | |
|                          |    - Creates payout invoice on match end  | |
|                          |    - Cancels with auto-return on abort    | |
|                          +------------------------------------------+ |
+----------------------------------------------------------------------+
```

---

## Communication Architecture

### Two Communication Channels

UniQuake uses **two separate channels** for different purposes:

| Channel | Protocol | Used For |
|---------|----------|----------|
| **WebSocket** (27950/27951) | Native Quake + signaling | Real-time game data, WebRTC negotiation, server list, game joining |
| **Sphere DMs** (NIP-17 via Nostr) | Sphere CommunicationsModule | Payment coordination, invoice sharing, session join requests, match results |

### Why Two Channels?

- **WebSocket** is required for the real-time Quake game protocol and WebRTC signaling — this cannot move to Nostr (latency-sensitive, high-frequency updates)
- **Sphere DMs** are used for all payment-related and session management messaging — this provides cryptographic identity verification, encrypted communication, and integration with the Sphere wallet UI

### DM Message Types (Server <-> Client)

All DMs use the `sphere.communications.sendDM()` API with structured JSON content:

```javascript
// Client -> Server: Request to join a paid session
{ type: 'uniquake:join_request', sessionId: string, role: 'player' | 'spectator' }

// Server -> Client: Invoice for entry fee
{ type: 'uniquake:entry_invoice', sessionId: string, invoiceId: string }

// Client -> Server: Confirm payment was made
{ type: 'uniquake:payment_notification', sessionId: string, invoiceId: string }

// Server -> Client: Player admitted to session
{ type: 'uniquake:join_confirmed', sessionId: string }

// Server -> Client: Match result and payout
{ type: 'uniquake:match_result', sessionId: string, winner: string,
  isBot: boolean, prizePool: string, payoutInvoiceId: string | null }

// Server -> Client: Match cancelled, fees being returned
{ type: 'uniquake:match_cancelled', sessionId: string, reason: string }
```

---

## Payment Architecture: Invoice-Based

All fee collection and prize distribution uses the **AccountingModule** invoicing system. No direct `payments.send()` calls.

### Why Invoicing?

| Feature | Direct transfer | Invoicing |
|---------|----------------|-----------|
| Payment tracking | Manual | Automatic (status: OPEN -> PARTIAL -> COVERED -> CLOSED) |
| Partial payments | Not handled | Supported |
| Overpayment | Lost | Tracked and returnable |
| Refunds/cancellation | Manual send-back | `cancelInvoice({ autoReturn: true })` |
| Receipt confirmation | None | `sendInvoiceReceipts()` via DMs |
| On-chain audit trail | Transfer only | Invoice token + transfer references |
| Multiple payers | Manual tracking | Built-in multi-target support |

### Entry Fee Invoice Flow

```
Player                    Server (PaymentManager)           Aggregator
  |                              |                              |
  |  DM: join_request            |                              |
  |  (sessionId, role=player)    |                              |
  |  --------------------------> |                              |
  |                              |                              |
  |                              |  1. sphere.accounting         |
  |                              |     .createInvoice({          |
  |                              |       targets: [{             |
  |                              |         address: serverAddr,  |
  |                              |         assets: [{            |
  |                              |           coin: ['UCT',       |
  |                              |                  '10']        |--- mint invoice token -->
  |                              |         }]                    |<-- inclusion proof ------
  |                              |       }],                     |
  |                              |       memo: 'UniQuake entry   |
  |                              |              Session xxx'     |
  |                              |     })                        |
  |                              |                              |
  |  DM: entry_invoice           |                              |
  |  (invoiceId)                 |                              |
  |  <-------------------------- |                              |
  |                              |                              |
  |  2. Connect intent:          |                              |
  |     pay_invoice(invoiceId)   |                              |
  |     Wallet shows modal:      |                              |
  |     "Pay 10 UCT to join      |                              |
  |      UniQuake session?"      |                              |
  |     [Confirm] [Cancel]       |                              |
  |                              |                              |
  |  3. sphere.accounting        |                              |
  |     .payInvoice(id, {...})   |--- transfer commitment ----> |
  |                              |<-- inclusion proof ----------|
  |                              |                              |
  |  DM: payment_notification    |                              |
  |  --------------------------> |                              |
  |                              |  4. sphere.accounting         |
  |                              |     .getInvoiceStatus(id)     |
  |                              |     -> state: 'COVERED'      |
  |                              |                              |
  |  DM: join_confirmed          |                              |
  |  <-------------------------- |                              |
  |                              |                              |
  |  [Player joins game via WS]  |                              |
```

### Spectator Join Flow (No Fee)

```
Spectator                 Server
  |                         |
  |  DM: join_request       |
  |  (role=spectator)       |
  |  ---------------------> |
  |                         |  (no invoice created)
  |  DM: join_confirmed     |
  |  <--------------------- |
  |                         |
  |  [Spectator joins via WS, observe-only mode]
```

### Match End Payout Flow

```
Match ends
  |
  1. Server determines winner and payout recipient:
  |
  |   Human wins any session     -> payout to winner's nametag
  |   Bot wins custom session    -> payout to session creator's nametag
  |   Bot wins default session   -> payout to UNIQUAKE_DEFAULT_PAYOUT_NAMETAG
  |
  2. Close the entry fee invoice:
  |   sphere.accounting.closeInvoice(entryInvoiceId)
  |
  3. Calculate prize pool:
  |   prizePool = entryFee * numberOfPayingPlayers
  |   (spectators and bots don't contribute)
  |
  4. Create payout invoice (recipient creates it, server pays it):
  |   This is a "reverse invoice" — the winner creates an invoice
  |   and the server pays it. OR the server sends directly to the
  |   winner's nametag via a server-created invoice.
  |
  |   Implementation: Server creates an invoice on behalf of the
  |   winner, then immediately pays it from the server wallet:
  |
  |   const payoutInvoice = await sphere.accounting.createInvoice({
  |     targets: [{
  |       address: winnerDirectAddress,
  |       assets: [{ coin: ['UCT', prizePool] }],
  |     }],
  |     memo: 'UniQuake winnings - Session xxx',
  |   });
  |   // Server pays its own invoice to the winner's address
  |   await sphere.accounting.payInvoice(payoutInvoice.invoiceId, {
  |     targetIndex: 0, assetIndex: 0,
  |   });
  |   await sphere.accounting.closeInvoice(payoutInvoice.invoiceId);
  |
  5. Notify all players via DM:
  |   { type: 'uniquake:match_result', winner, prizePool, payoutInvoiceId }

### Match Cancellation Flow

```
Match cancelled (server crash, admin action, insufficient players)
  |
  1. Cancel the entry fee invoice with auto-return:
  |   await sphere.accounting.cancelInvoice(entryInvoiceId, { autoReturn: true })
  |
  2. SDK automatically returns all received payments to senders
  |
  3. Notify all players via DM:
  |   { type: 'uniquake:match_cancelled', reason: '...' }
```

### Payout Decision Matrix

| Winner | Session Type | Payout Recipient |
|--------|-------------|-----------------|
| Human player | Any | The winning player's nametag |
| Bot | Custom session | Session creator's nametag |
| Bot | Default session | `UNIQUAKE_DEFAULT_PAYOUT_NAMETAG` (default: `babaika10`) |
| No paying players | Any | No payout (prize pool = 0) |
| Transfer fails | Any | Funds retained in server wallet; logged for manual resolution |
| Match cancelled | Any | All fees auto-returned via `cancelInvoice({ autoReturn: true })` |

---

## Configuration

### Server Environment Variables

```bash
# Sphere SDK Configuration
UNIQUAKE_MNEMONIC="word1 word2 ... word12"   # Server wallet (REQUIRED, keep secret!)
UNIQUAKE_NETWORK=testnet                      # testnet initially
UNIQUAKE_DEFAULT_PAYOUT_NAMETAG=babaika10     # default session bot-win recipient
UNIQUAKE_ENTRY_FEE=10                         # UCT (human-readable)
UNIQUAKE_ENTRY_COIN=UCT                       # coin type
UNIQUAKE_WALLET_URL=https://sphere.unicity.network  # for popup mode

# Nostr relays for DM communication
UNIQUAKE_NOSTR_RELAYS=wss://nostr-relay.testnet.unicity.network
```

---

## Code Changes Summary

### Files to REMOVE (old integration)

| File | Reason |
|------|--------|
| `lib/token-service.js` | Replaced by PaymentManager (sphere-sdk invoicing) |
| `lib/client/uniquake-token-service.js` | Replaced by sphere-game-bridge.js |
| `lib/client/game-integration.js` | Functionality moves to PaymentManager |

### Dependencies to REMOVE

```json
"@unicitylabs/shared": "^1.2.15",
"@unicitylabs/tx-flow-engine": "^1.3.9",
```

### Dependencies to ADD

```json
"@unicitylabs/sphere-sdk": "^0.6.14",
"ws": "^8.0.0"
```

### Files to CREATE (server-side)

| File | Purpose |
|------|---------|
| `lib/payment-manager.js` | Sphere SDK init, AccountingModule + CommunicationsModule, session management |
| `lib/session-escrow.js` | Per-session invoice tracking, player registry, prize pool |
| `lib/payout-engine.js` | Winner determination, payout invoice creation and payment |

### Files to CREATE (client-side)

| File | Purpose |
|------|---------|
| `lib/client/sphere-game-bridge.js` | `autoConnect()` + ConnectClient wallet API |

### Files to MODIFY

| File | Change |
|------|--------|
| `lib/signaling-service.js` | Remove old token handling, add PaymentManager hooks |
| `lib/game-server-manager.js` | Remove old token monitoring, session lifecycle via PaymentManager |
| `lib/server-registry.js` | Remove game state token monitoring |
| `lib/master-server.js` | Initialize PaymentManager with Sphere SDK |
| `bin/combined-master.js` | Pass Sphere config |
| `mock-server.js` | Serve sphere-game-bridge.js, pass walletUrl |
| `bin/index.ejs` | Load bridge when `?sphere=true` |
| `docker/entrypoint.sh` | Add UNIQUAKE_MNEMONIC, UNIQUAKE_NETWORK env vars |
| `start-quake.sh` | Add --mnemonic, --network, --wallet-url CLI args |
| `.env.example` | Add Sphere SDK configuration section |
| `package.json` | Update dependencies |

### Files NOT modified (Sphere app)

UniQuake does NOT modify any Sphere files. Integration contract = Sphere Connect protocol.

---

## Security Architecture

This section addresses all findings from adversarial review of the payment flow and communication model.

### S1. Admission Gate (prevents free-ride attack)

**Threat:** Payment and game protocol are on separate channels. Without enforcement, a player can connect directly to the Quake game server via WebSocket without paying.

**Mitigation:** The server maintains a `confirmedPlayers` set per session. The signaling service MUST verify every incoming game connection against this set before relaying to the game server.

**Mechanism: Admission Token**

1. When payment is confirmed, `PaymentManager` generates a cryptographically random **admission token** (32 bytes, hex-encoded) and includes it in the `join_confirmed` DM.
2. The client must present this token in the WebSocket connection URL: `ws://host:27950?session=xxx&token=yyy`.
3. The signaling service validates the token against the `confirmedPlayers` set before admitting the connection.
4. Tokens are single-use, per-session, and expire after 5 minutes.
5. Spectators receive admission tokens too (marked as spectator-only).

```
join_confirmed DM → { sessionId, role, admissionToken: 'a3f9b2c1...' }
WS connect     → ws://host:27950?session=xxx&admissionToken=a3f9b2c1...
Signaling gate → validate token → admit or reject
```

### S2. Identity Binding (prevents nametag spoofing)

**Threat:** The WebSocket channel has no cryptographic identity verification. Anyone can claim any nametag.

**Mitigation:** The admission token (S1) binds the DM identity to the WebSocket connection. The DM channel provides NIP-17 cryptographic sender authentication. The admission token is delivered via this authenticated channel and presented on the unauthenticated WebSocket. This creates a cryptographic chain:

```
Sphere wallet (secp256k1 key) → NIP-17 DM (authenticated sender)
  → admission token (random secret)
    → WebSocket connection (bearer token)
```

The server never trusts a self-asserted nametag on WebSocket. The nametag is looked up from the admission token's associated player record.

### S3. Server Wallet Mnemonic Protection

**Threat:** `UNIQUAKE_MNEMONIC` in env var is visible via `/proc/1/environ`, `docker inspect`, and logs.

**Mitigations:**
1. **Prefer Docker secrets:** Read mnemonic from `/run/secrets/uniquake_mnemonic` file (mounted via Docker secrets or bind mount). Support `UNIQUAKE_MNEMONIC_FILE` env var pointing to the file path.
2. **Clear env var after reading:** `delete process.env.UNIQUAKE_MNEMONIC` in PaymentManager constructor.
3. **Sanitized logging:** Never log the config object containing the mnemonic. Use a sanitized copy.
4. **Container security:** Run Node.js processes as non-root user inside the container.

```javascript
// PaymentManager.init()
const mnemonic = process.env.UNIQUAKE_MNEMONIC_FILE
  ? fs.readFileSync(process.env.UNIQUAKE_MNEMONIC_FILE, 'utf8').trim()
  : process.env.UNIQUAKE_MNEMONIC;
delete process.env.UNIQUAKE_MNEMONIC;  // clear immediately
```

### S4. Payout Idempotency (prevents double-payout)

**Threat:** Match-end event fires twice (timelimit + fraglimit in same frame). `distributeWinnings()` called twice, paying out the prize pool twice.

**Mitigation:** Synchronous state guard before any async operation:

```javascript
async distributeWinnings(sessionId, matchResult) {
  const escrow = this.sessions.get(sessionId);
  if (!escrow) return { status: 'error', reason: 'Session not found' };
  if (escrow.state !== 'playing' && escrow.state !== 'open') {
    return { status: 'already_processed' };
  }
  escrow.state = 'paying_out';  // SYNCHRONOUS — before any await
  // ... payout logic ...
}
```

Since Node.js is single-threaded, the synchronous state assignment prevents concurrent executions from passing the guard.

### S5. Join Deduplication (prevents double-invoice)

**Threat:** Player sends `join_request` twice. Server creates two invoices, orphaning the first.

**Mitigation:** Check `escrow.players` before creating an invoice:

```javascript
const existing = escrow.players.get(senderNametag);
if (existing?.paymentStatus === 'confirmed') {
  // Already paid — resend join_confirmed with admission token
  return;
}
if (existing?.invoiceId) {
  // Invoice already issued — resend the same invoiceId
  return;
}
```

### S6. Spectator Lockdown (prevents spectator-to-player escalation)

**Threat:** Spectator joins free, then switches to a playing team mid-game via Quake console commands.

**Mitigations:**
1. **Admission token encodes role.** The signaling service tracks `role: 'spectator' | 'player'` per connection.
2. **Quake server configuration:** Set `g_forceSpectator` or use server-side mod to prevent team switching for spectator-flagged clients.
3. **Winner filter:** `determineWinner()` MUST exclude players whose `paymentStatus !== 'confirmed'` from the winner pool. Only paying active players are eligible for winnings.

```javascript
function determineWinner(escrow, scores) {
  const paidPlayers = new Set(
    [...escrow.players.entries()]
      .filter(([_, p]) => p.paymentStatus === 'confirmed')
      .map(([nametag]) => nametag)
  );
  const eligible = scores.filter(s => paidPlayers.has(s.name) || s.isBot);
  // ... sort and pick winner from eligible only ...
}
```

### S7. Enforce WSS in Production (prevents invoice ID interception)

**Threat:** Invoice IDs sent over plaintext `ws://` can be intercepted.

**Mitigations:**
1. **Production: WSS only.** The Docker/HAProxy setup already provides TLS on port 27951. In production, disable plaintext port 27950 or redirect to WSS.
2. **Invoice IDs via DM only.** Send invoice IDs exclusively via encrypted Sphere DMs, not over WebSocket. The WebSocket carries only the admission token (which is single-use and time-limited).

### S8. Server Nametag Pinning (prevents impersonation)

**Threat:** Attacker registers a similar nametag and sends fake invoice DMs.

**Mitigations:**
1. **Client-side pinning:** The game page includes the server's expected nametag in its configuration (served via HTTPS). The sphere-game-bridge.js only processes DMs from this pinned nametag.
2. **Client initiates conversation:** The player sends `join_request` to the pinned server nametag. Only replies from that same nametag are processed. Unsolicited `entry_invoice` DMs from other nametags are rejected.
3. **Server nametag verified at startup:** PaymentManager validates nametag resolution during `init()` — fail-fast if the configured nametag cannot be resolved.

### S9. PostMessage Origin Enforcement

**Threat:** Malicious page embeds UniQuake iframe and intercepts wallet communication via `targetOrigin: '*'`.

**Mitigation:** The `sphere-game-bridge.js` MUST configure `autoConnect()` with a specific `walletUrl` and enforce origin validation:

```javascript
autoConnect({
  dapp: { name: 'UniQuake', url: window.location.origin },
  walletUrl: config.SPHERE_ORIGIN,  // e.g., 'https://sphere.unicity.network'
  // PostMessageTransport.forClient() uses targetOrigin from walletUrl
});
```

In iframe mode, the SDK's `PostMessageTransport.forClient()` defaults `targetOrigin` to `'*'`. UniQuake MUST override this with the expected parent origin. If the parent origin is unknown (generic embedding), the game should use popup or extension mode instead.

### S10. Server Wallet Balance & Retry

**Threat:** `payInvoice()` fails because entry fee transfers haven't been pulled yet.

**Mitigations:**
1. **Pull before payout:** Call `sphere.payments.receive()` immediately before attempting payout.
2. **Retry queue:** If payout fails, add to a persistent retry queue with exponential backoff (30s, 60s, 120s, max 5 retries).
3. **Periodic receive:** Run `sphere.payments.receive()` every 30 seconds in the PaymentManager to catch delayed transfers.
4. **Startup validation:** On server start, validate the default payout nametag resolves. Fail-fast if `babaika10` cannot be resolved.

### S11. Cancellation Rate Limiting

**Threat:** Repeated join/cancel cycles consume server resources and on-chain transaction fees.

**Mitigations:**
1. **Rate limit per nametag:** Max 3 join requests per 5 minutes per nametag.
2. **Delayed server spawn:** Don't spawn the game server process until minimum players (2 humans) are confirmed and paid.
3. **Lobby phase:** Collect fees in a lobby state. Spawn game server only when all confirmed. Cancel with auto-return if lobby times out (2 minutes).

### S12. Minimum Permission Scope

**Threat:** Broad permissions (`payments`, `invoices`) could be exploited by future wallet auto-approve features.

**Mitigation:** Request only `['identity', 'balance', 'invoices']` — remove `payments`. The design uses only `pay_invoice` intents, not direct payment intents. Each `pay_invoice` requires user confirmation regardless.

### Security Summary

| Threat | Mitigation | Priority |
|--------|-----------|----------|
| Free-ride (play without paying) | Admission token gate (S1) | **Must-have** |
| Nametag spoofing on WS | Admission token identity binding (S2) | **Must-have** |
| Mnemonic exposure | File-based secrets + env cleanup (S3) | **Must-have** |
| Double payout | Synchronous state guard (S4) | **Must-have** |
| Double join / orphaned invoice | Deduplication check (S5) | **Must-have** |
| Spectator escalation | Role-locked admission + winner filter (S6) | **Must-have** |
| Invoice ID interception | WSS-only + DM-only invoices (S7) | High |
| Server impersonation | Client-side nametag pinning (S8) | High |
| PostMessage origin attack | Enforce specific origin (S9) | High |
| Insufficient balance for payout | Receive-before-pay + retry queue (S10) | High |
| Cancellation DoS | Rate limiting + lobby phase (S11) | Medium |
| Permission scope creep | Minimal permissions (S12) | Medium |

---

## Migration Plan

### Phase 1: Server-Side (Payment Manager + DM Communication)
1. Create PaymentManager with AccountingModule + CommunicationsModule
2. Create SessionEscrow (invoice-based fee tracking)
3. Create PayoutEngine (invoice-based winnings distribution)
4. Wire into MasterServer/SignalingService
5. Remove old token-service.js and dependencies

### Phase 2: Client-Side (Wallet Bridge)
1. Create sphere-game-bridge.js with autoConnect()
2. Modify game page to load bridge when ?sphere=true
3. Add DM-based join flow with invoice payment
4. Test all three connect modes

### Phase 3: Integration Testing
1. Full flow: join -> pay invoice -> play -> win -> payout invoice
2. Cancellation flow: join -> pay -> cancel -> auto-return
3. Spectator flow: join free -> watch
4. Bot-win flows: default session and custom session

### Phase 4: Production (Testnet)
1. Docker image rebuild with sphere-sdk
2. Server mnemonic and nametag setup
3. Testnet deployment
