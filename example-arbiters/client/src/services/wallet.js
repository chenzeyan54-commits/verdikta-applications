/**
 * Wallet Service (injected wallet)
 *
 * Singleton that wraps the injected EIP-1193 provider via ethers v6. Provider
 * selection goes through ./injectedProvider (EIP-6963 first, legacy
 * window.ethereum second) so requests reach MetaMask even when another
 * extension has overwritten window.ethereum. Adapted from
 * example-bounty-program's wallet service, but with one deliberate difference:
 * this app's network is chosen by the header selector at runtime, not baked in
 * at build time. So the service only *tracks* the wallet's chainId — it never
 * enforces a specific chain or auto-disconnects on mismatch. Deciding whether
 * the wallet's chain matches the selected network (and prompting a switch) is
 * the UI's job (see MyArbiters).
 */

import { ethers } from 'ethers';
import {
  selectInjectedProvider,
  refreshDiscovery,
  walletEnvironment,
  withTimeout,
  explainWalletError,
  CONNECT_TIMEOUT_MS,
} from './injectedProvider';

const STORAGE_KEY = 'arbiters_wallet_connected';

// localStorage throws in some private / blocked-storage modes; never let the
// remembered-connection flag break the actual connection.
const safeStorage = {
  get(key) { try { return window.localStorage.getItem(key); } catch { return null; } },
  set(key, value) { try { window.localStorage.setItem(key, value); } catch { /* ignore */ } },
  remove(key) { try { window.localStorage.removeItem(key); } catch { /* ignore */ } },
};

function noProviderError() {
  const err = new Error('No wallet extension detected.');
  err.code = 'VERDIKTA_NO_PROVIDER';
  return err;
}

class WalletService {
  constructor() {
    this.provider = null;
    this.signer = null;
    this.address = null;
    this.chainId = null;
    this.injected = null;      // raw EIP-1193 provider we talk to
    this.connecting = false;
    this.lastError = null;     // { code, message, hint, link? } from explainWalletError
    this.lastDiagnostics = null;
    this.listeners = new Set();
  }

  /** Re-run EIP-6963 discovery (wallets can inject late) and pick a provider. */
  async resolveInjected() {
    await refreshDiscovery();
    this.injected = selectInjectedProvider();
    return this.injected;
  }

  getInjectedProvider() {
    if (!this.injected) this.injected = selectInjectedProvider();
    return this.injected;
  }

  /** Any injected EIP-1193 wallet, not only MetaMask (name kept for callers). */
  isMetaMaskInstalled() {
    return typeof window !== 'undefined' && !!this.getInjectedProvider();
  }

  getDiagnostics() {
    return this.lastDiagnostics || walletEnvironment();
  }

  clearError() {
    if (!this.lastError) return;
    this.lastError = null;
    this.notifyListeners();
  }

