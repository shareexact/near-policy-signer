# Security model and operating limits

This document states what the policy signer protects against, what it does not, and what an operator must do for the protections to hold. The README links here; nothing below is repeated there.

## Deployment rules (the protections depend on these)

1. **Deploy and initialize in one transaction.** `new` is private and also checks the caller in its body. Deploy with the init call attached (`cargo near deploy build-non-reproducible-wasm <account> with-init-call new ...`), so nobody can initialize the contract first with their own owner.
2. **Delete every access key on the contract account after deployment.** The MPC network derives the signing key from the calling account and the path. Any key left on the contract account can call the MPC `sign` method directly, with any payload, and get a valid signature for the contract's EVM address without any policy check. Check with `near account list-keys <account>`: the list must be empty.
3. **Never delete the contract account.** The derived EVM address depends only on the account id and the path. Whoever re-creates the name controls the address.
4. **The path is fixed at initialization.** There is no setter, because changing it would change the EVM address.
5. **Use a separate owner account, and keep its full-access key offline when you can.** Every owner method requires exactly 1 yoctoNEAR, so a function-call key on the owner account (for example a dapp login key) cannot change policy.
6. **Give each agent account a function-call key restricted to `request` on the contract, with a finite allowance.** The allowance is charged for the gas attached to every call, refused calls included. At 150 Tgas and the minimum gas price, one request costs about 0.015 NEAR, so a 1 NEAR allowance covers about 65 requests.

## Threat model

| Actor | Can | Cannot |
|---|---|---|
| Compromised or hallucinating agent | Send requests; lie about a Stock Token's multiplier or pending change; collect signatures within its limits; fill the approval queue up to `max_open_tickets` | Get a signature for a transaction the contract did not build; send to a recipient or token that is not allowlisted; exceed a token's per-request or daily cap, or its own per-agent cap, in the token's unit; skip the approval step above the soft limit; change policy, pause, approve tickets or upgrade |
| Compromised owner key | Everything the owner can do: change policy, approve tickets, sign approves and burns, propose an upgrade | Apply an upgrade before `upgrade_delay_s` (default 48 hours) has passed since the `upgrade_proposed` event |
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

## Operating limits, with examples

- **Signed transactions do not expire.** Daily caps limit signatures, not executions. An agent can collect signatures today and broadcast them later. To void signatures already issued: pause, read the chain's current nonce for the derived address (say 40) and the contract's `next_nonce` (say 43), then `burn_nonce` for 40, 41 and 42 with fees above any copy that may be in a mempool. Each burn is a zero-value transaction to `0x...dEaD` at that nonce.
- **In `StockExact` mode the allowance is the final bound in raw units.** A multiplier below 1.0 (after a reverse split) makes raw exceed shares. Size the `approve` for the worst case you accept.
- **A pending-change check sees only what the agent reports.** The contract cannot read Robinhood Chain state. An agent that reports `effective_at = 0` passes `MultiplierChangePending`. In `StockExact` mode `ExactTransfer` re-checks on chain and reverts; in `StockDirect` mode the raw cap still bounds the damage. Prefer `StockExact` for Stock Tokens.
- **Daily caps reset at 00:00 UTC.** Around midnight an agent can spend one day's cap just before and the next day's just after. Keep `max_per_request` well below `max_per_day` if that matters.
- **The soft limit is per request.** An agent can split a large transfer into several requests below `approval_above`; the daily cap still bounds the total.
- **`clear_in_flight` is for a callback that itself failed** (for example, out of gas). MPC errors and timeouts do not need it: the callback runs, receives the error and releases the reservation. Clearing releases nothing and does not advance the nonce. If the MPC did sign, the signature is public in its receipt, so void it with `burn_nonce`. A callback that arrives after clearing is logged as `late_callback`.
- **The request counter is not refunded** when signing fails. It bounds calls to the MPC network, not transfers.
- **One request at a time per chain.** A second request waits (`RequestInFlight`) until the first callback runs, normally within a few blocks.
- **Clock skew.** An observation may sit up to `max_clock_skew_s` (default 15 s) ahead of NEAR's clock, since the two chains keep separate clocks.

## Upgrades

The contract can replace its own code only through `propose_upgrade(code_hash)` then, at least `upgrade_delay_s` later (default 48 hours, floor 24 hours), `apply_upgrade(code)` with code whose sha256 matches. Both steps are owner-only and emit events, so anyone monitoring the account sees an upgrade coming. `apply_upgrade` deploys the code and calls `migrate`. This path works after all access keys are deleted. An owner who wants the code to be permanent calls `disable_upgrades`, which is irreversible.

## Reporting a vulnerability

Please report privately to the repository owner through GitHub's private vulnerability reporting for this repository. Do not open a public issue for a security problem.
