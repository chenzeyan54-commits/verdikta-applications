/**
 * Injected wallet provider discovery + diagnostics.
 *
 * Why this exists: the app used to grab `window.ethereum` blindly. That object
 * is a free-for-all — Brave Wallet, Phantom, Coinbase Wallet, OKX, Rabby and
 * others all overwrite it, so a click on "Connect Wallet" could be routed to a
 * wallet the user never set up and simply hang. EIP-6963 lets every installed
 * wallet announce itself instead; we listen for those announcements and prefer
 * MetaMask, falling back to the legacy `window.ethereum` object.
 *
 * It also centralises the "why did this fail?" mapping so the header can show
 * an actionable message instead of a 2-second toast that says nothing useful.
 */

// ---------------------------------------------------------------------------
// EIP-6963 discovery
// ---------------------------------------------------------------------------

/** @type {Map<string, {info: object, provider: object}>} keyed by rdns */
const announced = new Map();
let discoveryStarted = false;

function startDiscovery() {
  if (discoveryStarted || typeof window === 'undefined') return;
  discoveryStarted = true;
  window.addEventListener('eip6963:announceProvider', (event) => {
    const detail = event?.detail;
    if (!detail?.provider || !detail?.info) return;
    const key = detail.info.rdns || detail.info.uuid || detail.info.name;
    announced.set(key, { info: detail.info, provider: detail.provider });
  });
  try {
    window.dispatchEvent(new Event('eip6963:requestProvider'));
  } catch {
    // Older browsers without Event constructor — legacy path still works.
  }
}

// Kick off as early as possible so wallets have announced by the time the
// user clicks. Safe to call repeatedly.
startDiscovery();

/**
 * Re-broadcast the request. Wallets that injected late (or after a page was
 * restored from bfcache) answer synchronously, so one extra tick is enough.
 */
export async function refreshDiscovery() {
  startDiscovery();
  try {
    window.dispatchEvent(new Event('eip6963:requestProvider'));
  } catch { /* ignore */ }
  await new Promise((resolve) => setTimeout(resolve, 0));
}

const METAMASK_RDNS = 'io.metamask';

/**
 * Pick the provider we should talk to.
 *
 * Priority:
 *   1. MetaMask announced via EIP-6963
 *   2. The only EIP-6963 provider, if exactly one announced
 *   3. `window.ethereum.providers[]` entry flagged isMetaMask (Coinbase-style multi-inject)
 *   4. `window.ethereum` itself
 *
 * Returns null when nothing is injected at all.
 */
export function selectInjectedProvider() {
  if (typeof window === 'undefined') return null;

  const mm = announced.get(METAMASK_RDNS);
  if (mm) return mm.provider;

  // Some MetaMask builds/forks use a different rdns but still set isMetaMask.
  for (const { provider } of announced.values()) {
    if (provider?.isMetaMask && !provider?.isBraveWallet && !provider?.isPhantom) return provider;
  }

  if (announced.size === 1) {
    return announced.values().next().value.provider;
  }

  const eth = window.ethereum;
  if (!eth) return null;

  if (Array.isArray(eth.providers) && eth.providers.length) {
    const flagged = eth.providers.find((p) => p?.isMetaMask && !p?.isBraveWallet);
    return flagged || eth.providers[0];
  }

  return eth;
}

/** Human-readable name of a provider object, best effort. */
export function describeProvider(provider) {
  if (!provider) return 'none';
  for (const { info, provider: p } of announced.values()) {
    if (p === provider) return info.name || info.rdns || 'unknown (EIP-6963)';
  }
  if (provider.isMetaMask && !provider.isBraveWallet) return 'MetaMask (legacy window.ethereum)';
  if (provider.isBraveWallet) return 'Brave Wallet';
  if (provider.isPhantom) return 'Phantom';
  if (provider.isCoinbaseWallet) return 'Coinbase Wallet';
  if (provider.isRabby) return 'Rabby';
  if (provider.isOkxWallet || provider.isOKExWallet) return 'OKX Wallet';
  return 'unknown injected wallet';
}

// ---------------------------------------------------------------------------
// Environment diagnostics
// ---------------------------------------------------------------------------

