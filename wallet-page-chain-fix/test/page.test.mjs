// Loads index.html in jsdom with a MOCK Meteor extension (window.meteorCom). No real wallet is opened.
// The mock answers "login" and captures the base64 transactions the Meteor SDK would hand to the extension,
// then answers "closed_fail" (rejected), so nothing is ever signed or broadcast.
// Every RPC call is mocked (policy-v1's views, aa5hr.testnet's access key and the latest block), so the test needs no network.
import { JSDOM } from "jsdom";
import fs from "fs";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
// Independent decoder: near-api-js 0.45.1 (devDependency), not the near-js packages the page itself uses.
const { utils, transactions: T } = require("near-api-js");
const fixture = JSON.parse(fs.readFileSync(new URL("./fixtures/chain-fix-expected.json", import.meta.url), "utf8"));
const expected = fixture.tx.f1_set_chain;
const html = fs.readFileSync(new URL("../index.html", import.meta.url), "utf8");
const dec = (b64) => utils.serialize.deserialize(T.SCHEMA, T.Transaction, Buffer.from(b64, "base64"));
const ser = (t) => Buffer.from(utils.serialize.serialize(T.SCHEMA, t)).toString("base64");
const POLICY = "policy-v1.shareexact-chainsig-demo.testnet", PK = "ed25519:9k4yvZ8M7yezqHa6yzDoKr1m9nfv8HER5Bux9NUEmgYf";
const BLOCK_HASH = utils.serialize.base_encode(Buffer.alloc(32, 7));
let failures = 0;
const check = (cond, msg) => { console.log(`${cond ? "PASS" : "FAIL"} ${msg}`); if (!cond) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 30000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await sleep(100); } return null; }
const describeTx = (t) => t.actions.map((a) => { const k = a.enum, v = a[k];
  return k === "functionCall" ? `functionCall ${v.methodName} gas=${v.gas.toString()} deposit=${v.deposit.toString()} args=${Buffer.from(v.args).toString()}` : k; }).join("; ");
