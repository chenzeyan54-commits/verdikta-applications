/**
 * The calldata routes must not depend on the indexer or on a client-side wait:
 *  - getSubmission may revert "bad submissionId" for a submission that exists when the RPC
 *    node lags the caller's receipt → retried briefly (readChainSubmissionWithRetry).
 *  - If /confirm was skipped and the sync has not caught up, /start (and finalize /
 *    approve-as-creator) read the submission from chain and persist it (ensureLocalSubmission).
 */
let mockStorageData = { jobs: [], nextId: 0 };
jest.mock('fs', () => {
  const actual = jest.requireActual('fs');
  return { ...actual, promises: { ...actual.promises,
    mkdir: jest.fn().mockResolvedValue(undefined), access: jest.fn().mockResolvedValue(undefined),
    readFile: jest.fn().mockImplementation(() => Promise.resolve(JSON.stringify(mockStorageData))),
    writeFile: jest.fn().mockImplementation((_p, data) => { mockStorageData = JSON.parse(data); return Promise.resolve(); }),
    rename: jest.fn().mockResolvedValue(undefined) } };
});
jest.mock('../config', () => ({ config: { network: 'base-sepolia', bountyEscrowAddress: '0xabc123', chainId: 84532, explorer: 'https://sepolia.basescan.org' } }));
let mockGetSubmission = jest.fn();
jest.mock('../utils/contractService', () => ({ getContractService: () => ({ contract: { getSubmission: (...a) => mockGetSubmission(...a) } }) }));

process.env.CHAIN_READ_RETRIES = '3';
process.env.CHAIN_READ_RETRY_MS = '1';
const express = require('express');
const request = require('supertest');
const jobRoutes = require('../routes/jobRoutes');
const { readChainSubmissionWithRetry, ensureLocalSubmission, submissionRecordFromChain } = jobRoutes._chainHelpers;

const HUNTER = '0x' + '1'.repeat(40);
const ZERO = '0x' + '0'.repeat(40);
const ZERO_HASH = '0x' + '0'.repeat(64);
const badId = () => Object.assign(new Error('execution reverted: "bad submissionId"'), { reason: 'bad submissionId' });
const chainPrepared = (over = {}) => ({ status: 0n, hunter: HUNTER, hunterCid: 'QmWork', evalWallet: '0x' + '2'.repeat(40), verdiktaAggId: ZERO_HASH,
  acceptance: 0n, rejection: 0n, submittedAt: 1789000000n, finalizedAt: 0n, ethMaxBudget: 240000000000000n, creatorWindowEnd: 0n, funder: ZERO, ...over });
function makeJob(over = {}) { return { jobId: 7, title: 'T', creator: '0xcreator', bountyAmount: 0.01, threshold: 70, evaluationCid: 'QmEval', status: 'OPEN', createdAt: 1789000000, submissionCount: 0, submissions: [], contractAddress: '0xabc123', onChain: true, syncedFromBlockchain: true, ...over }; }
beforeEach(() => { mockStorageData = { jobs: [], nextId: 0 }; mockGetSubmission = jest.fn(); });

describe('readChainSubmissionWithRetry', () => {
  it('retries the "bad submissionId" revert and returns the submission once the node catches up', async () => {
    mockGetSubmission.mockRejectedValueOnce(badId()).mockRejectedValueOnce(badId()).mockResolvedValueOnce(chainPrepared());
    const sub = await readChainSubmissionWithRetry(7, 0, { attempts: 3, delayMs: 1 });
    expect(sub.hunter).toBe(HUNTER);
    expect(mockGetSubmission).toHaveBeenCalledTimes(3);
  });
  it('gives up after the configured attempts with the last revert', async () => {
    mockGetSubmission.mockRejectedValue(badId());
    await expect(readChainSubmissionWithRetry(7, 0, { attempts: 3, delayMs: 1 })).rejects.toThrow(/bad submissionId/);
    expect(mockGetSubmission).toHaveBeenCalledTimes(3);
  });
  it('does not retry other errors', async () => {
    mockGetSubmission.mockRejectedValue(new Error('network timeout'));
    await expect(readChainSubmissionWithRetry(7, 0, { attempts: 3, delayMs: 1 })).rejects.toThrow(/network timeout/);
    expect(mockGetSubmission).toHaveBeenCalledTimes(1);
  });
});

