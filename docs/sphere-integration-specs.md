# UniQuake x Sphere Integration — Detailed Specifications

## 1. Payment Manager (Server-Side)

### 1.1 Module: `PaymentManager`

**File:** `lib/payment-manager.js`

**Responsibility:** Manages the server-side Sphere SDK instance and orchestrates all payment flows.

**Initialization:**

```javascript
class PaymentManager {
  constructor(config) {
    this.config = {
      mnemonic: config.mnemonic,         // UNIQUAKE_MNEMONIC (required)
      network: config.network || 'testnet',
      defaultPayoutNametag: config.defaultPayoutNametag || 'babaika10',
      entryFee: config.entryFee || '10', // human-readable UCT
      entryCoin: config.entryCoin || 'UCT',
    };
    this.sphere = null;
    this.sessions = new Map();  // sessionId → SessionEscrow
  }

  async init() {
    // 1. Create Node.js providers
    // 2. Initialize Sphere SDK with persistent mnemonic
    // 3. Receive any pending transfers (from previous runs)
    // 4. Log wallet identity and balance
  }

  async createSession(sessionConfig) {
    // Returns: SessionEscrow instance
  }

  async processJoinRequest(sessionId, playerNametag) {
    // Returns: { paymentRequired: true, amount, recipientNametag, recipientAddress }
  }

  async confirmPayment(sessionId, playerNametag) {
    // Checks incoming transfers, confirms player's fee
    // Returns: { confirmed: boolean }
  }

  async distributeWinnings(sessionId, matchResult) {
    // Determines winner, transfers prize pool
    // Returns: { paidTo, amount, txStatus }
  }

  async destroy() {
    // Clean up Sphere SDK instance
  }
}
```

**Sphere SDK usage:**

```javascript
// Init
const { createNodeProviders } = require('@unicitylabs/sphere-sdk/impl/nodejs');
const { Sphere, toSmallestUnit } = require('@unicitylabs/sphere-sdk');

const providers = createNodeProviders({ network: this.config.network });
const { sphere } = await Sphere.init({
  ...providers,
  mnemonic: this.config.mnemonic,
});
this.sphere = sphere;

// Identity
const identity = sphere.getIdentity();
// { nametag, directAddress, chainPubkey, l1Address }

// Convert human-readable fee to smallest units
const feeInSmallestUnits = toSmallestUnit('10', 8); // '1000000000'

// Receive pending transfers
await sphere.payments.receive();

// Send winnings
await sphere.payments.send({
  recipient: '@winner_nametag',
  amount: prizePoolInSmallestUnits,
  coinId: 'UCT',
  memo: `UniQuake winnings - Session ${sessionId}`,
});

// Check balance
const assets = await sphere.payments.getAssets();
const uctBalance = assets.find(a => a.symbol === 'UCT');
```

### 1.2 Module: `SessionEscrow`

**File:** `lib/session-escrow.js`

**Responsibility:** Tracks per-session payment state.

```javascript
class SessionEscrow {
  constructor(sessionId, config) {
    this.sessionId = sessionId;
    this.creatorNametag = config.creatorNametag;    // who started this session
    this.isDefaultSession = config.isDefaultSession; // auto-started by health check
    this.entryFee = config.entryFee;                // smallest units string
    this.entryCoin = config.entryCoin;              // 'UCT'
    this.players = new Map();  // nametag → PlayerPayment
    this.state = 'open';       // open | playing | ended | paid_out
  }

  addPlayer(nametag, isBot) {
    this.players.set(nametag, {
      nametag,
      isBot,
      paymentStatus: isBot ? 'exempt' : 'pending',
      // pending | confirmed | refunded | exempt (bots)
      paidAt: null,
    });
  }

  confirmPayment(nametag) {
    const player = this.players.get(nametag);
    if (player && player.paymentStatus === 'pending') {
      player.paymentStatus = 'confirmed';
      player.paidAt = Date.now();
      return true;
    }
    return false;
  }

  get prizePool() {
    // Sum of confirmed human player fees
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

  get allPlayersPaid() {
    return [...this.players.values()]
      .filter(p => !p.isBot)
      .every(p => p.paymentStatus === 'confirmed');
  }

  getPayoutRecipient(winnerNametag, isWinnerBot, defaultPayoutNametag) {
    if (!isWinnerBot) {
      // Human winner gets the pot
      return winnerNametag;
    }
    if (this.isDefaultSession) {
      // Bot wins default session → configurable nametag
      return defaultPayoutNametag;
    }
    // Bot wins custom session → session creator
    return this.creatorNametag;
  }
}
```

