# Delete the owner account's second key (Meteor Wallet, NEAR testnet only)

One self-contained file, `index.html` (sha256 `502ca2e069350c6473d77947ab62b337cefc458925da3e04c789c0931b6ab1e7`), for one
transaction on the owner account of the testnet deployment in [DEPLOYMENT-TESTNET.md](../DEPLOYMENT-TESTNET.md) (open item 1).
Same design as [`../wallet-page/`](../wallet-page/); see [WALLET-SIGNING.md](../WALLET-SIGNING.md).

## Why

On Nov 2 a second full-access key, `ed25519:CY9aCwrmVaPMzMJLbxAxFGwGhEKgSgar5UKuVqLGZcaQ`, was added to `aa5hr.testnet`
(DEPLOYMENT-TESTNET.md row 10). No transaction of the deployment was signed with it. The owner account is the root of trust
of the contract, so it should hold only the key the owner uses: `ed25519:9k4yvZ8M7yezqHa6yzDoKr1m9nfv8HER5Bux9NUEmgYf`, in Meteor.

## The transaction

Serve locally and open in the browser that has Meteor with aa5hr.testnet:

    python3 -m http.server 8080 --bind 127.0.0.1   # in this folder, then open http://localhost:8080/

The button sends ONE transaction, signer aa5hr.testnet (signed by Meteor with 9k4y...), receiver aa5hr.testnet, with ONE action:

    DeleteKey ed25519:CY9aCwrmVaPMzMJLbxAxFGwGhEKgSgar5UKuVqLGZcaQ

The page builds no other transaction: it refuses another receiver, more than one action, any action that is not DeleteKey, and
any key other than CY9a... (above all 9k4y..., which Meteor signs with). The button unlocks only when aa5hr.testnet's key list,
read from the chain (`test.rpc.fastnear.com`, then `rpc.testnet.near.org`), still has CY9a... and has 9k4y... as a
full-access key, the connected account is aa5hr.testnet on testnet, and no `DEV__METEOR_WALLET_BASE_URL` override is set. If
the chain cannot be read, the button stays locked and the page says so. After the transaction the page re-reads the key list and
reports "already deleted".

Build: `npm ci && npm run build` (same sha256). Test: `npm test` (mock Meteor, nothing is signed; every RPC call is answered
offline). The expected transaction in `test/fixtures/` is built by `test/make-expected.mjs` with near-api-js 0.45.1 from keys
written out by hand, independently of `src/`.
