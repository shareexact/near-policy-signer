// Loads index.html in jsdom with a MOCK Meteor extension (window.meteorCom). No real wallet is opened.
// The mock answers "login" and captures the base64 transactions that the Meteor SDK would hand to the
// extension for signing, then answers "closed_fail" (rejected), so nothing is ever signed or broadcast.
// Read-only RPC goes to rpc.testnet.near.org (real chain state: policy-v1 deployed, 0 keys); in phase B the
// policy-v1 gate queries are mocked to fail on purpose.
import { JSDOM } from "jsdom";
import fs from "fs";
import { createRequire } from "module";
const nativeFetch = globalThis.fetch; // near-api-js 0.45 replaces global fetch with node-fetch
const require = createRequire(import.meta.url);
// Independent decoder: near-api-js 0.45.1 (devDependency), not the near-js packages the page itself uses.
const { utils, transactions: T } = require("near-api-js");
const expected = JSON.parse(fs.readFileSync(new URL("./fixtures/u3-expected.json", import.meta.url), "utf8")).tx;
const html = fs.readFileSync(new URL("../index.html", import.meta.url), "utf8");
const dec = (b64) => utils.serialize.deserialize(T.SCHEMA, T.Transaction, Buffer.from(b64, "base64"));
const ser = (t) => Buffer.from(utils.serialize.serialize(T.SCHEMA, t)).toString("base64");
let failures = 0;
const check = (cond, msg) => { console.log(`${cond ? "PASS" : "FAIL"} ${msg}`); if (!cond) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 30000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await sleep(100); } return null; }

function describeTx(t) {
  return t.actions.map((a) => { const k = a.enum, v = a[k];
    if (k === "transfer") return `transfer ${v.deposit.toString()}`;
    if (k === "addKey") return `addKey ${v.publicKey.toString()} ${v.accessKey.permission.enum} nonce=${v.accessKey.nonce.toString()}`;
    if (k === "functionCall") return `functionCall ${v.methodName} gas=${v.gas.toString()} deposit=${v.deposit.toString()} args=${Buffer.from(v.args).toString()}`;
    return k; }).join("; ");
}

function compare(label, capturedB64, expectedB64) {
  const c = dec(capturedB64), e = dec(expectedB64);
  check(c.signerId === e.signerId, `${label}: signerId ${c.signerId}`);
  check(c.receiverId === e.receiverId, `${label}: receiverId ${c.receiverId}`);
  check(c.publicKey.toString() === "ed25519:9k4yvZ8M7yezqHa6yzDoKr1m9nfv8HER5Bux9NUEmgYf", `${label}: publicKey ${c.publicKey.toString()} (aa5hr's on-chain full-access key)`);
  check(c.actions.length === e.actions.length, `${label}: ${c.actions.length} actions`);
  check(describeTx(c) === describeTx(e), `${label}: actions field by field: ${describeTx(c)}`);
  // byte-level: same tx once nonce/blockHash/publicKey (fetched live by the SDK) are set to the prepared values
  c.nonce = e.nonce; c.blockHash = e.blockHash; c.publicKey = e.publicKey;
  check(ser(c) === expectedB64, `${label}: borsh bytes identical to fixtures/u3-expected.json after normalising nonce/blockHash`);
}

async function makePage({ loginAccount, mockGate }) {
  const sent = [];
  const dom = new JSDOM(html, {
    url: "http://localhost:8080/", runScripts: "dangerously", pretendToBeVisual: true,
    beforeParse(window) {
      window.confirm = () => true;
      window.open = () => { throw new Error("window.open must not be used with the extension mock"); };
      window.fetch = async (url, opts) => {
        const body = JSON.parse(opts.body);
        if (mockGate && body.method === "query" && body.params.account_id === "policy-v1.shareexact-chainsig-demo.testnet") {
          // mockGate: "badhash" | "haskey" | "missing"  (makes the U3 lock check fail on purpose)
          if (mockGate === "missing") return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, error: { cause: { name: "UNKNOWN_ACCOUNT" } } }), { headers: { "content-type": "application/json" } });
          const result = body.params.request_type === "view_account"
            ? { amount: "1", locked: "0", code_hash: mockGate === "badhash" ? "11111111111111111111111111111111" : "8EtC2o7j51xd7ESB6vJJLCA18CPytCcmZ6HETqcSPows", storage_usage: 1, storage_paid_at: 0, block_height: 1, block_hash: "x" }
            : { keys: mockGate === "haskey" ? [{ public_key: "ed25519:7qYtkNWa2eS9LP5ZonKPq97HmD6NV5Chj4jkKgcEgEvp", access_key: { nonce: 1, permission: "FullAccess" } }] : [], block_height: 1, block_hash: "x" };
          return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), { headers: { "content-type": "application/json" } });
        }
        return nativeFetch(url, opts);
      };
      let listener = null; const answered = new Set();
      window.meteorCom = {
        addMessageDataListener: (l) => { listener = l; },
        sendMessageData: (data) => {
          if (answered.has(data.uid) || data.status !== "initializing") return;
          answered.add(data.uid);
          sent.push(data);
          setTimeout(() => {
            if (data.actionType === "login") listener({ uid: data.uid, status: "closed_success", endTags: [], payload: { accountId: loginAccount, allKeys: ["ed25519:9k4yvZ8M7yezqHa6yzDoKr1m9nfv8HER5Bux9NUEmgYf"] } });
            else listener({ uid: data.uid, status: "closed_fail", endTags: ["TEST_MOCK_REJECTED"] });
          }, 20);
        },
        directAction: async () => ({ success: false }),
      };
    },
  });
  const w = dom.window, d = w.document;
  await until(() => d.getElementById("u3-gate").textContent !== "Checking policy-v1...");
  return { w, d, sent, dom };
}

