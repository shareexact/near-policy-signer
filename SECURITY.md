# Security model and operating limits

This document states what the policy signer protects against, what it does not, and what an operator must do for the protections to hold. The README links here; nothing below is repeated there.

## Deployment rules (the protections depend on these)

1. **Deploy and initialize in one transaction.** `new` is private and also checks the caller in its body. Deploy with the init call attached (`cargo near deploy build-non-reproducible-wasm <account> with-init-call new ...`), so nobody can initialize the contract first with their own owner.
2. **Delete every access key on the contract account after deployment.** The MPC network derives the signing key from the calling account and the path. Any key left on the contract account can call the MPC `sign` method directly, with any payload, and get a valid signature for the contract's EVM address without any policy check. List the account's keys afterwards: the list must be empty.
3. **Never delete the contract account.** The derived EVM address depends only on the account id and the path. Whoever re-creates the name controls the address.
4. **The path is fixed at initialization.** There is no setter, because changing it would change the EVM address.
5. **Use a separate owner account, and keep its full-access key offline when you can.** Every owner method, and `accept_owner`, requires exactly 1 yoctoNEAR, so a function-call key on the owner account (for example a dapp login key) cannot change policy.
6. **Give each agent account a function-call key restricted to `request` on the contract, with a finite allowance.** Each call needs the gas it attaches covered up front (about 0.015 NEAR at 150 Tgas and the minimum gas price), refused calls included; unused gas is refunded to the allowance. Keep the agent's `requestGasTgas` at least the contract's sign gas plus 40 Tgas, or requests fail for lack of gas.

## Threat model

| Actor | Can | Cannot |
|---|---|---|
| Compromised or hallucinating agent | Send requests; lie about a Stock Token's multiplier or pending change; collect signatures within its limits; fill the approval queue up to `max_open_tickets`; use up the global daily request limit with fee bumps | Get a signature for a transaction the contract did not build; send to a recipient or token that is not allowlisted; exceed a token's per-request or daily cap, or its own per-agent cap, in the token's unit; skip the approval step above the soft limit; change policy, pause, approve tickets or upgrade |
| Compromised owner key | Approve queued tickets, pause and resume, remove, sign approves and burns (fees bounded), schedule policy changes and an ownership transfer, propose an upgrade. With `policy_delay_s` at 0 (the default, and the testnet deployment) every policy change also applies at once | With `policy_delay_s` set: loosen policy (new recipient, higher cap, new agent, shorter windows) or make its holder the proposed owner before the delay has passed since the `change_scheduled` event. Apply an upgrade before `upgrade_delay_s` (48 hours by default, never lowered) has passed since `upgrade_proposed`. The legitimate owner can `cancel_change` and `cancel_upgrade` in the meantime |
| Faulty or hostile MPC response | Return an error or a garbage signature | Make the contract sign something else: the agent rejects any signature that does not recover to the contract's derived address, and checks the payload hashes to the contract's sighash |
| Hostile token contract | Misreport its own multiplier to the agent | Change what the contract counts: caps are always in the unit the calldata carries (see below) |
| Anyone else | Call `request` (refused as `AgentNotAllowed`, at their own gas cost) and the views | Anything that changes state |

### Why caps cannot be shrunk by a false observation

Every token has one kind and one budget, in the unit that appears in the signed calldata:

| Kind | Calldata | Cap unit | Why it holds |
|---|---|---|---|
| `Plain` | `transfer(to, raw)` | raw | The raw amount is the amount moved |
| `StockDirect` | `transfer(to, raw)` | raw | Raw is computed from the observed multiplier, but the raw amount in the calldata is what moves, and that is what is counted |
| `StockExact` | `ExactTransfer.transferShares(token, to, shares, shortfall)` | shares | The chain converts shares to raw with the live multiplier at execution; the share amount is what is counted |

An earlier version accepted both modes for every Stock Token and kept a raw budget and a share budget side by side. An agent could fill the raw budget in Direct mode and the share budget in Exact mode, moving close to twice the intended amount. One kind per token removes that.

## New recipients and look-alike addresses

By default a recipient must be allowlisted. With `unknown_recipients_need_approval` on a chain, a transfer to any other address becomes a ticket in the approval queue; the owner's approval covers that one transfer and does not allowlist the address. Before either path, the contract compares the recipient with every allowlisted recipient on the chain (at most 200): if it shares the first and last four hex digits but is a different address, it is refused as `LookalikeRecipient`. That is the shape of an address-poisoning attack, where a scammer plants a look-alike address in the history so that a human, or an agent copying from history, picks it. The check does not catch every look-alike; it catches the one wallets truncate to.

