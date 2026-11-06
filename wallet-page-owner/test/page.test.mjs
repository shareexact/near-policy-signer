// Loads index.html in jsdom with a MOCK Meteor extension (window.meteorCom). No real wallet is opened.
// The mock answers "login" and captures the base64 transactions the Meteor SDK would hand to the extension,
// then answers "closed_fail" (rejected), so nothing is ever signed or broadcast. Every RPC call is answered offline.
import { JSDOM } from "jsdom";
import fs from "fs";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
// Independent decoder: near-api-js 0.45.1 (devDependency), not the near-js packages the page itself uses.
const { utils, transactions: T } = require("near-api-js");
const html = fs.readFileSync(new URL("../index.html", import.meta.url), "utf8");
const fixture = JSON.parse(fs.readFileSync(new URL("./fixtures/owner-expected.json", import.meta.url), "utf8"));
const dec = (b64) => utils.serialize.deserialize(T.SCHEMA, T.Transaction, Buffer.from(b64, "base64"));
const ser = (t) => Buffer.from(utils.serialize.serialize(T.SCHEMA, t)).toString("base64");
const POLICY = "policy-v1.shareexact-chainsig-demo.testnet", PK = "ed25519:9k4yvZ8M7yezqHa6yzDoKr1m9nfv8HER5Bux9NUEmgYf";
const UPGRADED = "E1xgsbWL3TwTefBKFAUdLoKiuYME2zEw938T8ycsnbPF", OLD = "8EtC2o7j51xd7ESB6vJJLCA18CPytCcmZ6HETqcSPows";
const BOB = "0xb0b0000000000000000000000000000000000b0b", ALICE = "0x0c7f5b0f2cba6a576f92f60205e87f4d28080490";
const BLOCK_HASH = utils.serialize.base_encode(Buffer.alloc(32, 7));
let failures = 0;
const check = (cond, msg) => { console.log(`${cond ? "PASS" : "FAIL"} ${msg}`); if (!cond) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 30000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await sleep(100); } return null; }
const now = () => Math.floor(Date.now() / 1000);
const ticket = (id, status, expiresIn = 3600) => ({ id, agent: "agent-v1.shareexact-chainsig-demo.testnet", chain_id: 46630, token: "0x0000000000000000000000000000000000000000", recipient: ALICE, amount: "800000000000000", cap_amount: "800000000000000", status, created_at: now() - 60, expires_at: now() + expiresIn });
const DEFAULT = {
  codeHash: UPGRADED, keys: [], owner: "aa5hr.testnet", paused: false, delay: 3600, bobAllowed: false,
  tickets: [ticket(1, "Approved"), ticket(2, "Pending"), ticket(3, "Pending")],
  scheduled: [],
};
const bobChange = { id: 7, change: { AllowRecipient: { chain_id: 46630, recipient: BOB } }, executable_at: now() + 3500 };

