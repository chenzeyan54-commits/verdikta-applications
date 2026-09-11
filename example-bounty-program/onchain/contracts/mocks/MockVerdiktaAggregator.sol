// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

/// @dev Mock Verdikta Aggregator for tests (ETH payment rail).
///      Lets the test harness pre-set evaluation results, control maxTotalFee, and
///      simulate the ethOwed refund credit / withdrawEth pull-payment ledger.
///
///      Round lifecycle mirrors the real ReputationAggregator closely enough for the
///      escrow's force-fail gate to be exercised:
///        - a request stamps startTimestamp and opens the round (not complete);
///        - setEvaluation(exists=true) models a fulfilled round (complete, valid result);
///        - finalizeEvaluationTimeout reverts AggregationComplete if already settled and
///          NotTimedOut before startTimestamp + responseTimeoutSeconds; otherwise it settles
///          the round as complete+failed (no result), or — if a "late result" was staged via
///          setTimeoutResult — as complete with a valid result (the real "enough responses
///          after all" branch);
///        - getAggregationStatus reports isComplete / failed like the real contract.
contract MockVerdiktaAggregator {
    uint256 public constant RESPONSE_TIMEOUT = 300;

    uint256 public feeMultiplier = 3; // maxTotalFee = input * multiplier
    uint256 public refundAmount;      // ETH (wei) credited to ethOwed[requester] (default 0)
    bool    public creditOnTimeout;   // if true, the refund is credited at finalizeEvaluationTimeout
                                      // (settlement) rather than at request time — models a round
                                      // whose prepay stays reserved until timed out + settled.

    struct Result {
        uint256[] scores;
        string    justificationCids;
        bool      exists;
    }

    error UnknownRequest();
    error AggregationComplete();
    error NotTimedOut();

    mapping(bytes32 => Result) private _results;
    mapping(bytes32 => Result) private _timeoutResults;  // staged "late" result applied at timeout
    mapping(address => uint256) public ethOwed;
    mapping(bytes32 => address) public requesterOf;      // aggId -> requester (the EvaluationWallet)
    mapping(bytes32 => uint256) public startTimestamp;   // aggId -> request time (0 = unknown)
    mapping(bytes32 => bool) public complete;            // aggId -> settled (fulfilled or timed out)
    mapping(bytes32 => bool) public failed;              // aggId -> timed out without a result
    uint256 private _nonce;

    // --- Test helpers ---

    /// @dev Pre-set the result that getEvaluation will return for a given aggId.
    ///      exists=true models a fulfilled (settled, successful) round.
    function setEvaluation(
        bytes32 aggId,
        uint256[] calldata scores,
        string calldata justCids,
        bool exists
    ) external {
        _results[aggId] = Result(scores, justCids, exists);
        if (exists) {
            complete[aggId] = true;
            failed[aggId] = false;
        }
    }

    /// @dev Stage a result that becomes valid only when finalizeEvaluationTimeout settles the
    ///      round — models late reveals arriving before the timeout is finalized.
    function setTimeoutResult(
        bytes32 aggId,
        uint256[] calldata scores,
        string calldata justCids
    ) external {
        _timeoutResults[aggId] = Result(scores, justCids, true);
    }

    function setFeeMultiplier(uint256 m) external {
        feeMultiplier = m;
    }

    /// @dev Set how much of each request's prepay is credited back as an ethOwed refund.
    ///      Must be <= the msg.value attached to the request for the mock to stay solvent.
    function setRefundAmount(uint256 amount) external {
        refundAmount = amount;
    }

    /// @dev When true, the prepay refund is credited at finalizeEvaluationTimeout (settlement)
    ///      instead of at request time — used to test the force-fail recovery path.
    function setCreditOnTimeout(bool v) external {
        creditOnTimeout = v;
    }

    // --- IVerdiktaAggregator implementation ---

    /// @dev What the escrow actually forwarded, per request — lets tests assert that
    ///      hunter-supplied addendum / selection weights are NOT passed through.
    struct RequestParams {
        string addendum;
        uint256 alpha;
        uint256 maxFee;
        uint256 estimatedBaseCost;
        uint256 maxFeeBasedScaling;
        uint64 requestedClass;
        uint256 cidCount;
    }
    mapping(bytes32 => RequestParams) public requestParams;

    function requestAIEvaluationWithApproval(
        string[] memory cids,
        string memory addendumText,
        uint256 _alpha,
        uint256 _maxFee,
        uint256 _estimatedBaseCost,
        uint256 _maxFeeBasedScalingFactor,
        uint64 _requestedClass
    ) external payable returns (bytes32 requestId) {
        _nonce++;
        requestId = keccak256(abi.encodePacked(_nonce, msg.sender));
        requestParams[requestId] = RequestParams(
            addendumText, _alpha, _maxFee, _estimatedBaseCost, _maxFeeBasedScalingFactor,
            _requestedClass, cids.length
        );
        requesterOf[requestId] = msg.sender;
        startTimestamp[requestId] = block.timestamp;
        // Default: settle at fulfillment — credit the unspent prepay refund now.
        // With creditOnTimeout, the prepay stays "reserved" until finalizeEvaluationTimeout.
        if (refundAmount > 0 && !creditOnTimeout) {
            ethOwed[msg.sender] += refundAmount;
        }
    }

    function getEvaluation(bytes32 _requestId)
        external
        view
        returns (uint256[] memory, string memory, bool)
    {
        Result storage r = _results[_requestId];
        return (r.scores, r.justificationCids, r.exists);
    }

    function getAggregationStatus(bytes32 aggId)
        external
        view
        returns (
            bool isComplete,
            bool isFailed,
            bool commitPhaseComplete,
            uint256 commitExpected,
            uint256 commitReceived,
            uint256 responseCount,
            uint256 requiredN,
            uint256 clusterP,
            address requester,
            uint256 startTs
        )
    {
        return (
            complete[aggId], failed[aggId], false, 0, 0, 0, 0, 0,
            requesterOf[aggId], startTimestamp[aggId]
        );
    }

    function maxTotalFee(uint256 requestedMaxOracleFee) external view returns (uint256) {
        return requestedMaxOracleFee * feeMultiplier;
    }

    // ethOwed(address) getter is auto-generated by the public `ethOwed` mapping.

    function withdrawEth() external {
        uint256 amt = ethOwed[msg.sender];
        require(amt > 0, "nothing owed");
        ethOwed[msg.sender] = 0;
        (bool ok,) = payable(msg.sender).call{value: amt}("");
        require(ok, "withdraw failed");
    }

    function responseTimeoutSeconds() external pure returns (uint256) {
        return RESPONSE_TIMEOUT;
    }

    function finalizeEvaluationTimeout(bytes32 aggId) external {
        if (startTimestamp[aggId] == 0) revert UnknownRequest();
        if (complete[aggId]) revert AggregationComplete();
        if (block.timestamp < startTimestamp[aggId] + RESPONSE_TIMEOUT) revert NotTimedOut();

        // Settle: refund the unspent prepay to the requester's (EvaluationWallet) pull credit.
        if (creditOnTimeout && refundAmount > 0) {
            ethOwed[requesterOf[aggId]] += refundAmount;
        }
        complete[aggId] = true;

        Result storage late = _timeoutResults[aggId];
        if (late.exists) {
            // "enough responses after all" — finishes normally with a valid result
            _results[aggId] = late;
            failed[aggId] = false;
        } else {
            failed[aggId] = true;
        }
    }

    receive() external payable {}
}
