# Policy Signer

**A spending firewall for AI agents that move money on EVM chains, built on NEAR Chain Signatures.** ETH, any ERC-20, and Stock Tokens, on any EVM chain the NEAR MPC network signs for.

An agent that holds a private key will eventually send the wrong amount, to the wrong address, at the wrong moment. Here the agent holds no EVM key at all. It holds a NEAR function-call key that can do one thing: ask a NEAR contract to send a transfer. The contract builds the exact EVM transaction itself, checks it against the owner's policy, and only then asks the NEAR MPC network to sign it. **The payload signed is exactly the payload checked.** Large transfers wait for a human. Anything outside the policy is refused with a named reason, recorded on chain, and nothing is signed.

**Why NEAR:** the agent holds no key; only the NEAR contract can obtain an MPC signature, and only for a transaction it built and checked itself.

Built for the NEAR HACKATHON, tracks AI Security & Defense and Open Innovation.

## How it works

```mermaid
flowchart LR
  U[Instruction: send 3 MSHR to alice] --> P[AI planner<br/>NEAR AI Cloud or offline rules]
  P -->|untrusted proposal| A[Agent runtime<br/>reads token state at one block]
  A -->|request + observation<br/>function-call key| C[Policy contract on NEAR]
  C -->|refused: named reason, event| A
  C -->|above soft limit| Q[Approval queue]
  Q -->|owner approves, signed with the owner key| A
  C -->|builds tx, reserves budget| M[NEAR MPC network<br/>Chain Signatures]
  M -->|signature| C
  C -->|unsigned tx + signature| A
  A -->|checks sighash and signer,<br/>then broadcasts| E[EVM chain<br/>Robinhood Chain]
  O[Owner console] -.->|reads views; owner actions<br/>signed in the owner's wallet| C
```

1. **Plan.** The planner turns plain text into `{token, recipient, amount}`. Its output is untrusted: it is checked against the agent's config, and the contract enforces everything again.
2. **Read.** For a Stock Token, the runtime reads `uiMultiplier`, `newUIMultiplier` and `effectiveAt` from one pinned block.
3. **Request.** The agent calls `request` with the transfer, what it observed and the fees. It never supplies calldata or a hash.
4. **Decide.** The contract checks the policy and returns one of: a named refusal, a ticket in the approval queue, or a signature request. Before calling the MPC network it reserves the nonce and the budget, so two requests can never spend the same budget.
5. **Sign.** The MPC network signs the sighash of the transaction the contract built. The callback records the signature. If signing failed or timed out, it records the request as possibly signed, because a late signature can still appear: the budget stays counted and the nonce stays reserved for the identical call.
6. **Verify and send.** The runtime checks that the payload hashes to the contract's sighash and that the signature recovers to the contract's derived address, then broadcasts, but only if the config allows broadcasting on that chain.

## What it guarantees