const log = (d) => d.getElementById("log").textContent;


const U3KEYS = ["c1_add_agent", "c2_set_chain", "c3_set_token", "c4_set_recipient"];
const ids = ["u3", "u3-1", "u3-2", "u3-3", "u3-4"];
const nextSign = (sent) => until(() => sent.find((s) => s.actionType === "sign" && !s._seen && (s._seen = true)));
const waitReject = async (d, n) => until(() => (log(d).match(/TEST_MOCK_REJECTED|ERROR/g) || []).length >= n);

// Phase A: real RPC. Connect as aa5hr.testnet; the lock check must pass on the real deployed policy-v1.
{
  const { w, d, sent } = await makePage({ loginAccount: "aa5hr.testnet", mockGate: false });
  // static: the page's plan has only FunctionCall, 1 yocto, 30 Tgas, receiver policy-v1.shareexact-chainsig-demo.testnet
  const plan = w.__walletPage.plan;
  check(!("U1" in plan) && !("U2ALT" in plan), "A: plan has no U1 or U2 (no CreateAccount / AddKey transactions)");
  check(plan.U3.length === 4 && plan.U3.every((t) => t.receiverId === "policy-v1.shareexact-chainsig-demo.testnet" && t.actions.length === 1 && t.actions.every((a) => a.type === "FunctionCall" && a.deposit === 1n && a.gas === 30000000000000n)), "A: plan U3 = 4 x one FunctionCall, 1 yocto, 30 Tgas, to policy-v1.shareexact-chainsig-demo.testnet");
  check(ids.every((id) => d.getElementById(id).disabled), "A: buttons disabled before connect");
  d.getElementById("connect").click();
  await until(() => d.getElementById("account").textContent === "aa5hr.testnet" && !d.getElementById("u3").disabled);
  const login = sent.find((s) => s.actionType === "login");
  check(login?.network === "testnet", `A: login request network=${login?.network}`);
  check(login && (login.inputs.contract_id ?? "") === "" && login.inputs.type === "ALL_METHODS", `A: login inputs ${JSON.stringify({ ...login?.inputs, public_key: "<random dApp key>" })}`);
  check(ids.every((id) => !d.getElementById(id).disabled), `A: U3 unlocked by the real chain: "${d.getElementById("u3-gate").textContent}"`);
  d.getElementById("u3").click();
  const s = await nextSign(sent);
  check(s?.network === "testnet", "A: U3 batch sign request network=testnet");
  const t = s.inputs.transactions.split(",");
  check(t.length === 4, "A: U3 batch is 4 transactions in one sign request");
  U3KEYS.forEach((k, i) => compare(`U3 batch ${i + 1}`, t[i], expected[k]));
  const nonces = t.map((b) => dec(b).nonce.toString());
  check(new Set(nonces).size === 4 && nonces.every((n, i) => i === 0 || BigInt(n) === BigInt(nonces[i - 1]) + 1n), `A: 4 consecutive nonces ${nonces.join(",")}`);
  check(t.every((b) => dec(b).actions.every((a) => a.enum === "functionCall")), "A: no CreateAccount / Transfer / AddKey action in any captured transaction");
  await waitReject(d, 1);
  for (let i = 1; i <= 4; i++) {
    d.getElementById(`u3-${i}`).click();
    const si = await nextSign(sent);
    const ti = si.inputs.transactions.split(",");
    check(ti.length === 1, `A: U3.${i} single button sends one transaction`);
    compare(`U3.${i} single`, ti[0], expected[U3KEYS[i - 1]]);
    await waitReject(d, i + 1);
  }
}

// Phase B: lock check failing on purpose (bad code hash, a key left, account missing).
for (const mode of ["badhash", "haskey", "missing"]) {
  const { d, sent } = await makePage({ loginAccount: "aa5hr.testnet", mockGate: mode });
  d.getElementById("connect").click();
  await until(() => d.getElementById("account").textContent === "aa5hr.testnet");
  await sleep(1500);
  check(ids.every((id) => d.getElementById(id).disabled), `B(${mode}): U3 buttons locked: "${d.getElementById("u3-gate").textContent}"`);
  d.getElementById("u3").disabled = false; d.getElementById("u3").click();
  d.getElementById("u3-1").disabled = false; d.getElementById("u3-1").click();
  await until(() => (log(d).match(/U3 is locked/g) || []).length >= 2, 8000);
  check((log(d).match(/U3 is locked/g) || []).length >= 2, `B(${mode}): forced clicks refused by the lock check`);
  check(!sent.some((x) => x.actionType === "sign"), `B(${mode}): no sign request reached the wallet`);
}

// Phase C: wrong account must be refused (real RPC, lock open).
{
  const { d, sent } = await makePage({ loginAccount: "someone-else.testnet", mockGate: false });
  d.getElementById("connect").click();
  await until(() => d.getElementById("account").textContent === "someone-else.testnet");
  await sleep(2500);
  check(ids.every((id) => d.getElementById(id).disabled), "C: all sign buttons disabled for someone-else.testnet");
  d.getElementById("u3").disabled = false; d.getElementById("u3").click();
  await until(() => /refusing to sign/.test(log(d)), 5000);
  check(/refusing to sign/.test(log(d)), "C: forced click refused by the signer guard");
  check(!sent.some((x) => x.actionType === "sign"), "C: no sign request reached the wallet");
}

console.log(failures ? `\n${failures} FAILED` : "\nALL CHECKS OK");
process.exit(failures ? 1 : 0);
