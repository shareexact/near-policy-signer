# Owner calls on the upgraded contract (Meteor Wallet, NEAR testnet only)

One self-contained file, `index.html` (sha256 `5c3ebee2e7344f2d6a467432762e310a370f7bb2e2c7f75ba59971e33f76f5f4`), for the owner's calls on the testnet deployment once it runs the
reproducible build of a3ac91e (code hash `E1xgsbWL3TwTefBKFAUdLoKiuYME2zEw938T8ycsnbPF`). Same design and locks as
[`../wallet-page/`](../wallet-page/); see [WALLET-SIGNING.md](../WALLET-SIGNING.md). It replaces
`wallet-page-owner-demo/`, which is pinned to ticket 1 and to the Nov 2 code.

Serve locally and open in the browser that has Meteor with aa5hr.testnet:

    python3 -m http.server 8080 --bind 127.0.0.1   # in this folder, then open http://localhost:8080/

Each button sends ONE FunctionCall, 1 yoctoNEAR, 30 Tgas, signer aa5hr.testnet, receiver
policy-v1.shareexact-chainsig-demo.testnet. All need: the upgraded code hash, no access keys on policy-v1,
`get_config.owner` aa5hr.testnet, the connected account aa5hr.testnet on testnet, and no `DEV__METEOR_WALLET_BASE_URL` override.
Arguments are read from the chain at each refresh and checked again just before signing. Reads go to `test.rpc.fastnear.com`,
then `rpc.testnet.near.org` if the first fails or is rate limited. An RPC error is never taken as an empty answer: if
neither endpoint answers, the page says "Could not read the chain" and every button stays locked. After a transaction the
page waits 5 seconds before reading again, because views read final state, a few blocks behind.

- **Approve** the newest ticket that is Pending and unexpired: `approve_ticket {"ticket_id":N}`. The page shows its agent,
  amount and recipient. The agent then has `approved_ticket_ttl_s` (900 s) to re-send with `--ticket N`.
- **Pause** `set_paused {"paused":true}` while not paused; **Resume** `set_paused {"paused":false}` while paused. Both are
  immediate, with or without the policy delay.
- **Show the policy delay**: with `policy_delay_s` 3600, **Schedule** sends
  `set_recipient {"chain_id":46630,"recipient":"0xb0b0000000000000000000000000000000000b0b","allowed":true}`, which the
  contract does not apply: it emits `change_scheduled` with an `executable_at` one hour later. **Cancel** then sends
  `cancel_change {"change_id":N}` for exactly that scheduled change. Unlocked only when the delay is on, bob is not
  allowlisted and nothing for bob is scheduled (Schedule), or when that change is scheduled (Cancel).

Build: `npm ci && npm run build` (same sha256). Test: `npm test` (mock Meteor, nothing is signed; every RPC call is answered
offline; the expected transactions in `test/fixtures/` are built by `test/make-expected.mjs` with near-api-js 0.45.1,
independently of `src/`).
