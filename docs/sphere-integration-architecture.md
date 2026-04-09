# UniQuake x Sphere Integration Architecture

## Overview

This document describes the architecture for integrating UniQuake into the Sphere wallet ecosystem, replacing the current `@unicitylabs/tx-flow-engine` + `@unicitylabs/shared` integration with `@unicitylabs/sphere-sdk`.

### Goals

1. Embed the QuakeJS game client inside Sphere's web UI
2. Give the game client access to the player's Sphere wallet (identity, nametag, tokens)
3. Collect a 10 UCT entry fee when players join a game session
4. Distribute winnings: human winner gets the pot; bot winner sends pot to session creator
5. Default sessions send unclaimed winnings to a configurable nametag (default: `babaika10`)
6. Fully remove the old `@unicitylabs/tx-flow-engine` and `@unicitylabs/shared` dependencies

### Non-Goals (this phase)

- L1 (ALPHA blockchain) payment integration
- Multi-coin support (UCT only)
- Tournament bracket system
- Spectator mode payments

---

## System Architecture

```
+----------------------------------------------------------------------+
|  SPHERE WEB APP (React 19 SPA)                                       |
|                                                                       |
|  +------------------+   +------------------------------------------+ |
|  |   WalletPanel    |   |  UniQuake Game Page                      | |
|  |   (L3 wallet)    |   |                                          | |
|  |                  |   |  +-------------------------------------+ | |
|  |  Identity        |   |  |  QuakeJS iframe                     | | |
|  |  Nametag         |   |  |  (uniquake-dev.dyndns.org/quake)    | | |
|  |  Balance (UCT)   |   |  |                                     | | |
|  |  Send/Receive    |   |  |  Uses Sphere Connect (PostMessage)  | | |
|  |                  |   |  |  to access wallet from iframe        | | |
|  +--------+---------+   |  +------------------+------------------+ | |
|           |              |                     |                     | |
|           |              +------------------------------------------+ |
|           |                                    |                      |
|    ConnectHost                          ConnectClient                  |
|    (wallet side)                        (game side)                   |
|           |                                    |                      |
|           +------------- PostMessage ----------+                      |
+----------------------------------------------------------------------+
                                    |
                        WebSocket (ws://host:27950)
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
|  +--------+---------+                                                 |
|  |  Game Session     |                                                |
|  |  Manager          |                                                |
|  |                   |  +------------------------------------------+ |
|  |  - Spawns ioq3ded |  |  Payment Manager (NEW - sphere-sdk)      | |
|  |  - Tracks scores  |  |                                          | |
|  |  - Manages state  |  |  - Sphere Node.js instance per session   | |
|  |                   |  |  - Collects entry fees (invoices)         | |
|  +-------------------+  |  - Distributes winnings on match end     | |
|                          |  - Nametag resolution for payouts        | |
|                          +------------------------------------------+ |
+----------------------------------------------------------------------+
```

---

## Component Design

### 1. Sphere App Integration (Client-Side)

#### 1.1 New Page: `QuakeGamePage.tsx`

A new React component in Sphere that embeds the QuakeJS game.

**Location:** `sphere/src/components/agents/QuakeGamePage.tsx`

**Integration method:** iframe + Sphere Connect protocol

**Rationale:** QuakeJS is a complex WebGL/Emscripten application that manages its own canvas, audio, and input. Embedding it as a React component would require significant refactoring of the QuakeJS codebase. An iframe provides clean isolation while Sphere Connect enables secure wallet communication.

```
QuakeGamePage
  |
  +-- Game iframe (src="{UNIQUAKE_URL}/quake?sphere=true")
  |     |
  |     +-- QuakeJS engine (ioquake3.js)
  |     +-- ConnectClient (PostMessage bridge to parent)
  |     +-- sphere-game-bridge.js (NEW: wallet ↔ game glue)
  |
  +-- ConnectHost (bridges iframe requests to wallet)
  +-- Game status bar (nametag, balance, session info)
  +-- Entry fee confirmation modal
```

#### 1.2 Sphere Connect Bridge

The iframe communicates with the parent Sphere app via the **Connect protocol** (PostMessage transport).

**Wallet side (Sphere app — ConnectHost):**
- Bridges RPC queries: `sphere_getIdentity`, `sphere_getBalance`, `sphere_getAssets`
- Handles intents: `send` (for entry fee payment), `sign_message` (for server auth)
- Shows confirmation UI for payment requests

**Game side (QuakeJS iframe — ConnectClient):**
- Queries identity/nametag on load
- Requests entry fee payment when joining a session
- Receives payment confirmation before allowing game join

**Permissions requested:** `identity`, `balance`, `payments`

#### 1.3 Sphere App Registration

Add to `sphere/src/config/activities.ts`:

