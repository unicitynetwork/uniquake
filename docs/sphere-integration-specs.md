# UniQuake x Sphere Integration — Detailed Specifications

## 1. Payment Manager (Server-Side)

### 1.1 Module: `PaymentManager`

**File:** `lib/payment-manager.js`

**Responsibility:** Manages the server-side Sphere SDK instance with AccountingModule (invoices) and CommunicationsModule (DMs) for all payment and signaling flows.

```javascript
class PaymentManager {
  constructor(config) {
    this.config = {
      mnemonic: config.mnemonic,
      network: config.network || 'testnet',
      defaultPayoutNametag: config.defaultPayoutNametag || 'babaika10',
      entryFee: config.entryFee || '10',
      entryCoin: config.entryCoin || 'UCT',
      walletUrl: config.walletUrl || 'https://sphere.unicity.network',
      nostrRelays: config.nostrRelays || ['wss://nostr-relay.testnet.unicity.network'],
    };
    this.sphere = null;
    this.sessions = new Map();  // sessionId -> SessionEscrow
  }

  async init() {
    // 1. Create Node.js providers
    const { createNodeProviders } = require('@unicitylabs/sphere-sdk/impl/nodejs');
    const { Sphere } = require('@unicitylabs/sphere-sdk');

    const providers = createNodeProviders({
      network: this.config.network,
      transport: { relays: this.config.nostrRelays },
    });

    // 2. Initialize Sphere SDK with persistent mnemonic + accounting + communications
    const { sphere } = await Sphere.init({
      ...providers,
      mnemonic: this.config.mnemonic,
      accounting: true,  // enables AccountingModule
    });
    this.sphere = sphere;

    // 3. Receive any pending transfers from previous runs
    await sphere.payments.receive();

    // 4. Set up DM listener for incoming join requests and payment notifications
    sphere.communications.onDM((dm) => this.handleIncomingDM(dm));

    // 5. Log identity
    const identity = sphere.getIdentity();
    console.log(`[PaymentManager] Initialized: ${identity.nametag || identity.directAddress}`);
    console.log(`[PaymentManager] Network: ${this.config.network}`);
  }

  // ── DM message handling ──

  async handleIncomingDM(dm) {
    try {
      const msg = JSON.parse(dm.content);
      if (!msg.type || !msg.type.startsWith('uniquake:')) return;

      switch (msg.type) {
        case 'uniquake:join_request':
          await this.handleJoinRequest(dm.sender, msg);
          break;
        case 'uniquake:payment_notification':
          await this.handlePaymentNotification(dm.sender, msg);
          break;
      }
    } catch (e) {
      // Non-JSON DMs or unrelated messages — ignore
    }
  }

  // ── Session management ──

  async createSession(sessionConfig) {
    const escrow = new SessionEscrow(sessionConfig.sessionId, {
      creatorNametag: sessionConfig.creatorNametag,
      isDefaultSession: sessionConfig.isDefaultSession || false,
      entryFee: toSmallestUnit(this.config.entryFee, 8),
      entryCoin: this.config.entryCoin,
    });
    this.sessions.set(sessionConfig.sessionId, escrow);
    return escrow;
  }

  async handleJoinRequest(senderNametag, msg) {
    const { sessionId, role } = msg;
    const escrow = this.sessions.get(sessionId);
    if (!escrow) return;

    if (role === 'spectator') {
      // Spectators join free
      escrow.addPlayer(senderNametag, false, true); // isBot=false, isSpectator=true
      await this.sphere.communications.sendDM(senderNametag, JSON.stringify({
        type: 'uniquake:join_confirmed',
        sessionId,
        role: 'spectator',
      }));
      return;
    }

    // Active player — create entry fee invoice
    escrow.addPlayer(senderNametag, false, false);

    const invoice = await this.sphere.accounting.createInvoice({
      targets: [{
        address: this.sphere.getIdentity().directAddress,
        assets: [{ coin: [this.config.entryCoin, this.config.entryFee] }],
      }],
      memo: `UniQuake entry fee - Session ${sessionId}`,
    });

    escrow.setPlayerInvoice(senderNametag, invoice.invoiceId);

    // Send invoice ID to player via DM
    await this.sphere.communications.sendDM(senderNametag, JSON.stringify({
      type: 'uniquake:entry_invoice',
      sessionId,
      invoiceId: invoice.invoiceId,
    }));
  }

  async handlePaymentNotification(senderNametag, msg) {
    const { sessionId, invoiceId } = msg;
    const escrow = this.sessions.get(sessionId);
    if (!escrow) return;

    // Check invoice status
    await this.sphere.payments.receive(); // pull latest transfers
    const status = await this.sphere.accounting.getInvoiceStatus(invoiceId);

    if (status.state === 'COVERED' || status.state === 'CLOSED') {
      escrow.confirmPayment(senderNametag);
      await this.sphere.communications.sendDM(senderNametag, JSON.stringify({
        type: 'uniquake:join_confirmed',
        sessionId,
        role: 'player',
      }));
    }
  }

  // ── Payout ──

  async distributeWinnings(sessionId, matchResult) {
    const escrow = this.sessions.get(sessionId);
    if (!escrow) return { status: 'error', reason: 'Session not found' };

    const payoutEngine = new PayoutEngine(this.sphere, this.config.defaultPayoutNametag);
    const result = await payoutEngine.processPayout(escrow, matchResult);

    // Notify all players via DM
    for (const [nametag] of escrow.players) {
      try {
        await this.sphere.communications.sendDM(nametag, JSON.stringify({
          type: 'uniquake:match_result',
          sessionId,
          winner: matchResult.winnerNametag,
          isBot: matchResult.isWinnerBot,
          prizePool: escrow.prizePool,
          payoutStatus: result.status,
        }));
      } catch (e) {
        // Best-effort notification
      }
    }

    return result;
  }

  // ── Cancellation ──

  async cancelSession(sessionId, reason) {
    const escrow = this.sessions.get(sessionId);
    if (!escrow) return;

    // Cancel all entry fee invoices with auto-return
    for (const [nametag, player] of escrow.players) {
      if (player.invoiceId) {
        try {
          await this.sphere.accounting.cancelInvoice(player.invoiceId, { autoReturn: true });
        } catch (e) {
          console.error(`[PaymentManager] Failed to cancel invoice for ${nametag}:`, e.message);
        }
      }
    }

    // Notify all players
    for (const [nametag] of escrow.players) {
      try {
        await this.sphere.communications.sendDM(nametag, JSON.stringify({
          type: 'uniquake:match_cancelled',
          sessionId,
          reason,
        }));
      } catch (e) {
        // Best-effort
      }
    }

    escrow.state = 'cancelled';
  }

  async destroy() {
    if (this.sphere) {
      await this.sphere.destroy();
    }
  }
}
```