async function makePage({ loginAccount, mock: m0 }) {
  const mock = { ...DEFAULT, hosts: [], ...m0 };
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
        if (p.account_id === POLICY) mock.hosts.push(host);
        if (p.account_id === POLICY && (mock.down ?? []).includes(host)) return new Response("rate limited", { status: 429 });
        if (p.account_id === POLICY && (mock.jsonError ?? []).includes(host)) return reply({ error: { name: "HANDLER_ERROR", cause: { name: "TOO_MANY_REQUESTS" } } });
        if (p.account_id === POLICY && p.method_name && p.method_name === mock.viewError) return reply({ result: { error: "wasm execution failed", logs: [], block_height: 1, block_hash: BLOCK_HASH } });
        if (body.method === "block") return reply({ result: { header: { hash: BLOCK_HASH, height: 1 } } });
        if (body.method === "query" && p.account_id === "aa5hr.testnet" && p.request_type === "view_access_key")
          return reply({ result: { nonce: 275000000000000, permission: "FullAccess", block_height: 1, block_hash: BLOCK_HASH } });
        if (body.method === "query" && p.account_id === "aa5hr.testnet" && p.request_type === "view_access_key_list")
          return reply({ result: { keys: [{ public_key: PK, access_key: { nonce: 275000000000000, permission: "FullAccess" } }], block_height: 1, block_hash: BLOCK_HASH } });
        if (body.method === "query" && p.account_id === POLICY) {
          if (mock.missing) return reply({ error: { cause: { name: "UNKNOWN_ACCOUNT" } } });
          if (p.request_type === "view_account") return reply({ result: { amount: "1", locked: "0", code_hash: mock.codeHash, storage_usage: 1, storage_paid_at: 0, block_height: 1, block_hash: BLOCK_HASH } });
          if (p.request_type === "view_access_key_list") return reply({ result: { keys: mock.keys, block_height: 1, block_hash: BLOCK_HASH } });
          if (p.request_type === "call_function") {
            const v = {
              get_config: { owner: mock.owner, paused: mock.paused, version: 1, params: { policy_delay_s: mock.delay } },
              list_tickets: mock.tickets,
              list_scheduled_changes: mock.scheduled,
              is_recipient_allowed: mock.bobAllowed,
            }[p.method_name];
            if (v === undefined) throw new Error("unexpected view " + p.method_name);
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
  return { w, d, sent, mock };
}
const ids = ["approve", "pause", "resume", "schedule", "cancel"];
const log = (d) => d.getElementById("log").textContent;
const state = (d) => ids.map((id) => `${id}=${d.getElementById(id).disabled ? "off" : "on"}`).join(" ");
const nextSign = (sent) => until(() => sent.find((s) => s.actionType === "sign" && !s._seen && (s._seen = true)));
async function connectAs(d, acct) { d.getElementById("connect").click(); await until(() => d.getElementById("account").textContent === acct); await sleep(3000); }
async function clickAndCompare(d, sent, button, key) {
  d.getElementById(button).click();
  const s = await nextSign(sent);
  const t = s?.inputs.transactions.split(",") ?? [];
  check(t.length === 1, `${key}: one transaction reached the wallet`);
  if (t.length !== 1) return;
  const c = dec(t[0]), e = dec(fixture.tx[key]);
  const fc = c.actions[0].functionCall;
  check(c.signerId === "aa5hr.testnet" && c.receiverId === POLICY && c.publicKey.toString() === PK, `${key}: signer, receiver, key`);
  check(fc.methodName === fixture.calls[key][0] && Buffer.from(fc.args).toString() === fixture.calls[key][1], `${key}: ${fc.methodName} ${Buffer.from(fc.args).toString()}`);
  c.nonce = e.nonce; c.blockHash = e.blockHash;
  check(ser(c) === fixture.tx[key], `${key}: borsh bytes identical to the fixture after normalising nonce and block hash`);
  await until(() => (log(d).match(/TEST_MOCK_REJECTED|ERROR/g) || []).length >= 1, 30000);
}

// Phase A: upgraded, delay on, two pending tickets, not paused, nothing scheduled.
{
  const { w, d, sent } = await makePage({ loginAccount: "aa5hr.testnet", mock: {} });
  check(state(d) === "approve=off pause=off resume=off schedule=off cancel=off", "A: all locked before connect");
  await connectAs(d, "aa5hr.testnet");
  const login = sent.find((s) => s.actionType === "login");
  check(login?.network === "testnet" && (login.inputs.contract_id ?? "") === "", `A: login network=${login?.network}, no contract_id`);
  await until(() => state(d) === "approve=on pause=on resume=off schedule=on cancel=off", 20000);
  check(state(d) === "approve=on pause=on resume=off schedule=on cancel=off", `A: ${state(d)}`);
  check(/Newest pending ticket: 3/.test(d.getElementById("approve-gate").textContent), "A: the newest pending ticket is 3");
  const forged = [
    { receiverId: POLICY, actions: [{ type: "FunctionCall", methodName: "approve_ticket", args: { ticket_id: 2 }, gas: 30000000000000n, deposit: 1n }] },
    { receiverId: POLICY, actions: [{ type: "FunctionCall", methodName: "set_recipient", args: { chain_id: 46630, recipient: "0x1111111111111111111111111111111111111111", allowed: true }, gas: 30000000000000n, deposit: 1n }] },
    { receiverId: POLICY, actions: [{ type: "FunctionCall", methodName: "cancel_change", args: { change_id: 7 }, gas: 30000000000000n, deposit: 1n }] },
    { receiverId: POLICY, actions: [{ type: "FunctionCall", methodName: "set_paused", args: { paused: "yes" }, gas: 30000000000000n, deposit: 1n }] },
    { receiverId: POLICY, actions: [{ type: "FunctionCall", methodName: "propose_owner", args: { new_owner: "evil.testnet" }, gas: 30000000000000n, deposit: 1n }] },
    { receiverId: "evil.testnet", actions: [{ type: "FunctionCall", methodName: "set_paused", args: { paused: true }, gas: 30000000000000n, deposit: 1n }] },
    { receiverId: POLICY, actions: [{ type: "FunctionCall", methodName: "set_paused", args: { paused: true }, gas: 30000000000000n, deposit: 2n }] },
    { receiverId: POLICY, actions: [{ type: "Transfer", deposit: 1n }] },
  ];
  check(forged.every((t) => { try { w.__walletPage.toSelectorTx(t); return false; } catch { return true; } }),
    "A: refuses another ticket, another recipient, a change not scheduled, bad args, other methods, other receiver, 2 yocto, Transfer");
  await clickAndCompare(d, sent, "approve", "approve");
  await clickAndCompare(d, sent, "pause", "pause");
  await clickAndCompare(d, sent, "schedule", "schedule");
  d.getElementById("resume").disabled = false; d.getElementById("resume").click();
  d.getElementById("cancel").disabled = false; d.getElementById("cancel").click();
  await until(() => (log(d).match(/is locked by on-chain state/g) || []).length >= 2, 30000);
  check((log(d).match(/is locked by on-chain state/g) || []).length >= 2, "A: forced resume (not paused) and cancel (nothing scheduled) refused");
  check(sent.filter((x) => x.actionType === "sign").length === 3, "A: exactly 3 sign requests reached the wallet");
}
// Phase B: paused, bob's change scheduled (id 7), no pending ticket.
{
  const { d, sent } = await makePage({ loginAccount: "aa5hr.testnet", mock: { paused: true, scheduled: [bobChange], tickets: [ticket(1, "Approved"), ticket(4, "Pending", -10)] } });
  await connectAs(d, "aa5hr.testnet");
  await until(() => state(d) === "approve=off pause=off resume=on schedule=off cancel=on", 20000);
  check(state(d) === "approve=off pause=off resume=on schedule=off cancel=on", `B: ${state(d)} (expired ticket 4 is not approvable)`);
  await clickAndCompare(d, sent, "resume", "resume");
  await clickAndCompare(d, sent, "cancel", "cancel");
}
// Phase C: locks failing on purpose.
const C = {
  notUpgraded: { codeHash: OLD },
  haskey: { keys: [{ public_key: "ed25519:7qYtkNWa2eS9LP5ZonKPq97HmD6NV5Chj4jkKgcEgEvp", access_key: { nonce: 1, permission: "FullAccess" } }] },
  wrongowner: { owner: "someone.testnet" },
  missing: { missing: true },
};
for (const [mode, mock] of Object.entries(C)) {
  const { d, sent } = await makePage({ loginAccount: "aa5hr.testnet", mock });
  await connectAs(d, "aa5hr.testnet");
  check(state(d) === "approve=off pause=off resume=off schedule=off cancel=off", `C(${mode}): ${state(d)}`);
  for (const id of ids) { d.getElementById(id).disabled = false; }
  d.getElementById("pause").click(); d.getElementById("schedule").click();
  await until(() => (log(d).match(/is locked by on-chain state/g) || []).length >= 2, 30000);
  check(!sent.some((x) => x.actionType === "sign"), `C(${mode}): forced clicks: no sign request`);
}
for (const [mode, mock] of Object.entries({ delayOff: { delay: 0 }, bobAlready: { bobAllowed: true } })) {
  const { d, sent } = await makePage({ loginAccount: "aa5hr.testnet", mock });
  await connectAs(d, "aa5hr.testnet");
  check(d.getElementById("schedule").disabled, `C(${mode}): schedule locked | ${d.getElementById("delay-gate").textContent}`);
  d.getElementById("schedule").disabled = false; d.getElementById("schedule").click();
  await until(() => /is locked by on-chain state/.test(log(d)), 30000);
  check(!sent.some((x) => x.actionType === "sign"), `C(${mode}): forced schedule: no sign request`);
}
// Phase D: wrong account, and the wallet-redirect override.
{
  const { d, sent } = await makePage({ loginAccount: "someone-else.testnet", mock: {} });
  await connectAs(d, "someone-else.testnet");
  check(state(d) === "approve=off pause=off resume=off schedule=off cancel=off", "D: all locked for someone-else.testnet");
  d.getElementById("pause").disabled = false; d.getElementById("pause").click();
  await until(() => /refusing to sign/.test(log(d)), 30000);
  check(/refusing to sign/.test(log(d)) && !sent.some((x) => x.actionType === "sign"), "D: forced click refused by the signer guard");
}
{
  const { w, d, sent } = await makePage({ loginAccount: "aa5hr.testnet", mock: {} });
  await connectAs(d, "aa5hr.testnet");
  w.localStorage.setItem("DEV__METEOR_WALLET_BASE_URL", "https://evil.example");
  d.getElementById("pause").disabled = false; d.getElementById("pause").click();
  await until(() => /DEV__METEOR_WALLET_BASE_URL is set/.test(log(d)), 30000);
  check(/DEV__METEOR_WALLET_BASE_URL is set/.test(log(d)) && !sent.some((x) => x.actionType === "sign"), "D: wallet-redirect override refused");
}
// Phase E: RPC trouble. A rate-limited first endpoint falls through to the second; an error is never read as an empty answer.
const FAST = "test.rpc.fastnear.com", NEARORG = "rpc.testnet.near.org";
{
  const { d, mock } = await makePage({ loginAccount: "aa5hr.testnet", mock: {} });
  check(mock.hosts.length > 0 && mock.hosts.every((h) => h === FAST), `E: reads go to ${FAST} first (${[...new Set(mock.hosts)]})`);
}
{
  const { d, mock } = await makePage({ loginAccount: "aa5hr.testnet", mock: { down: [FAST] } });
  await connectAs(d, "aa5hr.testnet");
  await until(() => state(d) === "approve=on pause=on resume=off schedule=on cancel=off", 20000);
  check(state(d) === "approve=on pause=on resume=off schedule=on cancel=off" && mock.hosts.includes(NEARORG), `E(${FAST} answers 429): read from ${NEARORG}, ${state(d)}`);
}
for (const [mode, m] of Object.entries({
  bothDown: { down: [FAST, NEARORG] },
  httpThenJsonError: { down: [FAST], jsonError: [NEARORG] },
  scheduledViewFails: { scheduled: [bobChange], viewError: "list_scheduled_changes" },
})) {
  const { d, sent } = await makePage({ loginAccount: "aa5hr.testnet", mock: m });
  await connectAs(d, "aa5hr.testnet");
  const gate = d.getElementById("gate").textContent, dg = d.getElementById("delay-gate").textContent;
  check(state(d) === "approve=off pause=off resume=off schedule=off cancel=off", `E(${mode}): all locked, ${state(d)}`);
  check(/^Could not read the chain/.test(gate) && /^Unknown/.test(dg) && /ERROR reading the chain/.test(log(d)), `E(${mode}): says so | ${gate.slice(0, 110)}`);
  check(!/nothing scheduled/.test(dg), `E(${mode}): an RPC error is not shown as "nothing scheduled"`);
  d.getElementById("schedule").disabled = false; d.getElementById("schedule").click();
  await until(() => (log(d).match(/ERROR/g) || []).length >= 3, 30000);
  check(!sent.some((x) => x.actionType === "sign"), `E(${mode}): forced schedule: no sign request`);
}
console.log(failures ? `\n${failures} FAILED` : "\nALL CHECKS OK");
process.exit(failures ? 1 : 0);
