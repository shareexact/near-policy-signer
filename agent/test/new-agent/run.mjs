// Offline test of scripts/new-agent.mjs against a mock NEAR RPC (a local HTTP server); no network.
// Run from agent/: node test/new-agent/run.mjs
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { utils, transactions as T } from "near-api-js";

const POLICY = "policy-v1.shareexact-chainsig-demo.testnet";
const home = fs.mkdtempSync(path.join(os.tmpdir(), "na-"));
const state = { accounts: {}, sent: [] }; // accounts[name] = [{public_key, access_key}]
let fails = 0;
const check = (c, m) => { console.log(`${c ? "PASS" : "FAIL"} ${m}`); if (!c) fails++; };
const hash32 = Buffer.alloc(32, 9);
// Decoded borsh values are plain objects: rebuild key strings and action names by hand.
const pk = (o) => (o?.ed25519Key ? "ed25519:" + utils.serialize.base_encode(Buffer.from(Object.values(o.ed25519Key.data))) : String(o));
const kind = (a) => Object.keys(a).find((k) => a[k] != null && k !== "enum");

const server = http.createServer((req, res) => {
  let body = ""; req.on("data", (d) => (body += d)); req.on("end", () => {
    const j = JSON.parse(body), p = j.params ?? {};
    const reply = (o) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ jsonrpc: "2.0", id: j.id, ...o })); };
    const unknown = () => reply({ error: { name: "HANDLER_ERROR", cause: { name: "UNKNOWN_ACCOUNT", info: {} }, message: `account ${p.account_id} does not exist while viewing` } });
    // As a real node does: view_account errors for an unknown account, view_access_key_list answers an empty list.
    if (j.method === "query" && p.request_type === "view_account") return state.accounts[p.account_id] ? reply({ result: { amount: "500000000000000000000000", locked: "0", code_hash: "11111111111111111111111111111111", storage_usage: 182, block_height: 1, block_hash: utils.serialize.base_encode(hash32) } }) : unknown();
    if (j.method === "query" && p.request_type === "view_access_key_list") return reply({ result: { keys: state.accounts[p.account_id] ?? [], block_height: 1, block_hash: utils.serialize.base_encode(hash32) } });
    if (j.method === "query" && p.request_type === "view_access_key") {
      const k = state.accounts[p.account_id]?.find((x) => x.public_key === p.public_key);
      return k ? reply({ result: { ...k.access_key, block_height: 1, block_hash: utils.serialize.base_encode(hash32) } }) : reply({ error: { name: "HANDLER_ERROR", cause: { name: "UNKNOWN_ACCESS_KEY" }, message: "access key does not exist" } });
    }
    if (j.method === "block") return reply({ result: { header: { hash: utils.serialize.base_encode(hash32), height: 1 } } });
    if (j.method === "status") return reply({ result: { chain_id: "testnet", sync_info: { latest_block_hash: utils.serialize.base_encode(hash32), latest_block_height: 1 } } });
    if (j.method === "send_tx" || j.method === "broadcast_tx_commit") {
      const raw = Buffer.from(j.method === "send_tx" ? p.signed_tx_base64 : p[0], "base64");
      const stx = T.SignedTransaction.decode(raw);
      const tx = stx.transaction;
      let keys = state.accounts[tx.signerId];
      const signer = keys.find((k) => k.public_key === pk(tx.publicKey));
      const ok = signer && signer.access_key.permission === "FullAccess";
      for (const a of tx.actions) {
        if (a.addKey) {
          const fc = a.addKey.accessKey.permission.functionCall;
          keys.push({ public_key: pk(a.addKey.publicKey), access_key: { nonce: 0, permission: fc ? { FunctionCall: { allowance: fc.allowance?.toString() ?? null, receiver_id: fc.receiverId, method_names: fc.methodNames } } : "FullAccess" } });
        }
        if (a.deleteKey) keys = state.accounts[tx.signerId] = keys.filter((k) => k.public_key !== pk(a.deleteKey.publicKey));
      }
      state.sent.push({ signer: pk(tx.publicKey), actions: tx.actions.map(kind), ok, receiver: tx.receiverId, add: tx.actions[0].addKey });
      const h = utils.serialize.base_encode(Buffer.alloc(32, state.sent.length));
      return reply({ result: { status: { SuccessValue: "" }, transaction: { hash: h, signer_id: tx.signerId }, transaction_outcome: { id: h, outcome: { logs: [], receipt_ids: [], gas_burnt: 1, tokens_burnt: "0", executor_id: tx.signerId, status: { SuccessValue: "" } } }, receipts_outcome: [], final_execution_status: "FINAL" } });
    }
    reply({ error: { message: `unexpected ${j.method}` } });
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const env = { ...process.env, HOME: home, NEAR_RPC_URL: `http://127.0.0.1:${server.address().port}` };
const run = (...a) => new Promise((r) => execFile("node", ["scripts/new-agent.mjs", ...a], { env }, (e, so, se) => r({ code: e ? e.code : 0, out: so + se })));
const file = path.join(home, ".near-policy-signer", "agent-v2.json");