### 1.2 Module: `SessionEscrow`

**File:** `lib/session-escrow.js`

**Responsibility:** Per-session invoice and player tracking.

```javascript
class SessionEscrow {
  constructor(sessionId, config) {
    this.sessionId = sessionId;
    this.creatorNametag = config.creatorNametag;
    this.isDefaultSession = config.isDefaultSession;
    this.entryFee = config.entryFee;     // smallest units string
    this.entryCoin = config.entryCoin;
    this.players = new Map();            // nametag -> PlayerRecord
    this.state = 'open';                 // open | playing | ended | paid_out | cancelled
  }

  addPlayer(nametag, isBot, isSpectator = false) {
    this.players.set(nametag, {
      nametag,
      isBot,
      isSpectator,
      invoiceId: null,
      paymentStatus: (isBot || isSpectator) ? 'exempt' : 'pending',
      // pending | confirmed | refunded | exempt
    });
  }

  setPlayerInvoice(nametag, invoiceId) {
    const player = this.players.get(nametag);
    if (player) player.invoiceId = invoiceId;
  }

  confirmPayment(nametag) {
    const player = this.players.get(nametag);
    if (player && player.paymentStatus === 'pending') {
      player.paymentStatus = 'confirmed';
      return true;
    }
    return false;
  }

  get prizePool() {
    let pool = BigInt(0);
    for (const player of this.players.values()) {
      if (player.paymentStatus === 'confirmed') {
        pool += BigInt(this.entryFee);
      }
    }
    return pool.toString();
  }

  get paidPlayerCount() {
    return [...this.players.values()].filter(p => p.paymentStatus === 'confirmed').length;
  }

  getPayoutRecipient(winnerNametag, isWinnerBot, defaultPayoutNametag) {
    if (!isWinnerBot) return winnerNametag;
    if (this.isDefaultSession) return defaultPayoutNametag;
    return this.creatorNametag;
  }
}
```

