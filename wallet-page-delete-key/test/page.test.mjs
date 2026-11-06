// Loads index.html in jsdom with a MOCK Meteor extension (window.meteorCom). No real wallet is opened.
// The mock answers "login" and captures the base64 transactions the Meteor SDK would hand to the extension,
// then answers "closed_fail" (rejected), so nothing is ever signed or broadcast. Every RPC call is answered offline.
import { JSDOM } from "jsdom";
import fs from "fs";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
// Independent decoder: near-api-js 0.45.1 (devDependency), not the near-js packages the page itself uses.
const { utils, transactions: T } = require("near-api-js");
const fixture = JSON.parse(fs.readFileSync(new URL("./fixtures/delete-key-expected.json", import.meta.url), "utf8"));
const expected = fixture.tx.k1_delete_key;
const html = fs.readFileSync(new URL("../index.html", import.meta.url), "utf8");
const dec = (b64) => utils.serialize.deserialize(T.SCHEMA, T.Transaction, Buffer.from(b64, "base64"));
const ser = (t) => Buffer.from(utils.serialize.serialize(T.SCHEMA, t)).toString("base64");
const OWNER = "aa5hr.testnet";
const KEEP = "ed25519:9k4yvZ8M7yezqHa6yzDoKr1m9nfv8HER5Bux9NUEmgYf", DEL = "ed25519:CY9aCwrmVaPMzMJLbxAxFGwGhEKgSgar5UKuVqLGZcaQ";
const OTHER = "ed25519:7qYtkNWa2eS9LP5ZonKPq97HmD6NV5Chj4jkKgcEgEvp";
const BLOCK_HASH = utils.serialize.base_encode(Buffer.alloc(32, 7));
const full = (pk) => ({ public_key: pk, access_key: { nonce: 275000000000000, permission: "FullAccess" } });
const fcKey = (pk) => ({ public_key: pk, access_key: { nonce: 1, permission: { FunctionCall: { allowance: null, receiver_id: "x.testnet", method_names: [] } } } });
let failures = 0;
const check = (cond, msg) => { console.log(`${cond ? "PASS" : "FAIL"} ${msg}`); if (!cond) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 30000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await sleep(100); } return null; }
const FAST = "test.rpc.fastnear.com", NEARORG = "rpc.testnet.near.org";

// mock: { keys?, down?: [host], jsonError?: [host] } for the page's own reads of aa5hr.testnet's key list
async function makePage({ loginAccount, mock: m0 }) {
  const mock = { keys: [full(KEEP), full(DEL)], hosts: [], ...m0 };
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
        const host = new URL(url).host;
        if (body.method === "block") return reply({ result: { header: { hash: BLOCK_HASH, height: 1 } } });
        if (body.method === "query" && p.account_id === OWNER && p.request_type === "view_access_key")
          return reply({ result: { nonce: 275000000000000, permission: "FullAccess", block_height: 1, block_hash: BLOCK_HASH } });
        if (body.method === "query" && p.account_id === OWNER && p.request_type === "view_access_key_list") {
          mock.hosts.push(host);
          if ((mock.down ?? []).includes(host)) return new Response("rate limited", { status: 429 });
          if ((mock.jsonError ?? []).includes(host)) return reply({ error: { name: "HANDLER_ERROR", cause: { name: "TOO_MANY_REQUESTS" } } });
          return reply({ result: { keys: mock.keys, block_height: 1, block_hash: BLOCK_HASH } });
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
            if (data.actionType === "login") listener({ uid: data.uid, status: "closed_success", endTags: [], payload: { accountId: loginAccount, allKeys: [KEEP] } });
            else listener({ uid: data.uid, status: "closed_fail", endTags: ["TEST_MOCK_REJECTED"] });
          }, 20);
        },
        directAction: async () => ({ success: false }),
      };
    },
  });
  const w = dom.window, d = w.document;
  await until(() => d.getElementById("gate").textContent !== "Checking aa5hr.testnet...");
  return { w, d, sent, mock };
}
const log = (d) => d.getElementById("log").textContent;
const btn = (d) => d.getElementById("del");
const gate = (d) => d.getElementById("gate").textContent;
const nextSign = (sent) => until(() => sent.find((s) => s.actionType === "sign" && !s._seen && (s._seen = true)));
async function connectAs(d, acct) { d.getElementById("connect").click(); await until(() => d.getElementById("account").textContent === acct); await sleep(3000); }