### 1.3 Module: `PayoutEngine`

**File:** `lib/payout-engine.js`

**Responsibility:** Determines payout recipient and executes transfer.

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
      return { status: 'no_prize', reason: 'No paid players' };
    }

    const recipient = escrow.getPayoutRecipient(
      winnerNametag,
      isWinnerBot,
      this.defaultPayoutNametag
    );

    // Resolve nametag to ensure it exists
    try {
      const peer = await this.sphere.resolve(recipient.startsWith('@') ? recipient : `@${recipient}`);
      if (!peer) {
        return { status: 'failed', reason: `Cannot resolve nametag: ${recipient}` };
      }
    } catch (err) {
      return { status: 'failed', reason: `Nametag resolution error: ${err.message}` };
    }

    // Execute transfer
    try {
      await this.sphere.payments.send({
        recipient: recipient.startsWith('@') ? recipient : `@${recipient}`,
        amount: prizePool,
        coinId: escrow.entryCoin,
        memo: `UniQuake winnings - Session ${escrow.sessionId}`,
        transferMode: 'instant',
      });

      escrow.state = 'paid_out';
      return {
        status: 'confirmed',
        recipient,
        amount: prizePool,
        coinId: escrow.entryCoin,
      };
    } catch (err) {
      return { status: 'failed', reason: `Transfer error: ${err.message}` };
    }
  }
}
```

---

## 2. Client-Side Wallet Bridge

### 2.1 Module: `sphere-game-bridge.js`

**File:** `lib/client/sphere-game-bridge.js`

**Loaded in:** QuakeJS iframe when `?sphere=true` query param is present

**Purpose:** Creates a ConnectClient to communicate with the parent Sphere wallet via PostMessage. Exposes a `window.SPHERE_WALLET` API for the game engine.

```javascript
// sphere-game-bridge.js — loaded in QuakeJS iframe

import { ConnectClient } from '@unicitylabs/sphere-sdk/connect';
import { PostMessageTransport } from '@unicitylabs/sphere-sdk/connect/browser';

class SphereGameBridge {
  constructor() {
    this.client = null;
    this.identity = null;
    this.connected = false;
    this.onConnectedCallbacks = [];
  }

  async init() {
    const transport = new PostMessageTransport({
      targetWindow: window.parent,
      targetOrigin: '*', // restricted by ConnectHost's origin validation
    });

    this.client = new ConnectClient({
      transport,
      dapp: {
        name: 'UniQuake',
        description: 'Quake III Arena with UCT stakes',
        url: window.location.origin,
      },
      permissions: ['identity', 'balance', 'payments'],
    });

    const result = await this.client.connect();
    this.identity = result.identity;
    this.connected = true;

    // Notify waiting callbacks
    this.onConnectedCallbacks.forEach(cb => cb(this.identity));
    this.onConnectedCallbacks = [];
  }

  async getIdentity() {
    if (!this.connected) throw new Error('Not connected to wallet');
    return this.client.query('sphere_getIdentity');
  }

  async getBalance() {
    if (!this.connected) throw new Error('Not connected to wallet');
    return this.client.query('sphere_getAssets');
  }

  async payEntryFee(recipientNametag, amount, coinId, sessionId) {
    if (!this.connected) throw new Error('Not connected to wallet');
    return this.client.intent('send', {
      recipient: recipientNametag,
      amount: amount,
      coinId: coinId,
      memo: `UniQuake entry fee - Session ${sessionId}`,
    });
  }

  onConnected(callback) {
    if (this.connected) {
      callback(this.identity);
    } else {
      this.onConnectedCallbacks.push(callback);
    }
  }

  destroy() {
    if (this.client) {
      this.client.disconnect();
    }
  }
}

// Expose globally for game engine access
window.SPHERE_WALLET = new SphereGameBridge();

