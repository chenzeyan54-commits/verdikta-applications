// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {IVerdiktaAggregator} from "./interfaces/IVerdiktaAggregator.sol";
import "./EvaluationWallet.sol";

/// @title BountyEscrow
/// @notice Bounty escrow with four effective states: OPEN, EXPIRED, AWARDED, CLOSED
/// @dev No cancellation - creator can only reclaim funds after deadline via closeExpiredBounty
contract BountyEscrow {
    /// @notice On-chain storage states (3 values for gas efficiency)
    enum BountyStatus {
        Open,    // 0: Active (maps to OPEN or EXPIRED based on deadline)
        Awarded, // 1: Winner has been paid
        Closed   // 2: Deadline passed, funds returned to creator
    }

    enum SubmissionStatus {
        Prepared,               // 0: Wallet created, awaiting ETH funding and start
        PendingVerdikta,        // 1: Evaluation in progress
        Failed,                 // 2: Did not meet threshold
        PassedPaid,             // 3: Met threshold and was paid
        PassedUnpaid,           // 4: Met threshold but someone else already won
        PendingCreatorApproval  // 5: Awaiting creator approval during window
    }

    struct Bounty {
        address creator;
        string  evaluationCid;      // IPFS CID for evaluation package (contains jury config, rubric ref, instructions)
        uint64  requestedClass;     // Verdikta class ID
        uint8   threshold;          // 0..100 acceptance threshold
        uint256 payoutWei;          // ETH locked (max of two payment amounts)
        uint256 createdAt;
        uint64  submissionDeadline; // Unix timestamp when submissions close
        BountyStatus status;
        address winner;
        uint256 submissions;        // count
        address targetHunter;       // address(0) = open to all, otherwise only this address can submit
        uint256 creatorDeterminationPayment;  // Payment if creator approves
        uint256 arbiterDeterminationPayment;  // Payment if arbiters approve via Verdikta
        uint64  creatorAssessmentWindowSize;  // Window duration in seconds (0 = no window)
    }

    struct Submission {
        address hunter;
        string  evaluationCid;      // Evaluation package CID (must match bounty's evaluationCid)
        string  hunterCid;          // Hunter's work product archive CID (bCID containing the actual submission)
        address evalWallet;
        bytes32 verdiktaAggId;      // set once started
        SubmissionStatus status;
        uint256 acceptance;         // stored acceptance (0..100)
        uint256 rejection;          // stored rejection (0..100)
        string  justificationCids;  // Verdikta result, if any
        uint256 submittedAt;
        uint256 finalizedAt;
        uint256 ethMaxBudget;       // ETH wei budget computed from maxOracleFee
        uint256 maxOracleFee;       // echo
        uint256 alpha;              // echo
        uint256 estimatedBaseCost;  // echo
        uint256 maxFeeBasedScaling; // echo
        string  addendum;           // echo
        uint64  creatorWindowEnd;   // Timestamp when creator window expires (0 if no window)
    }

    IVerdiktaAggregator public immutable verdikta;

    Bounty[] public bounties;
    mapping(uint256 => Submission[]) public subs;

    /// @notice Pull-payment ledger. ETH owed to an address whose direct payment couldn't be
    ///         delivered (e.g. a contract that rejects ETH). Lets resolution/close-out never
    ///         revert on a hostile or incompatible recipient. Claim via withdraw().
    mapping(address => uint256) public withdrawable;

    /// @notice Per-bounty count of submissions currently in PendingVerdikta. Lets
    ///         closeExpiredBounty / canBeClosed check "no active evaluation" in O(1) instead
    ///         of looping over every submission — an unbounded number of cheap
    ///         prepareSubmission calls could otherwise grow the loop past the block gas limit
    ///         and permanently lock the creator's escrow.
    mapping(uint256 => uint256) public activeEvaluations;

    /// @notice Hard cap on submissions (prepared, in any state) per bounty.
    /// @dev Bounds every per-bounty scan (_requireNoPassingSubmission at start,
    ///      _hasOtherPassingSubmission / _hasEarlierUnresolvedSubmission at finalize and
    ///      creator approval). Without it, a flood of gas-only prepareSubmission calls
    ///      (~2.5k gas per junk entry at finalize, measured) could push a PASSING
    ///      submission's finalize past the block gas limit; force-fail refuses because a
    ///      result exists, activeEvaluations stays pinned, and closeExpiredBounty is
    ///      blocked forever — locking both the hunter's payout and the creator's escrow.
    ///      At 128 the worst-case scan is a few million gas, far below any block limit.
    ///      A full bounty only rejects NEW prepares; existing submissions still resolve
    ///      and the creator can still close at the deadline.
    uint256 public constant MAX_SUBMISSIONS_PER_BOUNTY = 128;

    // Non-reentrancy guard (1 = unlocked, 2 = locked).
    uint256 private _lock = 1;

    // ----------------- Events -----------------
    event BountyCreated(
        uint256 indexed bountyId,
        address indexed creator,
        string evaluationCid,
        uint64 classId,
        uint8 threshold,
        uint256 payoutWei,
        uint64 submissionDeadline
    );

    event BountyClosed(
        uint256 indexed bountyId,
        address indexed creator,
        uint256 amountReturned
    );

    // FIELD ORDER MATTERS: static fields first, the dynamic string LAST.
    // Earlier revisions emitted `string evaluationCid` before `ethMaxBudget`. Because a
    // dynamic field is encoded as an offset word (96 / 0x60) with the bytes appended
    // later, any consumer decoding the log with a truncated or misordered ABI (e.g. a
    // naive `(address,uint256)`) read 96 as the budget and under-funded the start tx.
    // With the string last, even that naive decode reads evalWallet and ethMaxBudget
    // correctly.
    //
    // !! This is an EVENT-SIGNATURE CHANGE relative to the contracts deployed before
    // !! September 2026. It must be deployed together with every off-chain ABI copy
    // !! that decodes this event (server/utils/contractService.js,
    // !! server/routes/jobRoutes.js BUNDLE_ESCROW_ABI, server/scripts/submitToBounties.js,
    // !! client/src/services/contractService.js, client/src/pages/Blockchain.jsx), plus
    // !! a config.deploymentBlock bump and a sync reset. Anything that still reads the
    // !! OLD contract's logs must keep the old field order for that address.
    event SubmissionPrepared(
        uint256 indexed bountyId,
        uint256 indexed submissionId,
        address indexed hunter,
        address evalWallet,
        uint256 ethMaxBudget,
        string evaluationCid
    );

    event WorkSubmitted(
        uint256 indexed bountyId,
        uint256 indexed submissionId,
        bytes32 verdiktaAggId
    );

    event SubmissionFinalized(
        uint256 indexed bountyId,
        uint256 indexed submissionId,
        bool passed,
        uint256 acceptance,
        uint256 rejection,
        string justificationCids
    );

    event PayoutSent(
        uint256 indexed bountyId,
        address indexed winner,
        uint256 amountWei
    );

    event EthRefunded(
        uint256 indexed bountyId,
        uint256 indexed submissionId,
        uint256 amount
    );

    event CreatorApproved(
        uint256 indexed bountyId,
        uint256 indexed submissionId,
        address indexed hunter,
        uint256 amountPaid
    );

    event CreatorRefunded(
        uint256 indexed bountyId,
        address indexed creator,
        uint256 amountRefunded
    );

    /// @notice A direct payment couldn't be delivered and was credited to the pull ledger instead.
    event PaymentDeferred(address indexed to, uint256 amount);

    /// @notice An address claimed its pull-ledger balance.
    event Withdrawn(address indexed account, uint256 amount);

    constructor(IVerdiktaAggregator _verdikta) {
        require(address(_verdikta) != address(0), "zero addr");
        verdikta = _verdikta;
    }

    modifier nonReentrant() {
        require(_lock == 1, "reentrant");
        _lock = 2;
        _;
        _lock = 1;
    }

    // ------------- Bounty lifecycle -------------

    /// @notice Create a bounty with ETH escrow (backward-compatible, no creator window)
    /// @param targetHunter The only address allowed to submit; address(0) = open to all
    function createBounty(
        string calldata evaluationCid,
        uint64  requestedClass,
        uint8   threshold,
        uint64  submissionDeadline,
        address targetHunter
    ) external payable returns (uint256 bountyId) {
        return _createBounty(
            evaluationCid, requestedClass, threshold, submissionDeadline,
            targetHunter, msg.value, msg.value, 0
        );
    }

    /// @notice Create a bounty with creator approval window and split payment amounts
    /// @param targetHunter The only address allowed to submit; address(0) = open to all
    /// @param creatorDeterminationPayment Payment amount if creator approves during window
    /// @param arbiterDeterminationPayment Payment amount if arbiters approve via Verdikta
    /// @param creatorAssessmentWindowSize Window duration in seconds after submission (0 = no window)
    function createBounty(
        string calldata evaluationCid,
        uint64  requestedClass,
        uint8   threshold,
        uint64  submissionDeadline,
        address targetHunter,
        uint256 creatorDeterminationPayment,
        uint256 arbiterDeterminationPayment,
        uint64  creatorAssessmentWindowSize
    ) external payable returns (uint256 bountyId) {
        return _createBounty(
            evaluationCid, requestedClass, threshold, submissionDeadline,
            targetHunter, creatorDeterminationPayment, arbiterDeterminationPayment,
            creatorAssessmentWindowSize
        );
    }

    function _createBounty(
        string calldata evaluationCid,
        uint64  requestedClass,
        uint8   threshold,
        uint64  submissionDeadline,
        address targetHunter,
        uint256 creatorDeterminationPayment,
        uint256 arbiterDeterminationPayment,
        uint64  creatorAssessmentWindowSize
    ) internal returns (uint256 bountyId) {
        require(creatorDeterminationPayment > 0, "no creator payment");
        require(arbiterDeterminationPayment > 0, "no arbiter payment");
        require(
            msg.value == _max(creatorDeterminationPayment, arbiterDeterminationPayment),
            "ETH must equal max payment"
        );
        require(bytes(evaluationCid).length > 0, "empty evaluationCid");
        require(threshold <= 100, "bad threshold");
        require(submissionDeadline > block.timestamp, "deadline in past");
        require(
            creatorAssessmentWindowSize > 0 || creatorDeterminationPayment == arbiterDeterminationPayment,
            "window required when payments differ"
        );

        bounties.push(Bounty({
            creator: msg.sender,
            evaluationCid: evaluationCid,
            requestedClass: requestedClass,
            threshold: threshold,
            payoutWei: msg.value,
            createdAt: block.timestamp,
            submissionDeadline: submissionDeadline,
            status: BountyStatus.Open,
            winner: address(0),
            submissions: 0,
            targetHunter: targetHunter,
            creatorDeterminationPayment: creatorDeterminationPayment,
            arbiterDeterminationPayment: arbiterDeterminationPayment,
            creatorAssessmentWindowSize: creatorAssessmentWindowSize
        }));

        bountyId = bounties.length - 1;
        emit BountyCreated(
            bountyId,
            msg.sender,
            evaluationCid,
            requestedClass,
            threshold,
            msg.value,
            submissionDeadline
        );
    }

    /// @notice Close an expired bounty and return funds to creator
    /// @dev Can be called by ANYONE after submissionDeadline passes
    /// @dev Requires no active evaluations (PendingVerdikta submissions)
    /// @dev Safe to call at the deadline: prepare and start both require block.timestamp
    ///      to be before the deadline, so no submission can enter evaluation afterwards.
    ///      Only an evaluation already in flight (PendingVerdikta) blocks closing.
    /// @param bountyId The bounty to close
    function closeExpiredBounty(uint256 bountyId) external nonReentrant {
        Bounty storage b = _mustBounty(bountyId);
        require(b.status == BountyStatus.Open, "not open");
        require(block.timestamp >= b.submissionDeadline, "deadline not passed");

        // No submissions may be actively being evaluated (O(1) — see activeEvaluations).
        require(activeEvaluations[bountyId] == 0, "active evaluation - finalize first");

        // All clear - return funds to creator
        b.status = BountyStatus.Closed;
        uint256 amt = b.payoutWei;
        b.payoutWei = 0;

        emit BountyClosed(bountyId, b.creator, amt);
        _payOrCredit(b.creator, amt);
    }

    // ------------- Submissions & Verdikta -------------

    /// @notice STEP 1: Prepare a submission. Deploys an EvaluationWallet and records parameters.
    /// @dev The ethMaxBudget is emitted so the funder knows how much ETH to attach when starting.
    /// @dev If the bounty has a creator assessment window, status starts as PendingCreatorApproval.
    /// @dev Otherwise, status starts as Prepared (classic behavior).
    /// @dev Can only be called before the submission deadline. On windowed bounties the
    ///      effective cutoff is earlier: the creator window must end before the deadline.
    /// @param bountyId The bounty to submit to
    /// @param evaluationCid The evaluation package CID (must match the bounty's stored evaluationCid)
    /// @param hunterCid The hunter's work product archive CID (bCID containing the actual submission)
    /// @param addendum Optional text addendum for the evaluation
    /// @param alpha Reputation weight (0-1000, see ReputationKeeper)
    /// @param maxOracleFee Maximum fee per oracle
    /// @param estimatedBaseCost Estimated base cost
    /// @param maxFeeBasedScaling Maximum fee-based scaling
    function prepareSubmission(
        uint256 bountyId,
        string calldata evaluationCid,
        string calldata hunterCid,
        string calldata addendum,
        uint256 alpha,
        uint256 maxOracleFee,
        uint256 estimatedBaseCost,
        uint256 maxFeeBasedScaling
    ) external returns (uint256 submissionId, address evalWallet, uint256 ethMaxBudget) {
        Bounty storage b = _mustBounty(bountyId);
        require(b.status == BountyStatus.Open, "bounty not open");
        require(block.timestamp < b.submissionDeadline, "deadline passed");
        if (b.targetHunter != address(0)) {
            require(msg.sender == b.targetHunter, "bounty is targeted");
        }
        require(bytes(evaluationCid).length > 0, "empty evaluationCid");
        require(bytes(hunterCid).length > 0, "empty hunterCid");
        require(subs[bountyId].length < MAX_SUBMISSIONS_PER_BOUNTY, "submission limit reached");

        // Verify evaluationCid matches the bounty's stored evaluationCid
        require(
            keccak256(bytes(evaluationCid)) == keccak256(bytes(b.evaluationCid)),
            "evaluationCid mismatch"
        );

        ethMaxBudget = verdikta.maxTotalFee(maxOracleFee);
        require(ethMaxBudget > 0, "bad budget");

        EvaluationWallet wallet = new EvaluationWallet(
            address(this),
            msg.sender,
            verdikta
        );

        bool hasWindow = b.creatorAssessmentWindowSize > 0;

        // Windowed bounties: the deadline is the last moment for the hunter to have their
        // evaluation STARTED (see startPreparedSubmission), and starting is only allowed
        // strictly after the creator window ends. So the window must end early enough to
        // leave at least one second in which the hunter can start. Otherwise the submission
        // could never be arbitrated and the deadline-based close would be unsafe.
        if (hasWindow) {
            require(
                block.timestamp + b.creatorAssessmentWindowSize + 1 < b.submissionDeadline,
                "window would end after deadline"
            );
        }

        Submission memory s = Submission({
            hunter: msg.sender,
            evaluationCid: evaluationCid,
            hunterCid: hunterCid,
            evalWallet: address(wallet),
            verdiktaAggId: bytes32(0),
            status: hasWindow
                ? SubmissionStatus.PendingCreatorApproval
                : SubmissionStatus.Prepared,
            acceptance: 0,
            rejection: 0,
            justificationCids: "",
            submittedAt: block.timestamp,
            finalizedAt: 0,
            ethMaxBudget: ethMaxBudget,
            maxOracleFee: maxOracleFee,
            alpha: alpha,
            estimatedBaseCost: estimatedBaseCost,
            maxFeeBasedScaling: maxFeeBasedScaling,
            addendum: addendum,
            creatorWindowEnd: hasWindow
                ? uint64(block.timestamp) + b.creatorAssessmentWindowSize
                : 0
        });

        subs[bountyId].push(s);
        submissionId = subs[bountyId].length - 1;
        b.submissions += 1;

        emit SubmissionPrepared(
            bountyId,
            submissionId,
            msg.sender,
            address(wallet),
            ethMaxBudget,
            evaluationCid
        );

        return (submissionId, address(wallet), ethMaxBudget);
    }

    /// @notice Creator approves a submission during the assessment window
    /// @dev Pays creatorDeterminationPayment to hunter, refunds excess to creator
    /// @dev Blocked while an earlier submission by ANOTHER hunter still holds priority
    ///      (in evaluation, or in its own open window) — see _hasEarlierUnresolvedSubmission
    function creatorApproveSubmission(uint256 bountyId, uint256 submissionId) external nonReentrant {
        Bounty storage b = _mustBounty(bountyId);
        Submission storage s = _mustSubmission(bountyId, submissionId);

        require(msg.sender == b.creator, "only creator");
        require(b.status == BountyStatus.Open, "bounty not open");
        require(s.status == SubmissionStatus.PendingCreatorApproval, "not pending creator approval");
        require(block.timestamp <= s.creatorWindowEnd, "window expired");
        require(
            !_hasEarlierUnresolvedSubmission(bountyId, submissionId),
            "earlier submission unresolved"
        );

        uint256 pay = b.creatorDeterminationPayment;
        uint256 refund = b.payoutWei - pay;

        b.payoutWei = 0;
        b.status = BountyStatus.Awarded;
        b.winner = s.hunter;
        s.status = SubmissionStatus.PassedPaid;
        s.finalizedAt = block.timestamp;

        emit CreatorApproved(bountyId, submissionId, s.hunter, pay);
        emit PayoutSent(bountyId, s.hunter, pay);
        _payOrCredit(s.hunter, pay);

        if (refund > 0) {
            emit CreatorRefunded(bountyId, b.creator, refund);
            _payOrCredit(b.creator, refund);
        }
    }

    /// @notice STEP 2: Fund and start the Verdikta evaluation by attaching ETH.
    /// @dev The caller attaches msg.value == ethMaxBudget; it is forwarded to the
    ///      EvaluationWallet, which prepays Verdikta. No ERC20 approval is needed.
    /// @dev For Prepared submissions (no window): only the hunter can call.
    /// @dev For PendingCreatorApproval submissions (window expired): anyone can call and fund.
    /// @dev Must be called BEFORE the submission deadline. Everything the hunter has to do
    ///      (prepare, wait out any creator window, start) happens before the deadline, so at
    ///      the deadline every submission is either paid, in evaluation, or dead. That is
    ///      what makes closeExpiredBounty's deadline check sufficient.
    /// @dev Reverts if any existing submission has already passed evaluation (first-to-pass wins)
    function startPreparedSubmission(uint256 bountyId, uint256 submissionId) external payable nonReentrant {
        Bounty storage b = _mustBounty(bountyId);
        Submission storage s = _mustSubmission(bountyId, submissionId);

        require(b.status == BountyStatus.Open, "bounty not open");

        bool fromCreatorWindow = s.status == SubmissionStatus.PendingCreatorApproval;

        if (fromCreatorWindow) {
            // After window expires, anyone can start arbitration and fund the evaluation
            require(block.timestamp > s.creatorWindowEnd, "creator window still open");
        } else {
            require(s.status == SubmissionStatus.Prepared, "not prepared");
            require(msg.sender == s.hunter, "only hunter");
        }

        require(block.timestamp < b.submissionDeadline, "deadline passed");

        // Check if any existing submission has already passed on Verdikta
        // This prevents wasting the prepay when someone else already won
        _requireNoPassingSubmission(bountyId, b.threshold);

        // Funder attaches the worst-case prepay as ETH (no ERC20 approval needed).
        require(msg.value == s.ethMaxBudget, "wrong eth amount");

        EvaluationWallet wallet = EvaluationWallet(payable(s.evalWallet));

        // CID array for Verdikta:
        // cids[0] = Evaluation package (contains jury config, rubric reference via 'additional', instructions)
        // cids[1] = Hunter's work product (bCID containing the actual submission to evaluate)
        // Note: The rubric is referenced inside the evaluation package manifest, not passed separately
        string[] memory cids = new string[](2);
        cids[0] = s.evaluationCid;
        cids[1] = s.hunterCid;

        bytes32 aggId = wallet.startEvaluation{value: msg.value}(
            cids,
            s.addendum,
            s.alpha,
            s.maxOracleFee,
            s.estimatedBaseCost,
            s.maxFeeBasedScaling,
            b.requestedClass
        );

        s.verdiktaAggId = aggId;
        s.status = SubmissionStatus.PendingVerdikta;
        activeEvaluations[bountyId] += 1;

        emit WorkSubmitted(bountyId, submissionId, aggId);
    }

    /// @notice Finalize a submission by reading Verdikta results
    /// @dev If accepted and bounty still open, pay arbiterDeterminationPayment and refund excess to creator
    /// @dev For windowed bounties, payment blocked if earlier submission is unresolved
    /// @dev Can be called even after deadline (for submissions made before deadline)
    function finalizeSubmission(uint256 bountyId, uint256 submissionId) external nonReentrant {
        Bounty storage b = _mustBounty(bountyId);
        Submission storage s = _mustSubmission(bountyId, submissionId);
        require(s.status == SubmissionStatus.PendingVerdikta, "not pending");

        (uint256[] memory scores, string memory justCids, bool ok) =
            verdikta.getEvaluation(s.verdiktaAggId);

        if (!ok) {
            // If timed out but not finalized on Verdikta, try to finalize there
            try verdikta.finalizeEvaluationTimeout(s.verdiktaAggId) {
                (scores, justCids, ok) = verdikta.getEvaluation(s.verdiktaAggId);
            } catch { /* ignore */ }
        }
        require(ok, "Verdikta not ready");

        // Leaving PendingVerdikta (every branch below sets a terminal status).
        activeEvaluations[bountyId] -= 1;

        // A malformed score vector (anything other than the expected [DONT_FUND, FUND]
        // pair) is treated as a failed evaluation rather than a revert. Reverting here
        // would leave the submission stuck in PendingVerdikta forever: finalize can never
        // succeed, and failTimedOutSubmission refuses because a result exists. That would
        // pin activeEvaluations above zero, so the creator could never close the bounty
        // and the escrow would be locked. Failing it keeps the bounty usable and refunds
        // the hunter's leftover prepay.
        (bool validScores, uint256 acceptance, uint256 rejection) = _interpretScores(scores);
        s.acceptance = acceptance;
        s.rejection  = rejection;
        s.justificationCids = justCids;
        s.finalizedAt = block.timestamp;

        bool passed = validScores && _passed(acceptance, b.threshold);

        if (!passed) {
            s.status = SubmissionStatus.Failed;
            emit SubmissionFinalized(bountyId, submissionId, false, acceptance, rejection, justCids);
            _refundLeftoverEth(bountyId, submissionId);
            return;
        }

        // Passed evaluation
        emit SubmissionFinalized(bountyId, submissionId, true, acceptance, rejection, justCids);

        // Pay if bounty is still Open AND submission has priority
        if (b.status == BountyStatus.Open) {
            bool blocked;
            if (b.creatorAssessmentWindowSize > 0) {
                // Windowed bounties: priority ordering by submission index. If an earlier
                // submission (by another hunter) is still being evaluated, REVERT rather
                // than writing the terminal PassedUnpaid: this submission stays
                // PendingVerdikta and finalize is simply retried once the earlier one
                // resolves. The earlier one always resolves (oracle result, or timeout +
                // failTimedOutSubmission), so the wait is bounded. Writing PassedUnpaid
                // here instead would discard a passing result for good — and if the
                // earlier submission then failed, nobody would ever be paid.
                require(
                    !_hasEarlierUnresolvedSubmission(bountyId, submissionId),
                    "earlier submission pending - retry after it resolves"
                );
                blocked = false;
            } else {
                // Non-windowed bounties: first to complete wins; among simultaneous
                // passing results the lowest index wins (order-independent, see helper).
                blocked = _hasOtherPassingSubmission(bountyId, submissionId, b.threshold);
            }

            if (!blocked) {
                uint256 pay = b.arbiterDeterminationPayment;
                uint256 refund = b.payoutWei - pay;

                b.payoutWei = 0;
                b.status = BountyStatus.Awarded;
                b.winner = s.hunter;
                s.status = SubmissionStatus.PassedPaid;

                emit PayoutSent(bountyId, s.hunter, pay);
                _payOrCredit(s.hunter, pay);

                if (refund > 0) {
                    emit CreatorRefunded(bountyId, b.creator, refund);
                    _payOrCredit(b.creator, refund);
                }
            } else {
                // A lower-index submission already holds the win (it has a passing
                // result and will be paid when finalized). Final for this one.
                s.status = SubmissionStatus.PassedUnpaid;
            }
        } else {
            // Bounty already awarded or closed
            s.status = SubmissionStatus.PassedUnpaid;
        }

        _refundLeftoverEth(bountyId, submissionId);
    }

    /// @notice Force-fail a submission whose Verdikta round is settled with no valid result
    /// @dev Can be called by anyone. The gate is the AGGREGATOR's state, not a local timer:
    ///      - If the round has a valid result (already, or as a consequence of the settle
    ///        attempt below), this reverts — the result must go through finalizeSubmission,
    ///        so a passing score can never be discarded by a third party.
    ///      - If the round is still open on the aggregator (not yet timed out), this reverts —
    ///        failing now would make the submission terminal before the prepay is refundable,
    ///        stranding it in ethOwed[evalWallet] forever.
    ///      Only a round the aggregator itself reports as complete-and-failed can be force-failed.
    function failTimedOutSubmission(uint256 bountyId, uint256 submissionId) external nonReentrant {
        _mustBounty(bountyId);
        Submission storage s = _mustSubmission(bountyId, submissionId);

        require(s.status == SubmissionStatus.PendingVerdikta, "not pending");
        bytes32 aggId = s.verdiktaAggId;

        // Best-effort: settle the evaluation on the aggregator first. A dead/failed
        // round keeps the unspent prepay escrowed (reserved) until it is settled;
        // settlement moves it into the requester's pull credit (ethOwed[evalWallet]),
        // which _refundLeftoverEth then recovers and returns to the hunter below.
        // Reverts (NotTimedOut, AggregationComplete) are ignored; the checks that
        // follow decide whether force-failing is actually allowed.
        try verdikta.finalizeEvaluationTimeout(aggId) {} catch { /* ignore */ }

        // A valid result exists (possibly produced just now, if enough late responses
        // arrived before the timeout was finalized): this submission must be finalized,
        // never failed.
        (, , bool ok) = verdikta.getEvaluation(aggId);
        require(!ok, "result available - use finalizeSubmission");

        // No result AND the aggregator has settled the round => it genuinely failed.
        // If it is not settled yet, the prepay is still reserved there; failing now would
        // strand it. Wait for the aggregator's response timeout.
        (bool settled, , , , , , , , , ) = verdikta.getAggregationStatus(aggId);
        require(settled, "evaluation not settled");

        // Leaving PendingVerdikta (status set to Failed below).
        activeEvaluations[bountyId] -= 1;

        // Mark as failed
        s.status = SubmissionStatus.Failed;
        s.finalizedAt = block.timestamp;

        emit SubmissionFinalized(
            bountyId,
            submissionId,
            false,  // passed = false
            0,      // acceptance
            0,      // rejection
            "TIMED_OUT"
        );

        // Refund any ETH prepay left in the wallet (now recoverable post-settlement)
        _refundLeftoverEth(bountyId, submissionId);
    }

    /// @notice Claim ETH credited to you on the pull-payment ledger (a payout, refund, or
    ///         creator reclaim whose direct delivery failed). Pays msg.sender.
    function withdraw() external nonReentrant {
        uint256 amt = withdrawable[msg.sender];
        require(amt > 0, "nothing to withdraw");
        withdrawable[msg.sender] = 0;
        (bool ok,) = payable(msg.sender).call{value: amt}("");
        require(ok, "withdraw failed");
        emit Withdrawn(msg.sender, amt);
    }

    // ------------- Views -------------

    function bountyCount() external view returns (uint256) {
        return bounties.length;
    }

    function getBounty(uint256 bountyId) external view returns (Bounty memory) {
        return _mustBounty(bountyId);
    }

    function submissionCount(uint256 bountyId) external view returns (uint256) {
        return subs[bountyId].length;
    }

    function getSubmission(uint256 bountyId, uint256 submissionId)
        external view returns (Submission memory)
    {
        return _mustSubmission(bountyId, submissionId);
    }

    /// @notice Get the effective status of a bounty for frontend display
    /// @dev Returns: "OPEN", "EXPIRED", "AWARDED", or "CLOSED"
    /// @return status One of four status strings
    function getEffectiveBountyStatus(uint256 bountyId)
        external view returns (string memory)
    {
        Bounty storage b = _mustBounty(bountyId);

        // Terminal states first
        if (b.status == BountyStatus.Awarded) return "AWARDED";
        if (b.status == BountyStatus.Closed) return "CLOSED";

        // Open enum, but check if deadline passed
        if (b.status == BountyStatus.Open) {
            if (block.timestamp >= b.submissionDeadline) {
                return "EXPIRED"; // Deadline passed, awaiting closeExpiredBounty
            }
            return "OPEN"; // Active, accepting submissions
        }

        return "UNKNOWN"; // Should never happen
    }

    /// @notice Check if a bounty is accepting NEW submissions
    /// @dev Returns true only if Open status AND before deadline
    function isAcceptingSubmissions(uint256 bountyId) external view returns (bool) {
        Bounty storage b = _mustBounty(bountyId);
        return b.status == BountyStatus.Open && block.timestamp < b.submissionDeadline;
    }

    /// @notice Check if a bounty can be closed (deadline passed, no active evals)
    function canBeClosed(uint256 bountyId) external view returns (bool) {
        Bounty storage b = _mustBounty(bountyId);

        if (b.status != BountyStatus.Open) return false;
        if (block.timestamp < b.submissionDeadline) return false;

        // No active evaluations (O(1) — see activeEvaluations).
        return activeEvaluations[bountyId] == 0;
    }

    // ------------- Internals -------------

    /// @dev Check that no existing submission has already passed evaluation on Verdikta
    /// @dev This queries Verdikta directly since scores aren't stored until finalization
    function _requireNoPassingSubmission(uint256 bountyId, uint256 threshold) internal view {
        uint256 subCount = subs[bountyId].length;

        for (uint256 i = 0; i < subCount; i++) {
            Submission storage existing = subs[bountyId][i];

            // Skip non-pending submissions (already finalized or just prepared)
            if (existing.status != SubmissionStatus.PendingVerdikta) {
                continue;
            }

            // Query Verdikta for this submission's evaluation result
            (uint256[] memory scores, , bool ok) = verdikta.getEvaluation(existing.verdiktaAggId);

            // If evaluation is complete, check if it passed
            if (ok && scores.length == 2) {
                uint256 acceptance = scores[1] / 10000; // Normalize to 0-100
                if (acceptance > 100) acceptance = 100;

                if (acceptance >= threshold) {
                    revert("another submission already passed - finalize it first");
                }
            }
        }
    }

    /// @dev Non-windowed tie-break: does a LOWER-index submission already hold the win?
    ///      Used at finalization for non-windowed bounties.
    ///
    ///      "First to complete evaluation wins" cannot be observed on-chain (the escrow
    ///      only learns a result exists when someone calls finalize), so the rule that is
    ///      actually enforced is:
    ///        - if no other submission has a passing result yet, the one being finalized
    ///          wins (first to complete, in practice);
    ///        - if several have passing results at the same time, the LOWEST index wins.
    ///      Only lower-index siblings are consulted, so the outcome is independent of the
    ///      ORDER in which finalize() is called — and finalize is permissionless, so that
    ///      matters: with an any-sibling check, whichever passing submission was finalized
    ///      first was written PassedUnpaid and the other was paid, letting a rival (or
    ///      anyone) pick the winner by calling finalize on the victim first.
    ///
    ///      A lower-index PendingVerdikta sibling with a passing result blocks. It will be
    ///      paid when finalized (its own lower-index siblings are checked the same way), so
    ///      writing PassedUnpaid for the current submission is final and correct.
    ///      PassedUnpaid siblings never block: that status means "did not win".
    ///      The PassedPaid arm is unreachable from the sole call site (it runs only while
    ///      b.status == Open, and PassedPaid is always written together with Awarded);
    ///      it is kept as a defensive restatement of that invariant.
    function _hasOtherPassingSubmission(
        uint256 bountyId,
        uint256 currentSubmissionId,
        uint256 threshold
    ) internal view returns (bool) {
        for (uint256 i = 0; i < currentSubmissionId; i++) {
            Submission storage other = subs[bountyId][i];

            if (other.status == SubmissionStatus.PassedPaid) {
                return true;
            }

            // Lower-index sibling still pending but already passing on Verdikta: it wins.
            if (other.status == SubmissionStatus.PendingVerdikta) {
                (uint256[] memory scores, , bool ok) = verdikta.getEvaluation(other.verdiktaAggId);

                if (ok && scores.length == 2) {
                    uint256 acceptance = scores[1] / 10000; // Normalize to 0-100
                    if (acceptance > 100) acceptance = 100;

                    if (acceptance >= threshold) {
                        return true;
                    }
                }
            }
        }

        return false;
    }

    /// @dev Check if any earlier submission (lower index) still holds priority over
    ///      `submissionId`. Used for windowed bounties (creator approval + payment time).
    ///      An earlier submission blocks only while it can still win:
    ///        - PendingVerdikta: an oracle evaluation is in flight. Temporary — it always
    ///          resolves (result, or timeout + failTimedOutSubmission).
    ///        - PendingCreatorApproval with its window still OPEN: the creator may still
    ///          approve it. Bounded by the window length.
    ///      It does NOT block when:
    ///        - It belongs to the SAME hunter. A hunter who resubmits is choosing the later
    ///          version; the usual windowed flow is a targeted bounty where every submission
    ///          is theirs, and the creator must be able to approve the revision without
    ///          anyone paying to arbitrate the stale one.
    ///        - Its window expired and nobody started arbitration. Preparing costs only gas
    ///          and nobody is obliged to fund it, so such a submission would otherwise stay
    ///          "unresolved" forever and lock out every later submission for free.
    function _hasEarlierUnresolvedSubmission(
        uint256 bountyId,
        uint256 submissionId
    ) internal view returns (bool) {
        address hunter = subs[bountyId][submissionId].hunter;
        for (uint256 i = 0; i < submissionId; i++) {
            Submission storage e = subs[bountyId][i];
            if (e.hunter == hunter) continue;
            if (e.status == SubmissionStatus.PendingVerdikta) return true;
            if (e.status == SubmissionStatus.PendingCreatorApproval &&
                block.timestamp <= e.creatorWindowEnd) {
                return true;
            }
        }
        return false;
    }

    /// @dev Try to send `amount` to `to`. If the direct send fails (e.g. a contract that
    ///      rejects ETH), credit it to the pull-payment ledger instead of reverting — so a
    ///      hostile or incompatible recipient can never brick payout, refund, or bounty close.
    ///      Callers MUST update all contract state before calling this (checks-effects-interactions).
    function _payOrCredit(address to, uint256 amount) private {
        if (amount == 0) return;
        (bool ok,) = payable(to).call{value: amount}("");
        if (!ok) {
            withdrawable[to] += amount;
            emit PaymentDeferred(to, amount);
        }
    }

    function _refundLeftoverEth(uint256 bountyId, uint256 submissionId) private {
        Submission storage s = subs[bountyId][submissionId];
        // The wallet recovers its unspent prepay from the aggregator and hands it back to
        // THIS contract (never directly to the hunter), so the hand-off cannot be reverted.
        uint256 refunded = EvaluationWallet(payable(s.evalWallet)).refundLeftoverEth();
        emit EthRefunded(bountyId, submissionId, refunded);
        _payOrCredit(s.hunter, refunded);
    }

    function _mustBounty(uint256 bountyId) internal view returns (Bounty storage) {
        require(bountyId < bounties.length, "bad bountyId");
        return bounties[bountyId];
    }

    function _mustSubmission(uint256 bountyId, uint256 submissionId)
        internal view returns (Submission storage)
    {
        require(submissionId < subs[bountyId].length, "bad submissionId");
        return subs[bountyId][submissionId];
    }

    /// @dev Interpret Verdikta scores: scores[0]=reject (DONT_FUND), scores[1]=accept (FUND)
    /// @dev Verdikta returns scores that sum to 1,000,000 (e.g., [120000, 880000] = 12% reject, 88% accept)
    /// @dev We normalize to 0-100 by dividing by 10,000 to match threshold scale
    /// @dev Never reverts. A vector that is not exactly 2 long is reported as invalid
    ///      (valid == false, both scores 0) and the caller treats it as a failed evaluation.
    function _interpretScores(uint256[] memory scores)
        internal pure returns (bool valid, uint256 accept, uint256 reject)
    {
        if (scores.length != 2) {
            return (false, 0, 0);
        }
        valid = true;

        // Two scores from Verdikta: [DONT_FUND, FUND]
        // scores[0] = DONT_FUND (rejection score)
        // scores[1] = FUND (acceptance score)
        // Normalize from 0-1000000 to 0-100
        reject = scores[0] / 10000;
        accept = scores[1] / 10000;

        // Clamp to [0,100] just in case
        if (accept > 100) accept = 100;
        if (reject > 100) reject = 100;

        return (valid, accept, reject);
    }

    /// @dev Pass rule: acceptance must meet or exceed threshold
    function _passed(uint256 acceptance, uint256 threshold)
        internal pure returns (bool)
    {
        return acceptance >= threshold;
    }

    function _max(uint256 a, uint256 b) internal pure returns (uint256) {
        return a > b ? a : b;
    }

    receive() external payable {}
}