  subscribe(callback) {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  notifyListeners() {
    const state = this.getState();
    this.listeners.forEach((cb) => cb(state));
  }

  /** Build provider/signer for an authorized account and read the chain id. */
  async _hydrate(address) {
    this.provider = new ethers.BrowserProvider(this.getInjectedProvider());
    this.signer = await this.provider.getSigner();
    this.address = address;
    const net = await this.provider.getNetwork();
    this.chainId = Number(net.chainId);
  }

  /**
   * Silent reconnect on page load if the user connected before and is still
   * authorized. Uses eth_accounts (no popup).
   */
  async tryReconnect() {
    const injected = await this.resolveInjected();
    if (!injected) return null;
    if (safeStorage.get(STORAGE_KEY) !== 'true') return null;
    try {
      // Short timeout: a stuck extension must not stall page load.
      const accounts = await withTimeout(
        injected.request({ method: 'eth_accounts' }), 10_000, 'eth_accounts'
      );
      if (!accounts || !accounts.length) {
        safeStorage.remove(STORAGE_KEY);
        return null;
      }
      await this._hydrate(accounts[0]);
      this.setupEventListeners();
      this.notifyListeners();
      return this.getState();
    } catch (error) {
      console.warn('Wallet auto-reconnect failed:', error.message);
      safeStorage.remove(STORAGE_KEY);
      return null;
    }
  }

  /**
   * User-initiated connect. Opens MetaMask's account picker every time so the
   * user can choose / switch which account to connect.
   *
   * Plain eth_requestAccounts silently reuses the already-permitted account once
   * the site is authorized, so disconnect→reconnect always returned the same
   * address. Requesting the eth_accounts permission forces the selection dialog.
   */
  async connect() {
    if (this.connecting) {
      const err = new Error('A connection attempt is already in progress.');
      err.code = -32002;
      throw err;
    }
    this.connecting = true;
    this.lastError = null;
    this.notifyListeners();

    const env = walletEnvironment();
    this.lastDiagnostics = env;
    // Always log — a screenshot of the console is the cheapest bug report.
    console.info('[wallet] connect attempt', env);

    try {
      const injected = await this.resolveInjected();
      if (!injected) throw noProviderError();

      // Every wallet request is bounded: a wallet that never answers (hidden
      // prompt, stuck extension, wrong wallet grabbed the injection) must
      // surface as an error rather than an eternal silence.
      try {
        await withTimeout(
          injected.request({ method: 'wallet_requestPermissions', params: [{ eth_accounts: {} }] }),
          CONNECT_TIMEOUT_MS,
          'wallet_requestPermissions'
        );
      } catch (err) {
        if (err?.code === 4001 || err?.code === -32002 || err?.code === 'VERDIKTA_TIMEOUT') throw err;
        // Wallet doesn't support wallet_requestPermissions — fall back to the
        // plain account request below (no picker, but still connects).
        console.warn('[wallet] wallet_requestPermissions unsupported, falling back:', err?.message || err);
      }
      const accounts = await withTimeout(
        injected.request({ method: 'eth_requestAccounts' }),
        CONNECT_TIMEOUT_MS,
        'eth_requestAccounts'
      );
      if (!accounts || !accounts.length) throw new Error('Wallet returned no accounts.');
      await this._hydrate(accounts[0]);
      this.setupEventListeners();
      safeStorage.set(STORAGE_KEY, 'true');
      console.info('[wallet] connected', { address: this.address, chainId: this.chainId });
      return this.getState();
    } catch (error) {
      this.lastError = explainWalletError(error, env);
      console.error('[wallet] connect failed:', error, this.lastError);
      throw error;
    } finally {
      this.connecting = false;
      this.notifyListeners();
    }
  }

  /**
   * Disconnect. `revoke: true` (user clicked Disconnect) also asks the wallet
   * to drop this site's account permission (best effort). Internal callers
   * (account removed) leave the permission alone.
   */
  disconnect({ revoke = false } = {}) {
    if (revoke) {
      const injected = this.getInjectedProvider();
      if (injected) {
        injected.request({
          method: 'wallet_revokePermissions',
          params: [{ eth_accounts: {} }],
        }).then(
          () => console.info('[wallet] site permission revoked'),
          (err) => console.warn('[wallet] wallet_revokePermissions not supported or failed:', err?.message || err)
        );
      }
    }
    this.provider = null;
    this.signer = null;
    this.address = null;
    this.chainId = null;
    this.lastError = null;
    safeStorage.remove(STORAGE_KEY);
    this.notifyListeners();
  }

  /**
   * Ask MetaMask to switch to a chain (from config/chains.js). If the chain is
   * unknown to the wallet (4902) we add it first. The chainChanged listener
   * refreshes our state once the switch lands.
   */
  async switchChain(chain) {
    const injected = this.getInjectedProvider();
    if (!injected) throw noProviderError();
    try {
      await injected.request({
        method: 'wallet_switchEthereumChain',
        params: [{ chainId: chain.chainIdHex }],
      });
    } catch (error) {
      if (error.code === 4902) {
        await injected.request({
          method: 'wallet_addEthereumChain',
          params: [{
            chainId: chain.chainIdHex,
            chainName: chain.name,
            nativeCurrency: chain.currency,
            rpcUrls: [chain.rpcUrl],
            blockExplorerUrls: [chain.explorer],
          }],
        });
      } else if (error.code === 4001) {
        throw new Error('Network switch rejected.');
      } else {
        throw error;
      }
    }
  }

  setupEventListeners() {
    const injected = this.getInjectedProvider();
    if (!injected || typeof injected.on !== 'function') return;

    if (this.listenerTarget && typeof this.listenerTarget.removeListener === 'function') {
      if (this.handleAccountsChanged) {
        this.listenerTarget.removeListener('accountsChanged', this.handleAccountsChanged);
      }
      if (this.handleChainChanged) {
        this.listenerTarget.removeListener('chainChanged', this.handleChainChanged);
      }
    }
    this.listenerTarget = injected;

    this.handleAccountsChanged = async (accounts) => {
      if (!accounts.length) {
        this.disconnect();
        return;
      }
      if (accounts[0] !== this.address) {
        this.address = accounts[0];
        if (this.provider) {
          try {
            this.signer = await this.provider.getSigner();
          } catch (e) {
            console.error('Failed to refresh signer after account change:', e);
          }
        }
        this.notifyListeners();
      }
    };

    this.handleChainChanged = async (chainIdHex) => {
      this.chainId = parseInt(chainIdHex, 16);
      // Recreate provider/signer so they bind to the new chain. We do NOT
      // disconnect on mismatch — the UI surfaces a "switch network" prompt.
      if (injected && this.address) {
        try {
          this.provider = new ethers.BrowserProvider(injected);
          this.signer = await this.provider.getSigner();
        } catch (e) {
          console.error('Failed to refresh provider after chain change:', e);
        }
      }
      this.notifyListeners();
    };

    injected.on('accountsChanged', this.handleAccountsChanged);
    injected.on('chainChanged', this.handleChainChanged);
  }

  getState() {
    return {
      isConnected: !!this.address,
      address: this.address,
      chainId: this.chainId,
      connecting: this.connecting,
      hasProvider: this.isMetaMaskInstalled(),
      lastError: this.lastError,
    };
  }

  getProvider() {
    return this.provider;
  }

  getSigner() {
    return this.signer;
  }
}

export const walletService = new WalletService();
export default walletService;