```typescript
{
  id: 'quake',
  name: 'UniQuake',
  icon: '🎮',
  type: 'custom',  // new type for non-chat pages
  description: 'Play Quake III Arena with UCT stakes',
  backendActivityId: null,  // no AI agent backend
}
```

Add route handling in `AgentPage.tsx` for `type: 'custom'` that renders `QuakeGamePage` instead of `AgentChat`.

#### 1.4 Game Client Wallet Bridge (`sphere-game-bridge.js`)

A new JavaScript file loaded in the QuakeJS iframe that bridges wallet operations to the game engine.

**Responsibilities:**
- Initialize ConnectClient on page load
- Connect to parent Sphere wallet (request identity + payment permissions)
- Expose `window.SPHERE_WALLET` API for the game engine:
  - `getIdentity()` → `{ nametag, directAddress, publicKey }`
  - `getBalance()` → current UCT balance
  - `payEntryFee(sessionId, amount)` → triggers Send intent to session wallet
  - `onPaymentConfirmed(callback)` → notifies when fee is paid
- Communicate payment status to the UniQuake master server via WebSocket

---

### 2. Server-Side Payment Manager (Node.js sphere-sdk)

#### 2.1 Architecture

The UniQuake server runs a **server-side Sphere SDK instance** to manage game session wallets.

```
PaymentManager (NEW)
  |
  +-- Sphere instance (Node.js providers)
  |     - Wallet: session manager's wallet (persistent mnemonic)
  |     - Nametag: configurable (default: babaika10 for default sessions)
  |     - Network: testnet (configurable)
  |
  +-- SessionEscrow (per active game session)
  |     - Invoice for entry fees
  |     - Player registry (nametag → payment status)
  |     - Prize pool tracking
  |
  +-- PayoutEngine
        - Resolves winner (human vs bot)
        - Transfers prize pool to winner's nametag
        - Handles default session payout
        - Handles bot-win payout to session creator
```

#### 2.2 Payment Manager Lifecycle

```
Server Start
  |
  +-- Initialize Sphere SDK (Node.js providers)
  |     sphere = await Sphere.init({
  |       ...createNodeProviders({ network: 'testnet' }),
  |       mnemonic: process.env.UNIQUAKE_MNEMONIC,  // persistent
  |     })
  |
  +-- Register nametag if needed
  |     (configurable: UNIQUAKE_NAMETAG env var, default: 'babaika10')
  |
  +-- Listen for game session events from GameServerManager
```

#### 2.3 Entry Fee Collection Flow

```
Player wants to join session
  |
  1. Client sends: { type: 'join_session', nametag: '@alice', sessionId: 'xxx' }
  |
  2. Server creates/retrieves SessionEscrow for this session
  |     escrow.addPendingPlayer('@alice')
  |
  3. Server responds: { type: 'payment_required', amount: '1000000000', coinId: 'UCT',
  |                      recipientAddress: escrow.depositAddress,
  |                      recipientNametag: '@babaika10',
  |                      sessionId: 'xxx' }
  |
  4. Client (in Sphere iframe) triggers ConnectClient.intent('send', {
  |     recipient: recipientNametag,
  |     amount: '1000000000',
  |     coinId: 'UCT',
  |     memo: 'UniQuake entry fee - Session xxx'
  |   })
  |
  5. Sphere wallet shows confirmation modal to user
  |
  6. User confirms → Sphere executes payment via sphere.payments.send()
  |
  7. Server-side sphere.payments.receive() picks up the transfer via Nostr
  |     (or invoice system detects payment)
  |
  8. Server confirms: { type: 'payment_confirmed', sessionId: 'xxx', player: '@alice' }
  |
  9. Player is admitted to the game session
```

#### 2.4 Winnings Distribution Flow

```
Match ends (timeout or score limit)
  |
  1. Server determines winner:
  |     - If human player: winner = player's nametag
  |     - If bot: winner = session creator's nametag
  |     - If default session with bot win: winner = UNIQUAKE_DEFAULT_PAYOUT_NAMETAG
  |
  2. Calculate prize pool:
  |     prizePool = entryFee * numberOfPlayers
  |     (e.g., 10 UCT * 4 players = 40 UCT)
  |
  3. Transfer winnings:
  |     await sphere.payments.send({
  |       recipient: '@winner_nametag',
  |       amount: prizePool,
  |       coinId: 'UCT',
  |       memo: 'UniQuake winnings - Session xxx'
  |     })
  |
  4. Broadcast result to all connected clients:
  |     { type: 'match_result', winner: '@alice', prizePool: '40',
  |       paidTo: '@alice', txStatus: 'confirmed' }
```

---

### 3. Configuration

#### 3.1 Server Environment Variables (NEW)

