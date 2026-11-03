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
- every transaction goes to `policy-v1.shareexact-chainsig-demo.testnet` and is FunctionCall only, 1 yoctoNEAR, 30 Tgas
  (owner methods call `assert_one_yocto`); no CreateAccount, Transfer, AddKey, DeleteKey or DeployContract can be built;
- a live read-only RPC check: policy-v1's code_hash is `8EtC2o7j51xd7ESB6vJJLCA18CPytCcmZ6HETqcSPows` and its access-key
  list is empty (the owner page also checks `get_config.owner`);
- the wallet connects without a contract (no dApp function-call key is requested), Meteor's random local key pair is not
  logged, and a `DEV__METEOR_WALLET_BASE_URL` override in localStorage (which would redirect the wallet) is refused.

| Page | sha256 of index.html | Buttons |
|---|---|---|
| `wallet-page/` | `7022bb58e93625fac398a9d5e283b5666ba5c8e230f19dbc610f79c8c0594c02` | U3 x4 in one batch, or U3.1 to U3.4 one at a time |
| `wallet-page-owner-demo/` | `567ef6dcde2dee624eac46d546c08b6ff3a202e96be6d917ff905fda99958b47` | Approve ticket 1, Pause, Resume (one transaction each, each with its own on-chain lock) |

Rebuilding from `src/` gives the same sha256. Each folder's README lists the exact arguments.

## Tests

`npm ci && npm test` in each folder loads `index.html` in jsdom with a mock Meteor extension that captures the base64
transactions the Meteor SDK hands to the extension and then rejects them, so nothing is signed or sent. Each captured
transaction is decoded with an independent library (near-api-js 0.45.1) and compared field by field, and byte for byte after
normalising the live nonce and block hash, with the unsigned transactions in `test/fixtures/`. The tests also cover the locks
(wrong code hash, leftover key, missing account, wrong owner, ticket not pending), a wrong connected account, and forced
clicks on disabled buttons. They read aa5hr.testnet's current nonce from rpc.testnet.near.org, so they need network access.
