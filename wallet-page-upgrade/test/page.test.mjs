// Loads index.html in jsdom with a MOCK Meteor extension (window.meteorCom). No real wallet is opened.
// The mock answers "login" and captures the base64 transactions the Meteor SDK would hand to the extension,
// then answers "closed_fail" (rejected), so nothing is ever signed or broadcast.
// Every RPC call is answered offline, and ../policy_signer.wasm is served to the page as it would be locally.
import { JSDOM } from "jsdom";
import fs from "fs";
import crypto from "crypto";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
// Independent decoder: near-api-js 0.45.1 (devDependency), not the near-js packages the page itself uses.
const { utils, transactions: T } = require("near-api-js");
const html = fs.readFileSync(new URL("../index.html", import.meta.url), "utf8");
const wasm = fs.readFileSync(new URL("../policy_signer.wasm", import.meta.url));
const WASM_SHA = crypto.createHash("sha256").update(wasm).digest("hex");
const fixture = JSON.parse(fs.readFileSync(new URL("./fixtures/upgrade-expected.json", import.meta.url), "utf8"));
const dec = (b64) => utils.serialize.deserialize(T.SCHEMA, T.Transaction, Buffer.from(b64, "base64"));
const ser = (t) => Buffer.from(utils.serialize.serialize(T.SCHEMA, t)).toString("base64");
const POLICY = "policy-v1.shareexact-chainsig-demo.testnet", PK = "ed25519:9k4yvZ8M7yezqHa6yzDoKr1m9nfv8HER5Bux9NUEmgYf";
const DEPLOYED = "8EtC2o7j51xd7ESB6vJJLCA18CPytCcmZ6HETqcSPows";
const BLOCK_HASH = utils.serialize.base_encode(Buffer.alloc(32, 7));
let failures = 0;
const check = (cond, msg) => { console.log(`${cond ? "PASS" : "FAIL"} ${msg}`); if (!cond) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 30000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await sleep(100); } return null; }
const now = () => Math.floor(Date.now() / 1000);
const PARAMS_NOW = { max_observation_age_s: 120, max_clock_skew_s: 15, corp_action_window_s: 7200, max_requests_per_day: 50, pending_ticket_ttl_s: 86400, approved_ticket_ttl_s: 900, max_open_tickets: 20, upgrade_delay_s: 172800, policy_delay_s: 0 };

