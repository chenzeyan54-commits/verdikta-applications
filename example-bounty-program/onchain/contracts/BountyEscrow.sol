// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {IVerdiktaAggregator} from "./interfaces/IVerdiktaAggregator.sol";
import "./EvaluationWallet.sol";
import {BountyEscrowLens} from "./BountyEscrowLens.sol";

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

    /// @notice Oracle request settings, chosen by the CREATOR at bounty creation and used
    ///         verbatim for every evaluation of that bounty. They shape the jury (who is
    ///         eligible and how selection is weighted) and size the hunter's prepay, so they
    ///         belong with the party whose money is at stake and are visible to hunters
    ///         before they commit work. Hunters supply nothing that reaches the aggregator
    ///         except their work CID.
    struct OracleParams {
        uint256 maxOracleFee;        // per-oracle fee ceiling (wei); arbiters priced above it are ineligible; sizes ethMaxBudget
        uint256 alpha;               // 0..1000, quality-vs-timeliness blend in arbiter selection
        uint256 estimatedBaseCost;   // wei, < maxOracleFee; price-boost baseline (0 disables the boost)
        uint256 maxFeeBasedScaling;  // x-factor >= 1 capping the price boost (1 disables it)
    }

    /// @notice All inputs to createBounty, as one struct (avoids stack-too-deep and overload
    ///         ambiguity; extensible without a new signature).
    struct CreateParams {
        string  evaluationCid;               // evaluation package CID (bare CID, see _isValidCid)
        uint64  requestedClass;              // Verdikta class ID
        uint8   threshold;                   // 0..100 acceptance threshold
        uint64  submissionDeadline;          // unix seconds
        address targetHunter;                // address(0) = open to all
        uint256 creatorDeterminationPayment; // paid if the creator approves during the window
        uint256 arbiterDeterminationPayment; // paid if the oracle approves
        uint64  creatorAssessmentWindowSize; // seconds; 0 = no window (then the two payments must be equal)
        OracleParams oracle;
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
        OracleParams oracle;                  // creator-chosen oracle request settings
    }

    struct Submission {
        address hunter;             // who prepared (and is paid the bounty if it wins)
        string  hunterCid;          // Hunter's work product archive CID (bCID containing the actual submission)
        address evalWallet;
        bytes32 verdiktaAggId;      // set once started
        SubmissionStatus status;
        uint256 acceptance;         // stored acceptance (0..100)
        uint256 rejection;          // stored rejection (0..100)
        string  justificationCids;  // Verdikta result, if any
        uint256 submittedAt;
        uint256 finalizedAt;
        uint256 ethMaxBudget;       // ETH wei prepay, = maxTotalFee(bounty.oracle.maxOracleFee) at prepare time
        uint64  creatorWindowEnd;   // Timestamp when creator window expires (0 if no window)
        address funder;             // who attached the prepay at start; receives the unspent refund
    }

    IVerdiktaAggregator public immutable verdikta;

    /// @notice The read-only extension of this contract (see BountyEscrowLens): the
    ///         convenience views that no longer fit in this bytecode — getSubmissions,
    ///         getBounties, getOracleResult, nextAction, prepareCutoff, canBeClosed,
    ///         isAcceptingSubmissions, getEffectiveBountyStatus. They are still callable AT
    ///         THIS ADDRESS with the merged ABI (see fallback); this getter only exists so a
    ///         block explorer or a curious caller can find the verified lens source.
    ///         Created once, in the constructor. No setter, no owner, no upgrade path.
    BountyEscrowLens public immutable lens;

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

    /// @notice Accepted length range for CID strings (evaluation package and work product).
    /// @dev CIDv0 is exactly 46 chars; base32 CIDv1 is typically 59. The upper bound matches
    ///      the aggregator's own MAX_CID_LENGTH. See _isValidCid for the character rule.
    uint256 public constant MIN_CID_LENGTH = 46;
    uint256 public constant MAX_CID_LENGTH = 100;

    /// @notice Bounds on creator-chosen oracle settings, checked at createBounty so a bad
    ///         bounty fails at creation instead of stranding hunters at start time.
    /// @dev The aggregator/keeper themselves require estimatedBaseCost < maxFee and
    ///      scaling >= 1, clamp maxFee to the aggregator ceiling, and would panic on
    ///      alpha > 1000 or overflow on an astronomically large scaling factor.
    uint256 public constant MAX_ALPHA = 1000;
    uint256 public constant MAX_FEE_SCALING_FACTOR = 1000;

    /// @notice The addendum text forwarded to the aggregator: always empty.
    /// @dev It is appended to the query the arbiters see — a free-text channel into the
    ///      prompt. The creator's evaluation package is the whole query; nothing else may
    ///      be added by either party.
    string public constant ADDENDUM = "";

    /// @notice Score semantics. The aggregator returns one likelihood per outcome, each on a
    ///         0..SCORE_SCALE scale and summing to SCORE_SCALE; the escrow's threshold is
    ///         0..100, so scores are normalized by SCORE_DIVISOR. A vector is VALID only if
    ///         it has exactly two entries ([DONT_FUND, FUND]) each within SCORE_SCALE. See
    ///         _scoreVector — the single interpreter used by finalize and both sibling scans.
    uint256 public constant SCORE_SCALE = 1_000_000;
    uint256 public constant SCORE_DIVISOR = 10_000;

    /// @notice Gas forwarded to a recipient when the escrow pays out directly (_payOrCredit).
    /// @dev Payouts, refunds and bounty closes send ETH with `call{gas: PAYOUT_GAS_LIMIT}`.
    ///      Capping it makes settlement cost independent of the recipient: a contract that
    ///      burns everything it is given can only burn the cap, instead of forcing whoever
    ///      finalizes to bring ~64x the remaining work (EIP-150), and a callback gets too
    ///      little gas to do anything interesting. Ordinary wallets and simple smart-contract
    ///      wallets are paid directly; a recipient that needs more, or fails, is credited to
    ///      `withdrawable` and claims via withdraw() with full gas, exactly as a recipient
    ///      that rejects ETH is today. Deliberately a constant: this contract has no owner.
    uint256 public constant PAYOUT_GAS_LIMIT = 120_000;

    /// @notice Gas forwarded to the EvaluationWallet for the INLINE prepay recovery at the end
    ///         of finalizeSubmission / failTimedOutSubmission (wallet → aggregator withdrawEth →
    ///         wallet → escrow). Measured cost of that path is ~30k against the mock and well
    ///         under 100k against the live aggregator; 200k leaves ample headroom.
    /// @dev Why cap a call into our own wallet: the wallet forwards into the aggregator, and
    ///      the inline recovery is wrapped in try/catch precisely so resolution never depends
    ///      on that path. Without a cap, an aggregator withdraw that burned gas would leave
    ///      the transaction only 1/64 of its budget after the catch (EIP-150) — possibly not
    ///      enough to emit RefundDeferred and return — so the whole resolution would revert
    ///      anyway. With the cap, the worst case is a bounded amount of wasted gas and a
    ///      deferred refund. The retry path, recoverLeftoverEth(), forwards full gas.
    uint256 public constant INLINE_REFUND_GAS_LIMIT = 200_000;

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

    /// @param passed  the oracle result met the threshold (or the creator approved)
    /// @param paid    the bounty was awarded to this submission in this transaction
    ///                (false for Failed, PassedUnpaid, and TIMED_OUT)
    event SubmissionFinalized(
        uint256 indexed bountyId,
        uint256 indexed submissionId,
        bool passed,
        bool paid,
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

    /// @notice The inline recovery of a submission's unspent oracle prepay failed; the
    ///         resolution itself succeeded. Anyone may retry with recoverLeftoverEth().
    event RefundDeferred(uint256 indexed bountyId, uint256 indexed submissionId);

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
        // The lens's creation code lives in THIS contract's initcode (its own, larger,
        // EIP-3860 budget), not in the runtime bytecode that EIP-170 caps.
        lens = new BountyEscrowLens(_verdikta);
    }

    modifier nonReentrant() {
        require(_lock == 1, "reentrant");
        _lock = 2;
        _;
        _lock = 1;
    }

    // ------------- Bounty lifecycle -------------

    /// @notice Create a bounty with ETH escrow.
    /// @dev msg.value must equal max(creatorDeterminationPayment, arbiterDeterminationPayment).
    ///      For a bounty without a creator window pass both payments equal to msg.value.
    ///      The oracle settings are validated here (see OracleParams / MAX_* bounds) and used
    ///      verbatim for every evaluation of this bounty; hunters cannot change them.
    function createBounty(CreateParams calldata p) external payable returns (uint256 bountyId) {
        require(p.creatorDeterminationPayment > 0, "no creator payment");
        require(p.arbiterDeterminationPayment > 0, "no arbiter payment");
        require(
            msg.value == _max(p.creatorDeterminationPayment, p.arbiterDeterminationPayment),
            "ETH must equal max payment"
        );
        require(_isValidCid(p.evaluationCid), "bad evaluationCid");
        require(p.threshold <= 100, "bad threshold");
        require(p.submissionDeadline > block.timestamp, "deadline in past");
        require(
            p.creatorAssessmentWindowSize > 0 ||
                p.creatorDeterminationPayment == p.arbiterDeterminationPayment,
            "window required when payments differ"
        );

        // Oracle settings: reject anything the aggregator/keeper would reject at start.
        OracleParams calldata o = p.oracle;
        require(o.maxOracleFee > 0, "bad oracle fee");
        require(o.maxOracleFee <= verdikta.maxOracleFee(), "oracle fee above ceiling");
        require(o.estimatedBaseCost < o.maxOracleFee, "base cost must be below fee");
        require(o.maxFeeBasedScaling >= 1 && o.maxFeeBasedScaling <= MAX_FEE_SCALING_FACTOR, "bad fee scaling");
        require(o.alpha <= MAX_ALPHA, "bad alpha");
        require(verdikta.maxTotalFee(o.maxOracleFee) > 0, "bad budget");

        bounties.push(Bounty({
            creator: msg.sender,
            evaluationCid: p.evaluationCid,
            requestedClass: p.requestedClass,
            threshold: p.threshold,
            payoutWei: msg.value,
            createdAt: block.timestamp,
            submissionDeadline: p.submissionDeadline,
            status: BountyStatus.Open,
            winner: address(0),
            submissions: 0,
            targetHunter: p.targetHunter,
            creatorDeterminationPayment: p.creatorDeterminationPayment,
            arbiterDeterminationPayment: p.arbiterDeterminationPayment,
            creatorAssessmentWindowSize: p.creatorAssessmentWindowSize,
            oracle: o
        }));

        bountyId = bounties.length - 1;
        emit BountyCreated(
            bountyId,
            msg.sender,
            p.evaluationCid,
            p.requestedClass,
            p.threshold,
            msg.value,
            p.submissionDeadline
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

    /// @notice STEP 1: Prepare a submission. Deploys an EvaluationWallet and records the work.
    /// @dev The emitted ethMaxBudget is the aggregator's maxTotalFee for the BOUNTY's oracle fee
    ///      at prepare time — an ESTIMATE of what to attach at start. startPreparedSubmission
    ///      recomputes it live (see requiredPrepay()); every submission to a bounty prepays the
    ///      same amount at any given moment.
    /// @dev If the bounty has a creator assessment window, status starts as PendingCreatorApproval.
    ///      Otherwise, status starts as Prepared (classic behavior).
    /// @dev Can only be called before the submission deadline. On windowed bounties the
    ///      effective cutoff is earlier: the creator window must end before the deadline.
    /// @dev The oracle request is built entirely from the bounty (evaluation package, class,
    ///      creator-chosen oracle settings) plus an empty addendum; the hunter supplies only
    ///      their work CID.
    /// @param bountyId The bounty to submit to
    /// @param evaluationCid The evaluation package CID — must match the bounty's (a guard that
    ///        the caller is submitting against the package they think they are)
    /// @param hunterCid The hunter's work product archive CID (bare CID, see _isValidCid)
    function prepareSubmission(
        uint256 bountyId,
        string calldata evaluationCid,
        string calldata hunterCid
    ) external returns (uint256 submissionId, address evalWallet, uint256 ethMaxBudget) {
        return _prepareSubmission(bountyId, evaluationCid, hunterCid);
    }

    function _prepareSubmission(
        uint256 bountyId,
        string calldata evaluationCid,
        string calldata hunterCid
    ) internal returns (uint256 submissionId, address evalWallet, uint256 ethMaxBudget) {
        Bounty storage b = _mustBounty(bountyId);
        require(b.status == BountyStatus.Open, "bounty not open");
        require(block.timestamp < b.submissionDeadline, "deadline passed");
        if (b.targetHunter != address(0)) {
            require(msg.sender == b.targetHunter, "bounty is targeted");
        }
        // The bounty's evaluationCid was validated at creation; the mismatch check below
        // covers the caller's copy. The work-product CID is hunter-supplied free text and
        // MUST be a bare CID (see _isValidCid).
        require(_isValidCid(hunterCid), "bad hunterCid");
        require(subs[bountyId].length < MAX_SUBMISSIONS_PER_BOUNTY, "submission limit reached");

        // Verify evaluationCid matches the bounty's stored evaluationCid
        require(
            keccak256(bytes(evaluationCid)) == keccak256(bytes(b.evaluationCid)),
            "evaluationCid mismatch"
        );

        ethMaxBudget = verdikta.maxTotalFee(b.oracle.maxOracleFee);
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
            creatorWindowEnd: hasWindow
                ? uint64(block.timestamp) + b.creatorAssessmentWindowSize
                : 0,
            funder: address(0)
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

        evalWallet = address(wallet);
    }

    /// @notice Creator approves a submission during the assessment window
    /// @dev Pays creatorDeterminationPayment to hunter, refunds excess to creator
    /// @dev Blocked while an earlier submission still holds priority: another hunter's in
    ///      evaluation or in its own open window, or the SAME hunter's in evaluation (their
    ///      live claim to the arbiter rate) — see _hasEarlierUnresolvedSubmission
    function creatorApproveSubmission(uint256 bountyId, uint256 submissionId) external nonReentrant {
        Bounty storage b = _mustBounty(bountyId);
        Submission storage s = _mustSubmission(bountyId, submissionId);

        require(msg.sender == b.creator, "only creator");
        require(b.status == BountyStatus.Open, "bounty not open");
        require(s.status == SubmissionStatus.PendingCreatorApproval, "not pending creator approval");
        require(block.timestamp <= s.creatorWindowEnd, "window expired");
        require(
            !_hasEarlierUnresolvedSubmission(bountyId, submissionId, true),
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
        // The requirement is recomputed HERE from the bounty's fee policy: the aggregator's
        // maxTotalFee depends on owner-settable parameters (fee ceiling, arbiters polled,
        // bonus multiplier, cluster size), so the figure recorded at prepare is only an
        // estimate. Checking against the live value means a parameter change between
        // prepare and start can never strand a prepared submission (which would otherwise
        // have to be re-prepared — a new index, and on windowed bounties a restarted
        // window that may no longer fit before the deadline). Read it via requiredPrepay().
        OracleParams memory o = _effectiveOracle(b);   // clamped to the aggregator's live ceiling
        uint256 required = verdikta.maxTotalFee(o.maxOracleFee);
        require(required > 0, "bad budget");
        require(msg.value == required, "wrong eth amount");
        s.ethMaxBudget = required; // record what was actually prepaid

        EvaluationWallet wallet = EvaluationWallet(payable(s.evalWallet));

        // CID array for Verdikta:
        // cids[0] = Evaluation package (contains jury config, rubric reference via 'additional', instructions)
        // cids[1] = Hunter's work product (bCID containing the actual submission to evaluate)
        // Note: The rubric is referenced inside the evaluation package manifest, not passed separately
        string[] memory cids = new string[](2);
        cids[0] = b.evaluationCid;
        cids[1] = s.hunterCid;

        bytes32 aggId = wallet.startEvaluation{value: msg.value}(
            cids,
            ADDENDUM,
            o.alpha,
            o.maxOracleFee,
            o.estimatedBaseCost,
            o.maxFeeBasedScaling,
            b.requestedClass
        );

        s.funder = msg.sender;
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
        (, bool passed, uint256 acceptance, uint256 rejection) = _scoreVector(scores, b.threshold);
        s.acceptance = acceptance;
        s.rejection  = rejection;
        s.justificationCids = justCids;
        s.finalizedAt = block.timestamp;

        if (!passed) {
            s.status = SubmissionStatus.Failed;
            emit SubmissionFinalized(bountyId, submissionId, false, false, acceptance, rejection, justCids);
            _refundLeftoverEth(bountyId, submissionId);
            return;
        }

        // Passed evaluation. Pay if bounty is still Open AND submission has priority.
        bool paid = false;
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
                    !_hasEarlierUnresolvedSubmission(bountyId, submissionId, false),
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
                paid = true;

                emit SubmissionFinalized(bountyId, submissionId, true, true, acceptance, rejection, justCids);
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
        if (!paid) {
            emit SubmissionFinalized(bountyId, submissionId, true, false, acceptance, rejection, justCids);
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
            false,  // passed
            false,  // paid
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

    /// @notice The ETH (wei) a funder must attach to startPreparedSubmission for this bounty
    ///         RIGHT NOW: the aggregator's maxTotalFee for the bounty's oracle fee. Identical
    ///         for every submission to the bounty. The ethMaxBudget in SubmissionPrepared is
    ///         the same figure at prepare time — an estimate; this view is authoritative.
    function requiredPrepay(uint256 bountyId) external view returns (uint256) {
        Bounty storage b = _mustBounty(bountyId);
        return verdikta.maxTotalFee(_effectiveOracle(b).maxOracleFee);
    }

    /// @notice The oracle settings that startPreparedSubmission will actually forward RIGHT NOW.
    /// @dev Upstream configuration policy: the aggregator's fee ceiling, poll count, bonus
    ///      multiplier, cluster size and response timeout are owner-settable and may change
    ///      after a bounty is created. Creation validates the creator's settings against the
    ///      ceiling of that moment only. At start the escrow reads the live ceiling and CLAMPS:
    ///        - maxOracleFee     → min(bounty fee, current ceiling)  (the aggregator does this
    ///                             itself; mirrored here so the quote and the keeper agree)
    ///        - estimatedBaseCost → lowered to (effective fee − 1) if it no longer sits below
    ///                             the effective fee (the keeper requires base < fee; without
    ///                             this a lowered ceiling would make every start revert and
    ///                             strand prepared submissions)
    ///        - alpha, maxFeeBasedScaling → unchanged (nothing upstream constrains them)
    ///      requiredPrepay() is quoted from the effective fee.
    function effectiveOracleParams(uint256 bountyId) external view returns (OracleParams memory) {
        return _effectiveOracle(_mustBounty(bountyId));
    }

    function _effectiveOracle(Bounty storage b) internal view returns (OracleParams memory o) {
        o = b.oracle;
        uint256 ceiling = verdikta.maxOracleFee();
        if (o.maxOracleFee > ceiling) o.maxOracleFee = ceiling;
        if (o.estimatedBaseCost >= o.maxOracleFee) {
            o.estimatedBaseCost = o.maxOracleFee > 0 ? o.maxOracleFee - 1 : 0;
        }
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

            // If evaluation is complete with a VALID passing result, block. An invalid
            // vector is never "passing" (it will finalize as Failed), so it never blocks.
            if (ok) {
                (, bool passed, , ) = _scoreVector(scores, threshold);
                if (passed) {
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

                if (ok) {
                    (, bool passed, , ) = _scoreVector(scores, threshold);
                    if (passed) return true;
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
    ///        - Its window expired and nobody started arbitration. Preparing costs only gas
    ///          and nobody is obliged to fund it, so such a submission would otherwise stay
    ///          "unresolved" forever and lock out every later submission for free.
    ///        - It belongs to the SAME hunter and is sitting in its window
    ///          (PendingCreatorApproval). A hunter who resubmits is choosing the later
    ///          version; the usual windowed flow is a targeted bounty where every
    ///          submission is theirs, and the creator must be able to approve the revision
    ///          without anyone paying to arbitrate the stale one.
    ///        - It belongs to the SAME hunter, is in evaluation (PendingVerdikta), and the
    ///          caller is finalizeSubmission (`forCreatorApproval == false`): both versions
    ///          pay the same hunter at the same arbiter rate, so paying the later one first
    ///          harms nobody.
    ///      A same-hunter PendingVerdikta sibling DOES block creator approval
    ///      (`forCreatorApproval == true`). That sibling is the hunter's live, paid-for
    ///      claim to the arbiter rate — possibly already passing on the aggregator. Letting
    ///      the creator approve a newer version for the (possibly far smaller) creator rate
    ///      would extinguish that claim: the bounty becomes Awarded, and the earlier
    ///      version finalizes to PassedUnpaid. The creator may approve the newer version
    ///      once the earlier one has resolved (if it failed) — no prepay is forced on anyone.
    function _hasEarlierUnresolvedSubmission(
        uint256 bountyId,
        uint256 submissionId,
        bool forCreatorApproval
    ) internal view returns (bool) {
        address hunter = subs[bountyId][submissionId].hunter;
        for (uint256 i = 0; i < submissionId; i++) {
            Submission storage e = subs[bountyId][i];
            bool sameHunter = e.hunter == hunter;
            if (e.status == SubmissionStatus.PendingVerdikta) {
                if (!sameHunter || forCreatorApproval) return true;
                continue;
            }
            if (sameHunter) continue;
            if (e.status == SubmissionStatus.PendingCreatorApproval &&
                block.timestamp <= e.creatorWindowEnd) {
                return true;
            }
        }
        return false;
    }

    /// @dev Try to send `amount` to `to` with at most PAYOUT_GAS_LIMIT gas. If the direct
    ///      send fails (a contract that rejects ETH, or one that needs / burns more gas than
    ///      the cap), credit it to the pull-payment ledger instead of reverting — so a
    ///      hostile or incompatible recipient can never brick payout, refund, or bounty close,
    ///      nor dictate how much gas the caller must bring.
    ///      Callers MUST update all contract state before calling this (checks-effects-interactions).
    function _payOrCredit(address to, uint256 amount) private {
        if (amount == 0) return;
        (bool ok,) = payable(to).call{value: amount, gas: PAYOUT_GAS_LIMIT}("");
        if (!ok) {
            withdrawable[to] += amount;
            emit PaymentDeferred(to, amount);
        }
    }

    /// @dev Best-effort inline recovery of the unspent oracle prepay, run at the end of
    ///      finalizeSubmission / failTimedOutSubmission. The wallet pulls its ethOwed credit
    ///      from the aggregator and hands its balance back to THIS contract, which routes it
    ///      to whoever funded the start (Submission.funder).
    ///
    ///      Resolution must NOT depend on this succeeding: the chain wallet -> aggregator
    ///      withdrawEth -> wallet -> escrow is an external dependency, and if it ever reverted
    ///      (an aggregator upgrade, a paused withdrawal, a changed accounting rule) an
    ///      un-wrapped call would leave the submission stuck in PendingVerdikta, pin
    ///      activeEvaluations, and lock the bounty. So the call is wrapped: on failure the
    ///      status change and payout stand, RefundDeferred is emitted, and anyone can retry
    ///      later with recoverLeftoverEth(). In the common case the funder is refunded here,
    ///      in the same transaction, exactly as before.
    function _refundLeftoverEth(uint256 bountyId, uint256 submissionId) private {
        Submission storage s = subs[bountyId][submissionId];
        try EvaluationWallet(payable(s.evalWallet)).refundLeftoverEth{gas: INLINE_REFUND_GAS_LIMIT}() returns (uint256 refunded) {
            emit EthRefunded(bountyId, submissionId, refunded);
            _payOrCredit(s.funder, refunded);
        } catch {
            emit RefundDeferred(bountyId, submissionId);
        }
    }

    /// @notice Retry recovery of a resolved submission's unspent oracle prepay and pay it to
    ///         the address that funded the start. Anyone may call.
    /// @dev Only for submissions that have left evaluation (Failed / PassedPaid /
    ///      PassedUnpaid) — while a round is open the prepay is still reserved on the
    ///      aggregator and there is nothing to recover. The wallet's refundLeftoverEth() is
    ///      idempotent (pull any ethOwed credit, sweep the wallet balance), so this also
    ///      recovers ETH that reaches the wallet AFTER resolution. Reverts from the wallet or
    ///      aggregator are NOT swallowed here, so a caller can see why a retry failed.
    function recoverLeftoverEth(uint256 bountyId, uint256 submissionId) external nonReentrant {
        _mustBounty(bountyId);
        Submission storage s = _mustSubmission(bountyId, submissionId);
        require(
            s.status == SubmissionStatus.Failed ||
            s.status == SubmissionStatus.PassedPaid ||
            s.status == SubmissionStatus.PassedUnpaid,
            "not resolved"
        );
        require(s.funder != address(0), "never started");
        uint256 refunded = EvaluationWallet(payable(s.evalWallet)).refundLeftoverEth();
        require(refunded > 0, "nothing to recover");
        emit EthRefunded(bountyId, submissionId, refunded);
        _payOrCredit(s.funder, refunded);
    }

    /// @dev Shape check for an IPFS CID string. Accepts CIDv0 (46 base58 chars, "Qm…") and
    ///      base32 CIDv1 ("b…", lowercase a-z / 2-7), i.e. anything alphanumeric of a
    ///      plausible length; rejects everything else.
    ///
    ///      WHY THIS MATTERS: the aggregator only length-checks CIDs and then serializes the
    ///      request as a delimiter-based payload — "1:<cid0>,<cid1>:<addendum>" — for the
    ///      oracle nodes to parse. A hunter-supplied "CID" containing ',' would smuggle extra
    ///      archives into the evaluation, and one containing ':' would smuggle an addendum,
    ///      re-opening the prompt channel this contract deliberately keeps empty
    ///      (ADDENDUM). Validating here keeps every CID a bare content reference all
    ///      the way through parsing, regardless of how a node splits the payload.
    function _isValidCid(string calldata cid) internal pure returns (bool) {
        bytes calldata b = bytes(cid);
        uint256 len = b.length;
        if (len < MIN_CID_LENGTH || len > MAX_CID_LENGTH) return false;
        for (uint256 i = 0; i < len; i++) {
            bytes1 c = b[i];
            bool ok = (c >= 0x30 && c <= 0x39)   // 0-9
                   || (c >= 0x41 && c <= 0x5A)   // A-Z
                   || (c >= 0x61 && c <= 0x7A);  // a-z
            if (!ok) return false;
        }
        return true;
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

    /// @dev THE score interpreter. Used by finalizeSubmission (to decide Failed vs passed and
    ///      what to record) and by both sibling scans (_requireNoPassingSubmission at start,
    ///      _hasOtherPassingSubmission at payout), so eligibility and payout decisions can
    ///      never disagree about what a result means.
    ///
    ///      Vector layout: scores[0] = DONT_FUND (rejection), scores[1] = FUND (acceptance),
    ///      each 0..SCORE_SCALE (they sum to SCORE_SCALE; the sum is NOT checked so
    ///      aggregator-side rounding cannot invalidate a genuine result). Normalized to 0..100
    ///      by SCORE_DIVISOR to match the bounty threshold.
    ///
    ///      `valid` is false for a wrong length or any entry above SCORE_SCALE. An invalid
    ///      vector is never `passed` and reports 0/0 scores; finalize records it as Failed
    ///      (with the prepay refunded) and the scans treat it as not passing. Out-of-range
    ///      entries are rejected rather than clamped: clamping would turn a corrupt result
    ///      (e.g. [0, 2_000_000]) into a 100% pass and a payout.
    ///      Never reverts.
    function _scoreVector(uint256[] memory scores, uint256 threshold)
        internal pure returns (bool valid, bool passed, uint256 accept, uint256 reject)
    {
        if (scores.length != 2) return (false, false, 0, 0);
        if (scores[0] > SCORE_SCALE || scores[1] > SCORE_SCALE) return (false, false, 0, 0);
        reject = scores[0] / SCORE_DIVISOR;
        accept = scores[1] / SCORE_DIVISOR;
        valid = true;
        passed = accept >= threshold;
    }

    function _max(uint256 a, uint256 b) internal pure returns (uint256) {
        return a > b ? a : b;
    }

    // ------------- Read-only extension (lens) -------------

    /// @dev Any selector this contract does not implement is answered by the lens AT THIS
    ///      ADDRESS, so callers keep one address and one (merged) ABI and cannot tell the two
    ///      contracts apart. Mechanism: a STATICCALL into lensDelegate(), which delegatecalls
    ///      the lens. The STATICCALL frame makes the EVM itself reject any state change
    ///      (SSTORE, LOG, CALL with value, CREATE, SELFDESTRUCT) inside the lens, so this can
    ///      never become a write path — the lens is trusted for nothing. Return data and
    ///      revert data are copied back verbatim, so a lens view reverting "bad bountyId"
    ///      surfaces exactly as if this contract had reverted. This is NOT a proxy: `lens` is
    ///      an immutable with no setter, and this contract has no owner. Non-payable: ETH
    ///      sent with unknown calldata reverts (plain transfers still land in receive()).
    fallback() external {
        (bool ok, bytes memory ret) = address(this).staticcall(
            abi.encodeWithSelector(this.lensDelegate.selector, msg.data)
        );
        assembly {
            let p := add(ret, 32)
            let n := mload(ret)
            if iszero(ok) { revert(p, n) }
            return(p, n)
        }
    }

    /// @notice Plumbing for the fallback above — NOT for external use. Reverts "self only"
    ///         for every caller but this contract. It is in the ABI only because the
    ///         STATICCALL guard needs an external entry point; it is reachable solely inside
    ///         a static frame, so despite its non-view signature it cannot change state.
    function lensDelegate(bytes calldata data) external {
        require(msg.sender == address(this), "self only");
        address target = address(lens);
        assembly {
            let p := mload(0x40)
            calldatacopy(p, data.offset, data.length)
            let ok := delegatecall(gas(), target, p, data.length, 0, 0)
            returndatacopy(p, 0, returndatasize())
            if iszero(ok) { revert(p, returndatasize()) }
            return(p, returndatasize())
        }
    }

    receive() external payable {}
}
