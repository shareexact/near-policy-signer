# Testnet deployment commands

The commands used for the deployment in [DEPLOYMENT-TESTNET.md](DEPLOYMENT-TESTNET.md), with near-cli-rs 0.x syntax.
Testnet only. Keys are referred to by their public key; the secret keys stay in the local near-cli keychain
(`sign-with-legacy-keychain`) and are never written to this repository. Owner transactions are not here: they are signed in
Meteor Wallet, see [WALLET-SIGNING.md](WALLET-SIGNING.md).

## Build

```
cd policy-signer && cargo near build non-reproducible-wasm --locked && cd ..
sha256sum target/near/policy_signer/policy_signer.wasm
```

## Accounts (signed by the parent account)

Generate the temporary keys first (key 1 for policy-v1, key 2 for agent-v1) and keep them in the keychain.

```
near account create-account fund-myself policy-v1.shareexact-chainsig-demo.testnet '4.9 NEAR' \
  use-manually-provided-public-key ed25519:7qYtkNWa2eS9LP5ZonKPq97HmD6NV5Chj4jkKgcEgEvp \
  sign-as shareexact-chainsig-demo.testnet network-config testnet sign-with-legacy-keychain send
near account create-account fund-myself agent-v1.shareexact-chainsig-demo.testnet '1.9 NEAR' \
  use-manually-provided-public-key ed25519:HKXjTKwyv7DHJt2YKAzZbnvq5Ui1XvSPuYTPmbAC9erv \
  sign-as shareexact-chainsig-demo.testnet network-config testnet sign-with-legacy-keychain send
```

policy-v1 needs about 3.7 NEAR for contract storage; 4.9 NEAR leaves a margin. agent-v1 backs a 1 NEAR function-call allowance.

## B1: deploy and initialise

```
near contract deploy policy-v1.shareexact-chainsig-demo.testnet \
  use-file target/near/policy_signer/policy_signer.wasm \
  with-init-call new json-args '{"owner":"aa5hr.testnet","signer":"v1.signer-prod.testnet","path":"robinhood-46630-1","network":"Testnet"}' \
  prepaid-gas '100.0 Tgas' attached-deposit '0 NEAR' network-config testnet sign-with-legacy-keychain send
```

## B2: remove the contract's only key

```
near account delete-keys policy-v1.shareexact-chainsig-demo.testnet \
  public-keys ed25519:7qYtkNWa2eS9LP5ZonKPq97HmD6NV5Chj4jkKgcEgEvp network-config testnet sign-with-legacy-keychain send
```

## B3 and B4: give the agent a function-call key, then drop its full-access key

```
near account add-key agent-v1.shareexact-chainsig-demo.testnet grant-function-call-access --allowance '1 NEAR' \
  --contract-account-id policy-v1.shareexact-chainsig-demo.testnet --function-names request \
  use-manually-provided-public-key ed25519:F6TZxxYhxXHvJdVWVkjnyBPm6JzqKdANfNwxw1eM9aAG \
  network-config testnet sign-with-legacy-keychain send
near account delete-keys agent-v1.shareexact-chainsig-demo.testnet \
  public-keys ed25519:HKXjTKwyv7DHJt2YKAzZbnvq5Ui1XvSPuYTPmbAC9erv network-config testnet sign-with-legacy-keychain send
```

## Checks after setup (read-only)

```
near account view-account-summary policy-v1.shareexact-chainsig-demo.testnet network-config testnet now
near account list-keys policy-v1.shareexact-chainsig-demo.testnet network-config testnet now     # must be empty
near account list-keys agent-v1.shareexact-chainsig-demo.testnet network-config testnet now      # only the request key
near contract call-function as-read-only policy-v1.shareexact-chainsig-demo.testnet get_config json-args '{}' network-config testnet now
near contract call-function as-read-only v1.signer-prod.testnet derived_public_key \
  json-args '{"path":"robinhood-46630-1","predecessor":"policy-v1.shareexact-chainsig-demo.testnet","domain_id":0}' network-config testnet now
(cd agent && AGENT_CONFIG=agent.config.testnet.json npm run cli -- address)   # turns that key into the EVM address
```

The derived 46630 address must be `0xc86A2A2F3FB5a3ac4FcB18076803c76D97AAc43F`.

## Owner calls (Meteor)

Open `wallet-page/` for U3 (`add_agent`, `set_chain`, `set_token`, `set_recipient`), then `wallet-page-owner-demo/` for the
approval, pause and resume in step 8.

## Step 8 demo (agent CLI)

From `agent/`, with the agent's function-call secret key in `NEAR_AGENT_KEY` (load it from your keychain without printing it):

```
export AGENT_CONFIG=agent.config.testnet.json
npm run cli -- address
npm run cli -- preview "send 0.0004 ETH to alice"            # SIGN
npm run cli -- send "send 0.0004 ETH to alice" --broadcast   # needs allowBroadcast true for 46630
npm run cli -- send "send 0.002 ETH to alice"                # refused: AmountCapExceeded
npm run cli -- send "send 0.0008 ETH to alice"               # PENDING_APPROVAL, ticket id
#   owner approves the ticket (wallet-page-owner-demo), then within 15 minutes:
npm run cli -- send "send 0.0008 ETH to alice" --ticket 1 --broadcast
#   owner pauses; any send is refused with Paused; owner resumes
```

Set `allowBroadcast` back to `false` after the demo.

## A new agent (Nov 6)

The Nov 2 agent's key stayed in the environment the deployment ran in. A new agent, made where the demo runs:

```
cd agent
node scripts/new-agent.mjs keys      # keys in ~/.near-policy-signer/agent-v2.json (mode 600); prints the account and public key
#   wallet-page-new-agent step 1: create the account (0.5 NEAR from aa5hr.testnet)
node scripts/new-agent.mjs finish    # its only key: function call, policy-v1, method request; the full-access key deleted
#   wallet-page-new-agent step 2: add_agent (scheduled, 1 hour), then step 3: execute_change
```

`demo-take.sh` uses that agent when its key file is there.

## Demo video (agent CLI)

`agent/scripts/demo-take.sh` runs the video's agent sends in shot order on the machine that holds the agent's key, with a
read-only preflight first (the agent's on-chain key, not paused, nothing in flight, today's budget and request counts, the
derived address's balance). It waits for each owner step in `wallet-page-owner/` (approve, pause, resume) and checks it on
chain, and writes the outcomes and links to `~/demo-take-<time>.txt`. It never prints the key.

```
cd agent
./scripts/demo-take.sh check      # read-only
./scripts/demo-take.sh rehearse   # an on-chain refusal and a queued ticket the owner approves; no ETH spent
./scripts/demo-take.sh take       # shots 1, 4, 6, 7, 9 and 10; 0.0012 ETH plus fees, 6 of the agent's 20 daily requests
```

`bash test/demo-take/run.sh` tests it offline with a stub agent and stub views (also in CI).