- The agent can only obtain signatures for transfers the contract built, to allowlisted tokens and recipients, within caps, with capped fees. Native coin and ERC-20 transfers on any EVM chain the owner allowlists; major mainnets can never be allowlisted on a testnet deployment.
- **Caps cannot be shrunk by a false observation.** Every token has one kind and one budget, counted in the unit the signed calldata carries (see [Token kinds](#token-kinds)).
- Amounts above a soft limit need the owner's approval: single-use, expiring tickets that never lift a hard cap.
- **New counterparties without handing over control:** on chains where the owner turns it on, a transfer to a recipient that is not allowlisted goes to the approval queue instead of being refused. The approval is for that one transfer.
- **Address-poisoning detection on chain:** a recipient that is not allowlisted but shares the first and last four hex digits with an allowlisted one is refused as `LookalikeRecipient`, and can never be queued or approved.
- The owner can pause at once, and can void signatures already issued by burning their nonces.
- Each agent has its own request limit and optional per-token daily cap, on top of the global caps.
- A stolen owner key cannot loosen policy on the spot: with `policy_delay_s` set, every change that adds a recipient, raises a cap or adds an agent is announced and takes effect only after the delay. Removals and pause are always immediate.
- A failed or timed-out signature is treated as possibly issued: its nonce is not reused for a different transfer and its budget is not released.
- Every refusal, queue entry, signature, policy change and owner action is a NEP-297 event: an audit trail on chain.
- The code can change only through a timelock (48 hours by default; it can be raised, never lowered) with an on-chain announcement, or never, once `disable_upgrades` is called.

What it does not protect against, and what the operator must do (delete the contract account's keys, size allowances, use burns), is in [SECURITY.md](SECURITY.md).

## Try it in five minutes (no keys, no funds, no network)

| Do | See |
|---|---|
| `cargo test` | `policy-signer` 93 passed, `mock-signer` 5 passed: every refusal, the approval queue, new recipients and look-alikes, pause and burn, the policy delay, native transfers, owner controls, the upgrade timelock, and transaction encoding |
| `cd agent && npm ci && npm test` | 31 passed: planner, exact decimals, config validation, one-block reads, and signature assembly that recovers to the expected signer and refuses the wrong key, chain or nonce |
| `cd agent && npm run vectors` | The two EIP-1559 test vectors, regenerated with viem, matching the sighashes asserted in the contract tests |
| `cd dashboard && npm ci && npm run dev`, open the printed address, click **Demo data** | Today's budget per token, a queued 4-share request, a scheduled policy change, and the exact near-cli command the owner signs to approve it. With a deployed testnet contract, **Connect wallet (testnet)** lets the owner approve, reject, pause, burn and execute scheduled changes from a NEAR wallet (MyNearWallet, Meteor or HERE) |

The contract tests use `near-sdk` unit testing. The CI workflow (`.github/workflows/ci.yml`) also builds the wasm with `cargo near build`.

### The scenarios the tests act out

| An agent tries to | The contract answers |
|---|---|
| Send 6 shares when the limit is 5, claiming a multiplier of 100 so the raw amount looks tiny | `AmountCapExceeded` (shares are what Exact mode puts on chain) |
| Send to an address it made up | `RecipientNotAllowed`, or, where the owner allows new recipients, a ticket the owner must approve |
| Send to `0x0000ffff...dead`, crafted to look like the allowlisted `0x0000...dead` | `LookalikeRecipient`: never queued, never approvable |
| Send while a split takes effect within two hours | `MultiplierChangePending` |
| Send using an observation taken before a split that has since happened | `ObservationCrossedChange` |
| Send 4 shares when anything above 2 needs approval | `PENDING_APPROVAL`, ticket 1; signed only after the owner approves and the agent re-sends with a fresh observation |
| Reuse that ticket, or use another agent's | `TicketInvalid` |
| Keep sending after the owner pressed pause | `Paused` |
| Replace a signed transaction with a different one at the same nonce, or fee-bump another agent's | `InvalidReplacement` |
| Re-send an approved Stock Token request with a lower multiplier so more raw units move | `TicketInvalid` |
| Send 6 ETH when the native cap is 5 | `AmountCapExceeded` (caps in wei) |

## Components

| Path | What it is |
|---|---|
| `policy-signer/` | The NEAR contract (Rust, near-sdk 5.30). Policy, refusals, approval queue, EIP-1559 construction, MPC `sign` call and callback, owner controls, upgrades |
| `mock-signer/` | A mock of the MPC `sign` method with the real argument and response shapes, for sandbox integration tests (planned). Its signatures do not recover and must never be broadcast |
| `agent/` | The agent runtime and `policy-agent` CLI (TypeScript, viem, near-api-js): planner, reads, preview, request, verification, broadcast |
| `dashboard/` | The owner console (Vite, NEAR Wallet Selector): reads the contract's views; owner actions are signed in the owner's own wallet, testnet only, or shown as near-cli commands. The page holds no key |
| `SECURITY.md` | Threat model, deployment rules, operating limits |
| `ROADMAP.md` | What comes after the hackathon |

## Token kinds

| Kind | Use for | Agent sends | Calldata | Caps counted in |
|---|---|---|---|---|
| `Native` | The chain's coin (ETH), registered under the zero address | wei | value transfer to the recipient, empty calldata | wei |
| `Plain` | Any ERC-20 (stablecoins, governance tokens) | raw units | `transfer(to, raw)` | raw units |
| `StockExact` | Stock Tokens, recommended | shares (18 decimals) | ShareExact `ExactTransfer.transferShares(token, to, shares, shortfall)`; the chain converts with the live multiplier | shares |
| `StockDirect` | Stock Tokens where `ExactTransfer` is not deployed | shares | `transfer(to, raw)`, raw computed from the observed multiplier | raw units |

A Stock Token's raw ERC-20 unit is not one share: one raw unit is `uiMultiplier / 1e18` shares, and the ratio changes on every dividend reinvestment and split. Stock Token requests carry an observation of that state, and the contract refuses stale, incomplete or straddling observations.

## Refusals

Where a refusal means the same condition as a ShareExact contract error, it has the same name.

| Refusal | Condition |
|---|---|
| `Paused` | The owner paused the contract |
| `AgentNotAllowed` | Caller is not a registered, enabled agent |
| `RequestCapExceeded` | Global or per-agent daily request limit reached |
| `RequestInFlight` | A request on this chain is waiting for the MPC network |
| `ChainNotAllowed` / `TokenNotAllowed` / `RecipientNotAllowed` | Not allowlisted, or not a valid address. An unknown recipient is queued instead when the chain has `unknown_recipients_need_approval` |
| `LookalikeRecipient` | Not allowlisted, and the same first and last four hex digits as an allowlisted recipient on the chain: the address-poisoning pattern |
| `ExactTransferMissing` | A `StockExact` token on a chain with no `ExactTransfer` configured |
| `ObservationIncomplete` | Stock Token request without an observation, or with a missing field. Fails closed |
| `StaleObservation` | Older than `max_observation_age_s` (120 s) or more than `max_clock_skew_s` (15 s) ahead of NEAR's clock |
| `UnitUnavailable` | Multiplier is zero (same as `ExactTransfer.UnitUnavailable`) |
| `ObservationCrossedChange` | A scheduled change took effect after the observation was taken |
| `MultiplierChangePending` | A change is scheduled within `corp_action_window_s` (7200 s, floor 600 s). For a complete observation, the same predicate as `unitChangeImminent` in `@shareexact/sdk` |
| `ZeroAmount` | Zero, or floors to zero raw units (same as `ExactTransfer.ZeroAmount`) |
| `ShareShortfall` | Floor rounding loses more than `max_shortfall` (same as `ExactTransfer.ShareShortfall`) |
| `AmountOverflow` | The share to raw conversion does not fit in 128 bits |
| `InvalidFees` / `GasCapExceeded` | Priority fee above max fee or zero gas limit / fees or gas over the chain's caps |
| `NonceOutOfOrder` / `InvalidReplacement` | Not the next nonce / same nonce as the last signed transaction but a different call, or fees not strictly higher |
| `AmountCapExceeded` / `AgentCapExceeded` | Over the token's per-request or daily cap / over the agent's own daily cap |
| `TicketInvalid` | The ticket is missing, not approved, expired, another agent's, or for a different transfer |
| `QueueFull` | `max_open_tickets` open tickets already |

## Owner controls

All owner methods, and `accept_owner`, require exactly 1 yoctoNEAR. Setters follow `policy_delay_s`: at 0 they apply at once, above 0 they are scheduled and applied with `execute_change` after the delay (`cancel_change` drops one). Removals and pause are always immediate.

| Method | Effect |
|---|---|
| `add_agent`, `remove_agent`, `set_agent_cap` | Register agents, their request limits and per-token daily caps |
| `set_chain`, `set_token`, `set_recipient`, `set_params` | Allowlists, caps, soft limits and timing |
| `approve_ticket`, `reject_ticket` | Decide queued requests |
| `set_paused` | Stop new requests at once; callbacks in flight still settle |
| `execute_change`, `cancel_change` | Apply or drop a scheduled policy change |
| `burn_nonce` | Sign a zero-value transaction at a nonce, voiding any signature issued for it. Works while paused and may exceed the chain's fee caps by up to 3 times, so it can outbid a transaction signed at the cap |
| `request_approve` | Sign the ERC-20 `approve` that `StockExact` needs, for an amount the owner chooses |
| `reset_nonce`, `clear_in_flight` | Recover from a transaction that was never mined or a callback that failed |
| `propose_owner` / `accept_owner` | Two-step ownership transfer |
| `propose_upgrade`, `apply_upgrade`, `cancel_upgrade`, `disable_upgrades` | Timelocked code upgrades, or none |

Views: `list_recipients`, `list_scheduled_changes`, `get_status(chain_id, token)` (one call for budget, nonce, in-flight request and queue size), `preview(agent, request)` (exactly what `request` would decide), `get_config`, `list_tickets`, `get_ticket`, `get_agent`, `get_agent_usage`, `get_nonce_state`.

## Run it on NEAR testnet

Nothing in this repository has been deployed yet. These are the steps, in order; deployment rules 1 and 2 in [SECURITY.md](SECURITY.md) are not optional.

1. Build: `cd policy-signer && cargo near build non-reproducible-wasm --locked`.
2. Create three testnet accounts: the contract, an owner, and an agent.
3. Deploy with the init call in the same transaction (check `cargo near deploy --help` for your version):
   `new({"owner":"<owner>","signer":"v1.signer-prod.testnet","path":"robinhood-46630-1","network":"Testnet"})`
4. **Delete every access key on the contract account**, then confirm the key list is empty.
5. As the owner (1 yoctoNEAR each): `add_agent`, `set_chain(46630, ...)`, `set_token(...)`, `set_recipient(...)`. Read the MPC contract's `config` view and call `set_sign_gas` if its sign gas requirement is above 50 Tgas.
6. Give the agent account a function-call key for `request` on the contract, with a finite allowance (about 0.015 NEAR per request at 150 Tgas).
7. Fund the contract with testnet NEAR for storage and 1 yoctoNEAR per signature.
8. Find the contract's EVM address: `npm run cli -- address` (in `agent/`) calls the MPC contract's `derived_public_key` view with `{"path", "predecessor": <contract>, "domain_id": 0}` and converts the key. Fund it with Robinhood Chain testnet ETH.
9. Copy `agent/agent.config.example.json` to `agent/agent.config.json`, fill it in (use an RPC endpoint from the NEAR docs' provider list; the public endpoints are rate limited), set `NEAR_AGENT_KEY`, and from `agent/` run `npm run cli -- preview "send 1 MSHR to alice"`, then `npm run cli -- send "send 1 MSHR to alice" --broadcast` once broadcasting is enabled in the config. Keep `requestGasTgas` at least the contract's sign gas plus 40; the agent checks this before sending.

The MPC `sign` arguments (`{"request":{"payload_v2":{"Ecdsa":"<hex, no 0x>"},"path","domain_id":0}}`), the 1 yoctoNEAR deposit and the response shape match the `near/mpc` contract source. The live testnet configuration has not been checked yet.

## Relationship to ShareExact

All code in this repository was written in the hackathon window, starting 2026-10-31, after the 2026-10-19 announcement. It builds on [ShareExact](https://github.com/shareexact/shareexact), the same author's earlier project: its `ExactTransfer` contract and SDK (MIT) predate this hackathon and are not part of this entry: `StockExact` tokens call a deployed `ExactTransfer`, and no ShareExact code is copied here.

## Libraries

near-sdk 5.30; omni-transaction 0.5 (`evm` feature) for EIP-1559 serialization; viem 2.21 and near-api-js 4.0 in the agent; zod for validation; vitest. The planner can use NEAR AI Cloud through its OpenAI-compatible API (`https://cloud-api.near.ai/v1`).

## License

MIT. See [LICENSE](LICENSE).

---

ShareExact is an independent project and is not affiliated with, endorsed by, or officially connected with Robinhood Markets, Inc. Testnet tokens have no monetary value.
