import { useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { Target, Wallet, LogOut, Check, Menu, X, AlertTriangle, Loader2 } from 'lucide-react';
import { walletService } from '../services/wallet';
import { currentNetwork } from '../config';
import { apiService } from '../services/api';
import './Header.css';

// How often to poll the action-required endpoint while the user has a wallet
// connected. Once a minute is plenty for an expiry-triggered nag — close
// actions are rare and on-chain state changes slowly.
const ACTION_REQUIRED_POLL_MS = 60_000;

function Header({ walletState, onConnect, onDisconnect, onDismissError }) {
  const { isConnected, address, chainId, connecting, lastError } = walletState;
  const [showDiag, setShowDiag] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [actionRequiredCount, setActionRequiredCount] = useState(0);
  const location = useLocation();

  // Close the mobile menu on route change.
  useEffect(() => { setMenuOpen(false); }, [location.pathname]);

  // Poll for expired-bounty action-required count while a wallet is connected.
  // The endpoint returns 0 cheaply when there's nothing to do, so polling is
  // fine. Cleared immediately on disconnect to avoid stale badges.
  useEffect(() => {
    if (!isConnected || !address) {
      setActionRequiredCount(0);
      return;
    }
    let cancelled = false;
    const fetchCount = async () => {
      try {
        const result = await apiService.getActionRequired(address);
        if (!cancelled) setActionRequiredCount(result?.count || 0);
      } catch (_) {
        // Swallow — the badge is best-effort; failure shouldn't disrupt the header.
      }
    };
    fetchCount();
    const id = setInterval(fetchCount, ACTION_REQUIRED_POLL_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, [isConnected, address]);

  // Close on Escape.
  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e) => { if (e.key === 'Escape') setMenuOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [menuOpen]);

  const getCurrentNetworkName = () => {
    if (!chainId) return 'Unknown';
    return walletService.getNetworkName(chainId);
  };

  return (
    <header className="header">
      <div className="header-container">
        <Link to="/" className="logo">
          <Target size={28} className="logo-icon" />
          <div className="logo-text">
            <span className="logo-title">Verdikta Bounties</span>
            <span className="network-label">{currentNetwork.name}</span>
          </div>
        </Link>

        <button
          className="menu-toggle"
          aria-expanded={menuOpen}
          aria-controls="primary-nav"
          aria-label={menuOpen ? 'Close menu' : 'Open menu'}
          onClick={() => setMenuOpen(o => !o)}
        >
          {menuOpen ? <X size={24} /> : <Menu size={24} />}
        </button>

        <div
          id="primary-nav"
          className={`header-collapsible${menuOpen ? ' is-open' : ''}`}
        >
          <nav className="nav">
            <Link to="/" className="nav-link">Browse</Link>
            <Link to="/create" className="nav-link">Create Bounty</Link>
            <Link to="/agents" className="nav-link">Agents</Link>
            <Link to="/analytics" className="nav-link">Analytics</Link>
            {isConnected && (
              <Link to="/my-bounties" className="nav-link">
                My Bounties
                {actionRequiredCount > 0 && (
                  <span
                    className="nav-badge"
                    aria-label={`${actionRequiredCount} bounty${actionRequiredCount === 1 ? '' : 'ies'} need attention`}
                    title="Expired bounties needing close — click to review"
                  >
                    {actionRequiredCount}
                  </span>
                )}
              </Link>
            )}
          </nav>

          <div className="header-right">
            {!isConnected ? (
              <button
                onClick={onConnect}
                className="btn btn-primary btn-with-icon"
                disabled={!!connecting}
                aria-busy={!!connecting}
                title={connecting ? 'Waiting for your wallet — check for a wallet prompt' : 'Connect your wallet'}
              >
                {connecting ? <Loader2 size={18} className="spin" /> : <Wallet size={18} />}
                {connecting ? 'Connecting… check your wallet' : 'Connect Wallet'}
              </button>
            ) : (
              <div className="wallet-info">
                <div className="wallet-address">
                  <span className="network-badge correct" title={`Chain ID: ${chainId}`}>
                    <Check size={14} />
                    {getCurrentNetworkName()}
                  </span>
                  <span className="address" title={address}>
                    {walletService.formatAddress(address)}
                  </span>
                </div>

                <button onClick={onDisconnect} className="btn btn-secondary btn-sm btn-with-icon">
                  <LogOut size={16} />
                  Disconnect
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Persistent, actionable connection error. A 2-second toast was too
          easy to miss — this stays until dismissed or the next attempt. */}
      {!isConnected && lastError && (
        <div className="wallet-notice" role="alert">
          <div className="wallet-notice-body">
            <AlertTriangle size={18} className="wallet-notice-icon" />
            <div className="wallet-notice-text">
              <strong>{lastError.message}</strong>
              {lastError.hint && <span className="wallet-notice-hint">{lastError.hint}</span>}
              <span className="wallet-notice-actions">
                {lastError.link && (
                  <a href={lastError.link.href} target="_blank" rel="noopener noreferrer">
                    {lastError.link.label}
                  </a>
                )}
                <button type="button" className="link-button" onClick={() => setShowDiag(d => !d)}>
                  {showDiag ? 'Hide details' : 'Show details'}
                </button>
              </span>
              {showDiag && (
                <pre className="wallet-notice-diag">
                  {JSON.stringify(walletService.getDiagnostics(), null, 2)}
                </pre>
              )}
            </div>
          </div>
          <button
            type="button"
            className="wallet-notice-dismiss"
            aria-label="Dismiss"
            onClick={() => { setShowDiag(false); onDismissError && onDismissError(); }}
          >
            <X size={16} />
          </button>
        </div>
      )}
    </header>
  );
}

export default Header;

