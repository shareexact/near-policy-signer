# Signing the owner transactions in a browser wallet

The owner of the testnet deployment, `aa5hr.testnet`, holds its key in Meteor Wallet (browser extension), not in a CLI
keychain. So every transaction the owner signs goes through a wallet, and everything else is signed from a CLI keychain.
Deployed ids and hashes: [DEPLOYMENT-TESTNET.md](DEPLOYMENT-TESTNET.md).

## Who signs what

| Step | Signer | Where | What |
|---|---|---|---|
| Create policy-v1 and agent-v1 | shareexact-chainsig-demo.testnet | CLI | CreateAccount + Transfer + AddKey (temporary full-access key) |
| B1 to B4 | policy-v1, agent-v1 (temporary keys) | CLI | deploy + `new`, delete the contract's key, add the agent's function-call key, delete the agent's full-access key |
| U3 (4 calls) | aa5hr.testnet | Meteor, [`wallet-page/`](wallet-page/) | `add_agent`, `set_chain`, `set_token`, `set_recipient` |
| Step 8 owner calls | aa5hr.testnet | Meteor, [`wallet-page-owner-demo/`](wallet-page-owner-demo/) | `approve_ticket`, `set_paused true`, `set_paused false` |
| Chain policy fix | aa5hr.testnet | Meteor, [`wallet-page-chain-fix/`](wallet-page-chain-fix/) | `set_chain` 46630 with `exact_transfer` cleared |
| Upgrade to the current code, then the policy delay | aa5hr.testnet | Meteor, [`wallet-page-upgrade/`](wallet-page-upgrade/) | `propose_upgrade`, `apply_upgrade` after 48 hours, `set_params` with `policy_delay_s` 3600 |
| Owner calls after the upgrade | aa5hr.testnet | Meteor, [`wallet-page-owner/`](wallet-page-owner/) | `approve_ticket` (newest pending), `set_paused`, a scheduled `set_recipient` and its `cancel_change` |
| A new agent for the demo | aa5hr.testnet | Meteor, [`wallet-page-new-agent/`](wallet-page-new-agent/) | `testnet.create_account` (0.5 NEAR), then `add_agent` (scheduled by the policy delay) and `execute_change` |
| Agent requests | agent-v1 (function-call key, method `request` only) | agent CLI | `request` |

Why the accounts are not sub-accounts of the owner: creating `*.aa5hr.testnet` needs aa5hr.testnet to sign a CreateAccount
with a full-access AddKey, and Meteor blocks that request from a dApp ("Full access key request blocked"). MyNearWallet was
considered first; its `/sign` URL flow works for these actions but the wallet is being retired, so it was not used.

## The pages

Both pages are single self-contained HTML files (the bundle is inlined, no CDN), built with esbuild from `src/`. They hold no
keys: Meteor shows each transaction and signs and broadcasts only after the user approves it there. Serve them from
`http://localhost` (for example `python3 -m http.server 8080 --bind 127.0.0.1` in the folder), not from `file://`.

Shared locks, enforced before any request reaches the wallet:

- the connected account must be `aa5hr.testnet` and the wallet network `testnet`;
- every transaction goes to `policy-v1.shareexact-chainsig-demo.testnet` (one exception: `wallet-page-new-agent/` step 1 calls `testnet.create_account` with 0.5 NEAR and 100 Tgas) and is FunctionCall only, 1 yoctoNEAR, 30 Tgas (`apply_upgrade`: 300 Tgas)
  (owner methods call `assert_one_yocto`); no CreateAccount, Transfer, AddKey, DeleteKey or DeployContract can be built;
- a live read-only RPC check: policy-v1's code_hash is the expected one (`8EtC2o7j51xd7ESB6vJJLCA18CPytCcmZ6HETqcSPows` for the Nov 2 code; the upgrade page's step 3 requires `E1xgsbWL3TwTefBKFAUdLoKiuYME2zEw938T8ycsnbPF`) and its access-key
  list is empty (the owner page also checks `get_config.owner`);
- the wallet connects without a contract (no dApp function-call key is requested), Meteor's random local key pair is not
  logged, and a `DEV__METEOR_WALLET_BASE_URL` override in localStorage (which would redirect the wallet) is refused.

| Page | sha256 of index.html | Buttons |
|---|---|---|
| `wallet-page/` | `7022bb58e93625fac398a9d5e283b5666ba5c8e230f19dbc610f79c8c0594c02` | U3 x4 in one batch, or U3.1 to U3.4 one at a time |
| `wallet-page-owner-demo/` | `567ef6dcde2dee624eac46d546c08b6ff3a202e96be6d917ff905fda99958b47` | Approve ticket 1, Pause, Resume (one transaction each, each with its own on-chain lock) |
| `wallet-page-upgrade/` | `035e5d7595df3e0dde7b748ae815c7a36e6fcc9dbc6b8154a71f78a524247d40` | Propose, apply (with the reproducible wasm served next to it, checked in the browser), turn on the policy delay; each with its own on-chain lock |
| `wallet-page-owner/` | `5c3ebee2e7344f2d6a467432762e310a370f7bb2e2c7f75ba59971e33f76f5f4` | Approve the newest pending ticket, pause, resume, schedule and cancel a sample change (each with its own on-chain lock; the upgraded code hash is required) |
| `wallet-page-new-agent/` | `4514d8b85f1ed984b1580a3630aa7e4a3a010832a639d8fbc5fe9c5969ff876f` | Create the new agent's account (0.5 NEAR to the `testnet` registrar), schedule `add_agent`, execute it after the delay (each with its own on-chain lock; the agent's keys are made by `agent/scripts/new-agent.mjs`) |
| `wallet-page-chain-fix/` | `54cc590ad478c67ef0341c54c4dfc632f4a99be3618c79d5b7bd5fde13c1c6b9` | Clear `exact_transfer` (one transaction, unlocked only while it is still set and the rest of the chain policy is unchanged) |

Rebuilding from `src/` gives the same sha256. Each folder's README lists the exact arguments.

## Tests

`npm ci && npm test` in each folder loads `index.html` in jsdom with a mock Meteor extension that captures the base64
transactions the Meteor SDK hands to the extension and then rejects them, so nothing is signed or sent. Each captured
transaction is decoded with an independent library (near-api-js 0.45.1) and compared field by field, and byte for byte after
normalising the live nonce and block hash, with the unsigned transactions in `test/fixtures/`. The tests also cover the locks
(wrong code hash, leftover key, missing account, wrong owner, ticket not pending), a wrong connected account, and forced
clicks on disabled buttons. Every RPC call in the six tests is answered offline (the contract's views, aa5hr.testnet's key and the latest block), so they need no network, and CI runs all six, each after checking that a rebuild gives the committed page byte for byte.
