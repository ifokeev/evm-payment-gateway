// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {PaymentForwarder} from "../src/PaymentForwarder.sol";
import {PaymentForwarderFactory} from "../src/PaymentForwarderFactory.sol";
import {TestBase} from "./TestBase.sol";

contract MockToken {
    mapping(address => uint256) public balanceOf;

    function mint(address account, uint256 amount) external {
        balanceOf[account] += amount;
    }

    function transfer(address recipient, uint256 amount) external virtual returns (bool) {
        require(balanceOf[msg.sender] >= amount, "balance");
        balanceOf[msg.sender] -= amount;
        balanceOf[recipient] += amount;
        return true;
    }
}

contract NoReturnToken {
    mapping(address => uint256) public balanceOf;

    function mint(address account, uint256 amount) external {
        balanceOf[account] += amount;
    }

    function transfer(address recipient, uint256 amount) external {
        require(balanceOf[msg.sender] >= amount, "balance");
        balanceOf[msg.sender] -= amount;
        balanceOf[recipient] += amount;
    }
}

contract FalseReturnToken is MockToken {
    function transfer(address, uint256) external pure override returns (bool) {
        return false;
    }
}

contract MalformedReturnToken is MockToken {
    function transfer(address, uint256) external pure override returns (bool) {
        assembly {
            mstore(0, 1)
            return(31, 1)
        }
    }
}

contract RevertingTreasury {
    receive() external payable {
        revert("reject");
    }
}

