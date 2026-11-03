# Meteor Wallet signing page (NEAR testnet only)

One self-contained file, `index.html` (sha256 `7022bb58e93625fac398a9d5e283b5666ba5c8e230f19dbc610f79c8c0594c02`, 1418888 bytes), for U3 only: the 4 owner calls that
aa5hr.testnet signs on policy-v1.shareexact-chainsig-demo.testnet. No CreateAccount, Transfer or AddKey anywhere (the accounts
and keys were set up from a CLI keychain, see [USER-COMMANDS.md](../USER-COMMANDS.md)). No keys are in the page; Meteor signs
and broadcasts after you approve in Meteor. The page refuses to sign unless the connected account is `aa5hr.testnet` and the
network is testnet, and every transaction must be one FunctionCall, 1 yoctoNEAR, 30 Tgas, to policy-v1.shareexact-chainsig-demo.testnet.
Signed on Nov 2 2026: see [DEPLOYMENT-TESTNET.md](../DEPLOYMENT-TESTNET.md), rows U3.1 to U3.4.

## How to open it (on your own computer, where Meteor is installed)

Serve it from http://localhost. Do NOT open it as a file:// page (not verified to work, see below).

1. Put `index.html` in an empty folder.
2. In that folder run: `python3 -m http.server 8080 --bind 127.0.0.1`
3. Open http://localhost:8080/ in the browser that has the Meteor extension (or allow popups for localhost:8080
   if you use the web wallet https://wallet.meteorwallet.app).
4. Check the file first: `shasum -a 256 index.html` (macOS) or `sha256sum index.html` must print `7022bb58e93625fac398a9d5e283b5666ba5c8e230f19dbc610f79c8c0594c02`.

## Buttons and exactly what each one signs

All: signer aa5hr.testnet (the wallet's own full-access key ed25519:9k4yvZ8M7yezqHa6yzDoKr1m9nfv8HER5Bux9NUEmgYf; the
wallet fetches nonce and block hash). Before each one the page shows the full action list and asks for confirmation;
then Meteor shows it again for approval. Each returned hash is shown with a https://testnet.nearblocks.io/txns/<hash> link.

- **Connect Meteor**: wallet-selector `signIn` with no contract (Meteor login type ALL_METHODS, contract_id "").
- **U3 Owner calls x4** (one `signAndSendTransactions` with 4 transactions; or U3.1 to U3.4 one at a time, in order):
  receiver policy-v1.shareexact-chainsig-demo.testnet, each one FunctionCall, gas 30 Tgas, deposit 1 yoctoNEAR:
  1. add_agent `{"agent":"agent-v1.shareexact-chainsig-demo.testnet","policy":{"enabled":true,"label":"demo agent","max_requests_per_day":20}}`
  2. set_chain `{"chain_id":46630,"policy":{"max_fee_per_gas":"1000000000","max_priority_fee_per_gas":"100000000","max_gas_limit":"200000","exact_transfer":"0x2cbaedbf8bf46600cf311c7065f901aad973fd8e","unknown_recipients_need_approval":true}}`
  3. set_token `{"chain_id":46630,"token":"0x0000000000000000000000000000000000000000","policy":{"kind":"Native","max_per_request":"1000000000000000","max_per_day":"5000000000000000","approval_above":"500000000000000"}}`
  4. set_recipient `{"chain_id":46630,"recipient":"0x0C7F5b0f2cbA6a576F92f60205e87F4D28080490","allowed":true}`
  Locked (and forced clicks refused) until a read-only RPC check shows policy-v1.shareexact-chainsig-demo.testnet's code_hash is 8EtC2o7j51xd7ESB6vJJLCA18CPytCcmZ6HETqcSPows AND its key list is empty.

## Pinned versions

@near-wallet-selector/core 10.1.4, @near-wallet-selector/meteor-wallet 10.1.4 (brings @meteorwallet/sdk 1.0.24),
@near-js/transactions 2.5.1, @near-js/crypto 2.5.1, buffer 6.0.3, util 0.12.5, esbuild 0.28.2; test: jsdom 26.1.0.
Exact tree in package-lock.json. modal-ui is not used (the page calls the Meteor module directly).

## Build and test

```
npm ci && node build.mjs          # writes index.html (rebuild gives the same sha256)
node test/page.test.mjs           # 74 checks
```
The test loads index.html in jsdom with a mock Meteor extension (`window.meteorCom`). The mock answers the login and
captures the base64 transactions the Meteor SDK hands to the extension, then rejects them, so nothing is signed or sent.
Each captured transaction is decoded with an independent library (near-api-js 0.45.1, a devDependency) and compared field by
field, and byte for byte after normalising the live nonce and block hash, with `test/fixtures/u3-expected.json` (unsigned
transactions built separately with near-api-js). Covered: the batch button and the 4 single buttons; the lock opening on the
real deployed contract; the lock staying shut (and forced clicks refused) for a wrong code hash, a leftover key, or a missing
account; and a different account being refused. Needs network access to rpc.testnet.near.org.

## Source findings (wallet-selector 10.1.4, @meteorwallet/sdk 1.0.24)

- Action format: core `Action = NAJAction` (@near-js/transactions; src/lib/wallet/transactions.types.d.ts). The page builds
  its actions with `actionCreators.functionCall` only.
- Meteor module: `najActionToInternal` (core) maps CreateAccount, Transfer, AddKey (FullAccess or function call), FunctionCall,
  DeployContract, DeleteKey, DeleteAccount; the SDK's `createAction` (src/utils/create-action.ts) turns all of them back into
  near-js actions. So CreateAccount and AddKey are supported. Both `signAndSendTransaction` and `signAndSendTransactions` go to
  `requestSignTransactions`, which sends the borsh transactions to the wallet (src/MeteorWallet.ts:381-415).
- The page never signs locally: the SDK only signs with its local dApp key when that key is an on-chain function-call key that
  matches a zero-deposit call (MeteorWallet.ts:534-588). Every transaction here carries a 1 yoctoNEAR deposit, so it always goes to the wallet.
- file://: the extension path needs the extension to inject `window.meteorCom` into the page; the web path opens
  https://wallet.meteorwallet.app in a popup and talks by postMessage. Whether either works from a file:// (origin "null") page
  depends on the extension and the wallet site, not on the SDK, so it is not verified. Use http://localhost.
- The SDK prints the random local dApp key pair to the console during login (MeteorWallet.ts:263); the page mutes console.log
  during login. The page also refuses to sign if localStorage `DEV__METEOR_WALLET_BASE_URL` is set (src/envConfig.ts).
