// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import "../BountyEscrow.sol";

/// @dev Test stub: a hunter/recipient contract that, when paid, immediately re-enters the
///      escrow with a configurable call and records the outcome — used to prove the
///      nonReentrant guard fires on every ETH-moving entry point and that the original
///      payment still lands (the recipient does not revert).
contract MockReentrantRecipient {
    address public escrow;
    bytes   public attack;
    bool    public attempted;
    bool    public attackOk;
    bytes32 public attackReasonHash;   // keccak256 of the raw revert data of the re-entrant call
    uint256 public lastSubId;
    uint256 public lastBudget;

    function setAttack(address _escrow, bytes calldata data) external {
        escrow = _escrow;
        attack = data;
        attempted = false;
    }

    function prepare(address _escrow, uint256 bountyId, string calldata evalCid, string calldata hunterCid) external {
        (uint256 sid, , uint256 budget) = BountyEscrow(payable(_escrow)).prepareSubmission(bountyId, evalCid, hunterCid);
        lastSubId = sid;
        lastBudget = budget;
    }

    function start(address _escrow, uint256 bountyId, uint256 subId) external {
        uint256 v = BountyEscrow(payable(_escrow)).requiredPrepay(bountyId);
        BountyEscrow(payable(_escrow)).startPreparedSubmission{value: v}(bountyId, subId);
    }

    function claim(address _escrow) external {
        BountyEscrow(payable(_escrow)).withdraw();
    }

    receive() external payable {
        if (attack.length > 0 && !attempted) {
            attempted = true;
            (bool ok, bytes memory ret) = escrow.call(attack);
            attackOk = ok;
            attackReasonHash = keccak256(ret);
        }
    }
}
