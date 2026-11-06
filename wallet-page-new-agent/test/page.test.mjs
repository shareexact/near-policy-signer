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
const fixture = JSON.parse(fs.readFileSync(new URL("./fixtures/new-agent-expected.json", import.meta.url), "utf8"));
const dec = (b64) => utils.serialize.deserialize(T.SCHEMA, T.Transaction, Buffer.from(b64, "base64"));
const ser = (t) => Buffer.from(utils.serialize.serialize(T.SCHEMA, t)).toString("base64");
const POLICY = "policy-v1.shareexact-chainsig-demo.testnet", PK = "ed25519:9k4yvZ8M7yezqHa6yzDoKr1m9nfv8HER5Bux9NUEmgYf";
const AGENT = "policy-signer-agent-v2.testnet", AGENT_PK = "ed25519:7qYtkNWa2eS9LP5ZonKPq97HmD6NV5Chj4jkKgcEgEvp";
const UPGRADED = "E1xgsbWL3TwTefBKFAUdLoKiuYME2zEw938T8ycsnbPF";
const BLOCK_HASH = utils.serialize.base_encode(Buffer.alloc(32, 7));
let failures = 0;
const check = (cond, msg) => { console.log(`${cond ? "PASS" : "FAIL"} ${msg}`); if (!cond) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 30000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await sleep(100); } return null; }
const now = () => Math.floor(Date.now() / 1000);
const full = (pk) => ({ public_key: pk, access_key: { nonce: 0, permission: "FullAccess" } });
const reqKey = (pk, recv = POLICY, methods = ["request"]) => ({ public_key: pk, access_key: { nonce: 0, permission: { FunctionCall: { allowance: "250000000000000000000000", receiver_id: recv, method_names: methods } } } });
const POLICY_V2 = { enabled: true, label: "demo agent v2", max_requests_per_day: 20 };
const setAgent = (id, at, policy = POLICY_V2) => ({ id, change: { SetAgent: { agent: AGENT, policy } }, executable_at: at });
const DEFAULT = { codeHash: UPGRADED, keys: [], owner: "aa5hr.testnet", delay: 3600, agentKeys: null, registered: null, scheduled: [], agentIn: AGENT, pkIn: AGENT_PK };

