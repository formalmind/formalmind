// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// Demonstration source links only: no Solidity refinement proof is provided.
contract Permissions {
    mapping(address => mapping(address => bool)) public permissions;

    function setExecutor(address executor, bool allow) external {
        permissions[msg.sender][executor] = allow;
    }
}
