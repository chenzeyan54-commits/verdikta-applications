/**
 * Wallet Service
 * Handles wallet connection and network management.
 *
 * Provider selection goes through ./injectedProvider (EIP-6963 first, legacy
 * window.ethereum second) so the request is routed to MetaMask even when
 * another extension has overwritten window.ethereum. Every connect attempt
 * logs a diagnostics snapshot and exposes a structured `lastError` so the UI
 * can show something actionable instead of silently doing nothing.
 */

import { ethers } from 'ethers';
import { config, currentNetwork } from '../config';
import {
  selectInjectedProvider,
  refreshDiscovery,
  walletEnvironment,
  withTimeout,
  explainWalletError,
  storageAvailable,
  CONNECT_TIMEOUT_MS,
} from './injectedProvider';

// Network-aware storage key to support multi-network deployments
const NETWORK = config.network || 'base-sepolia';
const STORAGE_KEY = `wallet_was_connected_${NETWORK}`;

// localStorage throws in some private / blocked-storage modes. Never let a
// remembered-connection flag break the actual connection.
const safeStorage = {
  get(key) {
    try { return window.localStorage.getItem(key); } catch { return null; }
  },
  set(key, value) {
    try { window.localStorage.setItem(key, value); } catch { /* ignore */ }
  },
  remove(key) {
    try { window.localStorage.removeItem(key); } catch { /* ignore */ }
  },
};

function noProviderError() {
  const err = new Error('No wallet extension detected.');
  err.code = 'VERDIKTA_NO_PROVIDER';
  return err;
}

class WalletService {
  constructor() {
    this.injected = null;      // the raw EIP-1193 provider we talk to
    this.provider = null;      // ethers BrowserProvider wrapping `injected`
    this.signer = null;
    this.address = null;
    this.chainId = null;
    this.connecting = false;
    this.lastError = null;     // { code, message, hint, link? } from explainWalletError
    this.lastDiagnostics = null;
    this.listeners = new Set();
  }

  /**
   * Resolve the injected provider we should use, re-running EIP-6963
   * discovery in case a wallet injected after page load.
   */
  async resolveInjected() {
    await refreshDiscovery();
    this.injected = selectInjectedProvider();
    return this.injected;
  }

  /** Synchronous accessor used by contractService and the header. */
  getInjectedProvider() {
    if (!this.injected) this.injected = selectInjectedProvider();
    return this.injected;
  }

  /**
   * Try to silently reconnect if user was previously connected.
   * Uses eth_accounts (no prompt) instead of eth_requestAccounts.
   * Call this on app initialization.
   */
  async tryReconnect() {
    const injected = await this.resolveInjected();
    if (!injected) return null;

    // Check if user previously connected
    const wasConnected = safeStorage.get(STORAGE_KEY) === 'true';
    if (!wasConnected) return null;

    try {
      // eth_accounts returns accounts if already authorized (no prompt).
      // Short timeout: a stuck extension must not stall page load.
      const accounts = await withTimeout(
        injected.request({ method: 'eth_accounts' }),
        10_000,
        'eth_accounts'
      );

      if (!accounts || accounts.length === 0) {
        // User revoked access or never authorized
        safeStorage.remove(STORAGE_KEY);
        return null;
      }

      // User is still authorized - reconnect silently
      this.provider = new ethers.BrowserProvider(injected);
      this.signer = await this.provider.getSigner();
      this.address = accounts[0];

      const network = await this.provider.getNetwork();
      this.chainId = Number(network.chainId);

      // Don't auto-reconnect if on wrong network
      if (this.chainId !== currentNetwork.chainId) {
        console.warn(`Auto-reconnect skipped: wallet on chain ${this.chainId}, expected ${currentNetwork.chainId}`);
        this.provider = null;
        this.signer = null;
        this.address = null;
        this.chainId = null;
        return null;
      }

      this.setupEventListeners();
      this.notifyListeners();

      console.log('✅ Wallet auto-reconnected:', this.address);

      return {
        address: this.address,
        chainId: this.chainId,
        isCorrectNetwork: true
      };
    } catch (error) {
      console.warn('Auto-reconnect failed:', error.message);
      safeStorage.remove(STORAGE_KEY);
      return null;
    }
  }

  /**
   * Check if an injected wallet is available.
   * (Name kept for backwards compatibility — it is any EIP-1193 wallet, not
   * only MetaMask.)
   */
  isMetaMaskInstalled() {
    return typeof window !== 'undefined' && !!this.getInjectedProvider();
  }