```bash
# ─── Sphere SDK Configuration ─────────────────────────────────
# Wallet mnemonic for the game session manager (12 or 24 words)
# IMPORTANT: Keep this secret! Back it up!
UNIQUAKE_MNEMONIC="word1 word2 ... word12"

# Network: testnet or mainnet
UNIQUAKE_NETWORK=testnet

# Default payout nametag (receives winnings when bot wins default sessions)
UNIQUAKE_DEFAULT_PAYOUT_NAMETAG=babaika10

# Entry fee in UCT (human-readable amount, SDK converts to smallest units)
UNIQUAKE_ENTRY_FEE=10

# Entry fee coin type
UNIQUAKE_ENTRY_COIN=UCT
```

#### 3.2 Session Configuration

Each game session carries payment metadata:

```javascript
{
  sessionId: 'game-1234567890',
  creatorNametag: '@alice',           // who started this session
  entryFee: '1000000000',            // 10 UCT in smallest units (8 decimals)
  entryCoin: 'UCT',
  payoutNametag: '@alice',           // creator gets bot-win payouts
  isDefaultSession: false,
  players: [
    { nametag: '@alice', paid: true, isBot: false },
    { nametag: '@bob', paid: true, isBot: false },
    { nametag: 'bot_ranger', paid: false, isBot: true },
  ],
  prizePool: '2000000000',          // 20 UCT (2 human players * 10 UCT)
}
```

---

### 4. Code Changes Summary

#### 4.1 Files to REMOVE (old integration)

| File | Reason |
|------|--------|
| `lib/token-service.js` | Replaced by PaymentManager (sphere-sdk) |
| `lib/client/uniquake-token-service.js` | Replaced by sphere-game-bridge.js (Connect protocol) |
| `lib/client/game-integration.js` | Functionality moves to PaymentManager |

#### 4.2 Dependencies to REMOVE from `package.json`

```json
"@unicitylabs/shared": "^1.2.15",
"@unicitylabs/tx-flow-engine": "^1.3.9",
```

#### 4.3 Dependencies to ADD to `package.json`

```json
"@unicitylabs/sphere-sdk": "^0.6.14",
"ws": "^8.0.0"  // for sphere-sdk Node.js Nostr transport (upgrade from 7.2.x)
```

> **Note:** The main project's `ws` can be upgraded to 8.x. The `fresh_quakejs` submodule keeps its own `ws@0.4.x` (intentional, do not change).

#### 4.4 Files to CREATE (server-side)

| File | Purpose |
|------|---------|
| `lib/payment-manager.js` | Main payment orchestration — Sphere SDK init, session escrow, payout engine |
| `lib/session-escrow.js` | Per-session fee tracking, player registration, prize pool |
| `lib/payout-engine.js` | Winner determination, nametag resolution, prize transfer |

#### 4.5 Files to CREATE (client-side)

| File | Purpose |
|------|---------|
| `lib/client/sphere-game-bridge.js` | ConnectClient in iframe, wallet API for game engine |

#### 4.6 Files to CREATE (Sphere app)

| File | Purpose |
|------|---------|
| `sphere/src/components/agents/QuakeGamePage.tsx` | Game page with iframe + ConnectHost |
| `sphere/src/components/agents/QuakeEntryFeeModal.tsx` | Entry fee confirmation dialog |

#### 4.7 Files to MODIFY

| File | Change |
|------|--------|
| `lib/signaling-service.js` | Remove old token handling, add PaymentManager integration |
| `lib/game-server-manager.js` | Remove old token monitoring, use PaymentManager for session lifecycle |
| `lib/server-registry.js` | Remove game state token monitoring |
| `lib/master-server.js` | Initialize PaymentManager, pass to components |
| `bin/combined-master.js` | Pass Sphere config to MasterServer |
| `docker/entrypoint.sh` | Add UNIQUAKE_MNEMONIC, UNIQUAKE_NETWORK env vars |
| `start-quake.sh` | Add --mnemonic, --network CLI args |
| `.env.example` | Add Sphere SDK configuration section |
| `package.json` | Update dependencies |
| `mock-server.js` | Add `?sphere=true` query param support for iframe mode |
| `sphere/src/config/activities.ts` | Add UniQuake agent config |
| `sphere/src/pages/AgentPage.tsx` | Add QuakeGamePage case |

---

### 5. Security Considerations

#### 5.1 Server Wallet Security

- The server's mnemonic (`UNIQUAKE_MNEMONIC`) is the master key for all game payments
- It MUST be stored securely (env var, Docker secret, or encrypted config)
- The server wallet accumulates entry fees — it is a high-value target
- Consider: separate HD addresses per session for isolation

#### 5.2 Client-Side Security

- The QuakeJS iframe runs on a different origin (uniquake-dev.dyndns.org) from Sphere
- Sphere Connect's PostMessage transport validates origins
- ConnectHost requires user confirmation for all payment intents (Send)
- Read-only queries (identity, balance) are allowed without confirmation
- The game cannot extract the user's private key or mnemonic

