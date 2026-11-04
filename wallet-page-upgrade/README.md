# Upgrade the testnet contract (Meteor Wallet, NEAR testnet only)

One self-contained file, `index.html`, for the three owner calls that bring the testnet deployment in
[DEPLOYMENT-TESTNET.md](../DEPLOYMENT-TESTNET.md) from commit 88e06a6 to the current code, through the contract's own
upgrade timelock. Same design and locks as [`../wallet-page/`](../wallet-page/); see [WALLET-SIGNING.md](../WALLET-SIGNING.md).

## What changes

The only contract change since 88e06a6 is that `propose_owner` goes through the policy delay, so a stolen owner key cannot
hand the contract to its holder before the real owner can cancel. The state layout is unchanged (`migrate` reads it as is); [`upgrade-check/`](../upgrade-check/) checks this in CI by writing state with 88e06a6 and reading it with the new code. The full deploy and `migrate` receipt has not run in a sandbox.

## The code

`policy_signer.wasm` in this folder is the reproducible build of commit `a3ac91e3a581e9f01c665ec6e455ba39a55c9bdf`
(CI artifact `policy-signer-reproducible-wasm`), sha256 `c166e5635d8df6d25528acfa611c8ee81228650dced0b2f6a986ef6687d95e5a`
(base58 `E1xgsbWL3TwTefBKFAUdLoKiuYME2zEw938T8ycsnbPF`, the form NEAR shows as a code hash). Rebuild it yourself and compare:

    git checkout a3ac91e3a581e9f01c665ec6e455ba39a55c9bdf
    cd policy-signer && cargo near build reproducible-wasm
    sha256sum ../target/near/policy_signer/policy_signer.wasm

The build runs inside `sourcescan/cargo-near:0.22.0-rust-1.97.1`, pinned by digest in `policy-signer/Cargo.toml`
(NEP-330); the commit id is embedded in the wasm, so a build of another commit hashes differently.

## The calls

Serve this folder locally and open it in the browser that has Meteor with aa5hr.testnet:

    python3 -m http.server 8080 --bind 127.0.0.1   # in this folder, then open http://localhost:8080/

Each button sends ONE FunctionCall with 1 yoctoNEAR, signer aa5hr.testnet, receiver
policy-v1.shareexact-chainsig-demo.testnet. All three need: no access keys on policy-v1, `get_config.owner` aa5hr.testnet,
the connected account aa5hr.testnet on testnet, and no `DEV__METEOR_WALLET_BASE_URL` override.

1. **Propose** (`propose_upgrade {"code_hash":"<sha256>"}`, 30 Tgas). Unlocked while policy-v1 runs the Nov 2 code, upgrades
   are not disabled and nothing is pending. It emits `upgrade_proposed` with `executable_at` 48 hours later; until then the
   owner can `cancel_upgrade`.
2. **Apply** (`apply_upgrade {"code":"<base64 wasm>"}`, 300 Tgas), after the 48 hours. Unlocked only when the pending upgrade
   is exactly this sha256, its time has come, and `policy_signer.wasm` served next to the page hashes to it (checked in the
   browser before anything reaches the wallet). The contract checks the hash again, deploys the code and calls `migrate` in
   the same receipt; if `migrate` failed, the deploy would be reverted with it. The transaction carries the whole wasm. If
   Meteor refuses a transaction that large, apply with near-cli from an account key of aa5hr.testnet:

       near contract call-function as-transaction policy-v1.shareexact-chainsig-demo.testnet apply_upgrade \
         file-args apply-args.json prepaid-gas '300.0 Tgas' attached-deposit '1 yoctoNEAR' \
         sign-as aa5hr.testnet network-config testnet sign-with-legacy-keychain send   # or sign-with-keychain, wherever that key is stored

   where `apply-args.json` is `{"code":"<base64 of policy_signer.wasm>"}`
   (`printf '{"code":"%s"}' "$(base64 -w0 policy_signer.wasm)" > apply-args.json`).
3. **Turn on the policy delay** (`set_params` with `policy_delay_s` 3600 and every other parameter as deployed, 30 Tgas).
   Unlocked only when policy-v1 runs the new code and its parameters are exactly the deployed ones. With the delay at 0 it
   applies at once; afterwards every loosening of the policy and any ownership transfer waits an hour and can be cancelled.

After each call, the hash goes into DEPLOYMENT-TESTNET.md. After step 2, `view_account` shows the new code hash.

Build: `npm ci && npm run build` (same sha256 as the committed `index.html`). Test: `npm test` (mock Meteor, nothing is signed;
every RPC call is answered offline; the expected transactions in `test/fixtures/` are built by `test/make-expected.mjs`
with near-api-js 0.45.1, independently of `src/`).
