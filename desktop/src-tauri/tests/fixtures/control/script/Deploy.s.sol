// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import "../src/Box.sol";

/// Puts Box in scope.
contract Deploy {
    function run() public returns (Box) {
        return new Box();
    }
}
