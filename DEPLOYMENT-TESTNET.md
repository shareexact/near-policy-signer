# Testnet deployment (Nov 2 2026)

The contract, deployed at commit 88e06a6 and upgraded on Nov 6 to the reproducible build of a3ac91e, is on NEAR testnet and drives native ETH transfers on Robinhood Chain testnet
(chain id 46630) through the NEAR MPC signer. Testnet only; no mainnet account or chain was used.
All times are MST (UTC-7) on Mon Nov 2 2026 unless a row says otherwise. Every hash in rows 1 to 25 was re-read on RPC after the run; all are final and successful. Row 26 was signed on Nov 3 from the owner page, which then read `get_chain` back (see open item 3).

- Contract wasm: built from this commit with `cargo near build non-reproducible-wasm` (sha256 of the local build
  `6b903d6c47211006de2885f4a146f918da5d399695d48d1988742687a70e81c6`); on-chain code_hash `8EtC2o7j51xd7ESB6vJJLCA18CPytCcmZ6HETqcSPows`.
- Agent config used for the demo: [`agent/agent.config.testnet.json`](agent/agent.config.testnet.json)
  (run the CLI with `AGENT_CONFIG=agent.config.testnet.json`).
- How the owner transactions were signed: [WALLET-SIGNING.md](WALLET-SIGNING.md). Commands: [USER-COMMANDS.md](USER-COMMANDS.md).

## Accounts

| Role | Account / address |
|---|---|
| Owner (signs in Meteor Wallet) | `aa5hr.testnet` |
| Funding / parent account | `shareexact-chainsig-demo.testnet` |
| Policy contract | `policy-v1.shareexact-chainsig-demo.testnet` |
| Agent | `agent-v1.shareexact-chainsig-demo.testnet` |
| MPC signer | `v1.signer-prod.testnet`, path `robinhood-46630-1` |
| Derived 46630 address of policy-v1 | `0xc86A2A2F3FB5a3ac4FcB18076803c76D97AAc43F` |
| Deployer / demo recipient "alice" (46630) | `0x0C7F5b0f2cbA6a576F92f60205e87F4D28080490` |

## Transactions, in order