contract PaymentForwarderFactoryTest is TestBase {
    PaymentForwarderFactory private factory;
    address payable private treasury;

    function setUp() public {
        factory = new PaymentForwarderFactory();
        treasury = payable(address(0xBEEF));
    }

    function testNativePrefundingDeploysAndCollects() public {
        bytes32 salt = keccak256("native");
        address predicted = factory.predict(salt, treasury, address(0));
        vm.deal(predicted, 2 ether);

        (address deployed, uint256 amount) = factory.deployAndCollect(salt, treasury, address(0));

        assertEq(deployed, predicted);
        assertEq(amount, 2 ether);
        assertEq(treasury.balance, 2 ether);
        assertEq(predicted.balance, 0);
        assertTrue(predicted.code.length > 0);
    }

    function testTokenPrefundingDeploysAndCollects() public {
        MockToken token = new MockToken();
        bytes32 salt = keccak256("token");
        address predicted = factory.predict(salt, treasury, address(token));
        token.mint(predicted, 25e6);

        (, uint256 amount) = factory.deployAndCollect(salt, treasury, address(token));

        assertEq(amount, 25e6);
        assertEq(token.balanceOf(treasury), 25e6);
        assertEq(token.balanceOf(predicted), 0);
    }

    function testNoReturnTokenIsSupported() public {
        NoReturnToken token = new NoReturnToken();
        bytes32 salt = keccak256("no-return");
        address predicted = factory.predict(salt, treasury, address(token));
        token.mint(predicted, 10);

        factory.deployAndCollect(salt, treasury, address(token));

        assertEq(token.balanceOf(treasury), 10);
    }

    function testFalseReturnTokenRevertsWithoutDeploying() public {
        FalseReturnToken token = new FalseReturnToken();
        bytes32 salt = keccak256("false-return");
        address predicted = factory.predict(salt, treasury, address(token));
        token.mint(predicted, 10);

        vm.expectRevert(PaymentForwarder.TokenTransferFailed.selector);
        factory.deployAndCollect(salt, treasury, address(token));

        assertEq(predicted.code.length, 0);
        assertEq(token.balanceOf(predicted), 10);
    }

    function testMalformedReturnTokenRevertsWithoutDeploying() public {
        MalformedReturnToken token = new MalformedReturnToken();
        bytes32 salt = keccak256("malformed-return");
        address predicted = factory.predict(salt, treasury, address(token));
        token.mint(predicted, 10);

        vm.expectRevert();
        factory.deployAndCollect(salt, treasury, address(token));

        assertEq(predicted.code.length, 0);
        assertEq(token.balanceOf(predicted), 10);
    }

    function testZeroTreasuryIsRejected() public {
        vm.expectRevert(PaymentForwarder.InvalidTreasury.selector);
        factory.deployAndCollect(keccak256("zero-treasury"), payable(address(0)), address(0));
    }

    function testRevertingTreasuryLeavesNativeFundsRecoverable() public {
        RevertingTreasury rejecting = new RevertingTreasury();
        bytes32 salt = keccak256("rejecting-treasury");
        address predicted = factory.predict(salt, address(rejecting), address(0));
        vm.deal(predicted, 1 ether);

        vm.expectRevert(PaymentForwarder.NativeTransferFailed.selector);
        factory.deployAndCollect(salt, payable(address(rejecting)), address(0));

        assertEq(predicted.code.length, 0);
        assertEq(predicted.balance, 1 ether);
    }

    function testLateNativeDepositForwardsImmediately() public {
        bytes32 salt = keccak256("late-native");
        (address forwarder,) = factory.deployAndCollect(salt, treasury, address(0));
        vm.deal(address(this), 1 ether);

        (bool success,) = payable(forwarder).call{value: 1 ether}("");

        assertTrue(success);
        assertEq(treasury.balance, 1 ether);
        assertEq(forwarder.balance, 0);
    }

    function testLateTokenDepositCanBeCollectedByAnyone() public {
        MockToken token = new MockToken();
        bytes32 salt = keccak256("late-token");
        (address forwarder,) = factory.deployAndCollect(salt, treasury, address(token));
        token.mint(forwarder, 50);

        vm.prank(address(0xBAD));
        (, uint256 amount) = factory.deployAndCollect(salt, treasury, address(token));

        assertEq(amount, 50);
        assertEq(token.balanceOf(treasury), 50);
    }

    function testRepeatedCollectionIsHarmless() public {
        bytes32 salt = keccak256("repeat");
        (address first, uint256 firstAmount) = factory.deployAndCollect(salt, treasury, address(0));
        (address second, uint256 secondAmount) = factory.deployAndCollect(salt, treasury, address(0));

        assertEq(first, second);
        assertEq(firstAmount, 0);
        assertEq(secondAmount, 0);
    }

    function testDifferentTreasuryCannotRedirectAddress() public {
        bytes32 salt = keccak256("tenant");
        address intended = factory.predict(salt, treasury, address(0));
        address attacker = factory.predict(salt, address(0xBAD), address(0));

        assertTrue(intended != attacker);
        vm.deal(intended, 3 ether);
        vm.prank(address(0xBAD));
        factory.deployAndCollect(salt, treasury, address(0));
        assertEq(treasury.balance, 3 ether);
        assertEq(address(0xBAD).balance, 0);
    }

    function testAssetIsCommittedToTheAddress() public view {
        bytes32 salt = keccak256("asset");
        assertTrue(factory.predict(salt, treasury, address(0)) != factory.predict(salt, treasury, address(1)));
    }

    function testWrongAssetsRemainRecoverableToTreasury() public {
        MockToken intended = new MockToken();
        MockToken wrong = new MockToken();
        bytes32 salt = keccak256("wrong-assets");
        address predicted = factory.predict(salt, treasury, address(intended));
        vm.deal(predicted, 1 ether);
        wrong.mint(predicted, 25);

        (address forwarder,) = factory.deployAndCollect(salt, treasury, address(intended));
        PaymentForwarder(payable(forwarder)).collectNative();
        PaymentForwarder(payable(forwarder)).collectToken(address(wrong));

        assertEq(treasury.balance, 1 ether);
        assertEq(wrong.balanceOf(treasury), 25);
        assertEq(forwarder.balance, 0);
        assertEq(wrong.balanceOf(forwarder), 0);
    }

    function testZeroAddressCannotBeCollectedAsToken() public {
        (address forwarder,) = factory.deployAndCollect(keccak256("invalid-token"), treasury, address(0));
        vm.expectRevert(PaymentForwarder.InvalidAsset.selector);
        PaymentForwarder(payable(forwarder)).collectToken(address(0));
    }

    function testFuzzPredictionMatchesCreate2Formula(bytes32 salt, address payable fuzzTreasury, address asset) public {
        vm.assume(fuzzTreasury != address(0));
        bytes32 initHash =
            keccak256(abi.encodePacked(type(PaymentForwarder).creationCode, abi.encode(fuzzTreasury, asset)));
        address expected =
            address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(factory), salt, initHash)))));

        assertEq(factory.predict(salt, fuzzTreasury, asset), expected);
        assertEq(factory.initCodeHash(fuzzTreasury, asset), initHash);
    }
}
