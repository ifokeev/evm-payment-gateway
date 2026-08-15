const ADDRESS = /^0x[0-9a-f]{40}$/i;
const UINT256_MAX = (1n << 256n) - 1n;

export function walletPayment(paymentUri, from) {
  if (!ADDRESS.test(from)) throw new Error("wallet returned an invalid account");

  let uri;
  try {
    uri = new URL(paymentUri);
  } catch {
    throw new Error("invalid payment URI");
  }
  const match = uri.pathname.match(/^(0x[0-9a-f]{40})@([1-9]\d*)(\/transfer)?$/i);
  if (uri.protocol !== "ethereum:" || !match) throw new Error("invalid payment URI");

  const chainId = uint256(match[2], "chain ID");
  if (match[3]) {
    const recipient = onlyParameter(uri, "address");
    const amount = uint256(onlyParameter(uri, "uint256"), "token amount");
    if (!ADDRESS.test(recipient) || uri.searchParams.size !== 2)
      throw new Error("invalid token payment URI");
    return {
      chainId: quantity(chainId),
      transaction: {
        from,
        to: match[1],
        data: `0xa9059cbb${recipient.slice(2).toLowerCase().padStart(64, "0")}${amount.toString(16).padStart(64, "0")}`,
      },
    };
  }

  const amount = uint256(onlyParameter(uri, "value"), "native amount");
  if (uri.searchParams.size !== 1) throw new Error("invalid native payment URI");
  return {
    chainId: quantity(chainId),
    transaction: { from, to: match[1], value: quantity(amount) },
  };
}

function onlyParameter(uri, name) {
  const values = uri.searchParams.getAll(name);
  if (values.length !== 1) throw new Error(`invalid ${name}`);
  return values[0];
}

function uint256(value, label) {
  if (!/^[1-9]\d{0,77}$/.test(value)) throw new Error(`invalid ${label}`);
  const parsed = BigInt(value);
  if (parsed > UINT256_MAX) throw new Error(`invalid ${label}`);
  return parsed;
}

function quantity(value) {
  return `0x${value.toString(16)}`;
}