let r = await run("keys", "Bad_Name");
check(r.code !== 0 && /not a valid/.test(r.out), "keys: refuses an invalid name");
state.accounts["taken.testnet"] = [{ public_key: "ed25519:x", access_key: { nonce: 0, permission: "FullAccess" } }];
r = await run("keys", "taken.testnet");
check(r.code !== 0 && /already exists/.test(r.out), "keys: refuses a name that exists");
r = await run("finish");
check(r.code !== 0 && /run "node scripts\/new-agent.mjs keys" first/.test(r.out), "finish before keys: stops");
r = await run("keys");
const s = JSON.parse(fs.readFileSync(file, "utf8"));
check(r.code === 0 && s.accountId === "policy-signer-agent-v2.testnet", "keys: default name, file written");
check((fs.statSync(file).mode & 0o777) === 0o600, "keys: file mode 600");
check(r.out.includes(s.fullPublicKey) && !r.out.includes(s.fullSecretKey.slice(8)) && !r.out.includes(s.requestSecretKey.slice(8)), "keys: prints the public key, never a secret");
r = await run("keys");
check(r.code === 0 && /reusing/.test(r.out) && JSON.parse(fs.readFileSync(file, "utf8")).fullSecretKey === s.fullSecretKey, "keys again: reuses, does not overwrite");
r = await run("finish");
check(r.code !== 0 && /does not exist yet/.test(r.out), "finish before the account exists: stops");
// The owner creates the account with the full-access public key (testnet.create_account).
state.accounts[s.accountId] = [{ public_key: s.fullPublicKey, access_key: { nonce: 0, permission: "FullAccess" } }];
r = await run("finish");
check(r.code === 0, `finish: exits 0 ${r.code ? r.out : ""}`);
const k = state.accounts[s.accountId];
check(k.length === 1 && k[0].public_key === s.requestPublicKey && k[0].access_key.permission.FunctionCall.receiver_id === POLICY
  && JSON.stringify(k[0].access_key.permission.FunctionCall.method_names) === '["request"]' && k[0].access_key.permission.FunctionCall.allowance === "250000000000000000000000",
  "finish: exactly one key left, function call to policy-v1, method request, 0.25 NEAR");
check(state.sent.length === 2 && state.sent.every((x) => x.ok && x.signer === s.fullPublicKey && x.receiver === s.accountId) && state.sent[0].actions.join() === "addKey" && state.sent[1].actions.join() === "deleteKey",
  "finish: AddKey then DeleteKey, both signed with the full-access key, to the account itself");
const after = JSON.parse(fs.readFileSync(file, "utf8"));
check(!("fullSecretKey" in after) && after.requestSecretKey === s.requestSecretKey && after.txs.length === 2, "finish: the full-access secret is dropped from the file; the request key and the hashes are kept");
check(!r.out.includes(s.requestSecretKey.slice(8)) && !r.out.includes(s.fullSecretKey.slice(8)), "finish: no secret in the output");
r = await run("finish");
check(r.code === 0 && state.sent.length === 2, "finish again: nothing to send, still exits 0");
state.accounts[s.accountId].push({ public_key: "ed25519:stranger", access_key: { nonce: 0, permission: "FullAccess" } });
r = await run("finish");
check(r.code !== 0 && /did not make/.test(r.out), "finish: stops on a key it did not make");
server.close();
fs.rmSync(home, { recursive: true, force: true });
console.log(fails ? `\n${fails} FAILED` : "\nALL CHECKS OK");
process.exit(fails ? 1 : 0);
