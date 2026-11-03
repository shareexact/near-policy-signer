# Clear exact_transfer on chain 46630 (Meteor Wallet, NEAR testnet only)

One self-contained file, `index.html` (sha256 `54cc590ad478c67ef0341c54c4dfc632f4a99be3618c79d5b7bd5fde13c1c6b9`), for one owner call on the testnet deployment in
[DEPLOYMENT-TESTNET.md](../DEPLOYMENT-TESTNET.md). Same design and locks as [`../wallet-page/`](../wallet-page/); see
[WALLET-SIGNING.md](../WALLET-SIGNING.md).

## Why

On Nov 2 the chain policy for 46630 was set with `exact_transfer` `0x2cbaedbf8bf46600cf311c7065f901aad973fd8e`. That address is
not ShareExact's `ExactTransfer`, and no `ExactTransfer` is deployed on Robinhood Chain testnet. A chain policy must not name a
contract that is not there. With the field cleared, the contract refuses to register a `StockExact` token on this chain
("StockExact needs exact_transfer on the chain"); native and `Plain` transfers are unaffected.

## The call

Serve locally and open in the browser that has Meteor with aa5hr.testnet:

    python3 -m http.server 8080 --bind 127.0.0.1   # in this folder, then open http://localhost:8080/

The button sends ONE FunctionCall, 1 yoctoNEAR, 30 Tgas, signer aa5hr.testnet, receiver policy-v1.shareexact-chainsig-demo.testnet:

    set_chain {"chain_id":46630,"policy":{"max_fee_per_gas":"1000000000","max_priority_fee_per_gas":"100000000","max_gas_limit":"200000","exact_transfer":null,"unknown_recipients_need_approval":true}}

Every field except `exact_transfer` is the value set on Nov 2. `set_chain` is owner-only (`assert_owner`, exactly 1 yoctoNEAR) and
applies at once, since `policy_delay_s` is 0.

The button unlocks only when: policy-v1's code_hash is `8EtC2o7j51xd7ESB6vJJLCA18CPytCcmZ6HETqcSPows`, it has no access keys,
`get_config.owner` is aa5hr.testnet, `get_chain(46630)` still has an `exact_transfer` and all its other fields equal the values
above, the connected account is aa5hr.testnet on testnet, and no `DEV__METEOR_WALLET_BASE_URL` override is set. The page also
refuses any transaction whose arguments differ from the plan. After the call, `get_chain` shows `exact_transfer: null` and the
page reports "Already cleared".

Build: `npm ci && npm run build` (same sha256). Test: `npm test` (mock Meteor, nothing is signed; every RPC call is mocked, so it
needs no network). The expected transaction in `test/fixtures/` is built by `test/make-expected.mjs` with near-api-js 0.45.1 from
arguments written out by hand, independently of `src/`.
