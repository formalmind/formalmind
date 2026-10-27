// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// The control API's test contract: an owner, one value only the owner sets, and a getter.
contract Box {
    address public owner;
    uint256 public value;

    constructor() {
        owner = msg.sender;
    }

    function set(uint256 v) external {
        require(msg.sender == owner, "owner");
        value = v;
    }

    function get() external view returns (uint256) {
        return value;
    }
}
