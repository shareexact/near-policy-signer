#!/usr/bin/env node
// A new agent account for the testnet deployment, in two steps around one owner transaction.
//
//   node scripts/new-agent.mjs keys [account.testnet]   # 1. make the keys, check the name is free
//      -> the owner creates the account in wallet-page-new-agent/ (aa5hr.testnet calls testnet.create_account
//         with a NEAR deposit and the full-access public key printed here)
//   node scripts/new-agent.mjs finish                   # 2. add the agent's only key, then delete the full-access key
//      -> the owner registers the agent in wallet-page-new-agent/ (add_agent, through the policy delay)
//   node scripts/new-agent.mjs show                     # what is on chain now
//
// Keys live in ~/.near-policy-signer/agent-v2.json (mode 600), outside the repository; secrets are never printed.
// The agent ends with exactly one key: a function-call key for policy-v1, method `request`, with a 0.25 NEAR allowance.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { KeyPair, connect, keyStores } from "near-api-js";

const NETWORK = "testnet";
const RPC = process.env.NEAR_RPC_URL ?? "https://test.rpc.fastnear.com";
const POLICY = "policy-v1.shareexact-chainsig-demo.testnet";
const DEFAULT_NAME = "policy-signer-agent-v2.testnet";
const ALLOWANCE = 250_000_000_000_000_000_000_000n; // 0.25 NEAR, for gas only
const DIR = path.join(os.homedir(), ".near-policy-signer");
const FILE = path.join(DIR, "agent-v2.json");
const NB = "https://testnet.nearblocks.io/txns/";

const out = (s = "") => process.stdout.write(s + "\n");
const fail = (s) => { process.stderr.write(`STOP: ${s}\n`); process.exit(1); };

async function rpc(method, params) {
  const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  if (!r.ok) throw new Error(`${RPC}: HTTP ${r.status}`);
  return r.json();
}
/** The account's keys, or null if it does not exist. Existence comes from view_account: for an account that does not
 *  exist, view_access_key_list answers an empty list, not an error. */
async function keysOf(account) {
  const a = await rpc("query", { request_type: "view_account", finality: "final", account_id: account });
  if (a.error) {
    if (JSON.stringify(a.error).includes("UNKNOWN_ACCOUNT")) return null;
    throw new Error(JSON.stringify(a.error).slice(0, 300));
  }
  if (!a.result?.amount) throw new Error(`view_account ${account}: unexpected answer ${JSON.stringify(a).slice(0, 200)}`);
  const j = await rpc("query", { request_type: "view_access_key_list", finality: "final", account_id: account });
  if (j.error || !Array.isArray(j.result?.keys)) throw new Error(`view_access_key_list ${account}: ${JSON.stringify(j.error ?? j).slice(0, 300)}`);
  return j.result.keys;
}
const isRequestKey = (k, pk) => k.public_key === pk && k.access_key.permission?.FunctionCall?.receiver_id === POLICY
  && JSON.stringify(k.access_key.permission.FunctionCall.method_names) === JSON.stringify(["request"]);

function load() {
  if (!fs.existsSync(FILE)) fail(`no ${FILE}: run "node scripts/new-agent.mjs keys" first`);
  return JSON.parse(fs.readFileSync(FILE, "utf8"));
}

async function keys(name) {
  if (!/^[a-z0-9]+([-_][a-z0-9]+)*\.testnet$/.test(name) || name.length > 64) fail(`${name} is not a valid top-level testnet account name (lowercase, digits, - or _, ending in .testnet)`);
  if (fs.existsSync(FILE)) {
    const s = load();
    if (s.accountId !== name) fail(`${FILE} already holds keys for ${s.accountId}; to start over with another name, move that file away first`);
    out(`Keys for ${name} already exist in ${FILE}; reusing them.`);
  } else {
    if ((await keysOf(name)) !== null) fail(`${name} already exists on testnet; pick another name: node scripts/new-agent.mjs keys <name>.testnet`);
    const full = KeyPair.fromRandom("ed25519"), req = KeyPair.fromRandom("ed25519");
    fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
    const s = { accountId: name, fullPublicKey: full.getPublicKey().toString(), fullSecretKey: full.toString(),
      requestPublicKey: req.getPublicKey().toString(), requestSecretKey: req.toString(), createdAt: new Date().toISOString() };
    fs.writeFileSync(FILE, JSON.stringify(s, null, 1) + "\n", { mode: 0o600 });
    out(`Keys saved in ${FILE} (mode 600; the secret keys are not printed).`);
  }
  const s = load();
  const existing = await keysOf(s.accountId);
  out();
  out("For wallet-page-new-agent, step 1 (copy these two lines):");
  out(`  Account:    ${s.accountId}`);
  out(`  Public key: ${s.fullPublicKey}`);
  out();
  out(existing === null ? "The account does not exist yet: create it in the page, then run: node scripts/new-agent.mjs finish"
    : "The account already exists: run node scripts/new-agent.mjs finish");
}

