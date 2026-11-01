# ShareExact policy signer for NEAR

An AI agent that can move Stock Tokens should never hold a key.

This repository is a NEAR HACKATHON entry and the NEAR control plane for ShareExact. The agent holds only a NEAR function-call key. The contract builds the exact Robinhood Chain transaction itself, checks it against the owner's policy and the share unit, and only then asks the NEAR MPC network for a signature through Chain Signatures. **The signed payload is exactly the payload the policy checked.** When the agent gets the number wrong (shares instead of raw units, a stale multiplier, a pending split, an amount over the cap), the contract refuses with a named reason and nothing is signed.

**Why NEAR:** the agent holds no key; only the NEAR contract can obtain an MPC signature, and only for a transaction it built and checked itself.

**How it extends ShareExact:** ShareExact already enforces exact share delivery on Robinhood Chain. This contract adds a policy layer for any agent allowed to move those tokens: a control that does not depend on the agent being correct, with daily caps, allowlists and an onchain refusal log.

## What is in this repository

All code here was written in the hackathon window. It builds on [ShareExact](https://github.com/shareexact/shareexact)'s `ExactTransfer` contract and SDK (MIT), which predate this hackathon and are not part of this entry. Exact mode calls a deployed `ExactTransfer`; no ShareExact code is copied here.

| Path | What it is |
|---|---|
| `policy-signer` | C1. Rust NEAR contract: policy, refusals, EIP-1559 construction, MPC `sign` call and callback |
| `mock-signer` | C7. Mock MPC signer with the same `sign` shape, for sandbox tests without keys or funds. Its signatures do not recover and must never be broadcast |

Planned, not in this repository yet: the agent runtime (C2), the AI planner (C6) and an owner-gated mock Stock Token for testnet (C5).

## Request flow

1. The agent reads `uiMultiplier()`, `newUIMultiplier()` and `effectiveAt()` from the token and calls `request` with what it saw, the block it saw it at, the shares to send and the fees.
2. C1 checks the request against the owner's policy. Any failure returns a named refusal, logs a `refused` event and asks for nothing.
3. C1 reserves the nonce and the daily budget, builds the EIP-1559 transaction from the checked fields, hashes it and calls the MPC `sign` method from its own balance. The agent never supplies calldata or a hash.
4. The callback either records the signature (`signed` event, returned to the caller) or releases the reservation (`sign_failed`).
5. The agent assembles the raw transaction, recovers the signer locally, checks it is C1's derived address, and broadcasts.

C1 cannot read Robinhood Chain state; NEAR Chain Signatures is outbound only. It checks the agent's observation for completeness, age and consistency. In **Exact** mode the transaction calls ShareExact `ExactTransfer.transferShares`, which re-reads the multiplier at execution, so even a false observation cannot change the shares delivered. In **Direct** mode a plain ERC-20 `transfer` is bounded by caps and allowlists only.

## Refusals

Where a refusal means the same condition as a ShareExact contract error, it uses the same name. The predicates for a pending unit change match `unitChangeImminent` in `@shareexact/sdk` and `ShareExactGuard`.

| Refusal | Same name as | Condition |
|---|---|---|
| `ChainNotAllowed` | | Chain not allowlisted. Robinhood Chain mainnet (4663) can never be allowlisted on a `.testnet` signer |
| `TokenNotAllowed` | | Token not allowlisted, or not an address |
| `RecipientNotAllowed` | | Recipient not allowlisted, or not an address |
| `ModeNotAllowed` | | Exact mode on a chain with no `ExactTransfer` configured |
| `ObservationIncomplete` | | `new_multiplier`, `effective_at` or the block timestamp missing. Fails closed |
| `StaleObservation` | | Observation older than `max_observation_age_s` (default 120 s) or more than `max_clock_skew_s` (default 15 s) ahead of NEAR's clock |
| `UnitUnavailable` | `ExactTransfer.UnitUnavailable` | Multiplier is zero |
| `ObservationCrossedChange` | | A scheduled change took effect after the observation was taken |
| `MultiplierChangePending` | `ExactTransfer.MultiplierChangePending` | A change is scheduled within `corp_action_window_s` (default 7200 s, floor 600 s) |
| `ZeroAmount` | `ExactTransfer.ZeroAmount` | Zero shares, or a request that floors to zero raw units |
| `ShareShortfall` | `ExactTransfer.ShareShortfall` | Floor rounding loses more than `max_shortfall` |
| `AmountCapExceeded` | | Over the per-request or per-day raw cap for the token |
| `GasCapExceeded` | | Fees or gas limit over the chain's caps |
| `InvalidFees` | | Priority fee above max fee, or zero gas limit |
| `RequestInFlight` | | A request on this chain is still waiting for the MPC signer |
| `NonceOutOfOrder` | | Not the next nonce and not a valid replacement |
| `InvalidReplacement` | | Same nonce as the last signed transaction, but a different call or fees not strictly higher |
| `RequestCapExceeded` | | Daily request cap reached |

## Trust model

| Actor | Can | Cannot |
|---|---|---|
| Agent account (function-call key for `request` only) | Submit requests, read views | Change policy, request an `approve`, attach deposits, get a signature for a transaction C1 did not build |
| Owner (separate full-access account) | Set allowlists, caps and parameters; request the capped `approve` Exact mode needs | n/a; the owner is trusted |
| MPC network | Sign for C1's derivation path | Sign for C1's path without a call from C1 |
| Compromised agent | Lie about the multiplier; collect signatures within caps | In Exact mode, change the shares delivered or exceed the allowance. In both modes, exceed caps or use a token or recipient that is not allowlisted |

Stated limits a user must know:
- Signed EVM transactions do not expire, so daily caps limit signatures, not executions. In Exact mode the `approve` allowance is the hard spending bound.
- The request counter is not released when signing fails; it bounds MPC calls, not transfers.
- **Never delete the C1 account.** The derived EVM address depends only on the account id and the path, so whoever re-creates the name controls the address.
- The owner, agent and contract must be three different accounts; `new` enforces this.
- If the callback itself fails (for example, out of gas), the owner can clear the in-flight request. Clearing does not release budget or advance the nonce. MPC errors and timeouts do not need this: the callback handles them.

## Run the tests

No keys, funds or network needed. These are unit tests; the near-workspaces sandbox tests with the mock signer are planned and not in this repository yet.

```sh
cargo test
```

Expected result: `policy-signer` 46 passed, `mock-signer` 4 passed. The tests cover every refusal above, reservation and release, the replacement rule, access control, and EIP-1559 encoding. The encoding tests compare C1's output byte for byte with transactions serialized by viem 2.21.0 (`serializeTransaction`, chain 46630).

## Build for NEAR

```sh
rustup target add wasm32-unknown-unknown
cargo install cargo-near
cd policy-signer && cargo near build non-reproducible-wasm
cd ../mock-signer && cargo near build non-reproducible-wasm
```

## Deploy to NEAR testnet (not yet done)

Nothing in this repository has been deployed. The steps below are the plan for gate G1.

1. Create three testnet accounts: the contract, a separate owner and a separate agent.
2. Deploy and initialize:
   `new({"owner":"<owner>","agent":"<agent>","signer":"v1.signer-prod.testnet","path":"robinhood-46630-1"})`
3. As the owner: `set_chain(46630, ...)`, `set_token(...)`, `set_recipient(...)`.
4. Read the MPC contract's live sign gas requirement and call `set_sign_gas` if it is above 50 Tgas.
5. Give the agent account a function-call access key restricted to `request` on the contract, with a finite allowance.
6. Fund the contract with testnet NEAR (1 yoctoNEAR per signature plus storage).
7. Derive C1's EVM address from the MPC contract (`derived_public_key` for the contract account and the path) and fund it with Robinhood Chain testnet ETH.

To confirm at G1: that the `sign` argument shape (`request.payload_v2.Ecdsa`, `path`, `domain_id`) and the response shape are accepted when the caller is a contract.

## Libraries

near-sdk 5.30, omni-transaction 0.5 (Apache-2.0, `evm` feature only) for EIP-1559 serialization, viem 2.21 (test vectors only). ShareExact's `ExactTransfer` and `@shareexact/sdk` are the same author's earlier work (MIT), used as an external dependency.

---

ShareExact is an independent project and is not affiliated with, endorsed by, or officially connected with Robinhood Markets, Inc. Testnet tokens have no monetary value.
