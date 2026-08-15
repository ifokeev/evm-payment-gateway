// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

interface Vm {
    function assume(bool condition) external;
    function deal(address account, uint256 balance) external;
    function expectRevert() external;
    function expectRevert(bytes4 selector) external;
    function prank(address sender) external;
}

abstract contract TestBase {
    Vm internal constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    address[] private invariantTargets;

    function targetContract(address target) internal {
        invariantTargets.push(target);
    }

    function targetContracts() public view returns (address[] memory) {
        return invariantTargets;
    }

    function assertEq(uint256 actual, uint256 expected) internal pure {
        require(actual == expected, "uint mismatch");
    }

    function assertEq(address actual, address expected) internal pure {
        require(actual == expected, "address mismatch");
    }

    function assertEq(bytes32 actual, bytes32 expected) internal pure {
        require(actual == expected, "bytes32 mismatch");
    }

    function assertTrue(bool value) internal pure {
        require(value, "expected true");
    }
}