| # | Time | Chain | Hash | Signer (key) | Purpose | Status |
|---|---|---|---|---|---|---|
| 1 | 12:47:33 PM | NEAR | `7qbBUyCS4zYNSKQXqLcQPq14W5KxdWWCUL5zHKDwqbcj` | shareexact-chainsig-demo.testnet (AyRg...) | Transfer 1 NEAR to aa5hr.testnet (owner gas) | SuccessValue, block 275944568 |
| 2 | 1:47:28 PM | NEAR | `QEM9k9tBWsyoysusnmmp2ymzxWq1WAeeT8UdtK11L2M` | shareexact-chainsig-demo.testnet (AyRg...) | Transfer 6 NEAR to aa5hr.testnet | SuccessValue, block 275950840 |
| 3 | 3:08:25 PM | NEAR | `6VatiUd8iDh9mHu6JmorSvRgZrhLyCUMQYzmbEBJQ2Sy` | aa5hr.testnet (9k4y..., Meteor) | User top-up: 4 NEAR to shareexact-chainsig-demo.testnet | SuccessValue, block 275959354 |
| 4 (1a) | 3:09:53 PM | NEAR | `DKkBH1wwEyk5RGJDaeNFLZba7pr845dcxi3He77rA7qb` | shareexact-chainsig-demo.testnet (AyRg...) | CreateAccount policy-v1, Transfer 4.9 NEAR, AddKey full access (temporary key 1) | SuccessValue, block 275959501 |
| 5 (1b) | 3:10:03 PM | NEAR | `4CPurE3EvcvPJaqHJv6PLaADzsikjX7syo79AxYuXhtg` | shareexact-chainsig-demo.testnet (AyRg...) | CreateAccount agent-v1, Transfer 1.9 NEAR, AddKey full access (temporary key 2) | SuccessValue, block 275959521 |
| 6 (B1) | 3:10:58 PM | NEAR | `AUpSYgJ8tpGcvuZC741N2UL9SgmEAPS3gQ4Kco6t47Fj` | policy-v1 (key 1) | DeployContract (exact 88e06a6 wasm) + `new` (owner aa5hr.testnet, signer v1.signer-prod.testnet, path robinhood-46630-1) | SuccessValue, block 275959613 |
| 7 (B2) | 3:11:36 PM | NEAR | `BrsSE5DBW5jRWsweXap8dyQqLSBgvrQcCHxUYm1CrmEu` | policy-v1 (key 1) | DeleteKey key 1: contract account now has no keys | SuccessValue, block 275959677 |
| 8 (B3) | 3:12:02 PM | NEAR | `mNYTqf2eXxdtpUexryukrbDpuoXP9Avxo6rtNkethLm` | agent-v1 (key 2) | AddKey function-call key 3 (receiver policy-v1, method `request`, allowance 1 NEAR) | SuccessValue, block 275959727 |
| 9 (B4) | 3:12:22 PM | NEAR | `46GsdcwHBLJhsJN23ygkj23ct1XzEsWcLVizd8KqF5Wg` | agent-v1 (key 2) | DeleteKey key 2: only FC key 3 remains | SuccessValue, block 275959765 |
| 10 | 3:34:29 PM | NEAR | `HyYhJEpTQuPpY3LQrhWpmeR3jxu4bjQWXuoFWsjwgy3A` | aa5hr.testnet (9k4y...) | AddKey full access `ed25519:CY9aCwrmVaPMzMJLbxAxFGwGhEKgSgar5UKuVqLGZcaQ` on the owner account. Not part of the deployment; see open items | SuccessValue, block 275962123 |
| 11 (U3.1) | 3:41:28 PM | NEAR | `7AqrT3EwKu3QHUaQRWmDjkPCZ7mJJLqiuLvSTjG2f6mL` | aa5hr.testnet (9k4y..., Meteor) | `add_agent` agent-v1 (demo agent, 20/day) | SuccessValue, block 275962857 |
| 12 (U3.2) | 3:41:30 PM | NEAR | `7jqR9iNXJw9WD6xi1fhbFJ3Qij9aeWUtcVFWU8yMjgH4` | aa5hr.testnet (9k4y...) | `set_chain` 46630 (max fee 1 gwei, tip 0.1 gwei, gas 200000, `exact_transfer` `0x2cbaedbf...fd8e`, unknown recipients need approval; that address is not an ExactTransfer, see open item 3) | SuccessValue, block 275962861 |
| 13 (U3.3) | 3:41:32 PM | NEAR | `C15zkaqLfkeBZiWseuF9QXF2CtfsLaAtGjQe5mhd8SfV` | aa5hr.testnet (9k4y...) | `set_token` native ETH (1e15 per request, 5e15 per day, approval above 5e14) | SuccessValue, block 275962864 |
| 14 (U3.4) | 3:41:34 PM | NEAR | `HEDWxNHvjbfyiHwPPSK9r7BaMdmpZnhKWrXXaM4sRL1Q` | aa5hr.testnet (9k4y...) | `set_recipient` alice allowed | SuccessValue, block 275962867 |
| 15 | 3:46:33 PM | 46630 | `0xc902a98e99402231ad7338ad3ef8b426b81b520d6c3e40ee147c9ab9d3f8a68b` | deployer 0x0C7F...0490 (nonce 8) | Fund 0xc86A with 0.0018 ETH | status 0x1, block 147325820, gasUsed 21000, price 10000000 wei |
| 16 (8.2) | 3:47:26 PM | NEAR | `CQ5cihQx3pBsoRLcTUqCRMVBukdHPCjoncgJ9WSraXPQ` | agent-v1 (FC key 3) | `request` 0.0004 ETH to alice: SIGNED, request_id 1, 46630 nonce 0 | SuccessValue, block 275963453 |
| 17 (8.2) | 3:55:31 PM | 46630 | `0x270f77ca80c07a2ef0c2cd4e28838a6f8b35d649eba659f468a183b85a6b510c` | 0xc86A (MPC signature from #16), nonce 0 | 0.0004 ETH to alice. Broadcast once by hand (see note 3) | status 0x1, block 147329949, gasUsed 21000, price 10000000 wei |
| 18 (8.3) | about 3:56 PM | none | no transaction | agent CLI | `send 0.002 ETH`: refused `AmountCapExceeded` at the read-only preview; the agent key nonce did not change | refused, nothing signed |
| 19 (8.4) | 3:56:40 PM | NEAR | `BE3AfBTFjSB3XkwGJntEkKwfe4Z39HzSNBLWfDKx9rg1` | agent-v1 (FC key 3) | `request` 0.0008 ETH: PENDING_APPROVAL, ticket 1 | SuccessValue, block 275964441 |
| 20 (8.4) | 4:41:43 PM | NEAR | `G4vGHLGNerxLVdM2v3JBsF4DuMjbDygJxYYoxBkyrR2J` | aa5hr.testnet (9k4y..., Meteor) | `approve_ticket` 1 | SuccessValue, block 275969110 |
| 21 (8.4) | 4:43:19 PM | NEAR | `9tbbDUhiPLiUt4k14MbcfB2jRnhYMN9fVjksfnf6APb1` | agent-v1 (FC key 3) | `request` with ticket 1: SIGNED, request_id 2, 46630 nonce 1 | SuccessValue, block 275969278 |
| 22 (8.4) | 4:44:22 PM | 46630 | `0xc9ece954844ce74921104ee2ba88e7664a1ba57bd1b7edf582074ab194ddce1a` | 0xc86A (MPC signature from #21), nonce 1 | 0.0008 ETH to alice | status 0x1, block 147351894, gasUsed 21000, price 10000000 wei |
| 23 (8.5) | 5:04:25 PM | NEAR | `7Gvoi8dei739fGF5XaR7aMYr3UZ2NeRiSkucpPp6Pttp` | aa5hr.testnet (9k4y..., Meteor) | `set_paused` true | SuccessValue, block 275971480 |
| 24 (8.5) | about 5:06 PM | none | no transaction | agent CLI | `send 0.0004 ETH` while paused: refused `Paused` at the read-only preview; agent key nonce unchanged | refused, nothing signed |
| 25 (8.5) | 5:07:29 PM | NEAR | `GAJySQeS5z5ZcruUHMoFMv1jzELcfp1FWXsTo6SFeTx4` | aa5hr.testnet (9k4y..., Meteor) | `set_paused` false | SuccessValue, block 275971796 |
| 26 | Tue Nov 3 | NEAR | `CJ7H1U4jcRGWPANrJ4uKMLXeUfW1JvATUhwH2SKqhw2E` | aa5hr.testnet (9k4y..., Meteor) | `set_chain` 46630 with `exact_transfer` null, every other field unchanged ([`wallet-page-chain-fix/`](wallet-page-chain-fix/)); see open item 3 | signed in Meteor; get_chain then read `exact_transfer: null`, other fields unchanged |
| 27 | Wed Nov 4, 6:50:11 AM | NEAR | `3H6Yd7dbfdTz3iPz9qUjioz4ApqxRfuuWdKasKcy23Gm` | aa5hr.testnet (9k4y..., Meteor) | `propose_upgrade` sha256 `c166e5635d8df6d25528acfa611c8ee81228650dced0b2f6a986ef6687d95e5a` (release `policy-signer-wasm-a3ac91e`); event `upgrade_proposed`, `executable_at` 1793973011 = Fri Nov 6, 6:50:11 AM MST ([`wallet-page-upgrade/`](wallet-page-upgrade/)); see open item 4 | Success, block 276203160 |
| 28 | Fri Nov 6, 6:53:19 AM | NEAR | `DJDfYoJpDaEs7unEUHLsXPkk2u7st7HkCDsbLwXmjjPW` | aa5hr.testnet (9k4y..., Meteor) | `apply_upgrade` with the release wasm (sha256 `c166e563...`); the follow-up receipt deployed it and ran `migrate`; `view_account` then shows code hash `E1xgsbWL3TwTefBKFAUdLoKiuYME2zEw938T8ycsnbPF` ([`wallet-page-upgrade/`](wallet-page-upgrade/)) | signed in Meteor; the upgrade page then read code hash `E1xgsbWL...` from `view_account` and no pending upgrade |
| 29 | Fri Nov 6, 6:54:03 AM | NEAR | `8KzSo5hFA9vBbsfwK6NoZ2AeJ7mnXW4dGQueoUzQeEcC` | aa5hr.testnet (9k4y..., Meteor) | `set_params`: `policy_delay_s` 3600, every other parameter unchanged ([`wallet-page-upgrade/`](wallet-page-upgrade/)) | signed in Meteor; `get_config` then read `policy_delay_s` 3600, other parameters unchanged |
| 30 | Fri Nov 6, 7:28:50 AM | NEAR | `9aSU9vtuXgxudGwcRJ81PeuEKdPhfdnhxrCW7gU6dJuC` | aa5hr.testnet (9k4y..., Meteor) | `set_recipient` 46630 bob `0xb0b0000000000000000000000000000000000b0b` true: scheduled, not applied (`change_scheduled`, `executable_at` an hour later) ([`wallet-page-owner/`](wallet-page-owner/)) | signed in Meteor; the owner page then read scheduled change 1, allow bob, `executable_at` Fri Nov 6, 8:28:50 AM MST |
| 31 | Fri Nov 6, 7:29:46 AM | NEAR | `4hE5mRZvCSU8PJBbbRGXD8wYfzydMoECzicYsepfcb7p` | aa5hr.testnet (9k4y..., Meteor) | `cancel_change` for that change (`change_cancelled`); bob was never allowed ([`wallet-page-owner/`](wallet-page-owner/)) | Success, block 276498731; event `change_cancelled` for change 1 (`AllowRecipient` 46630 bob) |

Explorer links: NEAR `https://testnet.nearblocks.io/txns/<hash>`, 46630 `https://explorer.testnet.chain.robinhood.com/tx/<hash>`.

## Final state (read Nov 2, about 5:16 PM MST)

| Account | Balance (yoctoNEAR) | Code hash | Access keys |
|---|---|---|---|
| aa5hr.testnet | 2998345098935080099999993 (about 2.998 NEAR) | none | FullAccess `9k4yvZ8M7yezqHa6yzDoKr1m9nfv8HER5Bux9NUEmgYf`, FullAccess `CY9aCwrmVaPMzMJLbxAxFGwGhEKgSgar5UKuVqLGZcaQ` |
| shareexact-chainsig-demo.testnet | 184875850066995699999999 (about 0.185 NEAR) | none | FullAccess `AyRgxqiAmo9M1W77wQMB6NQHLtrGcECiCgUCfUnnQPPJ` |
| policy-v1.shareexact-chainsig-demo.testnet | 4897092598570197400000005 (about 4.897 NEAR), storage 371896 bytes | `8EtC2o7j51xd7ESB6vJJLCA18CPytCcmZ6HETqcSPows` | none (empty list) |
| agent-v1.shareexact-chainsig-demo.testnet | 1896594707148114600000000 (about 1.897 NEAR) | none | FunctionCall `F6TZxxYhxXHvJdVWVkjnyBPm6JzqKdANfNwxw1eM9aAG`: receiver policy-v1, methods `request`, allowance left 996677366878644200000000 |

46630: `0xc86A2A2F3FB5a3ac4FcB18076803c76D97AAc43F` 599580000000000 wei (0.00059958 ETH), nonce 2.
Alice `0x0C7F5b0f2cbA6a576F92f60205e87F4D28080490` 1368579830000000 wei, nonce 9.

Derived address check: `v1.signer-prod.testnet`'s `derived_public_key` view (predecessor policy-v1, path `robinhood-46630-1`, used by
`npm run cli -- address`) and an offline derivation from the signer's root public key both give `0xc86A2A2F3FB5a3ac4FcB18076803c76D97AAc43F`; both 46630 sends recovered to it.

`get_config` on Nov 2: version 1, owner aa5hr.testnet, proposed_owner null, signer v1.signer-prod.testnet, path robinhood-46630-1, network Testnet,
paused false, sign_gas_tgas 50, approved_ticket_ttl_s 900, pending_ticket_ttl_s 86400, policy_delay_s 0, no pending upgrade. (Since Nov 6: policy_delay_s 3600, transaction 29.)

`get_status {"chain_id":46630,"token":"0x0000000000000000000000000000000000000000"}`:

```
{"paused":false,"next_nonce":2,"last_signed_nonce":1,"in_flight":null,"chain":{"max_fee_per_gas":"1000000000","max_priority_fee_per_gas":"100000000","max_gas_limit":"200000","exact_transfer":"0x2cbaedbf8bf46600cf311c7065f901aad973fd8e","unknown_recipients_need_approval":true},"token":{"kind":"Native","max_per_request":"1000000000000000","max_per_day":"5000000000000000","approval_above":"500000000000000"},"cap_unit":"wei","spent_today":"0","remaining_today":"5000000000000000","requests_today":0,"max_requests_per_day":50,"open_tickets":0}
```

`spent_today` and `requests_today` read 0 because the contract day rolled over at 5:00 PM MST (00:00 UTC); 1.2e15 wei was spent on Nov 2 UTC.

## Notes on this deployment

1. Account names. The contract and agent accounts are sub-accounts of `shareexact-chainsig-demo.testnet`, not of the owner.
   Meteor Wallet refuses dApp requests that add a full-access key, so the owner could not sign the account creation. The
   accounts were created and set up from a CLI keychain instead; the owner stays `aa5hr.testnet`, and only owner calls are
   signed in the wallet.
2. 46630 funding was 0.0018 ETH, enough for the two demo sends (0.0012 ETH) plus two transactions at the worst-case fee cap.
3. Nonce 0. The first transfer from a fresh derived address uses EVM nonce 0. viem's `parseTransaction` returns
   `nonce: undefined` for it, so the agent's post-signing check refused a correctly signed transaction (fixed in this commit,
   with a test). For #17 the same MPC signature was rebuilt from the on-chain outcome of #16 with `assemble`, checked
   (hash, recovered signer, chain id, nonce, value, recipient, account nonce) and broadcast once with `eth_sendRawTransaction`.
   No second signature was requested.
