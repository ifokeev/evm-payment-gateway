# Security

Do not report payment or wallet vulnerabilities in a public issue. Use the
repository's private vulnerability reporting feature and include reproduction
steps, affected versions, and impact.

The deposit wallet must be generated and retained by Turnkey. Never export its
seed into Cloudflare. Give the API Worker a non-root credential that can only
create wallet accounts and give the sweeper Worker a different non-root
credential that can only sign policy-approved Ethereum transactions.

Install destination, chain, token calldata, gas, and gas-price policies before
deploying either credential. Restrict policy changes and wallet export to
human-controlled root quorum. A Cloudflare secret prevents accidental display,
but Worker code can read it; Turnkey policy is the boundary that limits a
compromised credential.

Put low-balance gas-wallet keys only in the private sweeper Worker. Never reuse
a treasury, exchange, or personal-wallet key as a gas key, and never give either
Worker a Safe owner key.

Use HTTPS for RPC, explorer, and webhook endpoints. The gateway does not follow
webhook redirects, so configure the final receiver URL directly.

Use Cloudflare encrypted secrets, keep `.api.secrets` and `.sweeper.secrets`
out of version control, and test with dedicated testnet keys before enabling a
mainnet network.