  /**
   * Subscribe to wallet state changes
   */
  subscribe(callback) {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  /**
   * Notify all subscribers of state change
   */
  notifyListeners() {
    const state = this.getState();
    this.listeners.forEach(callback => callback(state));
  }

  /**
   * Connect to the injected wallet.
   *
   * Throws a raw wallet error; callers should pass it through
   * `walletService.lastError` (already explained) or explainWalletError().
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

      // Request account access. Bounded: a wallet that never answers (hidden
      // prompt, stuck extension, wrong wallet grabbed window.ethereum) must
      // surface as an error rather than an eternal silence.
      const accounts = await withTimeout(
        injected.request({ method: 'eth_requestAccounts' }),
        CONNECT_TIMEOUT_MS,
        'eth_requestAccounts'
      );
      if (!accounts || accounts.length === 0) {
        throw new Error('Wallet returned no accounts.');
      }

      // Create provider and signer
      this.provider = new ethers.BrowserProvider(injected);
      this.signer = await this.provider.getSigner();
      this.address = accounts[0];

      // Get current chain ID
      const network = await withTimeout(this.provider.getNetwork(), 15_000, 'eth_chainId');
      this.chainId = Number(network.chainId);

      // Check if on correct network - prompt to switch if wrong
      if (this.chainId !== currentNetwork.chainId) {
        console.warn(`Connected to chain ${this.chainId}, expected ${currentNetwork.chainId}. Prompting switch.`);
        try {
          await this.switchNetwork();

          // Give the wallet time to process the switch before polling
          await new Promise(resolve => setTimeout(resolve, 1000));

          // Poll for network switch to complete (up to 6 seconds total)
          let switched = false;
          for (let i = 0; i < 12; i++) {
            try {
              // Recreate provider to get fresh network state
              this.provider = new ethers.BrowserProvider(injected);
              const updatedNetwork = await this.provider.getNetwork();
              this.chainId = Number(updatedNetwork.chainId);
              if (this.chainId === currentNetwork.chainId) {
                switched = true;
                break;
              }
            } catch {
              // Provider might not be ready yet, keep trying
              console.log(`Network check failed, retrying... attempt ${i + 1}/12`);
            }
            await new Promise(resolve => setTimeout(resolve, 500));
          }

          if (!switched) {
            throw new Error('Network switch timed out');
          }

          // Recreate signer on the correct network
          this.signer = await this.provider.getSigner();
        } catch (switchError) {
          // User rejected or switch failed - clean up
          console.warn('Network switch failed:', switchError);
          this.provider = null;
          this.signer = null;
          this.address = null;
          this.chainId = null;
          const err = new Error(
            `Please switch to ${currentNetwork.name} to connect` +
            (switchError?.message ? ` (${switchError.message})` : '') + '.'
          );
          err.code = 'VERDIKTA_WRONG_NETWORK';
          err.cause = switchError;
          throw err;
        }
      }

      // Set up wallet event listeners
      this.setupEventListeners();

      // Remember that user connected (for auto-reconnect after refresh)
      safeStorage.set(STORAGE_KEY, 'true');

      console.info('[wallet] connected', { address: this.address, chainId: this.chainId, storage: storageAvailable() });
      return {
        address: this.address,
        chainId: this.chainId,
        isCorrectNetwork: this.chainId === currentNetwork.chainId
      };
    } catch (error) {
      this.lastError = explainWalletError(error, env);
      console.error('[wallet] connect failed:', error, this.lastError);
      throw error;
    } finally {
      this.connecting = false;
      // Notify subscribers (state now carries either the address or lastError)
      this.notifyListeners();
    }
  }

  /**
   * Disconnect wallet.
   *
   * @param {{revoke?: boolean}} [opts] - `revoke: true` (user clicked
   *   Disconnect) also asks the wallet to drop this site's account permission
   *   so the next Connect shows a prompt again. Without it MetaMask keeps the
   *   permission and `eth_requestAccounts` resolves silently. Internal callers
   *   (account removed, wrong network) leave the permission alone.
   */
  disconnect({ revoke = false } = {}) {
    if (revoke) {
      const injected = this.getInjectedProvider();
      if (injected) {
        // Best effort, fire-and-forget: MetaMask supports it, other wallets may not.
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

    // Clear auto-reconnect flag
    safeStorage.remove(STORAGE_KEY);

    this.notifyListeners();
  }

  /** Clear the last connection error (e.g. user dismissed the notice). */
  clearError() {
    if (!this.lastError) return;
    this.lastError = null;
    this.notifyListeners();
  }

  /**
   * Switch to correct network
   * Note: This only requests the switch. Caller should poll for completion.
   */
  async switchNetwork() {
    const injected = this.getInjectedProvider();
    if (!injected) throw noProviderError();

    try {
      await injected.request({
        method: 'wallet_switchEthereumChain',
        params: [{ chainId: currentNetwork.chainIdHex }]
      });
      // Don't update state here - let caller poll for the switch to complete
      return true;
    } catch (error) {
      // Network doesn't exist, try to add it
      if (error.code === 4902) {
        return await this.addNetwork();
      } else if (error.code === 4001) {
        // User rejected the request
        throw new Error('Network switch rejected by user');
      } else {
        throw error;
      }
    }
  }

  /**
   * Add network to the wallet
   */
  async addNetwork() {
    const injected = this.getInjectedProvider();
    if (!injected) throw noProviderError();
    try {
      await injected.request({
        method: 'wallet_addEthereumChain',
        params: [{
          chainId: currentNetwork.chainIdHex,
          chainName: currentNetwork.name,
          nativeCurrency: currentNetwork.currency,
          rpcUrls: [currentNetwork.rpcUrl],
          blockExplorerUrls: [currentNetwork.explorer]
        }]
      });
      // Don't update state here - let caller poll for the switch to complete
      return true;
    } catch (error) {
      console.error('Failed to add network:', error);
      throw error;
    }
  }

  /**
   * Set up wallet event listeners
   */
  setupEventListeners() {
    const injected = this.getInjectedProvider();
    if (!injected || typeof injected.on !== 'function') return;

    // Remove existing listeners to prevent duplicates (only if they exist)
    if (this.listenerTarget && typeof this.listenerTarget.removeListener === 'function') {
      if (this.handleAccountsChanged) {
        this.listenerTarget.removeListener('accountsChanged', this.handleAccountsChanged);
      }
      if (this.handleChainChanged) {
        this.listenerTarget.removeListener('chainChanged', this.handleChainChanged);
      }
    }
    this.listenerTarget = injected;

    // Account changed
    this.handleAccountsChanged = async (accounts) => {
      console.log('Accounts changed:', accounts);

      if (accounts.length === 0) {
        // User disconnected
        this.disconnect();
      } else if (accounts[0] !== this.address) {
        // Account switched
        this.address = accounts[0];

        // Update signer
        if (this.provider) {
          try {
            this.signer = await this.provider.getSigner();
          } catch (error) {
            console.error('Failed to get signer after account change:', error);
          }
        }

        this.notifyListeners();
      }
    };

    // Chain changed
    this.handleChainChanged = async (chainIdHex) => {
      console.log('Chain changed:', chainIdHex);

      const newChainId = parseInt(chainIdHex, 16);
      this.chainId = newChainId;

      // Recreate provider and signer for new network
      if (injected && this.address) {
        try {
          this.provider = new ethers.BrowserProvider(injected);
          this.signer = await this.provider.getSigner();
        } catch (error) {
          console.error('Failed to update provider after chain change:', error);
        }
      }

      // Auto-disconnect if on wrong network
      if (newChainId !== currentNetwork.chainId) {
        console.warn(
          `Wrong network detected. Connected to chain ${newChainId}, ` +
          `expected ${currentNetwork.chainId} (${currentNetwork.name}). Disconnecting.`
        );
        this.disconnect();
        return;
      }

      this.notifyListeners();
    };

    injected.on('accountsChanged', this.handleAccountsChanged);
    injected.on('chainChanged', this.handleChainChanged);
  }

  /**
   * Get current wallet state
   */
  getState() {
    return {
      isConnected: !!this.address,
      address: this.address,
      chainId: this.chainId,
      isCorrectNetwork: this.chainId === currentNetwork.chainId,
      expectedChainId: currentNetwork.chainId,
      expectedNetwork: currentNetwork.name,
      connecting: this.connecting,
      hasProvider: this.isMetaMaskInstalled(),
      lastError: this.lastError,
    };
  }

  /**
   * Diagnostics snapshot for support (also logged on each connect attempt).
   */
  getDiagnostics() {
    return this.lastDiagnostics || walletEnvironment();
  }

  /**
   * Format address for display
   */
  formatAddress(address) {
    if (!address) return '';
    return `${address.substring(0, 6)}...${address.substring(address.length - 4)}`;
  }

  /**
   * Get provider (for contract interactions)
   */
  getProvider() {
    return this.provider;
  }

  /**
   * Get signer (for transactions)
   */
  getSigner() {
    return this.signer;
  }

  /**
   * Get network name from chain ID
   */
  getNetworkName(chainId) {
    const networks = {
      1: 'Ethereum Mainnet',
      5: 'Goerli Testnet',
      11155111: 'Sepolia Testnet',
      8453: 'Base Mainnet',
      84532: 'Base Sepolia',
      137: 'Polygon Mainnet',
      80001: 'Mumbai Testnet'
    };
    return networks[chainId] || `Chain ${chainId}`;
  }
}

// Export singleton instance
export const walletService = new WalletService();
export default walletService;
