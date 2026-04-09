# UniQuake x Sphere Integration Architecture

## Overview

This document describes the architecture for integrating UniQuake with the Sphere wallet ecosystem, replacing the current `@unicitylabs/tx-flow-engine` + `@unicitylabs/shared` integration with `@unicitylabs/sphere-sdk`.

**Key principle:** UniQuake is a standalone, self-contained web application. It produces an **integrable artifact** — it does NOT modify the Sphere codebase. Sphere can embed UniQuake via any of its three integration approaches.

### Goals

1. UniQuake game client connects to the player's Sphere wallet for identity and payments
2. Collect a 10 UCT entry fee when players join a game session
3. Distribute winnings: human winner gets the pot; bot winner sends pot to session creator
4. Default sessions send unclaimed winnings to a configurable nametag (default: `babaika10`)
5. Fully remove the old `@unicitylabs/tx-flow-engine` and `@unicitylabs/shared` dependencies
6. Work with all three Sphere integration modes (iframe, popup, extension)

### Non-Goals (this phase)

- Modifying the Sphere app codebase (Sphere team handles their side)
- L1 (ALPHA blockchain) payment integration
- Multi-coin support (UCT only)
- Tournament bracket system

---

## Sphere Connect Integration Model

UniQuake uses the **Sphere Connect protocol** — a JSON-RPC-like message system for dApp ↔ wallet communication. The SDK provides `autoConnect()` which auto-detects the best available transport.

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
|  | (wallet bridge)      | |     | ConnectHost               |    | Content Script → BG       |
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
3. **Server-side payment management** — collects fees and distributes winnings via Node.js sphere-sdk

### What Sphere Provides (not our responsibility)

The Sphere team implements the **ConnectHost** (wallet) side:

