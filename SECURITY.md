# Security

Do not report payment or wallet vulnerabilities in a public issue. Use the
repository's private vulnerability reporting feature and include reproduction
steps, affected versions, and impact.

The public gateway container must receive only a watch-only xpub. Never give it
a seed phrase, xprv, or gas-wallet private key.

The separate sweeper container needs the matching account xprv and per-network
gas-wallet keys. Use a wallet created only for this gateway, restrict access to
the internal sweeper API at the reverse proxy, keep little native currency in
each gas wallet, and never commit `.env` or `.sweeper.env`. Run one sweeper
replica unless gas-wallet nonce allocation is coordinated outside this
application.