function compare(label, capturedB64) {
  const c = dec(capturedB64), e = dec(expected);
  check(c.signerId === "aa5hr.testnet", `${label}: signerId ${c.signerId}`);
  check(c.receiverId === POLICY, `${label}: receiverId ${c.receiverId}`);
  check(c.publicKey.toString() === PK, `${label}: publicKey ${c.publicKey.toString()}`);
  check(c.actions.length === 1 && c.actions[0].enum === "functionCall", `${label}: exactly one FunctionCall`);
  check(Buffer.from(c.actions[0].functionCall.args).toString() === fixture.args, `${label}: args ${Buffer.from(c.actions[0].functionCall.args).toString()}`);
  check(describeTx(c) === describeTx(e), `${label}: ${describeTx(c)}`);
  c.nonce = e.nonce; c.blockHash = e.blockHash;
  check(ser(c) === expected, `${label}: borsh bytes identical to fixtures/chain-fix-expected.json after normalising nonce/blockHash`);
}
const CHAIN_NOW = { max_fee_per_gas: "1000000000", max_priority_fee_per_gas: "100000000", max_gas_limit: "200000", exact_transfer: "0x2cbaedbf8bf46600cf311c7065f901aad973fd8e", unknown_recipients_need_approval: true };
// mock: { chain?, owner?, codeHash?, keys?, missing? } overrides for policy-v1's views
async function makePage({ loginAccount, mock }) {
  const sent = [];
  const dom = new JSDOM(html, {
    url: "http://localhost:8080/", runScripts: "dangerously", pretendToBeVisual: true,
    beforeParse(window) {
      window.confirm = () => true;
      window.open = () => { throw new Error("window.open must not be used with the extension mock"); };
      window.fetch = async (url, opts) => {
        const body = JSON.parse(opts.body);
        const reply = (o) => new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, ...o }), { headers: { "content-type": "application/json" } });
        const p = body.params ?? {};
        if (body.method === "block") return reply({ result: { header: { hash: BLOCK_HASH, height: 1 } } });
        if (body.method === "query" && p.account_id === "aa5hr.testnet" && p.request_type === "view_access_key")
          return reply({ result: { nonce: 275000000000000, permission: "FullAccess", block_height: 1, block_hash: BLOCK_HASH } });
        if (body.method === "query" && p.account_id === "aa5hr.testnet" && p.request_type === "view_access_key_list")
          return reply({ result: { keys: [{ public_key: PK, access_key: { nonce: 275000000000000, permission: "FullAccess" } }], block_height: 1, block_hash: BLOCK_HASH } });
        if (body.method === "query" && p.account_id === POLICY) {
          if (mock.missing) return reply({ error: { cause: { name: "UNKNOWN_ACCOUNT" } } });
          if (p.request_type === "view_account") return reply({ result: { amount: "1", locked: "0", code_hash: mock.codeHash ?? "8EtC2o7j51xd7ESB6vJJLCA18CPytCcmZ6HETqcSPows", storage_usage: 1, storage_paid_at: 0, block_height: 1, block_hash: BLOCK_HASH } });
          if (p.request_type === "view_access_key_list") return reply({ result: { keys: mock.keys ?? [], block_height: 1, block_hash: BLOCK_HASH } });
          if (p.request_type === "call_function") {
            let v;
            if (p.method_name === "get_config") v = { owner: mock.owner ?? "aa5hr.testnet", paused: false, version: 1 };
            else if (p.method_name === "get_chain") v = "chain" in mock ? mock.chain : CHAIN_NOW;
            else throw new Error("unexpected view " + p.method_name);
            return reply({ result: { result: [...Buffer.from(JSON.stringify(v))], logs: [], block_height: 1, block_hash: BLOCK_HASH } });
          }
        }
        throw new Error(`unexpected RPC call ${body.method} ${JSON.stringify(p)}`);
      };
      let listener = null; const answered = new Set();
      window.meteorCom = {
        addMessageDataListener: (l) => { listener = l; },
        sendMessageData: (data) => {
          if (answered.has(data.uid) || data.status !== "initializing") return;
          answered.add(data.uid); sent.push(data);
          setTimeout(() => {
            if (data.actionType === "login") listener({ uid: data.uid, status: "closed_success", endTags: [], payload: { accountId: loginAccount, allKeys: [PK] } });
            else listener({ uid: data.uid, status: "closed_fail", endTags: ["TEST_MOCK_REJECTED"] });
          }, 20);
        },
        directAction: async () => ({ success: false }),
      };
    },
  });
  const w = dom.window, d = w.document;
  await until(() => d.getElementById("gate").textContent !== "Checking policy-v1...");
  return { w, d, sent };
}
const log = (d) => d.getElementById("log").textContent;
const btn = (d) => d.getElementById("fix");
const nextSign = (sent) => until(() => sent.find((s) => s.actionType === "sign" && !s._seen && (s._seen = true)));
async function connectAs(d, acct) { d.getElementById("connect").click(); await until(() => d.getElementById("account").textContent === acct); await sleep(3000); }

