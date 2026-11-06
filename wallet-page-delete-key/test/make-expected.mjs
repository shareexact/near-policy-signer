// Builds fixtures/delete-key-expected.json with near-api-js 0.45.1, independently of src/.
// The keys are written out here by hand, not imported from src/plan.js.
import fs from "fs";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const { utils, transactions: T } = require("near-api-js");
const signingKey = utils.PublicKey.fromString("ed25519:9k4yvZ8M7yezqHa6yzDoKr1m9nfv8HER5Bux9NUEmgYf");
const deleted = utils.PublicKey.fromString("ed25519:CY9aCwrmVaPMzMJLbxAxFGwGhEKgSgar5UKuVqLGZcaQ");
const tx = T.createTransaction("aa5hr.testnet", signingKey, "aa5hr.testnet", 1, [T.deleteKey(deleted)], Buffer.alloc(32));
const b64 = Buffer.from(utils.serialize.serialize(T.SCHEMA, tx)).toString("base64");
fs.writeFileSync(new URL("./fixtures/delete-key-expected.json", import.meta.url),
  JSON.stringify({ note: "nonce 1 and a zero block hash; the test normalises both", deleted: deleted.toString(), tx: { k1_delete_key: b64 } }, null, 1) + "\n");
console.log(b64);
