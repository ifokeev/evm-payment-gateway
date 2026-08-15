// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {PaymentForwarder} from "./PaymentForwarder.sol";

contract PaymentForwarderFactory {
    event ForwarderDeployed(bytes32 indexed salt, address indexed forwarder, address indexed treasury, address asset);

    function deployAndCollect(bytes32 salt, address payable treasury, address asset)
        external
        returns (address forwarder, uint256 amount)
    {
        forwarder = predict(salt, treasury, asset);
        if (forwarder.code.length == 0) {
            forwarder = address(new PaymentForwarder{salt: salt}(treasury, asset));
            emit ForwarderDeployed(salt, forwarder, treasury, asset);
        }

        amount = PaymentForwarder(payable(forwarder)).collect();
    }

    function predict(bytes32 salt, address treasury, address asset) public view returns (address) {
        return address(
            uint160(
                uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), salt, initCodeHash(treasury, asset))))
            )
        );
    }

    function initCodeHash(address treasury, address asset) public pure returns (bytes32) {
        return keccak256(abi.encodePacked(type(PaymentForwarder).creationCode, abi.encode(treasury, asset)));
    }
}
