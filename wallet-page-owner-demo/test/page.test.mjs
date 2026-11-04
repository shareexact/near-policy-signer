// Loads index.html in jsdom with a MOCK Meteor extension (window.meteorCom). No real wallet is opened.
// The mock answers "login" and captures the base64 transactions the Meteor SDK would hand to the extension,
// then answers "closed_fail" (rejected), so nothing is ever signed or broadcast.
// policy-v1's views are mocked in every phase (ticket 1 Pending from fixtures/ticket-1-pending.json, paused false unless set),
// so the test does not depend on the live demo state; aa5hr.testnet's key and the latest block are answered offline too, so no network is needed.
import { JSDOM } from "jsdom";
import fs from "fs";
import { createRequire } from "module";
const nativeFetch = globalThis.fetch; // near-api-js 0.45 replaces global fetch with node-fetch
const require = createRequire(import.meta.url);
// Independent decoder: near-api-js 0.45.1 (devDependency), not the near-js packages the page itself uses.
const { utils, transactions: T } = require("near-api-js");
const expected = JSON.parse(fs.readFileSync(new URL("./fixtures/owner-expected.json", import.meta.url), "utf8")).tx;
const html = fs.readFileSync(new URL("../index.html", import.meta.url), "utf8");
const dec = (b64) => utils.serialize.deserialize(T.SCHEMA, T.Transaction, Buffer.from(b64, "base64"));
const ser = (t) => Buffer.from(utils.serialize.serialize(T.SCHEMA, t)).toString("base64");
const POLICY = "policy-v1.shareexact-chainsig-demo.testnet", PK = "ed25519:9k4yvZ8M7yezqHa6yzDoKr1m9nfv8HER5Bux9NUEmgYf";
let failures = 0;
const check = (cond, msg) => { console.log(`${cond ? "PASS" : "FAIL"} ${msg}`); if (!cond) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 30000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await sleep(100); } return null; }
const describeTx = (t) => t.actions.map((a) => { const k = a.enum, v = a[k];
  return k === "functionCall" ? `functionCall ${v.methodName} gas=${v.gas.toString()} deposit=${v.deposit.toString()} args=${Buffer.from(v.args).toString()}` : k; }).join("; ");
function compare(label, capturedB64, expectedB64) {
  const c = dec(capturedB64), e = dec(expectedB64);
  check(c.signerId === "aa5hr.testnet" && c.signerId === e.signerId, `${label}: signerId ${c.signerId}`);
  check(c.receiverId === POLICY && c.receiverId === e.receiverId, `${label}: receiverId ${c.receiverId}`);
  check(c.publicKey.toString() === PK, `${label}: publicKey ${c.publicKey.toString()}`);
  check(c.actions.length === 1 && c.actions[0].enum === "functionCall", `${label}: exactly one FunctionCall`);
  check(describeTx(c) === describeTx(e), `${label}: ${describeTx(c)}`);
  c.nonce = e.nonce; c.blockHash = e.blockHash; c.publicKey = e.publicKey;
  check(ser(c) === expectedB64, `${label}: borsh bytes identical to fixtures/owner-expected.json after normalising nonce/blockHash`);
}
// The fixture is ticket 1 as read on Nov 2; its expiry is moved to an hour from now so the test does not depend on the date.
const realTicket = { ...JSON.parse(fs.readFileSync(new URL("./fixtures/ticket-1-pending.json", import.meta.url), "utf8")), expires_at: Math.floor(Date.now() / 1000) + 3600 };
// mock: { paused?, ticket?, owner?, codeHash?, keys?, missing? } overrides for policy-v1's views
// Offline RPC for everything the page and the Meteor SDK read besides policy-v1's mocked views:
// aa5hr.testnet's access key (nonce) and the latest block hash. The test needs no network.
const OFFLINE_BLOCK_HASH = "GPkfq5MTJcr3TjLxh7ysgfZA3Ls9QT8NojRUTWpyY4y5";
function offlineRpc(body) {
  const reply = (o) => new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, ...o }), { headers: { "content-type": "application/json" } });
  const p = body.params ?? {};
  if (body.method === "block") return reply({ result: { header: { hash: OFFLINE_BLOCK_HASH, height: 1 } } });
  if (body.method === "query" && p.account_id === "aa5hr.testnet" && p.request_type === "view_access_key")
    return reply({ result: { nonce: 275000000000000, permission: "FullAccess", block_height: 1, block_hash: OFFLINE_BLOCK_HASH } });
  if (body.method === "query" && p.account_id === "aa5hr.testnet" && p.request_type === "view_access_key_list")
    return reply({ result: { keys: [{ public_key: "ed25519:9k4yvZ8M7yezqHa6yzDoKr1m9nfv8HER5Bux9NUEmgYf", access_key: { nonce: 275000000000000, permission: "FullAccess" } }], block_height: 1, block_hash: OFFLINE_BLOCK_HASH } });
  throw new Error(`unexpected RPC call ${body.method} ${JSON.stringify(p)}`);
}

