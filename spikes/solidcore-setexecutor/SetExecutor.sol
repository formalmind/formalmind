// SPDX-License-Identifier: MIT
pragma solidity ^0.8.35;

type PoolId is bytes32;

// Reduced fixture: preserves the storage prefix used by Async Swap's setExecutor.
// Other protocol functions and OrderInfo fields are intentionally outside this demo.
contract SetExecutor {
    string private nameFallback;
    string private versionFallback;
    struct State {
        address poolManager;
        address numeraire;
        address feeVault;
        mapping(bytes32 => uint256) orders;
        mapping(address => mapping(address => bool)) isExecutor;
    }
    mapping(PoolId => State) private asyncOrders;
    event ExecutorSet(PoolId indexed poolId, address indexed maker, address indexed executor, bool allow);
    error ZeroAddress();

    function setExecutor(PoolId poolId, address executor, bool allow) external {
        asyncOrders[poolId].isExecutor[msg.sender][executor] = allow;
        emit ExecutorSet(poolId, msg.sender, executor, allow);
    }
}