#### 5.3 Payment Integrity

- Entry fees are verified server-side via `sphere.payments.receive()` (checks aggregator proofs)
- Bots do NOT pay entry fees (only human players contribute to the prize pool)
- Prize pool = sum of confirmed human player payments only
- Winnings transfer happens atomically after match end — if transfer fails, funds remain in server wallet for manual resolution

#### 5.4 Nametag Trust

- Nametags are resolved via Nostr relays — first-seen-wins for anti-hijack
- The server resolves the payout nametag at payment time, not at session creation
- If a nametag cannot be resolved, payout fails and funds are retained

---

### 6. Data Flow Diagrams

#### 6.1 Player Join Flow

```
Browser (Sphere)           iframe (QuakeJS)           Server (UniQuake)
     |                          |                          |
     |  [User clicks Play]      |                          |
     |  Load QuakeGamePage      |                          |
     |  Create ConnectHost      |                          |
     |       |                  |                          |
     |       +-- Load iframe -->|                          |
     |                          |  Create ConnectClient    |
     |  <-- connect request --- |                          |
     |  Show approval UI        |                          |
     |  [User approves]         |                          |
     |  --- session granted --> |                          |
     |                          |  getIdentity() --------> |
     |  <-- identity ---------- |  (nametag, pubkey)       |
     |                          |                          |
     |                          |  WS: join_session -----> |
     |                          |                          |  Create SessionEscrow
     |                          |  <-- payment_required -- |  (amount: 10 UCT)
     |                          |                          |
     |                          |  intent('send', {...})   |
     |  <-- send intent ------- |                          |
     |  Show fee modal          |                          |
     |  [User confirms 10 UCT] |                          |
     |  Execute payment         |                          |
     |  --- intent result ----> |                          |
     |                          |  WS: payment_sent -----> |
     |                          |                          |  sphere.payments.receive()
     |                          |                          |  Verify on aggregator
     |                          |  <-- payment_confirmed - |
     |                          |  [Join game]             |
```

#### 6.2 Match End Payout Flow

```
Server (UniQuake)                      Sphere SDK (Node.js)
     |                                       |
     |  [Match ends: @alice wins]            |
     |  Determine payout recipient:          |
     |    Human win → @alice                 |
     |    Bot win → @session_creator         |
     |    Default + bot → @babaika10         |
     |                                       |
     |  Calculate prize: 4 players * 10 = 40 |
     |                                       |
     |  sphere.payments.send({               |
     |    recipient: '@alice',        -----> |  Resolve nametag
     |    amount: '4000000000',              |  Find tokens to cover amount
     |    coinId: 'UCT',                     |  Create transfer commitment
     |    memo: 'UniQuake winnings'          |  Submit to aggregator
     |  })                                   |  Wait for proof
     |                                       |  Deliver via Nostr
     |  <-- transfer result --------------- |
     |                                       |
     |  Broadcast to clients:               |
     |  { type: 'match_result',             |
     |    winner: '@alice',                 |
     |    prize: '40 UCT',                  |
     |    txStatus: 'confirmed' }           |
```

---

### 7. Migration Plan

#### Phase 1: Server-Side Payment Manager
1. Create `PaymentManager`, `SessionEscrow`, `PayoutEngine`
2. Add sphere-sdk dependency, remove old deps
3. Wire PaymentManager into MasterServer/SignalingService
4. Remove old token-service.js and related code
5. Test: verify entry fee collection and payout via CLI/mock

#### Phase 2: Client-Side Wallet Bridge
1. Create `sphere-game-bridge.js` with ConnectClient
2. Modify QuakeJS game page to load bridge when `?sphere=true`
3. Add join-session flow with payment request
4. Test: verify iframe ↔ Sphere Connect handshake

#### Phase 3: Sphere App Integration
1. Create `QuakeGamePage.tsx` with ConnectHost + iframe
2. Add QuakeJS to Sphere's activities config
3. Create entry fee confirmation modal
4. Test: full end-to-end flow in Sphere

#### Phase 4: Polish and Production
1. Handle edge cases (payment timeout, partial payments, network errors)
2. Add match result UI overlay in game
3. Docker image rebuild with sphere-sdk
4. Production deployment and nametag configuration

---

### 8. Open Questions

1. **Fee-free spectators?** Should players who just watch (not play) bypass the fee?
2. **Refund policy?** If a match is cancelled before completion, are fees returned?
3. **Platform fee?** Should a percentage of the prize pool go to the platform (e.g., 5%)?
4. **Multiple rounds?** If the same session runs multiple matches, is the fee per-match or per-session?
5. **Token denomination:** 10 UCT — is this 10.00000000 (10 * 10^8 smallest units = 1000000000)?
6. **Testnet vs mainnet:** Initial deployment on testnet only? When to switch?
