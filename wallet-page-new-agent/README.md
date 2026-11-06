# A new agent for the testnet deployment (Meteor Wallet, NEAR testnet only)

One self-contained file, `index.html` (sha256 `4514d8b85f1ed984b1580a3630aa7e4a3a010832a639d8fbc5fe9c5969ff876f`), for the owner's three transactions that add a new agent to the
testnet deployment in [DEPLOYMENT-TESTNET.md](../DEPLOYMENT-TESTNET.md). Same design and locks as [`../wallet-page/`](../wallet-page/);
see [WALLET-SIGNING.md](../WALLET-SIGNING.md). The agent's keys are made and kept by [`agent/scripts/new-agent.mjs`](../agent/scripts/new-agent.mjs),
never by this page.

## Why

The key of the Nov 2 agent, `agent-v1.shareexact-chainsig-demo.testnet`, stayed in the environment the deployment ran in, which
is no longer available. Its account has no full-access key (by design), so no new key can be added to it. A new agent, with its
key where the demo now runs, takes its place for the recorded demo; agent-v1 stays registered.

## The steps

Serve locally and open in the browser that has Meteor with aa5hr.testnet:

    python3 -m http.server 8080 --bind 127.0.0.1   # in this folder, then open http://localhost:8080/

Where the agent will run (`agent/`):

    node scripts/new-agent.mjs keys          # makes the keys (in ~/.near-policy-signer/, mode 600) and prints the account and its public key

Then, in the page (enter the account and the public key it printed):

1. **Create the account**: `testnet.create_account {"new_account_id":"<agent>","new_public_key":"<key>"}` with a 0.5 NEAR deposit
   and 100 Tgas, from aa5hr.testnet. `testnet` is NEAR's testnet registrar: it creates `<name>.testnet` with that one full-access
   key and passes on the deposit (the agent's gas money). Unlocked only for a valid top-level `.testnet` name that does not exist
   yet and an ed25519 public key.

   Then `node scripts/new-agent.mjs finish`: it adds the agent's only key (a function-call key for policy-v1, method `request`,
   0.25 NEAR allowance), deletes the full-access key, and drops that key's secret from its file.
2. **Register it**: `add_agent {"agent":"<agent>","policy":{"enabled":true,"label":"demo agent v2","max_requests_per_day":20}}`,
   1 yoctoNEAR, 30 Tgas. With `policy_delay_s` 3600 the contract does not apply it: it emits `change_scheduled`, executable an
   hour later. Unlocked only when policy-v1 runs the upgraded code with no keys, is owned by aa5hr.testnet with the delay at 3600,
   the agent account has exactly one key, the function-call key for `request` on policy-v1, and the agent is neither registered
   nor scheduled.
3. **Apply it**: `execute_change {"change_id":N}`, 1 yoctoNEAR, 30 Tgas, for exactly that scheduled change (same agent, same
   policy), once its `executable_at` has passed.

Every button also needs the connected account aa5hr.testnet on testnet and no `DEV__METEOR_WALLET_BASE_URL` override; reads go
to `test.rpc.fastnear.com`, then `rpc.testnet.near.org`, and if neither answers every button stays locked. The page hands the
wallet only a transaction equal to one the last chain read unlocked.

Build: `npm ci && npm run build` (same sha256). Test: `npm test` (mock Meteor, nothing is signed; every RPC call is answered
offline). The expected transactions in `test/fixtures/` are built by `test/make-expected.mjs` with near-api-js 0.45.1 from
arguments written out by hand, independently of `src/`.
