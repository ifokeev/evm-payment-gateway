# Security

Do not report payment or wallet vulnerabilities in a public issue. Use the
repository's private vulnerability reporting feature and include reproduction
steps, affected versions, and impact.

The API Worker must receive only the watch-only xpub. Put the matching xprv and
low-balance gas-wallet keys only in the private sweeper Worker. Never reuse a
treasury, exchange, or personal-wallet key as either key.

Use Cloudflare encrypted secrets, keep `.api.secrets` and `.sweeper.secrets`
out of version control, and test with dedicated testnet keys before enabling a
mainnet network.