// Auto-init if in Sphere iframe
if (window.parent !== window) {
  window.SPHERE_WALLET.init().catch(err => {
    console.error('[sphere-bridge] Failed to connect to wallet:', err);
  });
}
```

### 2.2 Game Engine Integration Points

The existing QuakeJS signaling code (`lib/client/browser-server.js`, `lib/client/browser-mock-client.js`) needs modification to use `window.SPHERE_WALLET`:

**Join session flow (in browser):**
```javascript
async function joinGameSession(ws, sessionId) {
  // 1. Get player identity from Sphere wallet
  const identity = await window.SPHERE_WALLET.getIdentity();

  // 2. Send join request to server
  ws.send(JSON.stringify({
    type: 'join_session',
    nametag: identity.nametag,
    sessionId: sessionId,
  }));

  // 3. Wait for payment_required response (handled in ws.onmessage)
}

// In WebSocket message handler:
case 'payment_required':
  // Trigger wallet payment
  const result = await window.SPHERE_WALLET.payEntryFee(
    msg.recipientNametag,
    msg.amount,
    msg.coinId || 'UCT',
    msg.sessionId,
  );

  // Notify server payment was sent
  ws.send(JSON.stringify({
    type: 'payment_sent',
    sessionId: msg.sessionId,
    nametag: identity.nametag,
  }));
  break;
```

---

## 3. Sphere App Components

### 3.1 `QuakeGamePage.tsx`

```typescript
// React component that embeds QuakeJS in an iframe with ConnectHost bridge

interface QuakeGamePageProps {
  gameUrl: string;  // e.g., 'https://uniquake-dev.dyndns.org/quake?sphere=true'
}

// State:
//   - connection status (disconnected / connected / playing)
//   - player nametag
//   - current balance
//   - game session info (session ID, players, prize pool)
//   - pending payment request (for entry fee modal)

// ConnectHost setup:
//   - onConnectionRequest: auto-approve for known UniQuake origins
//   - onIntent('send'): show QuakeEntryFeeModal for user confirmation
//   - RPC queries: proxy to useWallet() hook

// Layout:
//   - Left 2/3: iframe (QuakeJS game)
//   - Right 1/3: WalletPanel (standard Sphere wallet)
//   - Top bar: session info, player count, prize pool
```

### 3.2 `QuakeEntryFeeModal.tsx`

```typescript
// Modal shown when the game requests an entry fee payment

// Displays:
//   - Game session name
//   - Entry fee amount (e.g., "10 UCT")
//   - Current wallet balance
//   - "Pay & Join" / "Cancel" buttons

// On confirm:
//   - Executes sphere.payments.send() via ConnectHost
//   - Returns success to the iframe's ConnectClient
//   - Updates wallet balance display

// On cancel:
//   - Returns error to ConnectClient
//   - Game shows "Payment cancelled" message
```

---

## 4. WebSocket Protocol Extensions

### 4.1 New Message Types (Client → Server)

```typescript
// Player requests to join a paid session
{ type: 'join_session', nametag: string, sessionId: string }

// Player confirms payment was sent
{ type: 'payment_sent', sessionId: string, nametag: string }

// Player requests their payment status
{ type: 'check_payment', sessionId: string, nametag: string }
```

### 4.2 New Message Types (Server → Client)

```typescript
// Server requests entry fee payment
{ type: 'payment_required',
  sessionId: string,
  amount: string,          // smallest units
  coinId: string,          // 'UCT'
  recipientNametag: string,// server wallet nametag
  recipientAddress: string // DIRECT:// address (fallback)
}

// Server confirms payment received
{ type: 'payment_confirmed',
  sessionId: string,
  player: string           // nametag
}

// Payment verification failed or timed out
{ type: 'payment_failed',
  sessionId: string,
  player: string,
  reason: string
}

