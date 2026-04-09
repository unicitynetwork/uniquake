/**
 * Sphere Wallet Bridge for UniQuake
 *
 * Connects to the Sphere wallet via the Connect protocol using autoConnect().
 * Supports all three transport modes: iframe, extension, and popup.
 * Exposes window.SPHERE_WALLET for game engine access.
 *
 * Requires: sphere-connect-bundle.js loaded before this script
 *   <script src="/public/sphere-connect-bundle.js"></script>
 *   <script src="/lib/client/sphere-game-bridge.js"></script>
 *
 * Usage:
 *   Load page with ?sphere=true to auto-connect, or call:
 *   window.SPHERE_WALLET.init({ walletUrl: '...' });
 */
(function(window) {
  'use strict';

  var LOG_PREFIX = '[sphere-bridge]';

  /**
   * SphereGameBridge provides a high-level API for interacting with the
   * Sphere wallet from the UniQuake game client.
   */
  class SphereGameBridge {
    constructor() {
      /** @type {object|null} ConnectClient instance */
      this.client = null;
      /** @type {object|null} Connection result from autoConnect */
      this.connection = null;
      /** @type {object|null} Player identity (nametag, directAddress, chainPubkey) */
      this.identity = null;
      /** @type {boolean} Whether the wallet is connected */
      this.connected = false;
      /** @type {'iframe'|'extension'|'popup'|null} Active transport mode */
      this.transport = null;
      /** @type {function|null} Disconnect callback from autoConnect */
      this.disconnectFn = null;
      /** @type {string|null} S8: Pinned server nametag for sender validation */
      this.serverNametag = null;
      /** @type {string|null} Admission token received from server */
      this.admissionToken = null;
      /** @type {string|null} Current game session ID */
      this.currentSessionId = null;
    }

    /**
     * Initialize the wallet connection via Sphere Connect autoConnect.
     *
     * @param {object} [config] - Configuration options
     * @param {string} [config.walletUrl] - Sphere wallet URL for popup mode
     * @param {string} [config.serverNametag] - S8: expected server nametag to pin
     * @param {string} [config.sphereOrigin] - S9: expected Sphere origin for PostMessage validation
     * @returns {Promise<void>}
     * @throws {Error} If SphereConnect bundle is not loaded
     */
    async init(config) {
      var cfg = config || window.UNIQUAKE_CONFIG || {};
      this.serverNametag = cfg.serverNametag || null;

      // Verify SphereConnect global is available
      if (!window.SphereConnect || !window.SphereConnect.autoConnect) {
        throw new Error(
          'SphereConnect bundle not loaded. Include sphere-connect-bundle.js before this script.'
        );
      }

      var walletUrl = cfg.walletUrl || 'https://sphere.unicity.network';

      var result = await window.SphereConnect.autoConnect({
        dapp: {
          name: 'UniQuake',
          description: 'Quake III Arena with UCT stakes',
          url: window.location.origin,
          icon: window.location.origin + '/favicon.ico',
        },
        walletUrl: walletUrl,
        // S12: minimal permission scope — no 'payments', only intents
        permissions: ['identity', 'balance', 'invoices'],
      });

      this.client = result.client;
      this.connection = result.connection;
      this.identity = result.connection.identity;
      this.transport = result.transport;
      this.disconnectFn = result.disconnect;
      this.connected = true;

      console.log(
        LOG_PREFIX + ' Connected via ' + this.transport
      );
      console.log(
        LOG_PREFIX + ' Identity: ' +
        (this.identity.nametag || this.identity.directAddress)
      );
    }

    // ── Internal helpers ──

    /**
     * Assert that the wallet is connected before performing an operation.
     *
     * @param {string} operation - Name of the operation for the error message
     * @throws {Error} If the wallet is not connected
     * @private
     */
    _requireConnection(operation) {
      if (!this.connected || !this.client) {
        throw new Error(
          LOG_PREFIX + ' Wallet not connected. Call init() before ' + operation + '(). ' +
          'Load the page with ?sphere=true or call window.SPHERE_WALLET.init().'
        );
      }
    }

    /**
     * S8: Validate that a sender nametag matches the pinned server nametag.
     * Use this to verify DM messages or server-originated data before processing.
     *
     * @param {string} senderNametag - The nametag of the message sender
     * @returns {boolean} True if the sender matches the pinned server nametag
     */
    isFromServer(senderNametag) {
      if (!this.serverNametag) {
        console.warn(
          LOG_PREFIX + ' No server nametag pinned. ' +
          'Set serverNametag in init config for S8 protection.'
        );
        return false;
      }

      // Normalize: strip leading '@' for comparison
      var pinned = this.serverNametag.replace(/^@/, '');
      var sender = (senderNametag || '').replace(/^@/, '');

      return pinned === sender;
    }

    // ── Queries (no user confirmation required) ──

    /**
     * Get the connected wallet's identity information.
     *
     * @returns {Promise<object>} Identity object with nametag, directAddress, chainPubkey
     */
    async getIdentity() {
      this._requireConnection('getIdentity');
      return this.client.query('sphere_getIdentity');
    }

    /**
     * Get the connected wallet's asset balances.
     *
     * @returns {Promise<Array>} Array of asset objects with coin and balance info
     */
    async getBalance() {
      this._requireConnection('getBalance');
      return this.client.query('sphere_getAssets');
    }

    /**
     * Resolve a nametag to its address and public key.
     *
     * @param {string} nametag - The nametag to resolve (e.g. '@playername')
     * @returns {Promise<object>} Resolved identity with directAddress
     */
    async resolve(nametag) {
      this._requireConnection('resolve');
      return this.client.query('sphere_resolve', { nametag: nametag });
    }

    /**
     * Check the status of an invoice.
     *
     * @param {string} invoiceId - The invoice ID to check
     * @returns {Promise<object>} Invoice status with state field
     */
    async getInvoiceStatus(invoiceId) {
      this._requireConnection('getInvoiceStatus');
      return this.client.query('sphere_getInvoiceStatus', { invoiceId: invoiceId });
    }

    // ── Intents (wallet shows confirmation UI to user) ──

    /**
     * Pay an invoice via the wallet. The wallet displays a confirmation modal
     * showing the amount and recipient. User must approve.
     *
     * @param {string} invoiceId - The invoice ID to pay (e.g. entry fee invoice)
     * @returns {Promise<object>} Payment result from the wallet
     * @throws {Error} If user cancels or payment fails
     */
    async payInvoice(invoiceId) {
      this._requireConnection('payInvoice');
      return this.client.intent('pay_invoice', {
        invoiceId: invoiceId,
        targetIndex: 0,
        assetIndex: 0,
      });
    }

    /**
     * Request the wallet to sign an arbitrary message. The wallet displays
     * the message and asks for user confirmation.
     *
     * @param {string} message - The message to sign
     * @returns {Promise<object>} Signature result from the wallet
     * @throws {Error} If user cancels or signing fails
     */
    async signMessage(message) {
      this._requireConnection('signMessage');
      return this.client.intent('sign_message', { message: message });
    }

    // ── Admission token management ──

    /**
     * Store the admission token received from the server after payment
     * confirmation. This token is presented on the WebSocket connection
     * to prove the player has paid (S1: admission gate).
     *
     * @param {string} token - The admission token from join_confirmed DM
     * @param {string} sessionId - The session ID this token is valid for
     */
    setAdmissionToken(token, sessionId) {
      this.admissionToken = token;
      this.currentSessionId = sessionId;
      console.log(
        LOG_PREFIX + ' Admission token set for session ' + sessionId
      );
    }

    /**
     * Get the current admission token.
     *
     * @returns {string|null} The admission token, or null if not set
     */
    getAdmissionToken() {
      return this.admissionToken;
    }

    /**
     * Get the current session ID.
     *
     * @returns {string|null} The session ID, or null if not in a session
     */
    getCurrentSessionId() {
      return this.currentSessionId;
    }

    /**
     * Clear the admission token and session ID.
     * Called when disconnecting from a game session.
     */
    clearAdmissionToken() {
      this.admissionToken = null;
      this.currentSessionId = null;
    }

    // ── Lifecycle ──

    /**
     * Disconnect from the Sphere wallet. Clears all state.
     * The game continues to function in legacy mode without a wallet.
     *
     * @returns {Promise<void>}
     */
    async disconnect() {
      if (this.disconnectFn) {
        try {
          await this.disconnectFn();
        } catch (err) {
          console.warn(LOG_PREFIX + ' Disconnect error:', err.message);
        }
      }

      this.client = null;
      this.connection = null;
      this.identity = null;
      this.connected = false;
      this.transport = null;
      this.disconnectFn = null;
      this.admissionToken = null;
      this.currentSessionId = null;

      console.log(LOG_PREFIX + ' Disconnected from wallet');
    }
  }

  // Expose globally for game engine access
  window.SPHERE_WALLET = new SphereGameBridge();

  // Auto-init when ?sphere=true is in the URL
  if (new URLSearchParams(window.location.search).get('sphere') === 'true') {
    var walletUrl = new URLSearchParams(window.location.search).get('walletUrl');
    window.SPHERE_WALLET.init({
      walletUrl: walletUrl || undefined,
    }).catch(function(err) {
      console.error(LOG_PREFIX + ' Connection failed:', err.message);
      // Game still works without wallet in legacy mode
    });
  }

})(window);
