/**
 * Aggregation History Page
 * Shows full arbiter evaluation lifecycle for a given Verdikta aggregation ID
 */

import { useState, useEffect, useRef } from 'react';
import { useParams, Link } from 'react-router-dom';
import {
  Activity,
  CheckCircle,
  XCircle,
  AlertTriangle,
  Clock,
  Users,
  ExternalLink,
  Copy,
  ArrowLeft,
  Loader2
} from 'lucide-react';
import { apiService } from '../services/api';
import { config } from '../config';
import './AggHistory.css';

const networkConfig = config.networks[config.network] || config.networks['base-sepolia'];

function AggHistory() {
  const { aggId } = useParams();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [copied, setCopied] = useState(null);

  useEffect(() => {
    async function fetchHistory() {
      setLoading(true);
      setError(null);
      try {
        const result = await apiService.getAggHistory(aggId);
        setData(result.data);
      } catch (err) {
        setError(err.response?.data?.error || err.message);
      } finally {
        setLoading(false);
      }
    }
    fetchHistory();
  }, [aggId]);

  const handleCopy = async (text, key = 'aggId') => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    }
    setCopied(key);
    setTimeout(() => setCopied(null), 1500);
  };

  if (loading) {
    return (
      <div className="agg-history">
        <div className="loading">
          <Loader2 size={32} className="spinning" />
          <p>Querying blockchain events...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="agg-history">
        <Link to="/" className="back-link"><ArrowLeft size={16} /> Back</Link>
        <div className="error-container">
          <AlertTriangle size={40} />
          <h2>Failed to load aggregation history</h2>
          <p>{error}</p>
        </div>
      </div>
    );
  }

  if (!data || !data.found) {
    return (
      <div className="agg-history">
        <Link to="/" className="back-link"><ArrowLeft size={16} /> Back</Link>
        <div className="not-found">
          <AlertTriangle size={40} />
          <h2>Aggregation Not Found</h2>
          <p>{data?.message || 'No matching events found for this aggregation ID in the last 50,000 blocks.'}</p>
          <div className="agg-id-display" style={{ marginTop: '1rem', display: 'inline-block' }}>
            {aggId}
          </div>
        </div>
      </div>
    );
  }

  const { contractParams, aggregationStatus, requestEvent, slots, fulfillment, outcome, analysis } = data;

  const isCompleted = outcome === 'COMPLETED';
  const isRunning = outcome?.startsWith('RUNNING') || outcome?.startsWith('IN PROCESS');
  const outcomeClass = isCompleted ? 'completed' : isRunning ? 'running' : 'failed';
  const OutcomeIcon = isCompleted ? CheckCircle : isRunning ? Clock : XCircle;

  return (
    <div className="agg-history">
      <Link to="/" className="back-link"><ArrowLeft size={16} /> Back</Link>

      {/* Header */}
      <div className="page-header">
        <div className="header-content">
          <h1><Activity size={28} /> Aggregation History</h1>
          <div className="agg-id-display">
            <span className="agg-id-label">Agg ID:</span>
            {aggId}
            <button className="copy-btn" onClick={() => handleCopy(aggId)}>
              {copied === 'aggId' ? 'Copied' : 'Copy'}
            </button>
          </div>
        </div>
      </div>

      {/* Outcome Banner */}
      <div className={`outcome-banner ${outcomeClass}`}>
        <OutcomeIcon size={22} />
        {outcome}
      </div>

      {/* Requirements & Actual */}
      <div className="req-actual-container">
        <div className="analytics-section req-actual-half">
          <h2><Activity size={20} /> Requirements</h2>
          <div className="req-actual-list">
            <div className="req-actual-row">
              <span className="req-actual-label">Arbiters polled</span>
              <span className="req-actual-value">{contractParams.K}</span>
            </div>
            <div className="req-actual-row">
              <span className="req-actual-label">Commits needed</span>
              <span className="req-actual-value">{contractParams.M}</span>
            </div>
            <div className="req-actual-row">
              <span className="req-actual-label">Reveals needed</span>
              <span className="req-actual-value">{contractParams.N}</span>
            </div>
            <div className="req-actual-row">
              <span className="req-actual-label">Max scores per reveal</span>
              <span className="req-actual-value">{contractParams.maxLikelihoodLength}</span>
            </div>
          </div>
        </div>

        <div className="analytics-section req-actual-half">
          <h2><Users size={20} /> Actual</h2>
          <div className="req-actual-list">
            {/* Polled */}
            <div className="req-actual-row">
              <span className="req-actual-label">Polled</span>
              <span className="req-actual-value">{slots ? slots.length : 0} / {contractParams.K}</span>
            </div>
            {slots && slots.length > 0 && (
              <div className="req-actual-oracles">
                {slots.map(s => (
                  <a
                    key={`p-${s.slot}`}
                    href={`${networkConfig.explorer}/address/${s.oracle}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="oracle-chip"
                  >
                    slot {s.slot}: {s.oracle.slice(0, 6)}...{s.oracle.slice(-4)} <ExternalLink size={10} />
                  </a>
                ))}
              </div>
            )}

            {/* Commits */}
            <div className="req-actual-row" style={{ marginTop: '0.75rem' }}>
              <span className="req-actual-label">Commits</span>
              <span className={`req-actual-value ${analysis.committed >= contractParams.M ? 'val-ok' : analysis.committed > 0 ? 'val-warn' : 'val-fail'}`}>
                {analysis.committed} / {contractParams.K}
              </span>
            </div>
            {slots && (() => {
              const committers = slots.filter(s => s.committed);
              return committers.length > 0 && (
                <div className="req-actual-oracles">
                  {committers.map(s => (
                    <a
                      key={`c-${s.slot}`}
                      href={`${networkConfig.explorer}/address/${s.oracle}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="oracle-chip"
                    >
                      slot {s.slot}: {s.oracle.slice(0, 6)}...{s.oracle.slice(-4)} <ExternalLink size={10} />
                    </a>
                  ))}
                </div>
              );
            })()}

            {/* Selected for reveal */}
            <div className="req-actual-row" style={{ marginTop: '0.75rem' }}>
              <span className="req-actual-label">Reveal Requested</span>
              <span className="req-actual-value">
                {slots ? slots.filter(s => s.revealRequested).length : 0} / {contractParams.M}
              </span>
            </div>
            {slots && (() => {
              const selected = slots.filter(s => s.revealRequested);
              return selected.length > 0 && (
                <div className="req-actual-oracles">
                  {selected.map(s => (
                    <a
                      key={`s-${s.slot}`}
                      href={`${networkConfig.explorer}/address/${s.oracle}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="oracle-chip"
                    >
                      slot {s.slot}: {s.oracle.slice(0, 6)}...{s.oracle.slice(-4)} <ExternalLink size={10} />
                    </a>
                  ))}
                </div>
              );
            })()}

            {/* Reveals */}
            <div className="req-actual-row" style={{ marginTop: '0.75rem' }}>
              <span className="req-actual-label">Reveals</span>
              <span className={`req-actual-value ${analysis.revealed >= contractParams.N ? 'val-ok' : analysis.revealed > 0 ? 'val-warn' : 'val-fail'}`}>
                {analysis.revealed} / {contractParams.N}
              </span>
            </div>
            {slots && (() => {
              const revealers = slots.filter(s => s.revealOK);
              return revealers.length > 0 && (
                <div className="req-actual-oracles">
                  {revealers.map(s => (
                    <a
                      key={`r-${s.slot}`}
                      href={`${networkConfig.explorer}/address/${s.oracle}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="oracle-chip"
                    >
                      slot {s.slot}: {s.oracle.slice(0, 6)}...{s.oracle.slice(-4)} <ExternalLink size={10} />
                    </a>
                  ))}
                </div>
              );
            })()}

            {/* Non-responding */}
            {analysis.nonResponding > 0 && (
              <>
                <div className="req-actual-row" style={{ marginTop: '0.75rem' }}>
                  <span className="req-actual-label">Non-responding</span>
                  <span className="req-actual-value val-warn">{analysis.nonResponding}</span>
                </div>
                <div className="req-actual-detail">
                  Slots: {analysis.nonRespondingSlotIds.join(', ')}
                </div>
              </>
            )}

            {/* Failures */}
            {Object.values(analysis.failures).some(v => v > 0) && (
              <div className="req-actual-failures" style={{ marginTop: '0.75rem' }}>
                <span className="req-actual-label" style={{ marginBottom: '0.25rem', display: 'block' }}>Failures</span>
                {analysis.failures.hashMismatch > 0 && (
                  <div className="failure-line"><XCircle size={12} className="icon-fail" /> {analysis.failures.hashMismatch} hash mismatch</div>
                )}
                {analysis.failures.invalidFormat > 0 && (
                  <div className="failure-line"><XCircle size={12} className="icon-fail" /> {analysis.failures.invalidFormat} invalid format</div>
                )}
                {analysis.failures.tooManyScores > 0 && (
                  <div className="failure-line"><XCircle size={12} className="icon-fail" /> {analysis.failures.tooManyScores} too many scores</div>
                )}
                {analysis.failures.wrongScoreCount > 0 && (
                  <div className="failure-line"><XCircle size={12} className="icon-fail" /> {analysis.failures.wrongScoreCount} wrong score count</div>
                )}
                {analysis.failures.tooFewScores > 0 && (
                  <div className="failure-line"><XCircle size={12} className="icon-fail" /> {analysis.failures.tooFewScores} too few scores</div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Request Event */}
      {requestEvent && (
        <div className="analytics-section">
          <h2><Activity size={20} /> Request Details</h2>
          <div className="fulfillment-details">
            <div className="detail-row">
              <span className="detail-label">Block:</span>
              <span className="detail-value">
                {requestEvent.block}
                {requestEvent.timestamp ? ` (${formatTime(requestEvent.timestamp)})` : ''}
              </span>
            </div>
            <div className="detail-row">
              <span className="detail-label">Tx Hash:</span>
              <span className="detail-value">
                <a
                  href={`${networkConfig.explorer}/tx/${requestEvent.txHash}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ color: 'var(--primary)', textDecoration: 'none' }}
                >
                  {requestEvent.txHash.slice(0, 20)}... <ExternalLink size={12} style={{ verticalAlign: 'middle' }} />
                </a>
              </span>
            </div>
            <div className="detail-row">
              <span className="detail-label">CIDs:</span>
              <span className="detail-value">
                {requestEvent.cids?.length > 0
                  ? requestEvent.cids.map((cid, i) => (
                      <span key={cid}>
                        {i > 0 && ', '}
                        <a
                          href={`${config.ipfsGateway}/ipfs/${cid}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          style={{ color: 'var(--primary)', textDecoration: 'none' }}
                        >
                          {cid} <ExternalLink size={10} style={{ verticalAlign: 'middle' }} />
                        </a>
                      </span>
                    ))
                  : 'N/A'}
              </span>
            </div>
          </div>
        </div>
      )}

      {/* Oracle Slots Table */}
      {slots && slots.length > 0 && (
        <div className="analytics-section">
          <h2><Users size={20} /> Arbiter Slots ({slots.length})</h2>
          <div className="slots-table">
            <table>
              <thead>
                <tr>
                  <th>Slot</th>
                  <th>Arbiter Addr</th>
                  <th>Job ID</th>
                  <th>Commit</th>
                  <th>Reveal Req</th>
                  <th>Reveal OK</th>
                  <th>Hash Mis</th>
                  <th>Bad Fmt</th>
                  <th>Too Many</th>
                  <th>Wrong Cnt</th>
                  <th>Too Few</th>
                </tr>
              </thead>
              <tbody>
                {slots.map(slot => (
                  <tr key={slot.slot}>
                    <td>{slot.slot}</td>
                    <td className="oracle-cell">
                      <a
                        href={`${networkConfig.explorer}/address/${slot.oracle}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="oracle-link"
                      >
                        {slot.oracle.slice(0, 8)}...{slot.oracle.slice(-4)}
                        <ExternalLink size={10} />
                      </a>
                    </td>
                    <td className="oracle-cell" title={slot.jobId || ''}>
                      {slot.jobId ? (
                        <span className="jobid-cell">
                          {slot.jobId.slice(0, 8)}...{slot.jobId.slice(-4)}
                          <button className="copy-icon-btn" onClick={() => handleCopy(slot.jobId, `job-${slot.slot}`)}>
                            {copied === `job-${slot.slot}` ? <CheckCircle size={11} className="icon-ok" /> : <Copy size={11} />}
                          </button>
                        </span>
                      ) : '-'}
                    </td>
                    <BoolCell value={slot.committed} />
                    <BoolCell value={slot.revealRequested} />
                    <BoolCell value={slot.revealOK} />
                    <BoolCell value={slot.hashMismatch} invert />
                    <BoolCell value={slot.invalidFormat} invert />
                    <BoolCell value={slot.tooManyScores} invert />
                    <BoolCell value={slot.wrongScoreCount} invert />
                    <BoolCell value={slot.tooFewScores} invert />
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Timing: block numbers + timestamps of each arbiter's lifecycle events */}
      {slots && slots.length > 0 && slots.some(s => s.timing) && (
        <div className="analytics-section">
          <h2><Clock size={20} /> Timing</h2>
          <p className="timing-hint">
            Block and time of each event per arbiter. The offset (+m:ss) is measured from the request
            {requestEvent?.timestamp ? ` at ${formatTime(requestEvent.timestamp)}` : ''}.
          </p>
          <div className="slots-table timing-table">
            <table>
              <thead>
                <tr>
                  <th>Slot</th>
                  <th>Arbiter Addr</th>
                  <th>Job ID</th>
                  <th>Selected</th>
                  <th>Commit</th>
                  <th>Reveal Req</th>
                  <th>Reveal</th>
                </tr>
              </thead>
              <tbody>
                {slots.map(slot => {
                  const t = slot.timing || {};
                  const revealEvt = t.reveal || t.failure;
                  const revealFailed = !t.reveal && !!t.failure;
                  return (
                    <tr key={`t-${slot.slot}`}>
                      <td>{slot.slot}</td>
                      <td className="oracle-cell">
                        <a
                          href={`${networkConfig.explorer}/address/${slot.oracle}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="oracle-link"
                        >
                          {slot.oracle.slice(0, 8)}...{slot.oracle.slice(-4)}
                          <ExternalLink size={10} />
                        </a>
                      </td>
                      <td className="oracle-cell" title={slot.jobId || ''}>
                        {slot.jobId ? (
                          <span className="jobid-cell">
                            {slot.jobId.slice(0, 8)}...{slot.jobId.slice(-4)}
                            <button className="copy-icon-btn" onClick={() => handleCopy(slot.jobId, `tjob-${slot.slot}`)}>
                              {copied === `tjob-${slot.slot}` ? <CheckCircle size={11} className="icon-ok" /> : <Copy size={11} />}
                            </button>
                          </span>
                        ) : '-'}
                      </td>
                      <TimingCell evt={t.selected} base={requestEvent?.timestamp} />
                      <TimingCell evt={t.commit} base={requestEvent?.timestamp} />
                      <TimingCell evt={t.revealRequest} base={requestEvent?.timestamp} />
                      <TimingCell evt={revealEvt} base={requestEvent?.timestamp} failed={revealFailed} />
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <TimingScatter slots={slots} requestTimestamp={requestEvent?.timestamp} />
        </div>
      )}

      {/* Fulfillment */}
      {fulfillment && (
        <div className="analytics-section">
          <h2><CheckCircle size={20} /> Fulfillment</h2>
          <div className="fulfillment-details">
            <div className="detail-row">
              <span className="detail-label">Likelihoods:</span>
              <span className="detail-value">[{fulfillment.likelihoods.join(', ')}]</span>
            </div>
            {fulfillment.justificationCID && (
              <div className="detail-row">
                <span className="detail-label">Justification CID:</span>
                <span className="detail-value">
                  <a
                    href={`${config.ipfsGateway}/ipfs/${fulfillment.justificationCID}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{ color: 'var(--primary)', textDecoration: 'none' }}
                  >
                    {fulfillment.justificationCID} <ExternalLink size={10} style={{ verticalAlign: 'middle' }} />
                  </a>
                </span>
              </div>
            )}
            <div className="detail-row">
              <span className="detail-label">Block:</span>
              <span className="detail-value">
                {fulfillment.block}
                {fulfillment.timestamp ? ` (${formatTime(fulfillment.timestamp)}` : ''}
                {fulfillment.timestamp && requestEvent?.timestamp ? `, ${formatOffset(fulfillment.timestamp - requestEvent.timestamp)} after request` : ''}
                {fulfillment.timestamp ? ')' : ''}
              </span>
            </div>
            <div className="detail-row">
              <span className="detail-label">Tx Hash:</span>
              <span className="detail-value">
                <a
                  href={`${networkConfig.explorer}/tx/${fulfillment.txHash}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ color: 'var(--primary)', textDecoration: 'none' }}
                >
                  {fulfillment.txHash.slice(0, 20)}... <ExternalLink size={12} style={{ verticalAlign: 'middle' }} />
                </a>
              </span>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}

/** Format a unix timestamp (seconds) as a local date/time string. */
function formatTime(ts) {
  if (!ts) return '';
  return new Date(ts * 1000).toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  });
}

/** Format a duration in seconds as +m:ss (or +h:mm:ss beyond an hour). */
function formatOffset(seconds) {
  if (seconds == null || Number.isNaN(seconds)) return '';
  const sign = seconds < 0 ? '-' : '+';
  const abs = Math.abs(Math.round(seconds));
  const h = Math.floor(abs / 3600);
  const m = Math.floor((abs % 3600) / 60);
  const s = abs % 60;
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
  return `${sign}${h > 0 ? `${h}:` : ''}${mm}:${String(s).padStart(2, '0')}`;
}

/**
 * Timing cell: block number (linked to the tx), wall-clock time, and offset
 * from the request. `evt` is { block, timestamp, txHash } or null.
 */
function TimingCell({ evt, base, failed }) {
  if (!evt || evt.block == null) {
    return <td><span className="icon-na">-</span></td>;
  }
  const offset = (base && evt.timestamp) ? formatOffset(evt.timestamp - base) : null;
  return (
    <td className={`timing-cell${failed ? ' timing-failed' : ''}`} title={evt.txHash || ''}>
      <div className="timing-block">
        {evt.txHash ? (
          <a
            href={`${networkConfig.explorer}/tx/${evt.txHash}`}
            target="_blank"
            rel="noopener noreferrer"
            className="oracle-link"
          >
            #{evt.block} <ExternalLink size={10} />
          </a>
        ) : `#${evt.block}`}
        {failed && <XCircle size={12} className="icon-fail" title="Reveal rejected" />}
      </div>
      <div className="timing-time">{evt.timestamp ? formatTime(evt.timestamp) : 'time unavailable'}</div>
      {offset && <div className="timing-offset">{offset}</div>}
    </td>
  );
}

/**
 * Scatter plot: one row per unique arbiter address (y), time since the request (x).
 * Commits and reveals are separate series; a rejected reveal is drawn hollow.
 */
const SCATTER_SERIES = {
  commit: { label: 'Commit', color: '#2a78d6' },
  reveal: { label: 'Reveal', color: '#eb6834' }
};

function TimingScatter({ slots, requestTimestamp }) {
  const [hover, setHover] = useState(null);
  const svgRef = useRef(null);

  // Collect points: { arbiter, kind, slot, block, ts, rejected }
  const points = [];
  for (const s of slots) {
    const t = s.timing || {};
    if (t.commit?.timestamp) {
      points.push({ arbiter: s.oracle, kind: 'commit', slot: s.slot, block: t.commit.block, ts: t.commit.timestamp, rejected: false });
    }
    const rev = t.reveal || t.failure;
    if (rev?.timestamp) {
      points.push({ arbiter: s.oracle, kind: 'reveal', slot: s.slot, block: rev.block, ts: rev.timestamp, rejected: !t.reveal });
    }
  }
  if (points.length === 0) return null;

  // Reference lines: when arbiters were selected (commit phase opens) and when
  // reveals were requested (reveal phase opens). Usually one block each, but
  // keep every distinct timestamp.
  const selectedTs = [...new Set(slots.map(s => s.timing?.selected?.timestamp).filter(Boolean))];
  const revealReqTs = [...new Set(slots.map(s => s.timing?.revealRequest?.timestamp).filter(Boolean))];

  // Time base: the request, else the earliest event
  const base = requestTimestamp || Math.min(...points.map(p => p.ts), ...selectedTs);
  for (const p of points) p.x = p.ts - base;

  // Group points that land on exactly the same spot (same arbiter, same
  // timestamp, same kind) so one hover shows every event stacked there.
  // Kind is part of the key: an arbiter holding several slots can have one
  // slot's reveal land in the same block as another slot's commit, and a
  // mixed group would draw one colour on top of the other, hiding an event.
  const groups = [];
  const groupIndex = new Map();
  for (const p of points) {
    const key = `${p.arbiter}|${p.ts}|${p.kind}`;
    if (!groupIndex.has(key)) {
      groupIndex.set(key, groups.length);
      groups.push({ arbiter: p.arbiter, ts: p.ts, x: p.x, kind: p.kind, items: [] });
    }
    groups[groupIndex.get(key)].items.push(p);
  }
  for (const g of groups) g.items.sort((a, b) => a.slot - b.slot);

  // Where a commit group and a reveal group coincide (same arbiter + instant),
  // nudge them apart vertically so both dots stay visible and hoverable.
  const COINCIDENT_DY = 6;
  const spotCount = new Map();
  for (const g of groups) {
    const spot = `${g.arbiter}|${g.ts}`;
    spotCount.set(spot, (spotCount.get(spot) || 0) + 1);
  }
  for (const g of groups) {
    const shared = spotCount.get(`${g.arbiter}|${g.ts}`) > 1;
    g.dy = shared ? (g.kind === 'commit' ? -COINCIDENT_DY : COINCIDENT_DY) : 0;
  }

  // Y: unique arbiters in first-seen slot order
  const arbiters = [];
  for (const s of slots) if (!arbiters.includes(s.oracle)) arbiters.push(s.oracle);

  // Layout (viewBox units = px at 1x)
  const margin = { top: 12, right: 20, bottom: 34, left: 118 };
  const rowH = 28;
  const width = 720;
  const plotW = width - margin.left - margin.right;
  const plotH = arbiters.length * rowH;
  const height = margin.top + plotH + margin.bottom;

  const maxX = Math.max(60, ...points.map(p => p.x), ...revealReqTs.map(t => t - base), ...selectedTs.map(t => t - base));
  const tickStep = niceTickStep(maxX);
  const xMax = Math.ceil(maxX / tickStep) * tickStep;
  const xScale = (x) => margin.left + (x / xMax) * plotW;
  const yScale = (i) => margin.top + i * rowH + rowH / 2;
  const ticks = [];
  for (let v = 0; v <= xMax; v += tickStep) ticks.push(v);

  const short = (a) => `${a.slice(0, 6)}...${a.slice(-4)}`;

  for (const g of groups) {
    g.cx = xScale(g.x);
    g.cy = yScale(arbiters.indexOf(g.arbiter)) + g.dy;
  }

  // Hover is resolved by nearest group to the pointer (in viewBox units), not
  // by stacked per-dot hit areas — overlapping hit circles let a later dot
  // swallow its neighbour's hover.
  const HOVER_RADIUS = 14;
  const handlePointerMove = (e) => {
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const px = (e.clientX - rect.left) * (width / rect.width);
    const py = (e.clientY - rect.top) * (height / rect.height);
    let best = null;
    let bestD = Infinity;
    for (let gi = 0; gi < groups.length; gi++) {
      const g = groups[gi];
      const d = Math.hypot(g.cx - px, g.cy - py);
      if (d < bestD) { bestD = d; best = gi; }
    }
    if (best !== null && bestD <= HOVER_RADIUS) {
      if (!hover || hover.gi !== best) setHover({ gi: best, cx: groups[best].cx, cy: groups[best].cy, g: groups[best] });
      return;
    }
    // No dot nearby: fall back to the reference lines (within the plot rows).
    if (py >= margin.top && py <= margin.top + plotH) {
      const lines = [
        ...selectedTs.map(t => ({ kind: 'commit', label: 'Arbiters selected', ts: t })),
        ...revealReqTs.map(t => ({ kind: 'reveal', label: 'Reveal requested', ts: t }))
      ];
      let bestLine = null;
      let bestLD = Infinity;
      for (const ln of lines) {
        const d = Math.abs(xScale(ln.ts - base) - px);
        if (d < bestLD) { bestLD = d; bestLine = ln; }
      }
      if (bestLine && bestLD <= 6) {
        const key = `line-${bestLine.kind}-${bestLine.ts}`;
        if (!hover || hover.gi !== key) {
          setHover({ gi: key, cx: xScale(bestLine.ts - base), cy: py, line: bestLine });
        }
        return;
      }
    }
    if (hover) setHover(null);
  };

  return (
    <div className="timing-scatter">
      <div className="scatter-legend">
        {Object.entries(SCATTER_SERIES).map(([k, v]) => (
          <span key={k} className="scatter-legend-item">
            <span className="scatter-swatch" style={{ background: v.color }} />
            {v.label}
          </span>
        ))}
        {points.some(p => p.rejected) && (
          <span className="scatter-legend-item">
            <span className="scatter-swatch hollow" style={{ borderColor: SCATTER_SERIES.reveal.color }} />
            Reveal (rejected)
          </span>
        )}
        {selectedTs.length > 0 && (
          <span className="scatter-legend-item">
            <span className="scatter-linekey vertical" style={{ background: SCATTER_SERIES.commit.color }} />
            Selected
          </span>
        )}
        {revealReqTs.length > 0 && (
          <span className="scatter-legend-item">
            <span className="scatter-linekey vertical" style={{ background: SCATTER_SERIES.reveal.color }} />
            Reveal requested
          </span>
        )}
      </div>
      <div className="scatter-wrap">
        <svg
          viewBox={`0 0 ${width} ${height}`}
          width="100%"
          role="img"
          aria-label="Commit and reveal times per arbiter"
          ref={svgRef}
          onPointerMove={handlePointerMove}
          onPointerLeave={() => setHover(null)}
        >
          {/* Row bands + y labels */}
          {arbiters.map((a, i) => (
            <g key={a}>
              <line
                x1={margin.left} x2={margin.left + plotW}
                y1={yScale(i)} y2={yScale(i)}
                className="scatter-rowline"
              />
              <text x={margin.left - 8} y={yScale(i)} className="scatter-ylabel" dominantBaseline="middle" textAnchor="end">
                {short(a)}
              </text>
            </g>
          ))}
          {/* Vertical gridlines + x ticks */}
          {ticks.map(v => (
            <g key={v}>
              <line
                x1={xScale(v)} x2={xScale(v)}
                y1={margin.top} y2={margin.top + plotH}
                className="scatter-grid"
              />
              <text x={xScale(v)} y={margin.top + plotH + 16} className="scatter-xlabel" textAnchor="middle">
                {formatOffset(v)}
              </text>
            </g>
          ))}
          <text x={margin.left + plotW / 2} y={height - 4} className="scatter-xtitle" textAnchor="middle">
            time since request
          </text>
          {/* Reference lines: selection (commit phase opens) and reveal requests */}
          {selectedTs.map(t => (
            <line
              key={`sel-${t}`}
              x1={xScale(t - base)} x2={xScale(t - base)}
              y1={margin.top} y2={margin.top + plotH}
              className="scatter-refline"
              stroke={SCATTER_SERIES.commit.color}
            >
            </line>
          ))}
          {revealReqTs.map(t => (
            <line
              key={`rr-${t}`}
              x1={xScale(t - base)} x2={xScale(t - base)}
              y1={margin.top} y2={margin.top + plotH}
              className="scatter-refline"
              stroke={SCATTER_SERIES.reveal.color}
            >
            </line>
          ))}
          {/* Points: one visual per stacked group; keyboard-focusable, but pointer
              hover is resolved by the svg-level nearest-group handler above. */}
          {groups.map((g, gi) => {
            const { cx, cy } = g;
            const active = hover && hover.gi === gi;
            const stacked = g.items.length > 1;
            // Stacked groups are drawn a little larger so the count fits inside
            const r = (stacked ? 7 : 5) + (active ? 1 : 0);
            const topItem = g.items[g.items.length - 1];
            return (
              <g
                key={gi}
                onFocus={() => setHover({ gi, cx, cy, g })}
                onBlur={() => setHover(null)}
                tabIndex={0}
                className="scatter-hit"
              >
                {g.items.map((p, i) => (
                  <circle
                    key={i}
                    cx={cx} cy={cy}
                    r={r}
                    fill={p.rejected ? 'var(--bg)' : SCATTER_SERIES[p.kind].color}
                    stroke={p.rejected ? SCATTER_SERIES[p.kind].color : 'var(--bg)'}
                    strokeWidth={2}
                  />
                ))}
                {stacked && (
                  <text
                    x={cx} y={cy}
                    className="scatter-count"
                    textAnchor="middle"
                    dominantBaseline="central"
                    fill={topItem.rejected ? SCATTER_SERIES[topItem.kind].color : 'var(--bg)'}
                  >
                    {g.items.length}
                  </text>
                )}
              </g>
            );
          })}
        </svg>
        {hover && (
          <div
            className={`scatter-tooltip${hover.cy < height / 2 ? ' below' : ''}`}
            style={{
              left: `${(hover.cx / width) * 100}%`,
              top: `${(hover.cy / height) * 100}%`
            }}
          >
            {hover.line ? (
              <>
                <div className="scatter-tooltip-value">{formatOffset(hover.line.ts - base)}</div>
                <div className="scatter-tooltip-row">
                  <span className="scatter-linekey vertical" style={{ background: SCATTER_SERIES[hover.line.kind].color }} />
                  {hover.line.label}
                </div>
                <div className="scatter-tooltip-row">{formatTime(hover.line.ts)}</div>
              </>
            ) : (
              <>
                <div className="scatter-tooltip-value">{formatOffset(hover.g.x)}</div>
                {hover.g.items.map((p, i) => (
                  <div key={i} className="scatter-tooltip-row">
                    <span className="scatter-linekey" style={{ background: SCATTER_SERIES[p.kind].color }} />
                    {SCATTER_SERIES[p.kind].label}{p.rejected ? ' (rejected)' : ''} · slot {p.slot} · block #{p.block}
                  </div>
                ))}
                <div className="scatter-tooltip-row">{formatTime(hover.g.ts)} · {short(hover.g.arbiter)}</div>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/** Pick a tick step (seconds) that yields roughly 4-8 ticks. */
function niceTickStep(maxSeconds) {
  const steps = [10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600];
  for (const st of steps) {
    if (maxSeconds / st <= 8) return st;
  }
  return 3600 * Math.ceil(maxSeconds / 3600 / 8);
}

/**
 * Boolean cell for the slots table
 * For positive events (commit, reveal): green check = true, gray dash = false
 * For failure events (invert=true): red X = true, gray dash = false
 */
function BoolCell({ value, invert }) {
  if (!value) {
    return <td><span className="icon-na">-</span></td>;
  }
  if (invert) {
    return <td><XCircle size={14} className="icon-fail" /></td>;
  }
  return <td><CheckCircle size={14} className="icon-ok" /></td>;
}

export default AggHistory;
