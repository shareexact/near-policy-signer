// Builds fixtures/new-agent-expected.json with near-api-js 0.45.1, independently of src/.
// Arguments, gas and deposits are written out here by hand, not imported from src/plan.js.
import fs from "fs";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const { utils, transactions: T } = require("near-api-js");
const pk = utils.PublicKey.fromString("ed25519:9k4yvZ8M7yezqHa6yzDoKr1m9nfv8HER5Bux9NUEmgYf");
const calls = {
  create: ["testnet", "create_account", '{"new_account_id":"policy-signer-agent-v2.testnet","new_public_key":"ed25519:7qYtkNWa2eS9LP5ZonKPq97HmD6NV5Chj4jkKgcEgEvp"}', "100000000000000", "500000000000000000000000"],
  schedule: ["policy-v1.shareexact-chainsig-demo.testnet", "add_agent", '{"agent":"policy-signer-agent-v2.testnet","policy":{"enabled":true,"label":"demo agent v2","max_requests_per_day":20}}', "30000000000000", "1"],
  execute: ["policy-v1.shareexact-chainsig-demo.testnet", "execute_change", '{"change_id":12}', "30000000000000", "1"],
};
const tx = {};
for (const [k, [receiver, method, args, gas, deposit]] of Object.entries(calls)) {
  const t = T.createTransaction("aa5hr.testnet", pk, receiver, 1, [T.functionCall(method, Buffer.from(args), gas, deposit)], Buffer.alloc(32));
  tx[k] = Buffer.from(utils.serialize.serialize(T.SCHEMA, t)).toString("base64");
}
fs.writeFileSync(new URL("./fixtures/new-agent-expected.json", import.meta.url),
  JSON.stringify({ note: "nonce 1 and a zero block hash; the test normalises both", calls, tx }, null, 1) + "\n");
console.log(Object.keys(tx).join(", "));
