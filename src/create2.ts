import {
  type Address,
  bytesToHex,
  concatHex,
  encodeAbiParameters,
  encodeFunctionData,
  getCreate2Address,
  type Hex,
  keccak256,
  parseAbi,
  zeroAddress,
} from "viem";
import { PAYMENT_FORWARDER_CREATION_CODE } from "./contracts.generated";

export const forwarderFactoryAbi = parseAbi([
  "function deployAndCollect(bytes32 salt, address treasury, address asset) returns (address forwarder, uint256 amount)",
]);

export function newIntentSalt(): Hex {
  return bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
}

export function forwarderInitCode(treasury: Address, token: Address | ""): Hex {
  return concatHex([
    PAYMENT_FORWARDER_CREATION_CODE,
    encodeAbiParameters(
      [{ type: "address" }, { type: "address" }],
      [treasury, token || zeroAddress],
    ),
  ]);
}

export function counterfactualAddress(
  factory: Address,
  salt: Hex,
  treasury: Address,
  token: Address | "",
): { address: Address; initCodeHash: Hex } {
  const initCodeHash = keccak256(forwarderInitCode(treasury, token));
  return {
    address: getCreate2Address({ from: factory, salt, bytecodeHash: initCodeHash }),
    initCodeHash,
  };
}

export function collectionCall(salt: Hex, treasury: Address, token: Address | ""): Hex {
  return encodeFunctionData({
    abi: forwarderFactoryAbi,
    functionName: "deployAndCollect",
    args: [salt, treasury, token || zeroAddress],
  });
}