### 1.3 Module: `PayoutEngine`

**File:** `lib/payout-engine.js`

**Responsibility:** Determines payout recipient and executes payment via invoicing.

```javascript
class PayoutEngine {
  constructor(sphere, defaultPayoutNametag) {
    this.sphere = sphere;
    this.defaultPayoutNametag = defaultPayoutNametag;
  }

  async processPayout(escrow, matchResult) {
    const { winnerNametag, isWinnerBot } = matchResult;
    const prizePool = escrow.prizePool;

    if (prizePool === '0') {
      escrow.state = 'ended';
      return { status: 'no_prize', reason: 'No paying players' };
    }

    const recipient = escrow.getPayoutRecipient(
      winnerNametag, isWinnerBot, this.defaultPayoutNametag
    );

    // Resolve nametag to get DIRECT address
    const recipientTag = recipient.startsWith('@') ? recipient : `@${recipient}`;
    let recipientAddress;
    try {
      const peer = await this.sphere.resolve(recipientTag);
      if (!peer || !peer.directAddress) {
        return { status: 'failed', reason: `Cannot resolve nametag: ${recipient}` };
      }
      recipientAddress = peer.directAddress;
    } catch (err) {
      return { status: 'failed', reason: `Nametag resolution error: ${err.message}` };
    }

    // Create payout invoice and pay it
    try {
      const { toSmallestUnit } = require('@unicitylabs/sphere-sdk');

      const invoice = await this.sphere.accounting.createInvoice({
        targets: [{
          address: recipientAddress,
          assets: [{ coin: [escrow.entryCoin, prizePool] }],
        }],
        memo: `UniQuake winnings - Session ${escrow.sessionId} - Winner: ${recipient}`,
      });

      // Pay the invoice from server wallet
      await this.sphere.accounting.payInvoice(invoice.invoiceId, {
        targetIndex: 0,
        assetIndex: 0,
      });

      // Close the invoice
      await this.sphere.accounting.closeInvoice(invoice.invoiceId);

      // Send receipt to winner
      try {
        await this.sphere.accounting.sendInvoiceReceipts(invoice.invoiceId);
      } catch (e) {
        // Best-effort receipt delivery
      }

      escrow.state = 'paid_out';
      return {
        status: 'confirmed',
        recipient,
        recipientAddress,
        amount: prizePool,
        coinId: escrow.entryCoin,
        invoiceId: invoice.invoiceId,
      };
    } catch (err) {
      return { status: 'failed', reason: `Payout error: ${err.message}` };
    }
  }
}
```

---

## 2. Client-Side Wallet Bridge

### 2.1 Module: `sphere-game-bridge.js`

**File:** `lib/client/sphere-game-bridge.js`

**Loaded in:** QuakeJS page when `?sphere=true` query param is present

**Purpose:** Uses `autoConnect()` to connect to Sphere wallet via any of the three transport modes. Exposes `window.SPHERE_WALLET` for game engine access.