// Match ended with payout
{ type: 'match_payout',
  sessionId: string,
  winner: string,          // nametag
  isBot: boolean,
  prizePool: string,       // human-readable UCT
  paidTo: string,          // recipient nametag
  txStatus: 'confirmed' | 'pending' | 'failed'
}
```

---

## 5. Winner Determination Logic

### 5.1 Score Extraction

The existing `server-cli.js` and `signaling-service.js` already track player scores. The PaymentManager hooks into the match-end event.

### 5.2 Winner Rules

```javascript
function determineWinner(escrow, scores) {
  // scores: [{ name: string, score: number, isBot: boolean }]

  // Sort by score descending
  const sorted = [...scores].sort((a, b) => b.score - a.score);
  const topPlayer = sorted[0];

  if (!topPlayer) {
    return { winnerNametag: null, isWinnerBot: true };
  }

  return {
    winnerNametag: topPlayer.name,  // nametag or bot name
    isWinnerBot: topPlayer.isBot,
    score: topPlayer.score,
  };
}
```

### 5.3 Payout Decision Matrix

| Winner | Session Type | Payout Recipient |
|--------|-------------|-----------------|
| Human player | Any | The winning player's nametag |
| Bot | Custom session | Session creator's nametag |
| Bot | Default session | `UNIQUAKE_DEFAULT_PAYOUT_NAMETAG` (default: `babaika10`) |
| No players | Any | No payout (prize pool = 0) |
| Transfer fails | Any | Funds retained in server wallet; logged for manual resolution |

---

## 6. Error Handling

### 6.1 Payment Failures

| Scenario | Handling |
|----------|---------|
| Player has insufficient UCT | ConnectClient returns error; game shows "Insufficient balance" |
| Player cancels payment modal | ConnectClient returns cancelled; game shows "Payment required to play" |
| Payment sent but not received by server within 60s | Server polls `sphere.payments.receive()` every 10s; after 60s timeout, player is removed from pending |
| Nostr relay unavailable | Sphere SDK retries with exponential backoff; if all relays fail, payment cannot be verified |
| Aggregator unavailable | Transfer commitment queued locally by sphere-sdk; confirmed when aggregator returns |
| Payout transfer fails | Funds remain in server wallet; error logged; admin can manually retry via CLI |
| Nametag resolution fails | Payout falls back to DIRECT address if available; otherwise retained |

### 6.2 Game Lifecycle Errors

| Scenario | Handling |
|----------|---------|
| Server crashes during active match | Docker restarts container; PaymentManager reloads wallet; pending sessions are marked as interrupted; fees are retained (no auto-refund) |
| Player disconnects during match | Player's fee is already in the pool; they forfeit (standard game behavior) |
| Match end event not received | Token monitoring detects inactive servers (>60s); forces match end and payout |
| Multiple simultaneous payouts | `sphere.payments.send()` is called sequentially (one payout per match end); SpendPlanner prevents double-spend |

---

## 7. Testing Strategy

### 7.1 Unit Tests

- `SessionEscrow`: player add/remove, payment confirmation, prize pool calculation, payout recipient logic
- `PayoutEngine`: winner determination across all matrix scenarios
- `PaymentManager`: mock sphere-sdk, verify correct API calls

### 7.2 Integration Tests

- Sphere SDK testnet: init wallet, request faucet, send/receive UCT
- Full join flow: mock WebSocket client → join_session → payment_required → payment_sent → payment_confirmed
- Full payout flow: mock match end → determine winner → send winnings → verify receipt

### 7.3 End-to-End Tests

- Sphere app + QuakeJS iframe: ConnectHost ↔ ConnectClient handshake
- Entry fee modal: confirm and cancel paths
- Full game: join → play → match end → payout → balance update

---

## 8. Deployment Considerations

### 8.1 Docker Image Changes

- Add `@unicitylabs/sphere-sdk` and `ws@8.x` to `package.json`
- Rebuild Docker image (`./docker/build.sh`)
- Add `UNIQUAKE_MNEMONIC` to container environment (via `start-quake.sh --mnemonic` or `.env`)
- The mnemonic MUST NOT be baked into the image — pass via env var at runtime

### 8.2 Sphere App Deployment

- Add UniQuake components to Sphere build
- Configure `VITE_UNIQUAKE_URL` environment variable (points to UniQuake server)
- Deploy updated Sphere SPA

### 8.3 First-Time Setup

1. Generate a mnemonic for the game server: `npx sphere-cli init --network testnet --nametag babaika10`
2. Fund the server wallet from faucet: `npx sphere-cli topup`
3. Export the mnemonic and set as `UNIQUAKE_MNEMONIC` env var
4. Start UniQuake with `./start-quake.sh --domain uniquake-dev.dyndns.org`
5. Verify server wallet: `docker exec uniquake node -e "... sphere status ..."`
