/**
 * Canonical descriptor for the SubmissionPrepared event.
 *
 * Agents integrating against the calldata endpoints have to filter step-1 receipt
 * logs by topic0 and decode the event themselves. Two things go wrong when they
 * hand-write that:
 *
 *   1. They compute topic0 from a signature that omits, or misorders, a field.
 *      The real topic0 IS the plain keccak256 of the signature below — nothing
 *      else — so a different hash means a different signature string.
 *   2. They decode with a truncated or misordered ABI. With the September 2026
 *      contract revision the dynamic `string evaluationCid` is the LAST data
 *      field, so `ethMaxBudget` sits at a fixed word offset and even a naive
 *      `(address,uint256)` decode of the data reads evalWallet and ethMaxBudget
 *      correctly. Under the PREVIOUS field order (string before uint256) a
 *      truncated ABI returned 96 (0x60, the string's offset word) as the budget
 *      and the start tx reverted for insufficient funds.
 *
 * Endpoints that hand out step-1 calldata embed this object in their response so
 * the topic and the field order come from the server, not from the caller's guess.
 *
 * NOTE: field order here must track the deployed contract. See the comment above
 * `event SubmissionPrepared` in onchain/contracts/BountyEscrow.sol. Anything that
 * still reads logs of the OLD contract (deployed before September 2026) must use
 * the legacy descriptor exported below for that address.
 */

const { ethers } = require('ethers');

const SUBMISSION_PREPARED_ABI =
  'event SubmissionPrepared(uint256 indexed bountyId, uint256 indexed submissionId, address indexed hunter, address evalWallet, uint256 ethMaxBudget, string evaluationCid)';

const SUBMISSION_PREPARED_SIGNATURE =
  'SubmissionPrepared(uint256,uint256,address,address,uint256,string)';

// 0x147341637c0b8d941e61a743cd410afff8526bec154904bb54f857b8f59cd6ca
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
  dataFields: ['evalWallet', 'ethMaxBudget', 'evaluationCid'],
  note: 'topic0 is the plain keccak256 of `signature` — if you computed a different hash you used a different field order (the pre-September-2026 contract emitted the string BEFORE ethMaxBudget; that signature hashes to 0xdf7bc54a…7437 and matches no logs on the current contract). Filter step-1 receipt logs on topic0, then decode the non-indexed data with the full `abi`: evalWallet is data word 0, ethMaxBudget is data word 1, and the dynamic string evaluationCid comes last. Prefer named access (args.ethMaxBudget) over positional indices.'
};

// ---------------------------------------------------------------------------
// Legacy (pre-September-2026) field order. Only for decoding logs emitted by the
// OLD BountyEscrow address; the current contract never emits this signature.
// ---------------------------------------------------------------------------
const LEGACY_SUBMISSION_PREPARED_ABI =
  'event SubmissionPrepared(uint256 indexed bountyId, uint256 indexed submissionId, address indexed hunter, address evalWallet, string evaluationCid, uint256 ethMaxBudget)';

const LEGACY_SUBMISSION_PREPARED_SIGNATURE =
  'SubmissionPrepared(uint256,uint256,address,address,string,uint256)';

// 0xdf7bc54a6444d008cf527c6a4bcdfa31d05db5a08445b8dd2eb3a05f24b67437
const LEGACY_SUBMISSION_PREPARED_TOPIC0 = ethers.id(LEGACY_SUBMISSION_PREPARED_SIGNATURE);

module.exports = {
  SUBMISSION_PREPARED_ABI,
  SUBMISSION_PREPARED_SIGNATURE,
  SUBMISSION_PREPARED_TOPIC0,
  submissionPreparedEvent,
  LEGACY_SUBMISSION_PREPARED_ABI,
  LEGACY_SUBMISSION_PREPARED_SIGNATURE,
  LEGACY_SUBMISSION_PREPARED_TOPIC0
};