async function makePage({ loginAccount, mock }) {
  const sent = [];
  const dom = new JSDOM(html, {
    url: "http://localhost:8080/", runScripts: "dangerously", pretendToBeVisual: true,
    beforeParse(window) {
      window.confirm = () => true;
      window.open = () => { throw new Error("window.open must not be used with the extension mock"); };
      window.fetch = async (url, opts) => {
        const body = JSON.parse(opts.body);
        if (mock && body.method === "query" && body.params.account_id === POLICY) {
          const reply = (o) => new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, ...o }), { headers: { "content-type": "application/json" } });
          if (mock.missing) return reply({ error: { cause: { name: "UNKNOWN_ACCOUNT" } } });
          const p = body.params;
          if (p.request_type === "view_account") return reply({ result: { amount: "1", locked: "0", code_hash: mock.codeHash ?? "8EtC2o7j51xd7ESB6vJJLCA18CPytCcmZ6HETqcSPows", storage_usage: 1, storage_paid_at: 0, block_height: 1, block_hash: "x" } });
          if (p.request_type === "view_access_key_list") return reply({ result: { keys: mock.keys ?? [], block_height: 1, block_hash: "x" } });
          if (p.request_type === "call_function") {
            let v;
            if (p.method_name === "get_config") v = { owner: mock.owner ?? "aa5hr.testnet", paused: mock.paused ?? false, version: 1 };
            else if (p.method_name === "get_ticket") v = "ticket" in mock ? mock.ticket : realTicket;
            else throw new Error("unexpected view " + p.method_name);
            return reply({ result: { result: [...Buffer.from(JSON.stringify(v))], logs: [], block_height: 1, block_hash: "x" } });
          }
        }
        return offlineRpc(body);
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
const ids = ["approve", "pause", "resume"];
const nextSign = (sent) => until(() => sent.find((s) => s.actionType === "sign" && !s._seen && (s._seen = true)));
const waitN = (d, re, n, ms) => until(() => (log(d).match(re) || []).length >= n, ms);
const state = (d) => ids.map((id) => `${id}=${d.getElementById(id).disabled ? "off" : "on"}`).join(" ");
async function connectAs(d, acct) { d.getElementById("connect").click(); await until(() => d.getElementById("account").textContent === acct); await sleep(8000); }

// Phase A: ticket 1 Pending, paused false. Approve and Pause unlocked, Resume locked.
{
  const { w, d, sent } = await makePage({ loginAccount: "aa5hr.testnet", mock: {} });
  const plan = w.__walletPage.plan;
  check(plan.TICKET_ID === 1 && plan.OWNER.length === 3, "A: plan holds 3 owner transactions, ticket 1");
  check(plan.OWNER.every((t) => t.receiverId === POLICY && t.actions.length === 1 && t.actions.every((a) => a.type === "FunctionCall" && a.deposit === 1n && a.gas === 30000000000000n)), "A: each = one FunctionCall, 1 yocto, 30 Tgas, to policy-v1");
  check(JSON.stringify(plan.OWNER.map((t) => [t.actions[0].methodName, t.actions[0].args])) === JSON.stringify([["approve_ticket", { ticket_id: 1 }], ["set_paused", { paused: true }], ["set_paused", { paused: false }]]), "A: methods/args = approve_ticket{ticket_id:1}, set_paused{paused:true}, set_paused{paused:false}");
  const forged = [{ receiverId: "evil.testnet", actions: [{ type: "FunctionCall", methodName: "set_paused", args: {}, gas: 30000000000000n, deposit: 1n }] },
    { receiverId: POLICY, actions: [{ type: "FunctionCall", methodName: "set_owner", args: {}, gas: 30000000000000n, deposit: 1n }] },
    { receiverId: POLICY, actions: [{ type: "FunctionCall", methodName: "approve_ticket", args: { ticket_id: 1 }, gas: 30000000000000n, deposit: 2n }] },
    { receiverId: POLICY, actions: [{ type: "Transfer", deposit: 1n }] },
    { receiverId: POLICY, actions: [plan.OWNER[0].actions[0], plan.OWNER[1].actions[0]] }];
  check(forged.every((t) => { try { w.__walletPage.toSelectorTx(t); return false; } catch { return true; } }), "A: toSelectorTx refuses other receiver, other method, 2 yocto, Transfer, 2 actions");
  check(ids.every((id) => d.getElementById(id).disabled), "A: buttons disabled before connect");
  await connectAs(d, "aa5hr.testnet");
  const login = sent.find((s) => s.actionType === "login");
  check(login?.network === "testnet" && (login.inputs.contract_id ?? "") === "", `A: login network=${login?.network}, no contract_id`);
  await until(() => state(d) === "approve=on pause=on resume=off", 20000);
  check(state(d) === "approve=on pause=on resume=off", `A: ${state(d)} | ${d.getElementById("approve-gate").textContent} | ${d.getElementById("pause-gate").textContent}`);
  d.getElementById("approve").click();
  let s = await nextSign(sent); check(s?.network === "testnet", "A: approve sign request network=testnet");
  let t = s.inputs.transactions.split(","); check(t.length === 1, "A: approve sends one transaction");
  compare("approve_ticket", t[0], expected.o1_approve_ticket); await waitN(d, /TEST_MOCK_REJECTED|ERROR/g, 1);
  d.getElementById("pause").click();
  s = await nextSign(sent); t = s.inputs.transactions.split(","); check(t.length === 1, "A: pause sends one transaction");
  compare("set_paused true", t[0], expected.o2_pause); await waitN(d, /TEST_MOCK_REJECTED|ERROR/g, 2);
  d.getElementById("resume").disabled = false; d.getElementById("resume").click();
  await waitN(d, /is locked by on-chain state/g, 1, 30000);
  check(/set_paused false \(resume\) is locked/.test(log(d)), "A: forced Resume click refused while not paused");
  check(sent.filter((x) => x.actionType === "sign").length === 2, "A: only 2 sign requests reached the wallet");
}
// Phase A2: contract paused (mocked). Resume unlocked, Pause locked.
{
  const { d, sent } = await makePage({ loginAccount: "aa5hr.testnet", mock: { paused: true } });
  await connectAs(d, "aa5hr.testnet");
  await until(() => state(d) === "approve=on pause=off resume=on", 20000);
  check(state(d) === "approve=on pause=off resume=on", `A2(paused): ${state(d)}`);
  d.getElementById("resume").click();
  const s = await nextSign(sent); const t = s.inputs.transactions.split(",");
  check(t.length === 1, "A2: resume sends one transaction"); compare("set_paused false", t[0], expected.o3_resume);
}
// Phase B: locks failing on purpose.
const now = Math.floor(Date.now() / 1000);
const B = { badhash: { codeHash: "11111111111111111111111111111111" }, haskey: { keys: [{ public_key: "ed25519:7qYtkNWa2eS9LP5ZonKPq97HmD6NV5Chj4jkKgcEgEvp", access_key: { nonce: 1, permission: "FullAccess" } }] },
  missing: { missing: true }, wrongowner: { owner: "someone.testnet" }, ticketApproved: { ticket: { ...realTicket, status: "Approved" } },
  ticketExpired: { ticket: { ...realTicket, expires_at: now - 10 } }, ticketGone: { ticket: null } };
for (const [mode, mock] of Object.entries(B)) {
  const { d, sent } = await makePage({ loginAccount: "aa5hr.testnet", mock });
  await connectAs(d, "aa5hr.testnet");
  const ticketOnly = mode.startsWith("ticket");
  check(ticketOnly ? state(d) === "approve=off pause=on resume=off" : ids.every((id) => d.getElementById(id).disabled), `B(${mode}): ${state(d)}`);
  d.getElementById("approve").disabled = false; d.getElementById("approve").click();
  if (!ticketOnly) { d.getElementById("pause").disabled = false; d.getElementById("pause").click(); }
  const n = ticketOnly ? 1 : 2;
  await waitN(d, /is locked by on-chain state/g, n, 30000);
  check((log(d).match(/is locked by on-chain state/g) || []).length >= n, `B(${mode}): forced clicks refused`);
  check(!sent.some((x) => x.actionType === "sign"), `B(${mode}): no sign request reached the wallet`);
}
// Phase C: wrong account.
{
  const { d, sent } = await makePage({ loginAccount: "someone-else.testnet", mock: {} });
  await connectAs(d, "someone-else.testnet");
  check(ids.every((id) => d.getElementById(id).disabled), "C: all buttons disabled for someone-else.testnet");
  d.getElementById("approve").disabled = false; d.getElementById("approve").click();
  await until(() => /refusing to sign/.test(log(d)), 30000);
  check(/refusing to sign/.test(log(d)), "C: forced click refused by the signer guard");
  check(!sent.some((x) => x.actionType === "sign"), "C: no sign request reached the wallet");
}
// Phase D: DEV__METEOR_WALLET_BASE_URL redirect guard.
{
  const { w, d, sent } = await makePage({ loginAccount: "aa5hr.testnet", mock: {} });
  await connectAs(d, "aa5hr.testnet");
  w.localStorage.setItem("DEV__METEOR_WALLET_BASE_URL", "https://evil.example");
  d.getElementById("approve").disabled = false; d.getElementById("approve").click();
  await until(() => /DEV__METEOR_WALLET_BASE_URL is set/.test(log(d)), 30000);
  check(/DEV__METEOR_WALLET_BASE_URL is set/.test(log(d)) && !sent.some((x) => x.actionType === "sign"), "D: wallet-redirect override refused, no sign request");
}
console.log(failures ? `\n${failures} FAILED` : "\nALL CHECKS OK");
process.exit(failures ? 1 : 0);