async function finish() {
  const s = load();
  let k = await keysOf(s.accountId);
  if (k === null) fail(`${s.accountId} does not exist yet: create it in wallet-page-new-agent (step 1) first`);
  const hasFull = k.some((x) => x.public_key === s.fullPublicKey && x.access_key.permission === "FullAccess");
  const hasReq = k.some((x) => isRequestKey(x, s.requestPublicKey));
  const strangers = k.filter((x) => x.public_key !== s.fullPublicKey && x.public_key !== s.requestPublicKey);
  if (strangers.length) fail(`${s.accountId} has keys this script did not make: ${strangers.map((x) => x.public_key).join(", ")}`);
  const txs = [];
  if (!hasReq || hasFull) {
    if (!hasFull) fail(`${s.accountId} has neither the request key nor the full-access key from ${FILE}`);
    const ks = new keyStores.InMemoryKeyStore();
    await ks.setKey(NETWORK, s.accountId, KeyPair.fromString(s.fullSecretKey));
    const near = await connect({ networkId: NETWORK, nodeUrl: RPC, keyStore: ks });
    if (!hasReq) {
      const r = await (await near.account(s.accountId)).addKey(s.requestPublicKey, POLICY, ["request"], ALLOWANCE);
      txs.push(["AddKey (function call: policy-v1, request, 0.25 NEAR allowance)", r.transaction.hash]);
      out(`AddKey: ${NB}${r.transaction.hash}`);
    }
    const r = await (await near.account(s.accountId)).deleteKey(s.fullPublicKey);
    txs.push(["DeleteKey (the full-access key)", r.transaction.hash]);
    out(`DeleteKey: ${NB}${r.transaction.hash}`);
  }
  // Reads are at "final", a few blocks behind the transactions just sent: wait for them before judging the keys.
  const done = (keys) => keys.length === 1 && isRequestKey(keys[0], s.requestPublicKey);
  for (let i = 0; i < 10; i++) {
    k = await keysOf(s.accountId);
    if (done(k) || !txs.length) break;
    await new Promise((r) => setTimeout(r, 3000));
  }
  if (!done(k)) fail(`unexpected keys on ${s.accountId}: ${JSON.stringify(k)}`);
  // Only after the account is in its final shape: drop the full-access secret from the file.
  const kept = { accountId: s.accountId, requestPublicKey: s.requestPublicKey, requestSecretKey: s.requestSecretKey, createdAt: s.createdAt, finishedAt: new Date().toISOString(), txs };
  fs.writeFileSync(FILE, JSON.stringify(kept, null, 1) + "\n", { mode: 0o600 });
  out();
  out(`${s.accountId} now has exactly one key: ${s.requestPublicKey.slice(0, 16)}..., function call, receiver policy-v1, method request.`);
  out("Next: register it in wallet-page-new-agent (step 2, add_agent; waits 1 hour; then step 3, execute).");
}

async function show() {
  const s = load();
  const k = await keysOf(s.accountId);
  out(`${s.accountId}: ${k === null ? "does not exist yet" : k.map((x) => `${x.public_key.slice(0, 16)}... ${x.access_key.permission === "FullAccess" ? "full access" : "function call " + JSON.stringify(x.access_key.permission.FunctionCall.method_names)}`).join("; ")}`);
}

const [cmd, arg] = process.argv.slice(2);
const run = { keys: () => keys(arg ?? DEFAULT_NAME), finish, show }[cmd];
if (!run) fail("usage: node scripts/new-agent.mjs keys [name.testnet] | finish | show");
run().catch((e) => fail(e?.message ?? String(e)));
