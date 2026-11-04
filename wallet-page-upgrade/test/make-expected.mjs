// Builds fixtures/upgrade-expected.json with near-api-js 0.45.1, independently of src/: the propose_upgrade
// transaction for the sha256 of ../policy_signer.wasm, with nonce 1 and a zero block hash (the test normalises both).
import fs from "fs";
import crypto from "crypto";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const { utils, transactions: T } = require("near-api-js");
const wasm = fs.readFileSync(new URL("../policy_signer.wasm", import.meta.url));
const sha = crypto.createHash("sha256").update(wasm).digest("hex");
const pk = utils.PublicKey.fromString("ed25519:9k4yvZ8M7yezqHa6yzDoKr1m9nfv8HER5Bux9NUEmgYf");
const args = `{"code_hash":"${sha}"}`;
const tx = T.createTransaction("aa5hr.testnet", pk, "policy-v1.shareexact-chainsig-demo.testnet", 1,
  [T.functionCall("propose_upgrade", Buffer.from(args), "30000000000000", "1")], Buffer.alloc(32));
const b64 = Buffer.from(utils.serialize.serialize(T.SCHEMA, tx)).toString("base64");
// set_params with the deployment's parameters (the contract defaults) and policy_delay_s 3600, written out by hand.
const delayArgs = '{"params":{"max_observation_age_s":120,"max_clock_skew_s":15,"corp_action_window_s":7200,"max_requests_per_day":50,"pending_ticket_ttl_s":86400,"approved_ticket_ttl_s":900,"max_open_tickets":20,"upgrade_delay_s":172800,"policy_delay_s":3600}}';
const delayTx = T.createTransaction("aa5hr.testnet", pk, "policy-v1.shareexact-chainsig-demo.testnet", 1,
  [T.functionCall("set_params", Buffer.from(delayArgs), "30000000000000", "1")], Buffer.alloc(32));
const delayB64 = Buffer.from(utils.serialize.serialize(T.SCHEMA, delayTx)).toString("base64");
const b58 = utils.serialize.base_encode(Buffer.from(sha, "hex"));
fs.writeFileSync(new URL("./fixtures/upgrade-expected.json", import.meta.url),
  JSON.stringify({ note: "nonce 1 and a zero block hash; the test normalises both", code_sha256: sha, code_hash_b58: b58, args, delay_args: delayArgs, tx: { propose: b64, set_delay: delayB64 } }, null, 1) + "\n");
console.log(sha);
