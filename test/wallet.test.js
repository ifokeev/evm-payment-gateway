import { describe, expect, it } from "vitest";
import { walletPayment } from "../demo/public/wallet.js";

const account = "0x1111111111111111111111111111111111111111";
const recipient = "0x2222222222222222222222222222222222222222";
const token = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";

describe("wallet payment requests", () => {
  it("builds an ERC-20 transfer from the wallet-compatible URI", () => {
    expect(
      walletPayment(
        `ethereum:${token}@84532/transfer?address=${recipient}&uint256=500000`,
        account,
      ),
    ).toEqual({
      chainId: "0x14a34",
      transaction: {
        from: account,
        to: token,
        data: `0xa9059cbb${recipient.slice(2).padStart(64, "0")}${"7a120".padStart(64, "0")}`,
      },
    });
  });

  it("builds a native transfer and rejects ambiguous or oversized values", () => {
    expect(walletPayment(`ethereum:${recipient}@84532?value=1000000000000`, account)).toEqual({
      chainId: "0x14a34",
      transaction: { from: account, to: recipient, value: "0xe8d4a51000" },
    });
    expect(() => walletPayment(`ethereum:${recipient}@84532?value=1&value=2`, account)).toThrow();
    expect(() =>
      walletPayment(`ethereum:${recipient}@84532?value=${1n << 256n}`, account),
    ).toThrow();
  });
});