```javascript
import { autoConnect } from '@unicitylabs/sphere-sdk/connect/browser';

class SphereGameBridge {
  constructor() {
    this.client = null;
    this.connection = null;
    this.identity = null;
    this.connected = false;
    this.transport = null;  // 'iframe' | 'extension' | 'popup'
    this.disconnectFn = null;
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
      permissions: ['identity', 'balance', 'payments', 'invoices'],
    });

    this.client = result.client;
    this.connection = result.connection;
    this.identity = result.connection.identity;
    this.transport = result.transport;
    this.disconnectFn = result.disconnect;
    this.connected = true;

    console.log(`[sphere-bridge] Connected via ${this.transport}`);
    console.log(`[sphere-bridge] Identity: ${this.identity.nametag || this.identity.directAddress}`);
  }

  // ── Queries ──

  async getIdentity() {
    return this.client.query('sphere_getIdentity');
  }

  async getBalance() {
    return this.client.query('sphere_getAssets');
  }

  async resolve(nametag) {
    return this.client.query('sphere_resolve', { nametag });
  }

  // ── Intents (wallet confirmation required) ──

  async payInvoice(invoiceId) {
    return this.client.intent('pay_invoice', {
      invoiceId,
      targetIndex: 0,
      assetIndex: 0,
    });
  }

  async signMessage(message) {
    return this.client.intent('sign_message', { message });
  }

  // ── Lifecycle ──

  async disconnect() {
    if (this.disconnectFn) await this.disconnectFn();
    this.connected = false;
  }
}

// Expose globally
window.SPHERE_WALLET = new SphereGameBridge();

// Auto-init if ?sphere=true
if (new URLSearchParams(window.location.search).get('sphere') === 'true') {
  const walletUrl = new URLSearchParams(window.location.search).get('walletUrl')
    || 'https://sphere.unicity.network';
  window.SPHERE_WALLET.init(walletUrl).catch(err => {
    console.error('[sphere-bridge] Connection failed:', err.message);
  });
}
```

### 2.2 Game Engine Join Flow (Browser-Side)

The existing signaling code integrates with `window.SPHERE_WALLET`:

```javascript
// When player clicks "Join Session":

async function joinPaidSession(sessionId) {
  const wallet = window.SPHERE_WALLET;
  if (!wallet || !wallet.connected) {
    showMessage('Sphere wallet not connected. Load with ?sphere=true');
    return;
  }

  // 1. Send join request via Sphere DM (handled by server PaymentManager)
  //    The bridge doesn't send DMs directly — it sends via WebSocket to the
  //    master server, which uses its own sphere.communications to DM back.
  //    
  //    Alternative: Client sends DM to server nametag directly.
  //    For simplicity, the join request goes via WebSocket:
  ws.send(JSON.stringify({
    type: 'join_session',
    nametag: wallet.identity.nametag,
    sessionId: sessionId,
    role: 'player',
  }));

  // 2. Server creates invoice and sends invoiceId back via WS or DM
  //    (handled in ws.onmessage)
}

// In WebSocket message handler:
case 'entry_invoice':
  // Server sent an invoice ID — pay it via wallet
  try {
    await window.SPHERE_WALLET.payInvoice(msg.invoiceId);
    // Wallet showed confirmation, user approved, payment sent
    ws.send(JSON.stringify({
      type: 'payment_sent',
      sessionId: msg.sessionId,
      invoiceId: msg.invoiceId,
    }));
  } catch (err) {
    showMessage('Payment cancelled or failed: ' + err.message);
  }
  break;

case 'join_confirmed':
  // Fee paid, join the game
  connectToGameServer(msg.sessionId);
  break;
```

