import axios from 'axios';

const api = axios.create({
  baseURL: '/',
  timeout: 15000,
});

export const apiService = {
  async getStatus() {
    const response = await api.get('/api/status');
    return response.data;
  },

  async getHealth() {
    const response = await api.get('/health');
    return response.data;
  },

  // Cross-network headline stats for the home page: total arbiters + health
  // per network. Cheap (one oracle-count call per network); cached server-side.
  async getSummary() {
    const response = await api.get('/api/summary', { timeout: 30000 });
    return response.data;
  },

  // Combined arbiter availability + system health for a network.
  // `network` is the client toggle value (e.g. 'base' | 'base_sepolia');
  // the server normalizes it. Allow extra time for the on-chain enumeration.
  async getAnalyticsOverview(network) {
    const response = await api.get('/api/analytics/overview', {
      params: { network },
      timeout: 60000,
    });
    return response.data;
  },

  // Invalidate the server-side cache for a network so the next read is fresh.
  async refreshAnalytics(network) {
    const response = await api.post('/api/analytics/refresh', null, {
      params: { network },
    });
    return response.data;
  },

  // Core contract addresses + live on-chain configuration for a network.
  // Allow extra time for the on-chain reads (matches analytics overview).
  async getContractsOverview(network) {
    const response = await api.get('/api/contracts/overview', {
      params: { network },
      timeout: 60000,
    });
    return response.data;
  },

  // Invalidate the contracts cache for a network.
  async refreshContracts(network) {
    const response = await api.post('/api/contracts/refresh', null, {
      params: { network },
    });
    return response.data;
  },

  // Arbiters owned by `owner` on `network`, grouped by operator contract, with
  // claimable ETH (per owner) and per-job stake/lock state. Backs the My Arbiters page.
  // Allows extra time for the on-chain enumeration.
  async getOwnedArbiters(owner, network) {
    const response = await api.get('/api/arbiters/owned', {
      params: { owner, network },
      timeout: 60000,
    });
    return response.data;
  },

  // Arbiters grouped by owner address for the analytics "Arbiters by Owner"
  // table (counts, reputation, claimable ETH, node funding).
  async getOwnersAnalytics(network) {
    const response = await api.get('/api/analytics/owners', {
      params: { network },
      timeout: 60000,
    });
    return response.data;
  },

  // Oracle health for a network: network eval success rate + per-operator
  // commit/reveal reliability, derived from aggregator events over a recent
  // window. Heavy archive-log scan — allow generous time.
  async getOracleHealth(network, days) {
    const response = await api.get('/api/analytics/oracle-health', {
      params: { network, ...(days ? { days } : {}) },
      timeout: 90000,
    });
    return response.data;
  },

  // Live arbiter watchdog reports for a network: active alerts, heartbeat
  // freshness, and recent history per operator. Fed by arbiter nodes POSTing
  // watchdog events to /api/alerts; cheap read (no on-chain work).
  async getAlerts(network) {
    const response = await api.get('/api/alerts', { params: { network } });
    return response.data;
  },

  // Reporting keys an arbiter owner has authorized to post watchdog events on
  // its behalf (see components/ReportingKeysSection). Nodes run under an ops
  // wallet rather than the owner key, so without a delegation their heartbeats
  // are rejected and the arbiter shows as "not reporting".
  async getReportingDelegations(owner, network) {
    const response = await api.get('/api/alerts/delegations', { params: { owner, network } });
    return response.data;
  },

  // Register an owner-signed delegation. `payload` carries the signed message's
  // fields verbatim ({ owner, delegate, expiresAt, issuedAt, sig, label }) —
  // the server reconstructs the message and recovers the signer, so these must
  // match what was signed exactly.
  async addReportingDelegation(payload) {
    const response = await api.post('/api/alerts/delegations', payload);
    return response.data;
  },

  // Withdraw a reporting authorization (owner-signed, same scheme).
  async revokeReportingDelegation(payload) {
    const response = await api.post('/api/alerts/delegations/revoke', payload);
    return response.data;
  },

  // Addresses that tried to report for one of this owner's operators and were
  // turned away — candidates to authorize. Each is backed by a valid signature
  // from that key, so it proves possession of the key, not permission.
  async getPendingReporters(owner, network) {
    const response = await api.get('/api/alerts/pending-reporters', {
      params: { owner, network },
      timeout: 60000,
    });
    return response.data;
  },

  // Full blow-by-blow of a single oracle aggregation (the drill-down behind a
  // blameworthy aggId): requirements, per-slot commit/reveal outcome, failures,
  // and final fulfillment. Bounded on-chain log scan — allow generous time.
  async getAggHistory(aggId, network) {
    const response = await api.get(`/api/analytics/agg-history/${aggId}`, {
      params: { network },
      timeout: 90000,
    });
    return response.data;
  },
};

export default apiService;
