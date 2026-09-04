/**
 * Canonical descriptor for the SubmissionPrepared event.
 *
 * Agents integrating against the calldata endpoints have to filter step-1 receipt
 * logs by topic0 and decode the event themselves. Two things go wrong when they
 * hand-write that:
 *
 *   1. They compute topic0 from a signature that omits the trailing
 *      `uint256 ethMaxBudget` (the field was added later). That yields
 *      0x87362e68... instead of the real topic and matches zero logs, so they
 *      conclude the deployed signature is "unknowable" and hardcode a magic
 *      constant. The real topic0 IS the plain keccak256 of the signature below.
 *   2. They decode with a truncated ABI, so `ethMaxBudget` reads back as 96
 *      (0x60 — the offset word for the dynamic `string evaluationCid`), and the
 *      start tx then reverts for insufficient funds.
 *
 * Endpoints that hand out step-1 calldata embed this object in their response so
 * the topic and the field order come from the server, not from the caller's guess.
 *
 * NOTE: field order here must track the deployed contracts. See the comment above
 * `event SubmissionPrepared` in onchain/contracts/BountyEscrow.sol — a queued change
 * moves the dynamic string last, and it has to be flipped atomically everywhere.
 */

const { ethers } = require('ethers');

const SUBMISSION_PREPARED_ABI =
  'event SubmissionPrepared(uint256 indexed bountyId, uint256 indexed submissionId, address indexed hunter, address evalWallet, string evaluationCid, uint256 ethMaxBudget)';

const SUBMISSION_PREPARED_SIGNATURE =
  'SubmissionPrepared(uint256,uint256,address,address,string,uint256)';

const SUBMISSION_PREPARED_TOPIC0 = ethers.id(SUBMISSION_PREPARED_SIGNATURE);

/**
 * Serializable descriptor for API responses.
 */
const submissionPreparedEvent = {
  name: 'SubmissionPrepared',
  signature: SUBMISSION_PREPARED_SIGNATURE,
  topic0: SUBMISSION_PREPARED_TOPIC0,
  abi: SUBMISSION_PREPARED_ABI,
  indexedFields: ['bountyId', 'submissionId', 'hunter'],
  dataFields: ['evalWallet', 'evaluationCid', 'ethMaxBudget'],
  note: 'topic0 is the plain keccak256 of `signature` — if you computed a different hash you dropped the trailing uint256 ethMaxBudget from the signature. Filter step-1 receipt logs on topic0, then decode the non-indexed data with the full `abi`: ethMaxBudget is LAST, after the dynamic string evaluationCid, so a truncated ABI returns 96 (0x60, the string offset word) instead of the budget.'
};

module.exports = {
  SUBMISSION_PREPARED_ABI,
  SUBMISSION_PREPARED_SIGNATURE,
  SUBMISSION_PREPARED_TOPIC0,
  submissionPreparedEvent
};