> **Note:** The join request travels via WebSocket for simplicity (it's already connected for game protocol). The server-side PaymentManager handles the invoice creation and uses Sphere DMs for payment coordination. The hybrid approach (WS for game protocol + DMs for payment protocol) is intentional — see Architecture doc "Two Communication Channels" section.

---

## 3. Sphere Integration Contract

UniQuake does NOT modify the Sphere codebase. Instead it provides a **ConnectClient** artifact that works with all three Sphere integration modes.

### 3.1 Integration Modes

Sphere provides three ways for dApps to connect to the wallet. UniQuake supports all three via `autoConnect()`:

- **iframe:** Sphere renders `<iframe src="https://uniquake-dev.dyndns.org/quake?sphere=true">`
- **popup:** User visits UniQuake directly; `autoConnect()` opens Sphere wallet popup
- **extension:** User visits UniQuake directly; Sphere browser extension detected automatically

### 3.2 Connect Protocol Contract

**RPC queries** (no user confirmation):
- `sphere_getIdentity` — nametag, directAddress, chainPubkey
- `sphere_getAssets` — token balances
- `sphere_resolve` — nametag to address resolution
- `sphere_getInvoiceStatus` — check invoice payment state

**Intents** (wallet shows confirmation UI):
- `pay_invoice` — pay an entry fee invoice
- `sign_message` — optional server auth

### 3.3 Sphere Team Responsibilities

The Sphere team decides how to expose UniQuake:
- Add iframe in GamesChat page with ConnectHost
- Add a link that opens UniQuake standalone (popup/extension modes)
- Configure allowed origins for PostMessage validation

---

## 4. DM Communication Protocol

### 4.1 Message Types

All DMs are JSON-encoded, sent via `sphere.communications.sendDM()`:

| Type | Direction | Fields | Purpose |
|------|-----------|--------|---------|
| `uniquake:join_request` | Client -> Server | `sessionId`, `role` | Request to join session |
| `uniquake:entry_invoice` | Server -> Client | `sessionId`, `invoiceId` | Invoice for entry fee |
| `uniquake:payment_notification` | Client -> Server | `sessionId`, `invoiceId` | Confirm payment sent |
| `uniquake:join_confirmed` | Server -> Client | `sessionId`, `role` | Player/spectator admitted |
| `uniquake:match_result` | Server -> Client | `sessionId`, `winner`, `isBot`, `prizePool`, `payoutStatus` | Match ended |
| `uniquake:match_cancelled` | Server -> Client | `sessionId`, `reason` | Match cancelled, fees returned |

### 4.2 Hybrid Communication Model

| Data Type | Channel | Reason |
|-----------|---------|--------|
| Game protocol (player movement, shooting, state sync) | WebSocket (Quake native) | Latency-critical, high-frequency |
| WebRTC signaling (offers, answers, ICE candidates) | WebSocket | Real-time peer negotiation |
| Server list, game joining | WebSocket | Existing infrastructure |
| Payment coordination (invoices, confirmations) | Sphere DMs (NIP-17) | Cryptographic identity, encrypted, wallet integration |
| Match results, cancellations | Sphere DMs (NIP-17) | Tied to wallet notifications |

---

## 5. Winner Determination

### 5.1 Score Extraction

The existing `server-cli.js` and `signaling-service.js` already track player scores.

### 5.2 Winner Rules

```javascript
function determineWinner(escrow, scores) {
  // scores: [{ name, score, isBot }]
  const sorted = [...scores].sort((a, b) => b.score - a.score);
  const topPlayer = sorted[0];
  if (!topPlayer) return { winnerNametag: null, isWinnerBot: true };
  return {
    winnerNametag: topPlayer.name,
    isWinnerBot: topPlayer.isBot,
    score: topPlayer.score,
  };
}
```

---

## 6. Error Handling

| Scenario | Handling |
|----------|---------|
| Player insufficient UCT | `pay_invoice` intent returns error; game shows message |
| Player cancels payment | Intent cancelled; player not admitted |
| Payment not received within 60s | Server polls `getInvoiceStatus()` every 10s; timeout removes pending player |
| Nostr relay unavailable | Sphere SDK retries; DMs may be delayed |
| Payout transfer fails | Funds remain in server wallet; error logged |
| Match cancelled | `cancelInvoice({ autoReturn: true })` refunds all fees |
| Server crashes | Docker restarts; PaymentManager reloads wallet; pending invoices remain on-chain |
| Nametag resolution fails | Payout fails; funds retained for manual resolution |

---

## 7. Testing Strategy

### Unit Tests
- `SessionEscrow`: player lifecycle, prize pool calculation, payout recipient logic
- `PayoutEngine`: all payout matrix scenarios
- `PaymentManager`: mock sphere-sdk, verify invoice creation/payment/cancellation

### Integration Tests (Testnet)
- Sphere SDK: init wallet, faucet, create invoice, pay invoice, close/cancel
- Join flow: join_request -> entry_invoice -> pay_invoice -> join_confirmed
- Payout flow: match end -> determine winner -> payout invoice -> close
- Cancellation: cancel invoice -> auto-return -> verify refund

### E2E Tests
- All three Connect modes (iframe, popup, extension)
- Full game: join -> pay -> play -> win -> payout
- Spectator: join free -> watch
- Cancellation: join -> pay -> cancel -> refund
