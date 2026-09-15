/**
 * Multer upload-shape errors (wrong multipart field name, too many files, oversized file,
 * rejected type) are CLIENT mistakes and must come back as 400 SUBMISSION_BAD_UPLOAD with a
 * fix hint on /submit/dry-run, /submit and /submit/bundle — not the generic 500 INTERNAL_ERROR
 * ("check server health"), which agents read as a site outage.
 */
// No fs mock: every case below is rejected by the upload middleware before any storage read,
// and the real tmp dir must exist for multer's disk storage to reach the size limit.
jest.mock('../config', () => ({ config: { network: 'base-sepolia', bountyEscrowAddress: '0x' + 'ab'.repeat(20), chainId: 84532, explorer: 'https://sepolia.basescan.org' } }));
jest.mock('../utils/contractService', () => ({ getContractService: () => ({ provider: {}, contract: {} }) }));

const express = require('express');
const request = require('supertest');
const jobRoutes = require('../routes/jobRoutes');

const HUNTER = '0x' + '11'.repeat(20);
function app() { const a = express(); a.use(express.json()); a.use('/jobs', jobRoutes); return a; }
const ENDPOINTS = ['/jobs/1/submit/dry-run', '/jobs/1/submit', '/jobs/1/submit/bundle'];

function expectBadUpload(res, detailsRe) {
  expect(res.status).toBe(400);
  expect(res.body.code).toBe('SUBMISSION_BAD_UPLOAD');
  expect(res.body.details).toMatch(detailsRe);
  expect(res.body.fix).toEqual(expect.any(String));
}

describe.each(ENDPOINTS)('POST %s upload-shape errors', (url) => {
  it('wrong multipart field name → 400, names the expected field', async () => {
    const res = await request(app()).post(url).field('hunter', HUNTER).attach('file', Buffer.from('hello'), 'sol.txt');
    expectBadUpload(res, /Unexpected multipart field "file".*"files"/);
  });
  it('more than 10 files → 400', async () => {
    let req = request(app()).post(url).field('hunter', HUNTER);
    for (let i = 0; i < 11; i++) req = req.attach('files', Buffer.from('x'), `f${i}.txt`);
    expectBadUpload(await req, /More than 10 files/);
  });
  it('oversized file → 400 with the MB limit', async () => {
    const res = await request(app()).post(url).field('hunter', HUNTER).attach('files', Buffer.alloc(20 * 1024 * 1024 + 1, 97), 'big.txt');
    expectBadUpload(res, /exceeds the 20MB per-file limit/);
  });
  it('rejected file type → 400', async () => {
    const res = await request(app()).post(url).field('hunter', HUNTER).attach('files', Buffer.from('MZ'), { filename: 'x.exe', contentType: 'application/x-msdownload' });
    expectBadUpload(res, /Invalid file type/);
  });
});