describe('ensureLocalSubmission', () => {
  it('returns the existing local record without touching the chain', async () => {
    const job = makeJob({ submissions: [{ submissionId: 0, hunter: HUNTER, status: 'Prepared' }] });
    const rec = await ensureLocalSubmission(job, 0, {}, { attempts: 1, delayMs: 1 });
    expect(rec.hunter).toBe(HUNTER);
    expect(mockGetSubmission).not.toHaveBeenCalled();
  });
  it('creates and persists the record from chain when the indexer has not caught up', async () => {
    const job = makeJob(); mockStorageData = { jobs: [JSON.parse(JSON.stringify(job))], nextId: 8 };
    mockGetSubmission.mockRejectedValueOnce(badId()).mockResolvedValue(chainPrepared({ status: 5n, creatorWindowEnd: 1789003600n }));
    const rec = await ensureLocalSubmission(job, 0, { clientType: 'bot', clientId: 'b1' }, { attempts: 3, delayMs: 1 });
    expect(rec).toMatchObject({ submissionId: 0, hunter: HUNTER, hunterCid: 'QmWork', status: 'PendingCreatorApproval', onChainStatus: 'PendingCreatorApproval', creatorWindowEnd: 1789003600, ethMaxBudget: '240000000000000', evaluationCid: 'QmEval', clientType: 'bot' });
    expect(rec.funder).toBeUndefined();
    expect(mockStorageData.jobs[0].submissions).toHaveLength(1);       // persisted
    expect(mockStorageData.jobs[0].submissionCount).toBe(1);
    expect(job.submissions).toHaveLength(1);                            // caller's copy updated
  });
  it('returns null (no record) when the submission does not exist on-chain either', async () => {
    const job = makeJob(); mockStorageData = { jobs: [JSON.parse(JSON.stringify(job))], nextId: 8 };
    mockGetSubmission.mockRejectedValue(badId());
    expect(await ensureLocalSubmission(job, 3, {}, { attempts: 2, delayMs: 1 })).toBeNull();
    expect(mockStorageData.jobs[0].submissions).toHaveLength(0);
  });
  it('maps a started submission with its funder and aggregation id', () => {
    const rec = submissionRecordFromChain(makeJob(), 2, chainPrepared({ status: 1n, verdiktaAggId: '0x' + 'ab'.repeat(32), funder: HUNTER }));
    expect(rec).toMatchObject({ status: 'PENDING_EVALUATION', onChainStatus: 'PendingVerdikta', funder: HUNTER, verdiktaAggId: '0x' + 'ab'.repeat(32), paidWinner: false });
  });
});

describe('POST /start without a prior /confirm', () => {
  function app() { const a = express(); a.use(express.json()); a.use('/jobs', jobRoutes); return a; }
  it('answers 404 with a chain-aware message when the submission is missing on-chain too', async () => {
    mockStorageData = { jobs: [makeJob()], nextId: 8 };
    mockGetSubmission.mockRejectedValue(badId());
    const res = await request(app()).post('/jobs/7/submissions/5/start').send({ hunter: HUNTER });
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not on-chain either/);
  });
  it('proceeds past the record gate when the chain has the submission (falls through to the live-status gate)', async () => {
    mockStorageData = { jobs: [makeJob({ creatorAssessmentWindowSize: 3600 })], nextId: 8 };
    const windowEnd = BigInt(Math.floor(Date.now() / 1000) + 1800);
    mockGetSubmission.mockRejectedValueOnce(badId()).mockResolvedValue(chainPrepared({ status: 5n, creatorWindowEnd: windowEnd }));
    const res = await request(app()).post('/jobs/7/submissions/0/start').send({ hunter: HUNTER });
    // The record was created from chain and the route continued to its normal gate.
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('CREATOR_WINDOW_OPEN');
    expect(mockStorageData.jobs[0].submissions).toHaveLength(1);
  });
});
