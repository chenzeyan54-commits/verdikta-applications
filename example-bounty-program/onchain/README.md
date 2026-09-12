# Verdikta Bounty Program — Smart Contracts

Solidity contracts for the Verdikta AI-Powered Bounty Program, built with Hardhat.

## Contracts

- **`BountyEscrow.sol`** — main contract. Holds ETH escrow, manages bounty lifecycle, coordinates with VerdiktaAggregator, supports an optional creator approval window.
- **`BountyEscrowLens.sol`** — the escrow's read-only views (`getSubmissions`, `getBounties`, `getOracleResult`, `nextAction`, `prepareCutoff`, `canBeClosed`, `isAcceptingSubmissions`, `getEffectiveBountyStatus`), split out so `BountyEscrow`'s runtime bytecode stays under the 24,576-byte EIP-170 limit. Created by the escrow's constructor (`lens()`), and served **at the escrow address**: the escrow's fallback forwards any selector it does not implement to the lens through a `STATICCALL`-guarded `delegatecall` (no state change is possible, the lens address is an immutable, there is no owner — this is not a proxy). Reads go through the escrow's public getters, so the two contracts share no storage layout. Use the **merged ABI** (`deploy/helpers.js → mergedAbi()`, exported to `frontend/src/abi/BountyEscrow.json` on deploy) wherever an ABI is attached to the escrow; the compiled `BountyEscrow` artifact alone lacks these views.
- **`EvaluationWallet.sol`** — per-submission wallet (an EIP-1167 minimal-proxy clone of the one implementation the escrow creates in its constructor — `walletImplementation()`; verified separately so explorers label the clones) that holds the ETH prepay and funds the oracle evaluation (recovers the unspent ETH refund and returns it to the hunter).
- **`interfaces/IVerdiktaAggregator.sol`** — interface to the ETH-funded AI oracle aggregator (payable `requestAIEvaluationWithApproval`, `ethOwed`/`withdrawEth`).
- **`mocks/`** — test stubs: `MockVerdiktaAggregator` (round lifecycle, refund credit, fee ceiling, records forwarded request params, switchable broken withdraw), `MockRejectingHunter` (rejects ETH), `MockGasHungryRecipient` (burns gas on receive).

The contract's behavioral rules (deadline, creator window, priority, submission cap, creator-owned oracle settings, CID validation, payout gas cap, force-fail gate, refund recovery) and its agent-facing views (`nextAction`, `getOracleResult`, `getSubmissions`, `getBounties`, `prepareCutoff` — served from `BountyEscrowLens` at the escrow address — and `requiredPrepay`) are documented in [../DEVELOPER-GUIDE.md → Submission timing and priority rules](../DEVELOPER-GUIDE.md#submission-timing-and-priority-rules). The contract has no owner and no upgrade path; every rule is a constant.

## Quick start

```bash
npm install
cp .env.example .env       # PRIVATE_KEY, RPC URLs, BASESCAN_API_KEY
npm run compile
npm test
```

## Scripts

| Command | Description |
|---|---|
| `npm run compile` | `hardhat compile` |
| `npm test` | `hardhat test` |
| `npm run coverage` | solidity-coverage report |
| `npm run deploy:sepolia` | Deploy to Base Sepolia |
| `npm run deploy:base` | Deploy to Base mainnet |
| `npm run verify` | Verify source on Basescan |
| `npm run clean` | `hardhat clean` |
| `npm run node` | Local Hardhat node |

Convenience deployment wrappers: `deploy_testnet.sh`, `deploy_mainnet.sh`.

## Environment

See `.env.example`. Required:

- `PRIVATE_KEY` — deployer key (NEVER commit)
- `BASE_SEPOLIA_RPC_URL`, `BASE_MAINNET_RPC_URL` — RPC endpoints
- `BASESCAN_API_KEY` — for source verification

## Deployment

```bash
npm run deploy:sepolia     # or deploy:base
```

After deployment, the new BountyEscrow address (and the `BountyEscrowLens` it created) is printed to console and saved to `deployments/`; both are verified on Basescan when `BASESCAN_API_KEY` is set (`deploy/verify.js <escrow>` verifies both after the fact). The lens is verified separately only so the explorer's read tab can show the views — callers never need its address. Update `BOUNTY_ESCROW_ADDRESS_*` in both `server/.env` and `client/.env`, then restart the server and rebuild the client. If the ABI changed, that is not enough — follow the release's cutover runbook in `../deploy/` (currently `../deploy/CUTOVER-2026-09-12.md`), which also applies the off-chain migration patch, bumps `deploymentBlocks`, and resets the job data.

## Project context

For deployed contract addresses, see [../README.md#contract-addresses](../README.md#contract-addresses).
For full contract reference (ABI, state diagrams, code samples), the in-app `/blockchain` page on the frontend is the canonical source.
