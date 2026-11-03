// Builds fixtures/chain-fix-expected.json with near-api-js 0.45.1, independently of src/.
// The arguments are written out here by hand, not imported from src/plan.js.
import fs from "fs";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const { utils, transactions: T } = require("near-api-js");
const args = '{"chain_id":46630,"policy":{"max_fee_per_gas":"1000000000","max_priority_fee_per_gas":"100000000","max_gas_limit":"200000","exact_transfer":null,"unknown_recipients_need_approval":true}}';
const pk = utils.PublicKey.fromString("ed25519:9k4yvZ8M7yezqHa6yzDoKr1m9nfv8HER5Bux9NUEmgYf");
const tx = T.createTransaction("aa5hr.testnet", pk, "policy-v1.shareexact-chainsig-demo.testnet", 1,
  [T.functionCall("set_chain", Buffer.from(args), "30000000000000", "1")], Buffer.alloc(32));
const b64 = Buffer.from(utils.serialize.serialize(T.SCHEMA, tx)).toString("base64");
fs.writeFileSync(new URL("./fixtures/chain-fix-expected.json", import.meta.url),
  JSON.stringify({ note: "nonce 1 and a zero block hash; the test normalises both", args, tx: { f1_set_chain: b64 } }, null, 1) + "\n");
console.log(b64);
