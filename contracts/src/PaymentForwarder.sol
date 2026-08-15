// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

interface IERC20Balance {
    function balanceOf(address account) external view returns (uint256);
}

contract PaymentForwarder {
    error InvalidTreasury();
    error NativeTransferFailed();
    error TokenTransferFailed();

    address payable private immutable treasury;
    address private immutable asset;

    event FundsCollected(address indexed asset, uint256 amount);

    constructor(address payable treasury_, address asset_) {
        if (treasury_ == address(0)) revert InvalidTreasury();
        treasury = treasury_;
        asset = asset_;
    }

    receive() external payable {
        _collectNative();
    }

    function collect() external returns (uint256 amount) {
        if (asset == address(0)) return _collectNative();

        amount = IERC20Balance(asset).balanceOf(address(this));
        if (amount == 0) return 0;
        (bool success, bytes memory result) = asset.call(abi.encodeWithSelector(0xa9059cbb, treasury, amount));
        if (!success || (result.length != 0 && !abi.decode(result, (bool)))) {
            revert TokenTransferFailed();
        }
        emit FundsCollected(asset, amount);
    }

    function _collectNative() private returns (uint256 amount) {
        amount = address(this).balance;
        if (amount == 0) return 0;
        (bool success,) = treasury.call{value: amount}("");
        if (!success) revert NativeTransferFailed();
        emit FundsCollected(address(0), amount);
    }
}