// mock: { pending?, codeHash?, keys?, owner?, disabled?, missing?, wasm? (bytes or null) }
async function makePage({ loginAccount, mock }) {
  const sent = [];
  const dom = new JSDOM(html, {
    url: "http://localhost:8080/", runScripts: "dangerously", pretendToBeVisual: true,
    beforeParse(window) {
      window.confirm = () => true;
      window.open = () => { throw new Error("window.open must not be used with the extension mock"); };
      if (!window.crypto?.subtle) Object.defineProperty(window, "crypto", { value: globalThis.crypto, configurable: true });
      window.fetch = async (url, opts) => {
        if (String(url).endsWith("policy_signer.wasm")) {
          const bytes = "wasm" in mock ? mock.wasm : wasm;
          if (!bytes) return new Response("not found", { status: 404 });
          return new Response(bytes, { status: 200, headers: { "content-type": "application/wasm" } });
        }
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
          if (p.request_type === "view_account") return reply({ result: { amount: "1", locked: "0", code_hash: mock.codeHash ?? DEPLOYED, storage_usage: 1, storage_paid_at: 0, block_height: 1, block_hash: BLOCK_HASH } });
          if (p.request_type === "view_access_key_list") return reply({ result: { keys: mock.keys ?? [], block_height: 1, block_hash: BLOCK_HASH } });
          if (p.request_type === "call_function" && p.method_name === "get_config") {
            const v = { owner: mock.owner ?? "aa5hr.testnet", paused: false, version: 1, upgrades_disabled: mock.disabled ?? false, pending_upgrade: mock.pending ?? null, params: mock.params ?? PARAMS_NOW };
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
const state = (d) => ["propose", "apply", "delay"].map((id) => `${id}=${d.getElementById(id).disabled ? "off" : "on"}`).join(" ");
const nextSign = (sent) => until(() => sent.find((s) => s.actionType === "sign" && !s._seen && (s._seen = true)));
async function connectAs(d, acct) { d.getElementById("connect").click(); await until(() => d.getElementById("account").textContent === acct); await sleep(3000); }
function decodeOne(s) {
  const t = s?.inputs.transactions.split(",") ?? [];
  return t.length === 1 ? dec(t[0]) : null;
}

// The wasm in this folder is the planned one.
{
  const { w } = await makePage({ loginAccount: "aa5hr.testnet", mock: {} });
  const plan = w.__walletPage.plan;
  check(plan.NEW_CODE_SHA256 === WASM_SHA, `plan NEW_CODE_SHA256 ${plan.NEW_CODE_SHA256} = sha256 of ../policy_signer.wasm ${WASM_SHA}`);
  check(fixture.code_sha256 === WASM_SHA, "fixture was built for this wasm");
  check(plan.NEW_CODE_HASH_B58 === fixture.code_hash_b58, `plan NEW_CODE_HASH_B58 ${plan.NEW_CODE_HASH_B58} = base58 of the wasm sha256`);
  check(/^[0-9a-f]{40}$/.test(plan.SOURCE_COMMIT), `SOURCE_COMMIT ${plan.SOURCE_COMMIT} is a full commit id`);
}

// Phase A: no upgrade pending. Propose unlocked, apply locked; the propose transaction is exactly the fixture.
{
  const { w, d, sent } = await makePage({ loginAccount: "aa5hr.testnet", mock: {} });
  const plan = w.__walletPage.plan;
  const a0 = plan.PROPOSE.actions[0];
  const forged = [{ receiverId: "evil.testnet", actions: [a0] },
    { receiverId: POLICY, actions: [{ ...a0, methodName: "disable_upgrades", args: {} }] },
    { receiverId: POLICY, actions: [{ ...a0, args: { code_hash: "00".repeat(32) } }] },
    { receiverId: POLICY, actions: [{ ...a0, deposit: 2n }] },
    { receiverId: POLICY, actions: [{ ...a0, gas: 300000000000000n }] },
    { receiverId: POLICY, actions: [{ type: "FunctionCall", methodName: "apply_upgrade", args: { code: Buffer.from("x").toString("base64") }, gas: 300000000000000n, deposit: 1n }] },
    { receiverId: POLICY, actions: [{ type: "Transfer", deposit: 1n }] },
    { receiverId: POLICY, actions: [a0, a0] }];
  check(forged.every((t) => { try { w.__walletPage.toSelectorTx(t); return false; } catch { return true; } }),
    "A: refuses other receiver, other method, other hash, 2 yocto, other gas, unverified code, Transfer, 2 actions");
  check(state(d) === "propose=off apply=off delay=off", "A: buttons disabled before connect");
  await connectAs(d, "aa5hr.testnet");
  const login = sent.find((s) => s.actionType === "login");
  check(login?.network === "testnet" && (login.inputs.contract_id ?? "") === "", `A: login network=${login?.network}, no contract_id`);
  await until(() => state(d) === "propose=on apply=off delay=off", 20000);
  check(state(d) === "propose=on apply=off delay=off", `A: ${state(d)} | ${d.getElementById("propose-gate").textContent}`);
  d.getElementById("propose").click();
  const t = decodeOne(await nextSign(sent));
  const e = dec(fixture.tx.propose);
  check(!!t && t.signerId === "aa5hr.testnet" && t.receiverId === POLICY && t.publicKey.toString() === PK, "A: propose signer, receiver, key");
  if (t) {
    const fc = t.actions[0].functionCall;
    check(t.actions.length === 1 && fc.methodName === "propose_upgrade" && Buffer.from(fc.args).toString() === JSON.stringify({ code_hash: WASM_SHA }), `A: propose_upgrade args ${Buffer.from(fc.args).toString()}`);
    check(fc.gas.toString() === "30000000000000" && fc.deposit.toString() === "1", "A: 30 Tgas, 1 yocto");
    t.nonce = e.nonce; t.blockHash = e.blockHash;
    check(ser(t) === fixture.tx.propose, "A: borsh bytes identical to the fixture after normalising nonce and block hash");
  }
  await until(() => /TEST_MOCK_REJECTED|ERROR/.test(log(d)), 30000);
  d.getElementById("apply").disabled = false; d.getElementById("apply").click();
  await until(() => /apply_upgrade is locked/.test(log(d)), 30000);
  check(/apply_upgrade is locked/.test(log(d)), "A: forced apply click refused (nothing pending)");
  check(sent.filter((x) => x.actionType === "sign").length === 1, "A: only 1 sign request reached the wallet");
}

// Phase B: the planned upgrade is pending but not due. Both locked.
{
  const { d, sent } = await makePage({ loginAccount: "aa5hr.testnet", mock: { pending: { code_hash: WASM_SHA, executable_at: now() + 3600 } } });
  await connectAs(d, "aa5hr.testnet");
  check(state(d) === "propose=off apply=off delay=off", `B: ${state(d)} | ${d.getElementById("apply-gate").textContent}`);
  d.getElementById("apply").disabled = false; d.getElementById("apply").click();
  await until(() => /is locked/.test(log(d)), 30000);
  check(!sent.some((x) => x.actionType === "sign"), "B: forced apply before the delay: no sign request");
}

// Phase C: due, and the served wasm is the planned one. Apply unlocked; it sends exactly that wasm.
{
  const { d, sent } = await makePage({ loginAccount: "aa5hr.testnet", mock: { pending: { code_hash: WASM_SHA, executable_at: now() - 10 } } });
  await connectAs(d, "aa5hr.testnet");
  await until(() => state(d) === "propose=off apply=on delay=off", 20000);
  check(state(d) === "propose=off apply=on delay=off", `C: ${state(d)} | ${d.getElementById("apply-gate").textContent}`);
  d.getElementById("apply").click();
  const t = decodeOne(await nextSign(sent));
  if (t) {
    const fc = t.actions[0].functionCall;
    const args = JSON.parse(Buffer.from(fc.args).toString());
    const code = Buffer.from(args.code, "base64");
    check(t.receiverId === POLICY && fc.methodName === "apply_upgrade" && Object.keys(args).join() === "code", "C: apply_upgrade to policy-v1, args {code}");
    check(crypto.createHash("sha256").update(code).digest("hex") === WASM_SHA, `C: the code sent hashes to the planned ${WASM_SHA}`);
    check(fc.gas.toString() === "300000000000000" && fc.deposit.toString() === "1", "C: 300 Tgas, 1 yocto");
  } else check(false, "C: one apply transaction reached the wallet");
}

// Phase D: locks failing on purpose. Nothing may reach the wallet, even with forced clicks.
const D = {
  wrongWasm: { pending: { code_hash: WASM_SHA, executable_at: now() - 10 }, wasm: Buffer.from("not the wasm") },
  noWasm: { pending: { code_hash: WASM_SHA, executable_at: now() - 10 }, wasm: null },
  otherPending: { pending: { code_hash: "ab".repeat(32), executable_at: now() - 10 } },
  alreadyUpgraded: { codeHash: "11111111111111111111111111111111" },
  haskey: { keys: [{ public_key: "ed25519:7qYtkNWa2eS9LP5ZonKPq97HmD6NV5Chj4jkKgcEgEvp", access_key: { nonce: 1, permission: "FullAccess" } }] },
  wrongowner: { owner: "someone.testnet" },
  disabled: { disabled: true },
  missing: { missing: true },
};
for (const [mode, mock] of Object.entries(D)) {
  const { d, sent } = await makePage({ loginAccount: "aa5hr.testnet", mock });
  await connectAs(d, "aa5hr.testnet");
  check(state(d) === "propose=off apply=off delay=off", `D(${mode}): ${state(d)}`);
  for (const id of ["propose", "apply", "delay"]) { d.getElementById(id).disabled = false; d.getElementById(id).click(); }
  await until(() => (log(d).match(/is locked by on-chain state/g) || []).length >= 3, 30000);
  check((log(d).match(/is locked by on-chain state/g) || []).length >= 3, `D(${mode}): forced clicks refused`);
  check(!sent.some((x) => x.actionType === "sign"), `D(${mode}): no sign request reached the wallet`);
}

// Phase F: after the upgrade, with the deployment's parameters: only the delay step is unlocked, and it sends exactly the fixture.
{
  const { d, sent } = await makePage({ loginAccount: "aa5hr.testnet", mock: { codeHash: fixture.code_hash_b58 } });
  await connectAs(d, "aa5hr.testnet");
  await until(() => state(d) === "propose=off apply=off delay=on", 20000);
  check(state(d) === "propose=off apply=off delay=on", `F: ${state(d)} | ${d.getElementById("delay-gate").textContent}`);
  d.getElementById("delay").click();
  const t = decodeOne(await nextSign(sent));
  if (t) {
    const fc = t.actions[0].functionCall;
    check(fc.methodName === "set_params" && Buffer.from(fc.args).toString() === fixture.delay_args, `F: set_params args ${Buffer.from(fc.args).toString()}`);
    const e = dec(fixture.tx.set_delay);
    t.nonce = e.nonce; t.blockHash = e.blockHash;
    check(ser(t) === fixture.tx.set_delay, "F: borsh bytes identical to the fixture after normalising nonce and block hash");
  } else check(false, "F: one set_params transaction reached the wallet");
}
// Phase G: delay already on, or other parameters changed: locked.
for (const [mode, params] of Object.entries({ alreadyOn: { ...PARAMS_NOW, policy_delay_s: 3600 }, otherParams: { ...PARAMS_NOW, max_open_tickets: 99 } })) {
  const { d, sent } = await makePage({ loginAccount: "aa5hr.testnet", mock: { codeHash: fixture.code_hash_b58, params } });
  await connectAs(d, "aa5hr.testnet");
  check(state(d) === "propose=off apply=off delay=off", `G(${mode}): ${state(d)} | ${d.getElementById("delay-gate").textContent}`);
  d.getElementById("delay").disabled = false; d.getElementById("delay").click();
  await until(() => /is locked by on-chain state/.test(log(d)), 30000);
  check(!sent.some((x) => x.actionType === "sign"), `G(${mode}): forced click: no sign request`);
}

// Phase E: wrong account, and the wallet-redirect override.
{
  const { d, sent } = await makePage({ loginAccount: "someone-else.testnet", mock: {} });
  await connectAs(d, "someone-else.testnet");
  check(state(d) === "propose=off apply=off delay=off", "E: buttons disabled for someone-else.testnet");
  d.getElementById("propose").disabled = false; d.getElementById("propose").click();
  await until(() => /refusing to sign/.test(log(d)), 30000);
  check(/refusing to sign/.test(log(d)) && !sent.some((x) => x.actionType === "sign"), "E: forced click refused by the signer guard");
}
{
  const { w, d, sent } = await makePage({ loginAccount: "aa5hr.testnet", mock: {} });
  await connectAs(d, "aa5hr.testnet");
  w.localStorage.setItem("DEV__METEOR_WALLET_BASE_URL", "https://evil.example");
  d.getElementById("propose").disabled = false; d.getElementById("propose").click();
  await until(() => /DEV__METEOR_WALLET_BASE_URL is set/.test(log(d)), 30000);
  check(/DEV__METEOR_WALLET_BASE_URL is set/.test(log(d)) && !sent.some((x) => x.actionType === "sign"), "E: wallet-redirect override refused");
}
console.log(failures ? `\n${failures} FAILED` : "\nALL CHECKS OK");
process.exit(failures ? 1 : 0);