1. **Iframe mode:** Sphere embeds `<iframe src="https://uniquake-dev.dyndns.org/quake?sphere=true">` in their UI and wraps it with a `ConnectHost` using `PostMessageTransport.forHost(iframe)`
2. **Popup mode:** Sphere's `/connect` route handles popup wallet sessions. Already implemented in the SDK.
3. **Extension mode:** Sphere's browser extension background script runs `ConnectHost` with `ExtensionTransport.forHost(chrome)`. Already implemented in the SDK.

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
|  |    |     P1: iframe → PostMessage to parent                      ||
|  |    |     P2: extension → Chrome messaging                        ||
|  |    |     P3: popup → window.open(walletUrl/connect)              ||
|  |    +-- ConnectClient                                              ||
|  |         Queries: sphere_getIdentity, sphere_getBalance            ||
|  |         Intents: send (entry fee), sign_message (server auth)     ||
|  +------------------------------------------------------------------+|
|                              |                                        |
|            WebSocket (ws://host:27950 or wss://host:27951)            |
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
|  |  - Spawns ioq3ded |  |  - Server wallet (persistent mnemonic)   | |
|  |  - Tracks scores  |  |  - SessionEscrow per active game         | |
|  |  - Manages state  |  |  - Entry fee collection (10 UCT)         | |
|  +-------------------+  |  - Payout on match end                   | |
|                          |  - Nametag resolution for transfers      | |
|                          +------------------------------------------+ |
+----------------------------------------------------------------------+
```

---

## Client-Side: `sphere-game-bridge.js`

### Design

A single JavaScript file loaded in the QuakeJS page when `?sphere=true` is present. Uses `autoConnect()` — works identically whether UniQuake is in an iframe, opened alongside a Sphere extension, or using a popup wallet.

### API

```javascript
// sphere-game-bridge.js

import { autoConnect } from '@unicitylabs/sphere-sdk/connect/browser';

class SphereGameBridge {
  constructor() {
    this.client = null;
    this.connection = null;
    this.identity = null;
    this.connected = false;
    this.transport = null;  // 'iframe' | 'extension' | 'popup'
    this.disconnect = null;
  }

  async init(walletUrl) {
    const result = await autoConnect({
      dapp: {
        name: 'UniQuake',
        description: 'Quake III Arena with UCT stakes',
        url: window.location.origin,
        icon: window.location.origin + '/favicon.ico',
      },
      walletUrl: walletUrl || 'https://sphere.unicity.network',
      permissions: ['identity', 'balance', 'payments'],
    });

    this.client = result.client;
    this.connection = result.connection;
    this.identity = result.connection.identity;
    this.transport = result.transport;
    this.disconnect = result.disconnect;
    this.connected = true;
  }

  // ── Queries (no user confirmation needed) ──

  async getIdentity() {
    return this.client.query('sphere_getIdentity');
  }

  async getBalance() {
    return this.client.query('sphere_getAssets');
  }

  async resolve(nametag) {
    return this.client.query('sphere_resolve', { nametag });
  }

  // ── Intents (wallet shows confirmation UI) ──

  async payEntryFee(recipientNametag, amount, coinId, sessionId) {
    return this.client.intent('send', {
      recipient: recipientNametag,
      amount: amount,
      coinId: coinId,
      memo: `UniQuake entry fee - Session ${sessionId}`,
    });
  }

  async signMessage(message) {
    return this.client.intent('sign_message', { message });
  }
}

// Expose globally for game engine
window.SPHERE_WALLET = new SphereGameBridge();

// Auto-init if ?sphere=true
if (new URLSearchParams(window.location.search).get('sphere') === 'true') {
  const walletUrl = new URLSearchParams(window.location.search).get('walletUrl')
    || 'https://sphere.unicity.network';
  window.SPHERE_WALLET.init(walletUrl).catch(err => {
    console.error('[sphere-bridge] Failed to connect:', err.message);
  });
}
```

### Behavior by Mode

| Aspect | iframe | popup | extension |
|--------|--------|-------|-----------|
| Connection | Automatic (parent detected) | Opens wallet popup window | Automatic (extension detected) |
| User sees | Game inside Sphere UI | Game in own tab + wallet popup | Game in own tab, extension icon |
| Entry fee confirmation | Sphere shows modal in parent | Popup window shows modal | Extension popup shows modal |
| Identity source | Parent Sphere's wallet | Popup Sphere's wallet | Extension's wallet |
| `walletUrl` needed? | No | Yes (for `window.open`) | No |

---

## Server-Side: Payment Manager

### Architecture

The UniQuake server runs a **server-side Sphere SDK instance** (Node.js) to manage game session payments.

```
PaymentManager
  |
  +-- Sphere instance (createNodeProviders)
  |     Wallet: persistent mnemonic (UNIQUAKE_MNEMONIC env var)
  |     Nametag: server's own nametag (registered on first run)
  |     Network: testnet (configurable)
  |
  +-- SessionEscrow (per active game session)
  |     Invoice for entry fees
  |     Player registry: nametag → payment status
  |     Prize pool tracking
  |
  +-- PayoutEngine
        Winner determination (human vs bot)
        Nametag resolution
        Prize transfer via sphere.payments.send()
```

### Entry Fee Collection Flow

```
Player (browser)                              Server (UniQuake)
     |                                              |
     |  1. WS: { type: 'join_session',              |
     |           nametag: '@alice',                  |
     |           sessionId: 'xxx' }                  |
     |  ----------------------------------------->  |
     |                                              |  2. Create/get SessionEscrow
     |                                              |     escrow.addPlayer('@alice')
     |  3. WS: { type: 'payment_required',          |
     |           amount: '1000000000',               |
     |           coinId: 'UCT',                     |
     |           recipientNametag: '@babaika10',     |
     |           sessionId: 'xxx' }                  |
     |  <-----------------------------------------  |
     |                                              |
     |  4. SPHERE_WALLET.payEntryFee(               |
     |       '@babaika10', '1000000000',             |
     |       'UCT', 'xxx')                           |
     |     → Wallet shows confirmation modal         |
     |     → User confirms 10 UCT                   |
     |     → sphere.payments.send() executes         |
     |                                              |
     |  5. WS: { type: 'payment_sent',              |
     |           sessionId: 'xxx',                   |
     |           nametag: '@alice' }                  |
     |  ----------------------------------------->  |
     |                                              |  6. sphere.payments.receive()
     |                                              |     Verify on aggregator
     |  7. WS: { type: 'payment_confirmed',         |
     |           sessionId: 'xxx',                   |
     |           player: '@alice' }                  |
     |  <-----------------------------------------  |
     |                                              |
     |  [Player admitted to game]                    |
```

### Winnings Distribution Flow

```
Match ends → Server determines winner:

  Is winner human?
    YES → payout to winner's nametag (@alice)
    NO (bot won) →
      Is this a default session?
        YES → payout to UNIQUAKE_DEFAULT_PAYOUT_NAMETAG (@babaika10)
        NO  → payout to session creator's nametag

Prize pool = entryFee × number_of_human_players
  (bots don't pay, so they don't contribute to the pool)

Transfer: sphere.payments.send({
  recipient: '@winner_or_creator_or_default',
  amount: prizePool,
  coinId: 'UCT',
  memo: 'UniQuake winnings - Session xxx',
})
```

### Payout Decision Matrix

| Winner | Session Type | Payout Recipient |
|--------|-------------|-----------------|
| Human player | Any | The winning player's nametag |
| Bot | Custom session | Session creator's nametag |
| Bot | Default session | `UNIQUAKE_DEFAULT_PAYOUT_NAMETAG` (default: `babaika10`) |
| No players | Any | No payout (prize pool = 0) |
| Transfer fails | Any | Funds retained in server wallet; logged for manual resolution |

---

## Configuration

### Server Environment Variables

```bash
# ─── Sphere SDK Configuration ─────────────────────────────────
# Wallet mnemonic for the game session manager (12 or 24 words)
# IMPORTANT: Keep this secret! Back it up!
UNIQUAKE_MNEMONIC="word1 word2 ... word12"

# Network: testnet or mainnet
UNIQUAKE_NETWORK=testnet

# Default payout nametag (receives winnings when bot wins default sessions)
UNIQUAKE_DEFAULT_PAYOUT_NAMETAG=babaika10

# Entry fee in UCT (human-readable, SDK converts to smallest units via 8 decimals)
UNIQUAKE_ENTRY_FEE=10

# Entry fee coin type
UNIQUAKE_ENTRY_COIN=UCT

# Sphere wallet URL for popup mode (clients that aren't in iframe/extension)
UNIQUAKE_WALLET_URL=https://sphere.unicity.network
```

### Session Configuration

```javascript
{
  sessionId: 'game-1234567890',
  creatorNametag: '@alice',           // who started this session
  isDefaultSession: false,            // auto-started sessions = true
  entryFee: '1000000000',            // 10 UCT in smallest units (8 decimals)
  entryCoin: 'UCT',
  payoutNametag: '@alice',            // creator gets bot-win payouts
  players: [
    { nametag: '@alice', paid: true, isBot: false },
    { nametag: '@bob', paid: true, isBot: false },
    { nametag: 'bot_ranger', paid: false, isBot: true },
  ],
  prizePool: '2000000000',           // 20 UCT (2 human players x 10 UCT)
}
```

---

## Code Changes Summary

### Files to REMOVE (old integration)

| File | Reason |
|------|--------|
| `lib/token-service.js` | Replaced by PaymentManager (sphere-sdk) |
| `lib/client/uniquake-token-service.js` | Replaced by sphere-game-bridge.js |
| `lib/client/game-integration.js` | Functionality moves to PaymentManager |

### Dependencies to REMOVE from `package.json`

```json
"@unicitylabs/shared": "^1.2.15",
"@unicitylabs/tx-flow-engine": "^1.3.9",
```

### Dependencies to ADD to `package.json`

```json
"@unicitylabs/sphere-sdk": "^0.6.14",
"ws": "^8.0.0"  // upgrade for sphere-sdk Node.js Nostr transport
```

> **Note:** `fresh_quakejs` keeps its own `ws@0.4.x` — do not change.

### Files to CREATE (server-side)

| File | Purpose |
|------|---------|
| `lib/payment-manager.js` | Sphere SDK init, session escrow management, payout orchestration |
| `lib/session-escrow.js` | Per-session fee tracking, player registry, prize pool |
| `lib/payout-engine.js` | Winner determination, nametag resolution, prize transfer |

### Files to CREATE (client-side)

| File | Purpose |
|------|---------|
| `lib/client/sphere-game-bridge.js` | `autoConnect()` + wallet API for game engine |

### Files to MODIFY

| File | Change |
|------|--------|
| `lib/signaling-service.js` | Remove old token handling, add PaymentManager integration for join_session/payment flow |
| `lib/game-server-manager.js` | Remove old token monitoring, use PaymentManager for session lifecycle |
| `lib/server-registry.js` | Remove game state token monitoring |
| `lib/master-server.js` | Initialize PaymentManager, pass to components |
| `bin/combined-master.js` | Pass Sphere config to MasterServer |
| `mock-server.js` | Serve `sphere-game-bridge.js`, pass `walletUrl` config to game page |
| `bin/index.ejs` | Load sphere-game-bridge.js when `?sphere=true`, pass walletUrl |
| `docker/entrypoint.sh` | Add UNIQUAKE_MNEMONIC, UNIQUAKE_NETWORK env vars |
| `start-quake.sh` | Add --mnemonic, --network, --wallet-url CLI args |
| `.env.example` | Add Sphere SDK configuration section |
| `package.json` | Update dependencies |

### Files NOT modified (Sphere app)

UniQuake does NOT modify any files in the `sphere/` repository. The Sphere team is responsible for:
- Adding a QuakeJS page/agent entry in their `activities.ts`
- Creating a page component that renders an iframe with `ConnectHost`
- Handling the `send` intent to show a fee confirmation modal

The integration contract between UniQuake and Sphere is the **Sphere Connect protocol** — documented in `sphere-sdk/docs/CONNECT.md`.

---

## Security Considerations

### Server Wallet Security

- The server's mnemonic (`UNIQUAKE_MNEMONIC`) is the master key for all game payments
- MUST be stored securely (env var, Docker secret, or encrypted config)
- The server wallet accumulates entry fees — high-value target
- Consider: separate HD addresses per session for isolation (`sphere.deriveAddress(index)`)

### Client-Side Security

- `autoConnect()` negotiates permissions with the wallet
- Read-only queries (`sphere_getIdentity`, `sphere_getBalance`) require permission but no user confirmation
- Payment intents (`send`) always require user confirmation in the wallet UI
- The game page CANNOT extract the user's private key or mnemonic
- PostMessage origin validation prevents cross-origin attacks (iframe and popup modes)
- Extension mode uses Chrome's isolated world + message passing

### Payment Integrity

- Entry fees are verified server-side via `sphere.payments.receive()` (checks aggregator proofs)
- Bots do NOT pay entry fees (only human players contribute to the prize pool)
- Prize pool = sum of confirmed human player payments only
- If payout transfer fails, funds remain in server wallet for manual resolution

---

## Migration Plan

### Phase 1: Server-Side Payment Manager
1. Create `PaymentManager`, `SessionEscrow`, `PayoutEngine`
2. Add sphere-sdk dependency, remove old deps
3. Wire PaymentManager into MasterServer/SignalingService
4. Remove old token-service.js and related code
5. Test: verify entry fee collection and payout via CLI/mock

### Phase 2: Client-Side Wallet Bridge
1. Create `sphere-game-bridge.js` with `autoConnect()`
2. Modify game page to load bridge when `?sphere=true`
3. Add join-session flow with payment request
4. Test: verify all three connect modes (iframe, popup, extension)

### Phase 3: Integration Testing
1. Test in Sphere iframe (requires Sphere team to add the page)
2. Test standalone with popup wallet
3. Test with Sphere browser extension
4. Full end-to-end: join → pay → play → win → payout

### Phase 4: Production
1. Docker image rebuild with sphere-sdk
2. Production mnemonic setup and nametag registration
3. Deployment and monitoring

---

## Open Questions

1. **Fee-free spectators?** Should players who just watch bypass the fee?
2. **Refund policy?** If a match is cancelled before completion, are fees returned?
3. **Platform fee?** Should a percentage of the prize pool go to the platform (e.g., 5%)?
4. **Multiple rounds?** Fee per-match or per-session?
5. **Token denomination:** 10 UCT = 10.00000000 (10 * 10^8 smallest units = 1,000,000,000)?
6. **Testnet vs mainnet:** Initial deployment on testnet only?
