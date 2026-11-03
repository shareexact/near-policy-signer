# Roadmap

Where the policy signer goes after the hackathon. Each step keeps the two rules that make it what it is: the agent never holds a key, and every owner runs their own instance.

## Who it is for

- **Teams running trading, treasury or payment agents** that need an agent to move money without handing it a hot wallet.
- **Agent frameworks** that want a safe default for "give the agent a budget".
- **Stock Token holders on Robinhood Chain**, where share units move with every dividend and split and a wrong number is easy to sign.

## Done in this version

- **Wallet approvals in the console (testnet).** The owner connects a NEAR wallet (MyNearWallet, Meteor or HERE) and approves, rejects, pauses, burns and executes or cancels scheduled changes from the browser. The page signs only when the connected account is the contract's owner and the contract is a `.testnet` account; otherwise it shows the near-cli command.

- **Live testnet deployment.** The contract runs on NEAR testnet and signs native transfers on Robinhood Chain testnet through the MPC network: signed, refused, queued and approved, and paused requests, all with hashes in [DEPLOYMENT-TESTNET.md](DEPLOYMENT-TESTNET.md).

## Next: from hackathon entry to daily tool

| Step | What | Why it matters to a user |
|---|---|---|
| Sandbox integration tests | The full request, sign and callback path with the mock signer in near-workspaces, in CI | The NEAR integration is proven on every commit |
| Alerts | Notify the owner (email or Telegram) on every `escalated`, `change_scheduled`, `upgrade_proposed` and refusal spike, and before a Stock Token's unit change | The owner hears about anything that needs them, without watching a dashboard |

## Then: breadth

| Step | What |
|---|---|
| Audit export | Index the contract's events into a monthly CSV and JSON report: every request, refusal reason, signature, ticket decision and policy change, with links on both chains |
| Agent packages | Publish the TypeScript client on npm and an MCP server exposing `preview`, `request` and `status`, so any agent framework can use the signer without a key |
| More chains | The contract is chain-agnostic for EVM; add tested presets for Base, Arbitrum and Ethereum testnets, then non-EVM chains the MPC network signs for |
| Deploy factory | One-click deployment of an instance owned by the caller, with no control kept by the factory |
| Recipient labels and rate windows | Named recipients in events, and rolling 24 hour windows instead of UTC days |

## A front door: one site, two ways to send

Today the policy signer is reached through this repository. The plan is a public landing page on shareexact.com that explains what ShareExact does and offers two paths:

| Path | For | Where it goes |
|---|---|---|
| Send it myself | A person sending Stock Tokens by share count | The existing ShareExact desk |
| Let an agent send within my limits | An owner giving an agent a budget | This console, on testnet until the mainnet steps below are done |

Both paths settle on Robinhood Chain first. The page is built so that more chains can be added as paths later:

- **Base.** EVM, so the contract already builds and signs for it: `Plain` and `Native` tokens work with a chain policy and Base testnet presets. Stock Token kinds do not apply there.
- **Solana.** Needs Ed25519 signing from the MPC network (a separate signature domain) and Solana transaction construction in the contract, a separate token model and new refusals. A substantial contract change, planned after the EVM paths are stable.

The landing page and the console's move to the site wait until the site's current review period is over; until then, nothing on shareexact.com changes.

## Before mainnet

Mainnet is a separate decision. Before it: an external security review of the contract, fuzzing of the refusal boundaries, a bug bounty, and a mainnet deployment on fresh accounts with `v1.signer` and a new path. No testnet key or address is reused.