function detectBrowser() {
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
  if (/Firefox\//.test(ua)) return 'firefox';
  if (/Edg\//.test(ua)) return 'edge';
  if (/OPR\//.test(ua)) return 'opera';
  if (/Chrome\//.test(ua) && !/Chromium/.test(ua)) return 'chrome';
  if (/Safari\//.test(ua) && !/Chrome\//.test(ua)) return 'safari';
  return 'unknown';
}

function isMobile() {
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
  return /Android|iPhone|iPad|iPod|Mobile/i.test(ua);
}

function isBrave() {
  return typeof navigator !== 'undefined' && !!navigator.brave;
}

/** Whether localStorage is usable (throws in some private/blocked-storage modes). */
export function storageAvailable() {
  try {
    const k = '__verdikta_probe__';
    window.localStorage.setItem(k, '1');
    window.localStorage.removeItem(k);
    return true;
  } catch {
    return false;
  }
}

/**
 * Snapshot of everything that matters for "why didn't the wallet connect?".
 * Logged to the console on every connect attempt so a screenshot of DevTools
 * (or a screen recording with the console open) is enough to diagnose.
 */
export function walletEnvironment() {
  const selected = selectInjectedProvider();
  return {
    browser: detectBrowser(),
    brave: isBrave(),
    mobile: isMobile(),
    userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : '',
    hasWindowEthereum: typeof window !== 'undefined' && !!window.ethereum,
    windowEthereumIsMetaMask: !!(typeof window !== 'undefined' && window.ethereum?.isMetaMask),
    windowEthereumIsBrave: !!(typeof window !== 'undefined' && window.ethereum?.isBraveWallet),
    legacyProviderCount: Array.isArray(window?.ethereum?.providers) ? window.ethereum.providers.length : (window?.ethereum ? 1 : 0),
    eip6963Wallets: Array.from(announced.values()).map(({ info }) => info.name || info.rdns),
    selectedProvider: describeProvider(selected),
    localStorage: storageAvailable(),
  };
}

// ---------------------------------------------------------------------------
// Request helpers
// ---------------------------------------------------------------------------

export const CONNECT_TIMEOUT_MS = 60000;

/**
 * Race a wallet request against a timeout. Wallets are allowed to take a long
 * time (the user has to click "Connect" in the extension) but they must not
 * hang forever with no feedback — that is exactly the "nothing happens" bug.
 */
export function withTimeout(promise, ms, label = 'wallet request') {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(`${label} timed out after ${Math.round(ms / 1000)}s`);
      err.code = 'VERDIKTA_TIMEOUT';
      reject(err);
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// ---------------------------------------------------------------------------
// Error mapping
// ---------------------------------------------------------------------------

/**
 * Turn a raw wallet error into {code, message, hint, link} that a human can
 * act on. `message` is one line; `hint` is a second, more detailed line.
 */
export function explainWalletError(error, env = walletEnvironment()) {
  const code = error?.code ?? error?.error?.code;
  const raw = error?.message || error?.error?.message || (typeof error === 'string' ? error : '') || 'Unknown error';
  const firefox = env.browser === 'firefox';

  if (code === 'VERDIKTA_NO_PROVIDER') {
    if (env.mobile) {
      return {
        code,
        message: 'No wallet detected in this browser.',
        hint: 'On a phone, open this site inside the MetaMask app (Browser tab) or another wallet app with a built-in browser.',
        link: { href: 'https://metamask.io/download/', label: 'Get MetaMask' },
      };
    }
    return {
      code,
      message: 'No wallet extension detected.',
      hint: firefox
        ? 'Firefox disables extensions in Private Windows by default. Open about:addons → MetaMask → set "Run in Private Windows" to Allow, or use a normal window. Also confirm MetaMask is installed and enabled.'
        : 'Install MetaMask (or another EIP-6963 wallet) and reload. If it is installed, check it is enabled for this site and not blocked in a private/incognito window.',
      link: { href: 'https://metamask.io/download/', label: 'Get MetaMask' },
    };
  }

  if (code === 4001 || /user rejected|user denied/i.test(raw)) {
    return {
      code: 4001,
      message: 'Connection request was rejected in the wallet.',
      hint: 'Click Connect Wallet again and approve the request in the wallet prompt.',
    };
  }

  if (code === -32002 || /already pending|already processing/i.test(raw)) {
    return {
      code: -32002,
      message: 'A wallet prompt is already open and waiting for you.',
      hint: firefox
        ? 'Firefox opens the MetaMask prompt as a separate window — it may be hidden behind this one. Click the MetaMask icon in the toolbar to bring it forward.'
        : 'Click the MetaMask icon in your browser toolbar to find the pending request and approve it.',
    };
  }

  if (code === 'VERDIKTA_TIMEOUT') {
    return {
      code,
      message: `The wallet (${env.selectedProvider}) did not respond.`,
      hint: firefox
        ? 'Check for a MetaMask window hidden behind the browser (click the toolbar icon). If there is none, the extension may be stuck: disable and re-enable it in about:addons, or restart Firefox.'
        : 'Click the wallet icon in your toolbar to look for a pending prompt. If there is none, the extension may be stuck: disable and re-enable it, or restart the browser.',
    };
  }

  if (code === 'VERDIKTA_WRONG_NETWORK') {
    return {
      code,
      message: raw,
      hint: 'Switch networks in the wallet, then click Connect Wallet again.',
    };
  }

  if (code === 4902) {
    return {
      code,
      message: 'The required network is not in your wallet yet.',
      hint: 'Approve the "Add network" prompt in the wallet, then connect again.',
    };
  }

  if (/insecure|SecurityError|localStorage/i.test(raw)) {
    return {
      code: 'STORAGE',
      message: 'Browser storage is blocked, which interrupted the connection.',
      hint: 'Allow site data / cookies for this site (or leave strict private mode) and try again.',
    };
  }

  return {
    code: code ?? 'UNKNOWN',
    message: `Failed to connect wallet: ${raw}`,
    hint: `Wallet: ${env.selectedProvider}. Browser: ${env.browser}${env.brave ? ' (Brave)' : ''}. See the browser console for details.`,
  };
}
