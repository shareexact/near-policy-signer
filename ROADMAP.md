# Roadmap

Where the policy signer goes after the hackathon. Each step keeps the two rules that make it what it is: the agent never holds a key, and every owner runs their own instance.

## Who it is for

- **Teams running trading, treasury or payment agents** that need an agent to move money without handing it a hot wallet.
- **Agent frameworks** that want a safe default for "give the agent a budget".
- **Stock Token holders on Robinhood Chain**, where share units move with every dividend and split and a wrong number is easy to sign.

## Next: from hackathon entry to daily tool

| Step | What | Why it matters to a user |
|---|---|---|
| Live testnet deployment | Contract on NEAR testnet, a funded derived address on Robinhood Chain testnet, addresses in the README | Anyone can watch a real request get refused or signed |
| Sandbox integration tests | The full request, sign and callback path with the mock signer in near-workspaces, in CI | The NEAR integration is proven on every commit |
| Wallet approvals in the console | Approve, reject, pause and burn from a NEAR wallet in the browser, instead of copying commands | The approval queue becomes a phone-friendly daily habit |
| Alerts | Notify the owner (email or Telegram) on every `escalated`, `change_scheduled`, `upgrade_proposed` and refusal spike, and before a Stock Token's unit change | The owner hears about anything that needs them, without watching a dashboard |

## Then: breadth

| Step | What |
|---|---|
| Audit export | Index the contract's events into a monthly CSV and JSON report: every request, refusal reason, signature, ticket decision and policy change, with links on both chains |
| Agent packages | Publish the TypeScript client on npm and an MCP server exposing `preview`, `request` and `status`, so any agent framework can use the signer without a key |
| More chains | The contract is chain-agnostic for EVM; add tested presets for Base, Arbitrum and Ethereum testnets, then non-EVM chains the MPC network signs for |
| Deploy factory | One-click deployment of an instance owned by the caller, with no control kept by the factory |
| Recipient labels and rate windows | Named recipients in events, and rolling 24 hour windows instead of UTC days |

## Before mainnet

Mainnet is a separate decision. Before it: an external security review of the contract, fuzzing of the refusal boundaries, a bug bounty, and a mainnet deployment on fresh accounts with `v1.signer` and a new path. No testnet key or address is reused.