// Phase A: exact_transfer still set. The button unlocks and sends exactly the planned transaction.
{
  const { w, d, sent } = await makePage({ loginAccount: "aa5hr.testnet", mock: {} });
  const plan = w.__walletPage.plan;
  const a0 = plan.FIX.actions[0];
  check(plan.FIX.receiverId === POLICY && plan.FIX.actions.length === 1 && a0.type === "FunctionCall" && a0.deposit === 1n && a0.gas === 30000000000000n, "A: plan = one FunctionCall, 1 yocto, 30 Tgas, to policy-v1");
  check(JSON.stringify(a0.args) === fixture.args, "A: plan args equal the hand-written fixture args");
  const forged = [{ receiverId: "evil.testnet", actions: [a0] },
    { receiverId: POLICY, actions: [{ ...a0, methodName: "set_paused" }] },
    { receiverId: POLICY, actions: [{ ...a0, args: { chain_id: 46630, policy: { ...a0.args.policy, max_fee_per_gas: "999000000000" } } }] },
    { receiverId: POLICY, actions: [{ ...a0, args: { chain_id: 46630, policy: { ...a0.args.policy, exact_transfer: "0x8c726dc9d27902515f70596b7f07610f1bf4ecd2" } } }] },
    { receiverId: POLICY, actions: [{ ...a0, deposit: 2n }] },
    { receiverId: POLICY, actions: [{ type: "Transfer", deposit: 1n }] },
    { receiverId: POLICY, actions: [a0, a0] }];
  check(forged.every((t) => { try { w.__walletPage.toSelectorTx(t); return false; } catch { return true; } }), "A: toSelectorTx refuses other receiver, other method, other fee cap, an exact_transfer address, 2 yocto, Transfer, 2 actions");
  check(btn(d).disabled, "A: button disabled before connect");
  await connectAs(d, "aa5hr.testnet");
  const login = sent.find((s) => s.actionType === "login");
  check(login?.network === "testnet" && (login.inputs.contract_id ?? "") === "", `A: login network=${login?.network}, no contract_id`);
  await until(() => !btn(d).disabled, 20000);
  check(!btn(d).disabled, `A: button unlocked | ${d.getElementById("chain-gate").textContent}`);
  btn(d).click();
  const s = await nextSign(sent);
  if (!s) console.log("PAGE LOG:\n" + log(d));
  check(s?.network === "testnet", "A: sign request network=testnet");
  const t = s?.inputs.transactions.split(",") ?? [];
  check(t.length === 1, "A: one transaction");
  if (t[0]) compare("set_chain", t[0]);
  await until(() => /TEST_MOCK_REJECTED|ERROR/.test(log(d)), 30000);
  check(sent.filter((x) => x.actionType === "sign").length === 1, "A: only 1 sign request reached the wallet");
}
// Phase B: locks failing on purpose. Nothing may reach the wallet, even with a forced click.
const B = {
  cleared: { chain: { ...CHAIN_NOW, exact_transfer: null } },
  otherFees: { chain: { ...CHAIN_NOW, max_fee_per_gas: "2000000000" } },
  noChain: { chain: null },
  badhash: { codeHash: "11111111111111111111111111111111" },
  haskey: { keys: [{ public_key: "ed25519:7qYtkNWa2eS9LP5ZonKPq97HmD6NV5Chj4jkKgcEgEvp", access_key: { nonce: 1, permission: "FullAccess" } }] },
  missing: { missing: true },
  wrongowner: { owner: "someone.testnet" },
};
for (const [mode, mock] of Object.entries(B)) {
  const { d, sent } = await makePage({ loginAccount: "aa5hr.testnet", mock });
  await connectAs(d, "aa5hr.testnet");
  check(btn(d).disabled, `B(${mode}): button locked | ${d.getElementById("chain-gate").textContent}`);
  if (mode === "cleared") check(/Already cleared/.test(d.getElementById("chain-gate").textContent), "B(cleared): page says it is already cleared");
  btn(d).disabled = false; btn(d).click();
  await until(() => /is locked by on-chain state/.test(log(d)), 30000);
  check(/is locked by on-chain state/.test(log(d)), `B(${mode}): forced click refused`);
  check(!sent.some((x) => x.actionType === "sign"), `B(${mode}): no sign request reached the wallet`);
}
// Phase C: wrong account.
{
  const { d, sent } = await makePage({ loginAccount: "someone-else.testnet", mock: {} });
  await connectAs(d, "someone-else.testnet");
  check(btn(d).disabled, "C: button disabled for someone-else.testnet");
  btn(d).disabled = false; btn(d).click();
  await until(() => /refusing to sign/.test(log(d)), 30000);
  check(/refusing to sign/.test(log(d)), "C: forced click refused by the signer guard");
  check(!sent.some((x) => x.actionType === "sign"), "C: no sign request reached the wallet");
}
// Phase D: DEV__METEOR_WALLET_BASE_URL redirect guard.
{
  const { w, d, sent } = await makePage({ loginAccount: "aa5hr.testnet", mock: {} });
  await connectAs(d, "aa5hr.testnet");
  w.localStorage.setItem("DEV__METEOR_WALLET_BASE_URL", "https://evil.example");
  btn(d).disabled = false; btn(d).click();
  await until(() => /DEV__METEOR_WALLET_BASE_URL is set/.test(log(d)), 30000);
  check(/DEV__METEOR_WALLET_BASE_URL is set/.test(log(d)) && !sent.some((x) => x.actionType === "sign"), "D: wallet-redirect override refused, no sign request");
}
console.log(failures ? `\n${failures} FAILED` : "\nALL CHECKS OK");
process.exit(failures ? 1 : 0);