async function makePage({ loginAccount = "aa5hr.testnet", mock: m0 = {} } = {}) {
  const mock = { ...DEFAULT, ...m0 };
  const sent = [];
  const dom = new JSDOM(html, {
    url: "http://localhost:8080/", runScripts: "dangerously", pretendToBeVisual: true,
    beforeParse(window) {
      window.localStorage.setItem("nps-agent", mock.agentIn); window.localStorage.setItem("nps-agent-pk", mock.pkIn);
      window.confirm = () => true;
      window.open = () => { throw new Error("window.open must not be used with the extension mock"); };
      window.fetch = async (url, opts) => {
        const body = JSON.parse(opts.body);
        const reply = (o) => new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, ...o }), { headers: { "content-type": "application/json" } });
        const p = body.params ?? {};
        if ((mock.down ?? []).includes(new URL(url).host)) return new Response("rate limited", { status: 429 });
        if (body.method === "block") return reply({ result: { header: { hash: BLOCK_HASH, height: 1 } } });
        if (body.method === "query" && p.account_id === "aa5hr.testnet" && p.request_type === "view_access_key")
          return reply({ result: { nonce: 275000000000000, permission: "FullAccess", block_height: 1, block_hash: BLOCK_HASH } });
        if (body.method === "query" && p.account_id === "aa5hr.testnet" && p.request_type === "view_access_key_list")
          return reply({ result: { keys: [full(PK)], block_height: 1, block_hash: BLOCK_HASH } });
        if (body.method === "query" && p.account_id === mock.agentIn && p.request_type === "view_access_key_list")
          return mock.agentKeys ? reply({ result: { keys: mock.agentKeys, block_height: 1, block_hash: BLOCK_HASH } }) : reply({ error: { name: "HANDLER_ERROR", cause: { name: "UNKNOWN_ACCOUNT" } } });
        if (body.method === "query" && p.account_id === POLICY) {
          if (p.request_type === "view_account") return reply({ result: { amount: "1", locked: "0", code_hash: mock.codeHash, storage_usage: 1, storage_paid_at: 0, block_height: 1, block_hash: BLOCK_HASH } });
          if (p.request_type === "view_access_key_list") return reply({ result: { keys: mock.keys, block_height: 1, block_hash: BLOCK_HASH } });
          if (p.request_type === "call_function") {
            const v = {
              get_config: { owner: mock.owner, paused: false, version: 1, params: { policy_delay_s: mock.delay } },
              get_agent: mock.registered,
              list_scheduled_changes: mock.scheduled,
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
  return { w, d, sent };
}
const ids = ["create", "schedule", "execute"];
const log = (d) => d.getElementById("log").textContent;
const state = (d) => ids.map((id) => `${id}=${d.getElementById(id).disabled ? "off" : "on"}`).join(" ");
const gate = (d, id) => d.getElementById(`${id}-gate`).textContent;
const nextSign = (sent) => until(() => sent.find((s) => s.actionType === "sign" && !s._seen && (s._seen = true)));
async function connectAs(d, acct) { d.getElementById("connect").click(); await until(() => d.getElementById("account").textContent === acct); await sleep(3000); }
async function clickAndCompare(d, sent, button, key) {
  d.getElementById(button).click();
  const s = await nextSign(sent);
  const t = s?.inputs.transactions.split(",") ?? [];
  check(t.length === 1, `${key}: one transaction reached the wallet`);
  if (t.length !== 1) return;
  const c = dec(t[0]), e = dec(fixture.tx[key]);
  const [receiver, method, args, gas, deposit] = fixture.calls[key];
  const fc = c.actions[0].functionCall;
  check(c.signerId === "aa5hr.testnet" && c.receiverId === receiver && c.publicKey.toString() === PK && c.actions.length === 1, `${key}: signer aa5hr.testnet, receiver ${c.receiverId}, one action`);
  check(fc.methodName === method && Buffer.from(fc.args).toString() === args && fc.gas.toString() === gas && fc.deposit.toString() === deposit, `${key}: ${fc.methodName} ${Buffer.from(fc.args).toString()} gas ${fc.gas} deposit ${fc.deposit}`);
  c.nonce = e.nonce; c.blockHash = e.blockHash;
  check(ser(c) === fixture.tx[key], `${key}: borsh bytes identical to the fixture after normalising nonce and block hash`);
  await until(() => (log(d).match(/TEST_MOCK_REJECTED|ERROR/g) || []).length >= 1, 30000);
}
const expectState = async (d, want, label) => { await until(() => state(d) === want, 20000); check(state(d) === want, `${label}: ${state(d)}`); };

// A: the account does not exist; the public key is entered. Only step 1 unlocks.
{
  const { w, d, sent } = await makePage();
  check(state(d) === "create=off schedule=off execute=off", "A: all locked before connect");
  await connectAs(d, "aa5hr.testnet");
  const login = sent.find((s) => s.actionType === "login");
  check(login?.network === "testnet" && (login.inputs.contract_id ?? "") === "", `A: login network=${login?.network}, no contract_id`);
  await expectState(d, "create=on schedule=off execute=off", "A");
  const plan = w.__walletPage.plan;
  const forged = [
    plan.create(AGENT, "ed25519:9k4yvZ8M7yezqHa6yzDoKr1m9nfv8HER5Bux9NUEmgYf"),
    plan.create("someone-else.testnet", AGENT_PK),
    { ...plan.create(AGENT, AGENT_PK), actions: [{ ...plan.create(AGENT, AGENT_PK).actions[0], deposit: 5_000_000_000_000_000_000_000_000n }] },
    plan.schedule(AGENT), plan.execute(12),
    { receiverId: "testnet", actions: [{ type: "Transfer", deposit: 1n }] },
    { ...plan.create(AGENT, AGENT_PK), actions: [plan.create(AGENT, AGENT_PK).actions[0], plan.create(AGENT, AGENT_PK).actions[0]] },
  ];
  check(forged.every((t) => { try { w.__walletPage.toSelectorTx(t); return false; } catch { return true; } }), "A: refuses another key, another name, 5 NEAR, a locked add_agent or execute, a Transfer, two actions");
  await clickAndCompare(d, sent, "create", "create");
}
// A2: no public key entered, or a malformed one: step 1 stays locked.
for (const pkIn of ["", "ed25519:notakey", "9k4yvZ8M7yezqHa6yzDoKr1m9nfv8HER5Bux9NUEmgYf"]) {
  const { d } = await makePage({ mock: { pkIn } });
  await connectAs(d, "aa5hr.testnet");
  check(state(d) === "create=off schedule=off execute=off", `A2(pk "${pkIn.slice(0, 16)}"): locked | ${gate(d, "create")}`);
}
// B: the account exists with its full-access key only (finish not run yet): nothing unlocks.
{
  const { d, sent } = await makePage({ mock: { agentKeys: [full(AGENT_PK)] } });
  await connectAs(d, "aa5hr.testnet");
  check(state(d) === "create=off schedule=off execute=off" && /only the request key/.test(gate(d, "schedule")), `B: locked | ${gate(d, "schedule")}`);
  for (const id of ids) d.getElementById(id).disabled = false;
  d.getElementById("schedule").click(); d.getElementById("create").click();
  await until(() => (log(d).match(/is locked by on-chain state/g) || []).length >= 2, 30000);
  check(!sent.some((x) => x.actionType === "sign"), "B: forced clicks: no sign request");
}
for (const [mode, agentKeys] of Object.entries({
  twoKeys: [reqKey(AGENT_PK), full("ed25519:F6TZxxYhxXHvJdVWVkjnyBPm6JzqKdANfNwxw1eM9aAG")],
  otherReceiver: [reqKey(AGENT_PK, "evil.testnet")],
  otherMethods: [reqKey(AGENT_PK, POLICY, ["request", "approve_ticket"])],
})) {
  const { d } = await makePage({ mock: { agentKeys } });
  await connectAs(d, "aa5hr.testnet");
  check(state(d) === "create=off schedule=off execute=off", `B(${mode}): schedule locked | ${gate(d, "schedule")}`);
}
// C: the account has only the request key, not registered, nothing scheduled: step 2 unlocks.
{
  const { d, sent } = await makePage({ mock: { agentKeys: [reqKey(AGENT_PK)] } });
  await connectAs(d, "aa5hr.testnet");
  await expectState(d, "create=off schedule=on execute=off", "C");
  await clickAndCompare(d, sent, "schedule", "schedule");
}
for (const [mode, m] of Object.entries({ delayOff: { delay: 0 }, registered: { registered: POLICY_V2 }, notUpgraded: { codeHash: "8EtC2o7j51xd7ESB6vJJLCA18CPytCcmZ6HETqcSPows" }, wrongOwner: { owner: "someone.testnet" } })) {
  const { d } = await makePage({ mock: { agentKeys: [reqKey(AGENT_PK)], ...m } });
  await connectAs(d, "aa5hr.testnet");
  check(state(d) === "create=off schedule=off execute=off", `C(${mode}): locked | ${gate(d, "schedule").slice(0, 90)}`);
}
// D: scheduled, not yet executable: locked; executable: step 3 unlocks with that change id.
{
  const { d } = await makePage({ mock: { agentKeys: [reqKey(AGENT_PK)], scheduled: [setAgent(12, now() + 1800)] } });
  await connectAs(d, "aa5hr.testnet");
  check(state(d) === "create=off schedule=off execute=off" && /Locked until then/.test(gate(d, "execute")), `D(not yet): locked | ${gate(d, "execute").slice(0, 80)}`);
}
{
  const { d, sent } = await makePage({ mock: { agentKeys: [reqKey(AGENT_PK)], scheduled: [setAgent(12, now() - 60)] } });
  await connectAs(d, "aa5hr.testnet");
  await expectState(d, "create=off schedule=off execute=on", "D(due)");
  await clickAndCompare(d, sent, "execute", "execute");
}
{
  const { d } = await makePage({ mock: { agentKeys: [reqKey(AGENT_PK)], scheduled: [setAgent(12, now() - 60, { ...POLICY_V2, max_requests_per_day: 1000 })] } });
  await connectAs(d, "aa5hr.testnet");
  check(state(d) === "create=off schedule=off execute=off" && /not the planned/.test(gate(d, "execute")), `D(other policy): locked | ${gate(d, "execute").slice(0, 70)}`);
}
// E: RPC down, wrong account, wallet-redirect override.
{
  const { d, sent } = await makePage({ mock: { down: ["test.rpc.fastnear.com", "rpc.testnet.near.org"] } });
  await connectAs(d, "aa5hr.testnet");
  check(state(d) === "create=off schedule=off execute=off" && /^Could not read the chain/.test(d.getElementById("gate").textContent), "E(RPC down): all locked, says so");
  d.getElementById("create").disabled = false; d.getElementById("create").click();
  await until(() => (log(d).match(/ERROR/g) || []).length >= 2, 30000);
  check(!sent.some((x) => x.actionType === "sign"), "E(RPC down): forced click: no sign request");
}
{
  const { d, sent } = await makePage({ loginAccount: "someone-else.testnet" });
  await connectAs(d, "someone-else.testnet");
  check(state(d) === "create=off schedule=off execute=off", "E: all locked for someone-else.testnet");
  d.getElementById("create").disabled = false; d.getElementById("create").click();
  await until(() => /refusing to sign/.test(log(d)), 30000);
  check(/refusing to sign/.test(log(d)) && !sent.some((x) => x.actionType === "sign"), "E: forced click refused by the signer guard");
}
{
  const { w, d, sent } = await makePage();
  await connectAs(d, "aa5hr.testnet");
  w.localStorage.setItem("DEV__METEOR_WALLET_BASE_URL", "https://evil.example");
  d.getElementById("create").click();
  await until(() => /DEV__METEOR_WALLET_BASE_URL is set/.test(log(d)), 30000);
  check(/DEV__METEOR_WALLET_BASE_URL is set/.test(log(d)) && !sent.some((x) => x.actionType === "sign"), "E: wallet-redirect override refused");
}
console.log(failures ? `\n${failures} FAILED` : "\nALL CHECKS OK");
process.exit(failures ? 1 : 0);