4. Owner calls used 30 Tgas each (the console uses 100 Tgas); all succeeded.
5. #22 was broadcast by the agent CLI itself (`send ... --ticket 1 --broadcast`), with `allowBroadcast` set to true for the run as USER-COMMANDS.md describes and set back to false afterwards, which is how the committed config reads.

## Open items

1. The owner account `aa5hr.testnet` has a second full-access key, `ed25519:CY9aCwrmVaPMzMJLbxAxFGwGhEKgSgar5UKuVqLGZcaQ`,
   added at 3:34:29 PM by `HyYhJEpTQuPpY3LQrhWpmeR3jxu4bjQWXuoFWsjwgy3A`. No transaction in this deployment was signed with it
   (all owner transactions used `ed25519:9k4yvZ8M7yezqHa6yzDoKr1m9nfv8HER5Bux9NUEmgYf`). It is scheduled for removal.
2. `allowBroadcast` is `false` for 46630 in the testnet config; enable it only for a planned demo.
3. `exact_transfer` on chain 46630 was set on Nov 2 to `0x2cbaedbf8bf46600cf311c7065f901aad973fd8e`, which is not ShareExact's
   `ExactTransfer`; no `ExactTransfer` is deployed on Robinhood Chain testnet. It had no effect on this deployment, which registers
   only native ETH. It was cleared on Nov 3 by transaction 26, one owner call, `set_chain` with `exact_transfer: null` and every other field
   unchanged, signed in [`wallet-page-chain-fix/`](wallet-page-chain-fix/). The contract now refuses to register a `StockExact`
   token on 46630.
4. Upgrade to the current code, done. The deployment ran 88e06a6, from before `propose_owner` went through the policy delay. The upgrade goes through the contract's own timelock with [`wallet-page-upgrade/`](wallet-page-upgrade/): `propose_upgrade` for the reproducible build of commit a3ac91e (release `policy-signer-wasm-a3ac91e`, sha256 `c166e5635d8df6d25528acfa611c8ee81228650dced0b2f6a986ef6687d95e5a`), `apply_upgrade` at least 48 hours later, then `set_params` with `policy_delay_s` 3600. Proposed on Nov 4 (transaction 27); it can be applied from Fri Nov 6, 6:50:11 AM MST (13:50:11 UTC). Applied on Nov 6 (transaction 28); the 1-hour policy delay turned on (29); a change scheduled under it and cancelled (30, 31).
