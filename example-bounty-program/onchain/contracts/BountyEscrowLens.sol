// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

import {IVerdiktaAggregator} from "./interfaces/IVerdiktaAggregator.sol";
import {BountyEscrow} from "./BountyEscrow.sol";

/// @title BountyEscrowLens
/// @notice The BountyEscrow's read-only convenience views, kept in a separate contract so the
///         escrow's runtime bytecode stays under the EIP-170 size limit. Pure reads: no state,
///         no owner, no way to write anything.
/// @dev Two ways to call it, same answers:
///   1. AT THE ESCROW ADDRESS, with the escrow's merged ABI (escrow + lens). The escrow's
///      fallback forwards every selector it does not implement itself to this contract via a
///      STATICCALL-guarded delegatecall (see BountyEscrow.fallback / lensDelegate). Callers
///      need no second address and see no difference from a view living in the escrow.
///   2. Directly at this contract's address (`BountyEscrow.lens()`), e.g. from a block
///      explorer's read tab, where the escrow's verified source does not list these views.
///
///   Every read goes through the escrow's own external getters (getBounty, getSubmission,
///   activeEvaluations, ...), never raw storage slots, so there is no storage layout to keep in
///   sync between the two contracts. `escrow` and `verdikta` are immutables — part of the
///   code, not storage — so they are intact when this code runs under delegatecall.
///
///   Created exactly once, by the escrow's constructor (msg.sender at construction IS the
///   escrow). There is no setter anywhere: the pair is fixed for life, like every other rule
///   of the escrow.
contract BountyEscrowLens {
    BountyEscrow public immutable escrow;
    IVerdiktaAggregator public immutable verdikta;

    /// @notice Page size cap for getBounties.
    uint256 public constant MAX_BATCH = 100;

    constructor(IVerdiktaAggregator _verdikta) {
        escrow = BountyEscrow(payable(msg.sender));
        verdikta = _verdikta;
    }

    /// @dev Reached when the escrow forwards a selector that neither contract implements
    ///      (a mistyped function name, or an ABI from another release). A readable reason
    ///      instead of the empty revert data a missing selector would otherwise produce.
    fallback() external {
        revert("unknown function");
    }

    // ------------- Bounty views -------------

    /// @notice Get the effective status of a bounty for frontend display
    /// @dev Returns: "OPEN", "EXPIRED", "AWARDED", or "CLOSED"
    /// @return status One of four status strings
    function getEffectiveBountyStatus(uint256 bountyId)
        external view returns (string memory)
    {
        BountyEscrow.Bounty memory b = escrow.getBounty(bountyId);

        // Terminal states first
        if (b.status == BountyEscrow.BountyStatus.Awarded) return "AWARDED";
        if (b.status == BountyEscrow.BountyStatus.Closed) return "CLOSED";

        // Open enum, but check if deadline passed
        if (b.status == BountyEscrow.BountyStatus.Open) {
            if (block.timestamp >= b.submissionDeadline) {
                return "EXPIRED"; // Deadline passed, awaiting closeExpiredBounty
            }
            return "OPEN"; // Active, accepting submissions
        }

        return "UNKNOWN"; // Should never happen
    }

    /// @notice Would prepareSubmission succeed for this bounty RIGHT NOW (ignoring who calls)?
    /// @dev Open, before the effective prepare cutoff (see prepareCutoff — on windowed bounties
    ///      the creator window must still fit before the deadline), and on windowed bounties
    ///      below MAX_SUBMISSIONS_PER_BOUNTY. Does NOT consider targetHunter: on a targeted
    ///      bounty only that address can prepare — compare it yourself.
    function isAcceptingSubmissions(uint256 bountyId) external view returns (bool) {
        BountyEscrow.Bounty memory b = escrow.getBounty(bountyId);
        if (b.status != BountyEscrow.BountyStatus.Open) return false;
        if (block.timestamp > _prepareCutoff(b)) return false;
        if (b.creatorAssessmentWindowSize > 0 &&
            escrow.submissionCount(bountyId) >= escrow.MAX_SUBMISSIONS_PER_BOUNTY()) return false;
        return true;
    }

    /// @notice Check if a bounty can be closed (deadline passed, no active evals)
    function canBeClosed(uint256 bountyId) external view returns (bool) {
        BountyEscrow.Bounty memory b = escrow.getBounty(bountyId);

        if (b.status != BountyEscrow.BountyStatus.Open) return false;
        if (block.timestamp < b.submissionDeadline) return false;

        // No active evaluations (O(1) — see BountyEscrow.activeEvaluations).
        return escrow.activeEvaluations(bountyId) == 0;
    }

    /// @notice The last timestamp at which prepareSubmission can succeed for this bounty:
    ///         deadline - 1 for plain bounties; on windowed bounties the creator window must
    ///         end at least two seconds before the deadline (one second to start), so it is
    ///         deadline - window - 2. May already be in the past. 0 if the bounty is not Open.
    function prepareCutoff(uint256 bountyId) external view returns (uint256) {
        return _prepareCutoff(escrow.getBounty(bountyId));
    }

    function _prepareCutoff(BountyEscrow.Bounty memory b) internal pure returns (uint256) {
        if (b.status != BountyEscrow.BountyStatus.Open) return 0;
        uint256 d = b.submissionDeadline;
        uint256 w = b.creatorAssessmentWindowSize;
        if (w == 0) return d - 1;
        return d > w + 2 ? d - w - 2 : 0;
    }

    // ------------- Agent-facing views -------------
    // These exist so an agent can drive the whole lifecycle with ONLY the escrow's merged ABI
    // and a plain RPC: batch reads instead of one call per item, the oracle result without
    // the aggregator's ABI, and a single "what should I do now" answer per submission.

    /// @notice Every submission of a bounty in one call. Bounded by MAX_SUBMISSIONS_PER_BOUNTY
    ///         on windowed bounties only; a non-windowed bounty has no prepare cap, so an
    ///         indexer should prefer getSubmissionsPage there (this call is fine for the
    ///         ordinary handful of submissions, but a junk-flooded bounty can exceed an RPC
    ///         provider's eth_call gas allowance).
    function getSubmissions(uint256 bountyId)
        external view returns (BountyEscrow.Submission[] memory out)
    {
        require(bountyId < escrow.bountyCount(), "bad bountyId");
        uint256 n = escrow.submissionCount(bountyId);
        out = new BountyEscrow.Submission[](n);
        for (uint256 i = 0; i < n; i++) out[i] = escrow.getSubmission(bountyId, i);
    }

    /// @notice Up to MAX_BATCH submissions of a bounty starting at `start` (clamped to what
    ///         exists). An empty array means `start` is past the end. Page with
    ///         start += result.length; submission id == start + index.
    function getSubmissionsPage(uint256 bountyId, uint256 start, uint256 count)
        external view returns (BountyEscrow.Submission[] memory out)
    {
        require(bountyId < escrow.bountyCount(), "bad bountyId");
        uint256 n = escrow.submissionCount(bountyId);
        if (start >= n) return new BountyEscrow.Submission[](0);
        if (count > MAX_BATCH) count = MAX_BATCH;
        uint256 end = start + count;
        if (end > n) end = n;
        out = new BountyEscrow.Submission[](end - start);
        for (uint256 i = start; i < end; i++) out[i - start] = escrow.getSubmission(bountyId, i);
    }

    /// @notice Up to MAX_BATCH bounties starting at `start` (clamped to what exists). An
    ///         empty array means `start` is past the end. Page with start += result.length.
    function getBounties(uint256 start, uint256 count)
        external view returns (BountyEscrow.Bounty[] memory out)
    {
        uint256 n = escrow.bountyCount();
        if (start >= n) return new BountyEscrow.Bounty[](0);
        if (count > MAX_BATCH) count = MAX_BATCH;
        uint256 end = start + count;
        if (end > n) end = n;
        out = new BountyEscrow.Bounty[](end - start);
        for (uint256 i = start; i < end; i++) out[i - start] = escrow.getBounty(i);
    }

    /// @notice The oracle's view of a submission, proxied so callers need no aggregator ABI.
    /// @return started    the evaluation has been started (an aggregation id exists)
    /// @return hasResult  a valid result exists (finalizeSubmission will succeed — unless
    ///                    nextAction says AWAIT_EARLIER: a passing result that must wait for an
    ///                    earlier in-flight submission)
    /// @return settled    the aggregator round is complete (fulfilled, or timed out and finalized)
    /// @return failed     the round timed out without a result (failTimedOutSubmission will succeed)
    /// @return scores     raw likelihoods (see escrow.SCORE_SCALE()), empty if no result
    /// @return justificationCids  the result's justification CIDs, empty if no result
    /// @return startTimestamp     when the round was started on the aggregator (0 if not started)
    function getOracleResult(uint256 bountyId, uint256 submissionId)
        external view
        returns (
            bool started, bool hasResult, bool settled, bool failed,
            uint256[] memory scores, string memory justificationCids, uint256 startTimestamp
        )
    {
        require(bountyId < escrow.bountyCount(), "bad bountyId");
        BountyEscrow.Submission memory s = escrow.getSubmission(bountyId, submissionId);
        if (s.verdiktaAggId == bytes32(0)) {
            return (false, false, false, false, new uint256[](0), "", 0);
        }
        started = true;
        (scores, justificationCids, hasResult) = verdikta.getEvaluation(s.verdiktaAggId);
        (settled, failed, , , , , , , , startTimestamp) = verdikta.getAggregationStatus(s.verdiktaAggId);
    }

    /// @notice What can be done with a submission RIGHT NOW — the on-chain "diagnose".
    /// @dev Every label is the call that will SUCCEED now (not merely the state the submission
    ///      is in). Returns one of:
    ///   "START"          — startPreparedSubmission is callable (Prepared: by the hunter;
    ///                      expired-window PendingCreatorApproval: by anyone) — attach requiredPrepay()
    ///   "AWAIT_SLOT"     — start would revert "evaluation slots full": MAX_ACTIVE_EVALUATIONS
    ///                      evaluations are in flight on this bounty; retry once any resolves
    ///   "AWAIT_CREATOR"  — in its creator window; only the creator can act (creatorApproveSubmission)
    ///   "AWAIT_ORACLE"   — evaluation in flight, no result yet, round not timed out: wait
    ///   "AWAIT_EARLIER"  — a PASSING result exists but finalize would revert "earlier submission
    ///                      pending": a lower-index submission by another hunter is still in
    ///                      evaluation (payout priority — see BountyEscrow._hasEarlierPendingByOther).
    ///                      Retry once it resolves (finalize or force-fail it — anyone may)
    ///   "FINALIZE"       — call finalizeSubmission: a result exists, or the round timed out with
    ///                      enough late reveals that settling it yields one (finalize settles it).
    ///                      On an Awarded/Closed bounty this writes PassedUnpaid/Failed and only
    ///                      refunds the prepay — there is no payout left to win
    ///   "FORCE_FAIL"     — round settled (or timed out and will settle) with no result: call
    ///                      failTimedOutSubmission
    ///   "RECOVER_REFUND" — resolved, but unspent prepay is still recoverable: recoverLeftoverEth
    ///   "DONE"           — resolved, nothing left to do
    ///   "DEAD"           — cannot be started (any more): deadline passed, bounty not open, or an
    ///                      in-flight submission already has a passing result (start would revert
    ///                      "another submission already passed" — that one, or an earlier one,
    ///                      will be paid)
    function nextAction(uint256 bountyId, uint256 submissionId) external view returns (string memory) {
        BountyEscrow.Bounty memory b = escrow.getBounty(bountyId);
        BountyEscrow.Submission memory s = escrow.getSubmission(bountyId, submissionId);
        BountyEscrow.SubmissionStatus st = s.status;
        bool open = b.status == BountyEscrow.BountyStatus.Open;

        if (st == BountyEscrow.SubmissionStatus.Prepared ||
            st == BountyEscrow.SubmissionStatus.PendingCreatorApproval) {
            if (st == BountyEscrow.SubmissionStatus.PendingCreatorApproval &&
                block.timestamp <= s.creatorWindowEnd) {
                return open ? "AWAIT_CREATOR" : "DEAD";
            }
            if (!open || block.timestamp >= b.submissionDeadline) return "DEAD";
            uint256[] memory pending = escrow.pendingSubmissionIds(bountyId);
            if (_anyPassing(bountyId, pending, b.threshold)) return "DEAD";
            if (pending.length >= escrow.MAX_ACTIVE_EVALUATIONS()) return "AWAIT_SLOT";
            return "START";
        }
        if (st == BountyEscrow.SubmissionStatus.PendingVerdikta) {
            (uint256[] memory scores, , bool ok) = verdikta.getEvaluation(s.verdiktaAggId);
            if (ok) {
                if (open && _passes(scores, b.threshold) &&
                    _earlierPendingByOther(bountyId, submissionId, s.hunter)) {
                    return "AWAIT_EARLIER";
                }
                return "FINALIZE";
            }
            (bool settled, , bool commitDone, , , uint256 responses, uint256 required, , , uint256 startTs) =
                verdikta.getAggregationStatus(s.verdiktaAggId);
            if (settled) return "FORCE_FAIL";
            // Not yet settled on-chain, but past the response timeout: both finalize and
            // force-fail settle the round themselves. Which one succeeds depends on whether
            // enough reveals arrived (then settling yields a result) — mirror the aggregator's
            // finalizeEvaluationTimeout branches.
            if (block.timestamp >= startTs + verdikta.responseTimeoutSeconds()) {
                return (commitDone && responses >= required) ? "FINALIZE" : "FORCE_FAIL";
            }
            return "AWAIT_ORACLE";
        }
        // Resolved: Failed / PassedPaid / PassedUnpaid
        if (s.funder != address(0) &&
            (verdikta.ethOwed(s.evalWallet) > 0 || s.evalWallet.balance > 0)) {
            return "RECOVER_REFUND";
        }
        return "DONE";
    }

    // ------------- Internals (mirror the escrow's rules; views only) -------------

    /// @dev Same interpretation as BountyEscrow._scoreVector: a valid two-entry vector with
    ///      both entries within SCORE_SCALE, passing iff FUND / SCORE_DIVISOR >= threshold.
    function _passes(uint256[] memory scores, uint256 threshold) internal view returns (bool) {
        if (scores.length != 2) return false;
        if (scores[0] > escrow.SCORE_SCALE() || scores[1] > escrow.SCORE_SCALE()) return false;
        return scores[1] / escrow.SCORE_DIVISOR() >= threshold;
    }

    /// @dev Does any in-flight evaluation of the bounty already have a passing result?
    ///      (BountyEscrow._requireNoPassingSubmission's condition.)
    function _anyPassing(uint256 bountyId, uint256[] memory pending, uint256 threshold)
        internal view returns (bool)
    {
        for (uint256 i = 0; i < pending.length; i++) {
            bytes32 aggId = escrow.getSubmission(bountyId, pending[i]).verdiktaAggId;
            (uint256[] memory scores, , bool ok) = verdikta.getEvaluation(aggId);
            if (ok && _passes(scores, threshold)) return true;
        }
        return false;
    }

    /// @dev Is a lower-index submission by another hunter still in evaluation?
    ///      (BountyEscrow._hasEarlierPendingByOther's condition.)
    function _earlierPendingByOther(uint256 bountyId, uint256 submissionId, address hunter)
        internal view returns (bool)
    {
        uint256[] memory pending = escrow.pendingSubmissionIds(bountyId);
        for (uint256 i = 0; i < pending.length; i++) {
            uint256 id = pending[i];
            if (id < submissionId && escrow.getSubmission(bountyId, id).hunter != hunter) return true;
        }
        return false;
    }
}
