# Step 8 owner calls (Meteor Wallet, NEAR testnet only)

One self-contained file, `index.html` (sha256 `567ef6dcde2dee624eac46d546c08b6ff3a202e96be6d917ff905fda99958b47`), for the
owner calls of the step 8 demo. Same design and locks as [`../wallet-page/`](../wallet-page/); see
[WALLET-SIGNING.md](../WALLET-SIGNING.md). Signed on Nov 2 2026: see [DEPLOYMENT-TESTNET.md](../DEPLOYMENT-TESTNET.md).

Serve locally and open in the browser that has Meteor with aa5hr.testnet:

    python3 -m http.server 8080 --bind 127.0.0.1   # in this folder, then open http://localhost:8080/

Each button sends ONE FunctionCall, 1 yoctoNEAR, 30 Tgas, signer aa5hr.testnet, receiver policy-v1.shareexact-chainsig-demo.testnet.
Method names and arguments match `policy-signer/src/lib.rs` (`approve_ticket(ticket_id: u64)`, `set_paused(paused: bool)`, both
`#[payable]` and owner-only through `assert_owner`, which requires exactly 1 yoctoNEAR):

- Approve ticket 1: `approve_ticket {"ticket_id":1}`, unlocked only while ticket 1 is Pending and unexpired.
- Pause: `set_paused {"paused":true}`, unlocked only while `paused` is false.
- Resume: `set_paused {"paused":false}`, unlocked only while `paused` is true.

All buttons also need: code_hash `8EtC2o7j51xd7ESB6vJJLCA18CPytCcmZ6HETqcSPows`, no access keys on policy-v1,
`get_config.owner == aa5hr.testnet`, connected account aa5hr.testnet, network testnet, and no `DEV__METEOR_WALLET_BASE_URL`
override. The ticket id is fixed in `src/plan.js`; for another ticket, change `TICKET_ID` and rebuild.

After an approval the agent has `approved_ticket_ttl_s` (900 s on the deployment) to re-send the same request with
`--ticket <id>`.

Build: `npm ci && npm run build` (same sha256). Test: `npm test` (mock Meteor, nothing is signed; policy-v1's views are mocked
from `test/fixtures/`, aa5hr.testnet's nonce is read from rpc.testnet.near.org).
