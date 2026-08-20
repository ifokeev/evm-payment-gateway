# Security

Do not report payment or wallet vulnerabilities in a public issue. Use GitHub
private vulnerability reporting. Include reproduction steps, affected versions,
and impact.

## Contract model

Each intent uses a counterfactual CREATE2 address committed to four values: the
factory, random salt, treasury, and asset. No private key exists for a deposit
address. The immutable forwarder can send only its complete native or ERC-20
balance to the committed treasury.

If a payer sends the wrong asset, anyone can invoke native or token recovery.
Recovery still routes the complete balance only to the immutable treasury.

The factory and forwarder have no administrator, proxy, upgrade path,
`delegatecall`, `selfdestruct`, or arbitrary withdrawal destination. Anyone can
call collection. A caller that pays gas does not get control over the funds.

Only configure trusted token contracts. A malicious or non-standard token can
reenter, lie about balances, or block collection. The included transfer logic
supports standard boolean-returning tokens and established no-return tokens,
but configuration remains the security boundary.

## Cloudflare credentials

The treasury key and multisig owner keys must never enter Cloudflare. The API
Worker receives only its bearer key, webhook secret, webhook URL, and public
network configuration.

The private relayer Worker receives a separate EVM key through
`SWEEPER_NETWORKS_JSON`. Keep only enough native token in that account for a
small number of collection transactions. A compromised relayer can waste that
balance, but it cannot sign for deposit addresses or change a forwarder's
treasury.

The API and relayer both pin the factory runtime code hash. The API rejects
relayer private keys. It independently validates each registered transaction.
This validation covers the signer, chain, factory destination, calldata, value,
gas, and gas price.

Use Cloudflare encrypted secrets. Keep `.api.<environment>.secrets` and
`.sweeper.<environment>.secrets` out of version control. Never share relayer
keys, treasuries, RPC credentials, API keys, or webhook secrets between testnet
and mainnet.

## Operational requirements

Use these operational controls:

- Use HTTPS RPC and webhook endpoints. The gateway never follows webhook
  redirects.
- Use a multisig treasury for material value.
- Before you accept payments, validate its ability to receive native assets.
- Set confirmation depth and reorg history for each network's risk profile.
- Monitor relayer balance, failed collections, scanner lag, webhook retries,
  and unexpected factory code-hash failures.
- Validate every token address and decimals value against issuer data.
- Treat `payment.succeeded` as an at-least-once event.
- Deduplicate webhook IDs and business fulfillment in your database.
- Handle `payment.reorged`. More confirmations reduce reorg risk but do not
  eliminate it.

## Mainnet status

The contracts are not externally audited. Automated checks include unit tests,
1,000-case CREATE2 fuzzing, stateful invariant testing, Worker/D1 integration
tests, type checking, linting, generated-bytecode verification, and deployment
dry runs. These checks reduce risk but cannot prove the absence of defects.

Mainnet deployment is intentionally blocked unless the operator sets
`ALLOW_UNAUDITED_MAINNET=true`. Start with testnet. Use low payment and relayer
limits during a monitored mainnet rollout.
