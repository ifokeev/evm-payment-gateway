// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {PaymentForwarderFactory} from "../src/PaymentForwarderFactory.sol";
import {TestBase, Vm} from "./TestBase.sol";

contract InvariantToken {
    mapping(address => uint256) public balanceOf;

    function mint(address account, uint256 amount) external {
        balanceOf[account] += amount;
    }

    function transfer(address recipient, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[recipient] += amount;
        return true;
    }
}

contract CollectionHandler {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    bytes32 private constant NATIVE_SALT = keccak256("invariant-native");
    bytes32 private constant TOKEN_SALT = keccak256("invariant-token");

    PaymentForwarderFactory public immutable factory;
    InvariantToken public immutable token;
    address payable public immutable treasury;
    address public immutable nativeForwarder;
    address public immutable tokenForwarder;
    uint256 public nativeSent;
    uint256 public tokenSent;

    constructor(PaymentForwarderFactory factory_, InvariantToken token_, address payable treasury_) {
        factory = factory_;
        token = token_;
        treasury = treasury_;
        nativeForwarder = factory_.predict(NATIVE_SALT, treasury_, address(0));
        tokenForwarder = factory_.predict(TOKEN_SALT, treasury_, address(token_));
        factory_.deployAndCollect(NATIVE_SALT, treasury_, address(0));
        factory_.deployAndCollect(TOKEN_SALT, treasury_, address(token_));
    }

    function payNative(uint96 input) external {
        uint256 amount = uint256(input) % 1 ether + 1;
        vm.deal(address(this), amount);
        (bool success,) = payable(nativeForwarder).call{value: amount}("");
        require(success, "native payment failed");
        nativeSent += amount;
    }

    function payToken(uint96 input) external {
        uint256 amount = uint256(input) % 1e12 + 1;
        token.mint(tokenForwarder, amount);
        factory.deployAndCollect(TOKEN_SALT, treasury, address(token));
        tokenSent += amount;
    }

    function collectAgain() external {
        factory.deployAndCollect(NATIVE_SALT, treasury, address(0));
        factory.deployAndCollect(TOKEN_SALT, treasury, address(token));
    }
}

contract PaymentForwarderInvariantTest is TestBase {
    PaymentForwarderFactory private factory;
    InvariantToken private token;
    CollectionHandler private handler;
    address payable private treasury;

    function setUp() public {
        factory = new PaymentForwarderFactory();
        token = new InvariantToken();
        treasury = payable(address(0xBEEF));
        handler = new CollectionHandler(factory, token, treasury);
        targetContract(address(handler));
    }

    function invariantFundsOnlyReachCommittedTreasury() public view {
        assertEq(treasury.balance, handler.nativeSent());
        assertEq(token.balanceOf(treasury), handler.tokenSent());
        assertEq(handler.nativeForwarder().balance, 0);
        assertEq(token.balanceOf(handler.tokenForwarder()), 0);
        assertEq(address(factory).balance, 0);
    }
}