// Phase A: both keys present. The button unlocks and sends exactly the planned transaction.
{
  const { w, d, sent, mock } = await makePage({ loginAccount: OWNER, mock: {} });
  const plan = w.__walletPage.plan;
  const a0 = plan.DEL.actions[0];
  check(plan.DEL.receiverId === OWNER && plan.DEL.actions.length === 1 && a0.type === "DeleteKey" && a0.publicKey === DEL, "A: plan = aa5hr.testnet to itself, one DeleteKey CY9a...");
  check(fixture.deleted === DEL, "A: the hand-written fixture deletes the same key");
  check(mock.hosts.length > 0 && mock.hosts.every((h) => h === FAST), `A: reads go to ${FAST} first`);
  const forged = [
    { receiverId: "evil.testnet", actions: [a0] },
    { receiverId: OWNER, actions: [{ type: "DeleteKey", publicKey: KEEP }] },
    { receiverId: OWNER, actions: [{ type: "DeleteKey", publicKey: OTHER }] },
    { receiverId: OWNER, actions: [a0, a0] },
    { receiverId: OWNER, actions: [{ type: "AddKey", publicKey: OTHER }] },
    { receiverId: OWNER, actions: [{ type: "Transfer", deposit: 1n }] },
    { receiverId: OWNER, actions: [{ type: "DeleteAccount", beneficiaryId: "evil.testnet" }] },
    { receiverId: OWNER, actions: [{ type: "FunctionCall", methodName: "x", args: {}, gas: 1n, deposit: 0n }] },
  ];
  check(forged.every((t) => { try { w.__walletPage.toSelectorTx(t); return false; } catch { return true; } }), "A: toSelectorTx refuses another receiver, deleting 9k4y..., another key, 2 actions, AddKey, Transfer, DeleteAccount, FunctionCall");
  check(btn(d).disabled, "A: button disabled before connect");
  await connectAs(d, OWNER);
  const login = sent.find((s) => s.actionType === "login");
  check(login?.network === "testnet" && (login.inputs.contract_id ?? "") === "", `A: login network=${login?.network}, no contract_id`);
  await until(() => !btn(d).disabled, 20000);
  check(!btn(d).disabled && /Unlocked/.test(gate(d)), `A: button unlocked | ${gate(d)}`);
  btn(d).click();
  const s = await nextSign(sent);
  if (!s) console.log("PAGE LOG:\n" + log(d));
  check(s?.network === "testnet", "A: sign request network=testnet");
  const t = s?.inputs.transactions.split(",") ?? [];
  check(t.length === 1, "A: one transaction");
  if (t[0]) {
    const c = dec(t[0]), e = dec(expected);
    check(c.signerId === OWNER && c.receiverId === OWNER, `A: signer ${c.signerId}, receiver ${c.receiverId}`);
    check(c.publicKey.toString() === KEEP, `A: signed with ${c.publicKey.toString()}`);
    check(c.actions.length === 1 && c.actions[0].enum === "deleteKey" && c.actions[0].deleteKey.publicKey.toString() === DEL, `A: one DeleteKey of ${c.actions[0]?.deleteKey?.publicKey?.toString()}`);
    c.nonce = e.nonce; c.blockHash = e.blockHash;
    check(ser(c) === expected, "A: borsh bytes identical to fixtures/delete-key-expected.json after normalising nonce/blockHash");
  }
  await until(() => /TEST_MOCK_REJECTED|ERROR/.test(log(d)), 30000);
  check(sent.filter((x) => x.actionType === "sign").length === 1, "A: only 1 sign request reached the wallet");
}
// Phase B: locks failing on purpose. Nothing may reach the wallet, even with a forced click.
const B = {
  alreadyDeleted: { keys: [full(KEEP)] },
  keepIsFunctionCall: { keys: [fcKey(KEEP), full(DEL)] },
  keepMissing: { keys: [full(OTHER), full(DEL)] },
  bothDown: { down: [FAST, NEARORG] },
  httpThenJsonError: { down: [FAST], jsonError: [NEARORG] },
};
for (const [mode, mock] of Object.entries(B)) {
  const { d, sent } = await makePage({ loginAccount: OWNER, mock });
  await connectAs(d, OWNER);
  check(btn(d).disabled, `B(${mode}): button locked | ${gate(d)}`);
  if (mode === "alreadyDeleted") check(/already deleted/.test(gate(d)), "B(alreadyDeleted): page says so");
  if (mode.startsWith("keep")) check(/^.*Locked: 9k4y/.test(gate(d)), `B(${mode}): page names the reason`);
  if (/Down|Error/.test(mode)) check(/^Could not read the chain/.test(gate(d)) && /ERROR reading the chain/.test(log(d)), `B(${mode}): page says it could not read the chain`);
  btn(d).disabled = false; btn(d).click();
  await until(() => /is locked by on-chain state|ERROR: /.test(log(d)), 30000);
  check(!sent.some((x) => x.actionType === "sign"), `B(${mode}): forced click: no sign request reached the wallet`);
}
// Phase B2: the first endpoint is rate limited; the second answers.
{
  const { d, mock } = await makePage({ loginAccount: OWNER, mock: { down: [FAST] } });
  await connectAs(d, OWNER);
  await until(() => !btn(d).disabled, 20000);
  check(!btn(d).disabled && mock.hosts.includes(NEARORG), `B2(${FAST} answers 429): read from ${NEARORG}, unlocked`);
}
// Phase C: wrong account.
{
  const { d, sent } = await makePage({ loginAccount: "someone-else.testnet", mock: {} });
  await connectAs(d, "someone-else.testnet");
  check(btn(d).disabled, "C: button disabled for someone-else.testnet");
  btn(d).disabled = false; btn(d).click();
  await until(() => /refusing to sign/.test(log(d)), 30000);
  check(/refusing to sign/.test(log(d)) && !sent.some((x) => x.actionType === "sign"), "C: forced click refused by the signer guard");
}
// Phase D: DEV__METEOR_WALLET_BASE_URL redirect guard.
{
  const { w, d, sent } = await makePage({ loginAccount: OWNER, mock: {} });
  await connectAs(d, OWNER);
  w.localStorage.setItem("DEV__METEOR_WALLET_BASE_URL", "https://evil.example");
  btn(d).disabled = false; btn(d).click();
  await until(() => /DEV__METEOR_WALLET_BASE_URL is set/.test(log(d)), 30000);
  check(/DEV__METEOR_WALLET_BASE_URL is set/.test(log(d)) && !sent.some((x) => x.actionType === "sign"), "D: wallet-redirect override refused, no sign request");
}
console.log(failures ? `\n${failures} FAILED` : "\nALL CHECKS OK");
process.exit(failures ? 1 : 0);
