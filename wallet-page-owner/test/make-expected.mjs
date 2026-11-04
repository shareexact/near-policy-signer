// Builds fixtures/owner-expected.json with near-api-js 0.45.1, independently of src/: the five owner transactions the
// test expects (approve ticket 3, pause, resume, schedule bob, cancel change 7), with nonce 1 and a zero block hash.
import fs from "fs";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const { utils, transactions: T } = require("near-api-js");
const pk = utils.PublicKey.fromString("ed25519:9k4yvZ8M7yezqHa6yzDoKr1m9nfv8HER5Bux9NUEmgYf");
const POLICY = "policy-v1.shareexact-chainsig-demo.testnet";
const calls = {
  approve: ["approve_ticket", '{"ticket_id":3}'],
  pause: ["set_paused", '{"paused":true}'],
  resume: ["set_paused", '{"paused":false}'],
  schedule: ["set_recipient", '{"chain_id":46630,"recipient":"0xb0b0000000000000000000000000000000000b0b","allowed":true}'],
  cancel: ["cancel_change", '{"change_id":7}'],
};
const tx = {};
for (const [k, [m, args]] of Object.entries(calls)) {
  const t = T.createTransaction("aa5hr.testnet", pk, POLICY, 1, [T.functionCall(m, Buffer.from(args), "30000000000000", "1")], Buffer.alloc(32));
  tx[k] = Buffer.from(utils.serialize.serialize(T.SCHEMA, t)).toString("base64");
}
fs.writeFileSync(new URL("./fixtures/owner-expected.json", import.meta.url),
  JSON.stringify({ note: "nonce 1 and a zero block hash; the test normalises both", calls, tx }, null, 1) + "\n");
console.log(Object.keys(tx).join(", "));
