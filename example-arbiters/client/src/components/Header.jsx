import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Scale, Wallet, LogOut, AlertTriangle, X } from 'lucide-react';
import { useNetwork, NETWORKS } from '../context/NetworkContext';
import { useWallet } from '../context/WalletContext';
import { useToast } from './Toast';
import './Header.css';

const formatAddress = (addr) =>
  addr ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : '';

function Header() {
  const { selectedNetwork, setNetwork } = useNetwork();
  const {
    isConnected, address, connecting, isMetaMaskInstalled, lastError,
    connect, disconnect, clearError, getDiagnostics,
  } = useWallet();
  const toast = useToast();
  const [showDiag, setShowDiag] = useState(false);

  const handleConnect = async () => {
    try {
      await connect();
    } catch (err) {
      // walletService logged the raw error + diagnostics and set lastError
      // (rendered persistently below). The toast is a nudge toward it.
      toast.error(err?.message || 'Failed to connect wallet', 8000);
    }
  };

  return (
    <header className="header">
      <div className="header-container">
        <div className="header-left">
          <Link to="/" className="logo">
            <Scale size={28} className="logo-icon" />
            <div className="logo-text">
              <h1>Verdikta Arbiters</h1>
            </div>
          </Link>
          <nav className="nav">
            <Link to="/" className="nav-link">Home</Link>
            <Link to="/my-arbiters" className="nav-link">My Arbiters</Link>
            <Link to="/analytics" className="nav-link">Analytics</Link>
            <Link to="/contracts" className="nav-link">Contracts</Link>
          </nav>
        </div>
        <div className="header-right">
          <select
            value={selectedNetwork}
            onChange={(e) => setNetwork(e.target.value)}
            className="network-selector"
            aria-label="Select network"
          >
            {NETWORKS.map((n) => (
              <option key={n.value} value={n.value}>{n.label}</option>
            ))}
          </select>

          {isConnected ? (
            <div className="wallet-pill" title={address}>
              <Wallet size={14} />
              <span className="wallet-address-short">{formatAddress(address)}</span>
              <button
                className="wallet-disconnect"
                onClick={disconnect}
                title="Disconnect wallet"
                aria-label="Disconnect wallet"
              >
                <LogOut size={14} />
              </button>
            </div>
          ) : isMetaMaskInstalled ? (
            <button
              className="btn-connect"
              onClick={handleConnect}
              disabled={connecting}
              aria-busy={!!connecting}
              title={connecting ? 'Waiting for your wallet — check for a wallet prompt' : 'Connect your wallet'}
            >
              <Wallet size={14} />
              {connecting ? 'Connecting… check your wallet' : 'Connect Wallet'}
            </button>
          ) : (
            <a
              className="btn-connect"
              href="https://metamask.io/download/"
              target="_blank"
              rel="noopener noreferrer"
              title="Any browser wallet extension works (MetaMask, Rabby, Coinbase Wallet, Brave Wallet, OKX). This link installs MetaMask."
            >
              <Wallet size={14} />
              Install a wallet
            </a>
          )}
        </div>
      </div>

      {/* Persistent, actionable connection error (a short toast is easy to miss). */}
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
                <pre className="wallet-notice-diag">{JSON.stringify(getDiagnostics(), null, 2)}</pre>
              )}
            </div>
          </div>
          <button
            type="button"
            className="wallet-notice-dismiss"
            aria-label="Dismiss"
            onClick={() => { setShowDiag(false); clearError(); }}
          >
            <X size={16} />
          </button>
        </div>
      )}
    </header>
  );
}

export default Header;