## Policy delay

Set `policy_delay_s` (for example 3600) once the policy is in place; until then a stolen owner key controls the policy at once. From then on, every setter call and `propose_owner` is scheduled: it emits `change_scheduled` with the full change and its `executable_at`, and takes effect only when the owner calls `execute_change` after that time. Watch for `change_scheduled` events you did not make, and `cancel_change` them. Lowering the delay is itself a scheduled change. Removals (`remove_chain`, `remove_token`, `set_recipient(false)`, `remove_agent`), pause and resume, ticket decisions, burns and approves are immediate. So a stolen owner key can still resume a paused contract and approve queued tickets within the hard caps; the owner's response is to pause again and remove the agent, which are immediate too. The testnet deployment runs commit 88e06a6, from before `propose_owner` went through the delay; its `policy_delay_s` is 0. Tightening a cap goes through the delay too; to tighten at once, remove the token or pause.

## Operating limits, with examples

- **Signed transactions do not expire.** Daily caps limit signatures, not executions. An agent can collect signatures today and broadcast them later. To void signatures already issued: pause, read the chain's current nonce for the derived address (say 40) and the contract's `next_nonce` (say 43), then `burn_nonce` for 40, 41 and 42 with fees above any copy that may be in a mempool. Each burn is a zero-value transaction to `0x...dEaD` at that nonce. Burns may exceed the chain's fee caps by up to 3 times (gas limit at most 50,000), so they can outbid a transaction signed at the cap without letting an owner key spend the address's balance on fees.
- **In `StockExact` mode the allowance is the final bound in raw units.** A multiplier below 1.0 (after a reverse split) makes raw exceed shares. Size the `approve` for the worst case you accept.
- **A pending-change check sees only what the agent reports.** The contract cannot read Robinhood Chain state. An agent that reports `effective_at = 0` passes `MultiplierChangePending`. In `StockExact` mode `ExactTransfer` re-checks on chain and reverts; in `StockDirect` mode the raw cap still bounds the damage. Prefer `StockExact` for Stock Tokens.
- **Daily caps reset at 00:00 UTC.** Around midnight an agent can spend one day's cap just before and the next day's just after. Keep `max_per_request` well below `max_per_day` if that matters.
- **The soft limit is per request.** An agent can split a large transfer into several requests below `approval_above`; the daily cap still bounds the total.
- **A failed or timed-out signature is treated as possibly issued.** After an MPC timeout the nodes can still publish a valid signature in a late transaction. So the callback does not free the nonce for a different transfer and does not release the budget. The same agent can re-sign the identical call as a fee bump at no extra budget, or the owner can burn the nonce. The cost is that a genuine failure keeps its budget counted until the next day.
- **Fee bumps.** Only the agent that requested a transaction can fee-bump it, with the identical call and strictly higher fees within the caps.
- **Changing a token's kind mid-day** carries today's spend over in the old unit. Change kinds when the token's spend for the day is zero.
- **`clear_in_flight` is for a callback that itself failed** (for example, out of gas). MPC errors and timeouts do not need it: the callback runs, receives the error and records the request as possibly signed. Clearing releases nothing and does not advance the nonce. If the MPC did sign, the signature is public in its receipt, so void it with `burn_nonce`. A callback that arrives after clearing is logged as `late_callback`.
- **The request counter is not refunded** when signing fails. It bounds calls to the MPC network, not transfers.
- **One request at a time per chain.** A second request waits (`RequestInFlight`) until the first callback runs, normally within a few blocks.
- **Clock skew.** An observation may sit up to `max_clock_skew_s` (default 15 s) ahead of NEAR's clock, since the two chains keep separate clocks.

## Upgrades

The contract can replace its own code only through `propose_upgrade(code_hash)` then, at least `upgrade_delay_s` later (48 hours by default; it can be raised, never lowered), `apply_upgrade(code)` with code whose sha256 matches. Both steps are owner-only and emit events, so anyone monitoring the account sees an upgrade coming. `apply_upgrade` deploys the code and calls `migrate` in one receipt, announced as `upgrade_started`. If `migrate` fails, the deploy is reverted with it and the old code stays; propose again and wait the delay again. Attach generous gas (for example 300 Tgas). The code travels base64-encoded in the transaction, so the wasm must stay under about 1.1 MB. This path works after all access keys are deleted. An owner who wants the code to be permanent calls `disable_upgrades`, which is irreversible.

## Reporting a vulnerability

Please report privately to the repository owner through GitHub's private vulnerability reporting for this repository. Do not open a public issue for a security problem.
