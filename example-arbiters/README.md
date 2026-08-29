# Example Arbiters

Peer project to `example-bounty-program` — a scaffold for the Verdikta Arbiters application. Currently a "coming soon" placeholder; ready to grow.

## Layout

```
client/   # Vite + React 19 frontend
server/   # Express API
```

Client and server are fully independent packages. Install and run each in its own terminal.

## Run locally

```bash
# Terminal 1 — server (port 5008)
cd server
npm install
npm run dev

# Terminal 2 — client (port 5175, proxies /api/* to the server)
cd client
npm install
npm run dev
```

Open http://localhost:5175.

## Ports

- Client dev: `5175`
- Server: `5008`

Chosen to avoid collisions with `example-frontend` (5000/3001), `example-bounty-program` (5005–5006/5173), and `example-agents` (5007/5174).

## Arbiter watchdog alerts

The `/analytics` page has an **Arbiter Alerts** card fed by arbiter nodes
themselves: each node's `chainlink-health-watchdog.sh` (verdikta-arbiter repo)
runs from cron every ~2 minutes and can POST one JSON event per run —
`OK` heartbeat, `ALERT`, or `RECOVERED` — to this server's `POST /api/alerts`,
keyed by the node's on-chain operator address. Because healthy nodes heartbeat
continuously, the server also flags operators whose reports **stop** ("Not
reporting") — the only way to notice an arbiter whose whole machine went dark.

Authentication is **signature-only, zero-config**: the watchdog signs each
event with the operator owner's key (EIP-191 personal message, computed
locally on the node — no transaction, no gas) and sends `signer` + `sig`. The
server recovers the signer, requires a fresh `ts` (10-minute replay bound),
and requires the signer to equal the operator contract's on-chain `owner()`.
Any freshly installed, registered arbiter can therefore report immediately —
there is deliberately **no shared secret** (a leaked fleet-wide token would
allow spoofing any operator's status, including fake "healthy" heartbeats
masking a real outage), and unsigned events are rejected with 401.

Server setup (nothing required; one optional knob):

```bash
ALERTS_STALE_AFTER_MINUTES=10             # optional; heartbeat staleness window
```

Node-operator setup (in the arbiter install's `installer/.env`; the install
script offers to configure this):

```bash
WATCHDOG_ALERT_WEBHOOK="https://arbiters.verdikta.org/api/alerts"
```

Events are validated (owner signature, plus operator address registered in
the keeper) and persisted per network to `server/data/{network}/alerts.json`
(same pattern as the gas-receipt store). The Operator Reliability tables show
a colored dot for operators that report. Read path: `GET /api/alerts?network=`.

### Reporting keys (nodes running under a different wallet)

Many operators run their nodes with an ops wallet that is *not* the operator
contract's `owner()`. Those nodes sign with a key the server doesn't recognize,
so every heartbeat is rejected with 403 and the arbiter shows as "not
reporting". Putting the owner key on the node is the wrong fix — it controls
the wVDKA stake, `deregisterOracle`, and ETH earnings.

Instead the owner authorizes a **reporting key** from the **Reporting keys**
section on `/my-arbiters`: an EIP-191 message signed in the browser (no
transaction, no gas) naming an address allowed to report on its behalf until a
chosen expiry. Ingest then accepts owner *or* live delegate. The trust root is
unchanged — only `owner()` can authorize — and **nothing on the arbiter node
changes**; the watchdog keeps sending exactly the payload it sends today.

Delegations are scoped to (owner, network), so one signature covers every
operator that wallet owns, including ones registered later. They carry a hard
expiry (90 days by default, 1 year max) and can be revoked with a second
signature, which leaves a tombstone so a captured older authorization can't be
replayed. Stored per network in `server/data/{network}/reporters.json`.

Discovery: a validly-signed event from an unrecognized key is recorded as a
*pending reporter* before the 403 — so `/my-arbiters` shows "a node at
`<hostname>` is trying to report for operator `0x…` with key `0x…`" and a
one-click **Authorize**, rather than making the owner dig the address out of a
server log. A pending entry proves someone holds that key, not that it should
be trusted; authorizing still requires the owner's signature. The list is
bounded per operator and expires after a week of silence.

Delegation endpoints (all owner-signature gated, no shared secret):

```
GET  /api/alerts/delegations?network=&owner=        # authorized keys
POST /api/alerts/delegations                        # authorize (owner-signed)
POST /api/alerts/delegations/revoke                 # revoke (owner-signed)
GET  /api/alerts/pending-reporters?network=&owner=  # candidates to authorize
```

## Notes

- No wallet / IPFS code yet. Keep it that way until the feature set demands it.
- Read-only blockchain access is intentional: the `/analytics` page reads arbiter/oracle data from the Verdikta aggregator + ReputationKeeper contracts via ethers (no wallet, no writes, no IPFS). A network toggle (Base mainnet / Base Sepolia) is exposed in the UI; the server reads each network over a public RPC (PublicNode), so no API keys are required. Override with `RPC_URL` / `INFURA_API_KEY` for a private endpoint.
- The write surfaces are all under `/api/alerts`: `POST /api/alerts` (arbiter watchdog webhooks) and the reporting-key delegation endpoints (see above). Every one of them is gated on an EIP-191 signature checked against on-chain state — there is no shared secret and no server-side allow-list to maintain.
- Visual theme mirrors `example-bounty-program` (shared CSS variables and components). Keep in sync when the design system evolves.
