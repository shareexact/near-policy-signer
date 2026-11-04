import { Buffer } from "buffer";
globalThis.Buffer ??= Buffer;
import { setupWalletSelector } from "@near-wallet-selector/core";
import { setupMeteorWallet } from "@near-wallet-selector/meteor-wallet";
import { actionCreators } from "@near-js/transactions";
import * as P from "./plan.js";

const $ = (id) => document.getElementById(id);
const log = (msg) => { const el = $("log"); el.textContent += `[${new Date().toLocaleTimeString()}] ${msg}\n`; };
const ALLOWED = new Set(["propose_upgrade", "apply_upgrade", "set_params"]);

export function toNajActions(actions) {
  return actions.map((a) => {
    if (a.type !== "FunctionCall") throw new Error(`unknown action ${a.type}`);
    return actionCreators.functionCall(a.methodName, a.args, a.gas, a.deposit);
  });
}
// The sha256 of the wasm the apply button would send, checked when the file is loaded and again at signing.
let verifiedCodeBase64 = null;
function assertOwnerCallOnly(tx) {
  if (tx.receiverId !== P.POLICY) throw new Error(`refusing: receiver ${tx.receiverId} is not ${P.POLICY}`);
  if (tx.actions.length !== 1) throw new Error("refusing: exactly one action per transaction");
  for (const a of tx.actions) {
    if (a.type !== "FunctionCall" || a.deposit !== 1n) throw new Error("refusing: only FunctionCall with 1 yocto is allowed");
    if (!ALLOWED.has(a.methodName)) throw new Error(`refusing: method ${a.methodName} is not propose_upgrade, apply_upgrade or set_params`);
    if (a.methodName === "propose_upgrade") {
      if (a.gas !== P.PROPOSE_GAS) throw new Error("refusing: propose_upgrade must use the planned gas");
      if (JSON.stringify(a.args) !== JSON.stringify(P.PROPOSE.actions[0].args)) throw new Error("refusing: propose_upgrade arguments differ from the plan");
    } else if (a.methodName === "set_params") {
      if (a.gas !== P.PROPOSE_GAS) throw new Error("refusing: set_params must use the planned gas");
      if (JSON.stringify(a.args) !== JSON.stringify(P.SET_DELAY.actions[0].args)) throw new Error("refusing: set_params arguments differ from the plan");
    } else {
      if (a.gas !== P.APPLY_GAS) throw new Error("refusing: apply_upgrade must use the planned gas");
      if (Object.keys(a.args).join() !== "code" || a.args.code !== verifiedCodeBase64) throw new Error("refusing: apply_upgrade code is not the verified wasm");
    }
  }
}
export const toSelectorTx = (tx) => (assertOwnerCallOnly(tx), { signerId: P.SIGNER, receiverId: tx.receiverId, actions: toNajActions(tx.actions) });

function hexOf(buf) { return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join(""); }
// Loads the wasm served next to the page and keeps it only if its sha256 is the planned one.
async function loadVerifiedWasm() {
  if (verifiedCodeBase64) return verifiedCodeBase64;
  let bytes;
  try {
    const r = await fetch(P.WASM_FILE, { cache: "no-store" });
    if (!r.ok) return null;
    bytes = new Uint8Array(await r.arrayBuffer());
  } catch { return null; }
  const digest = hexOf(await crypto.subtle.digest("SHA-256", bytes));
  if (digest !== P.NEW_CODE_SHA256) { log(`REFUSED: ${P.WASM_FILE} has sha256 ${digest}, not the planned ${P.NEW_CODE_SHA256}`); return null; }
  verifiedCodeBase64 = Buffer.from(bytes).toString("base64");
  return verifiedCodeBase64;
}

async function rpc(method, params) {
  const r = await fetch(P.RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  return r.json();
}
const q = async (params) => (await rpc("query", { finality: "final", ...params })).result ?? null;
async function view(method, args) {
  const r = await q({ request_type: "call_function", account_id: P.POLICY, method_name: method, args_base64: btoa(JSON.stringify(args)) });
  if (!r?.result) return undefined;
  return JSON.parse(Buffer.from(r.result).toString("utf8"));
}

let selector = null, connected = null;
async function getSelector() {
  if (!selector) selector = await setupWalletSelector({ network: P.NETWORK, modules: [setupMeteorWallet()] });
  return selector;
}
function setConnected(id) {
  connected = id;
  $("account").textContent = id ? id : "not connected";
  const ok = id === P.SIGNER;
  $("account").className = ok ? "ok" : "bad";
  if (id && !ok) log(`REFUSED: connected account is ${id}, not ${P.SIGNER}. Nothing will be signed. Disconnect and connect ${P.SIGNER}.`);
  refreshState();
}
async function connect() {
  const wallet = await (await getSelector()).wallet("meteor-wallet");
  // Plain connect, no dApp function-call key for any contract. Mute console.log: @meteorwallet/sdk logs its random local key pair.
  const origLog = console.log;
  let accounts;
  try { console.log = () => {}; accounts = await wallet.signIn({ contractId: undefined, methodNames: [] }); }
  finally { console.log = origLog; }
  setConnected(accounts?.[0]?.accountId ?? null);
}
async function disconnect() {
  if (!selector) return;
  try { const w = await selector.wallet("meteor-wallet"); await w.signOut(); } catch (e) { log(`sign out: ${e.message ?? e}`); }
  setConnected(null);
}
async function activeAccount() {
  const st = (await getSelector()).store.getState();
  return st.accounts.find((a) => a.active)?.accountId ?? st.accounts[0]?.accountId ?? null;
}
async function guardSigner() {
  if (window.localStorage.getItem("DEV__METEOR_WALLET_BASE_URL") != null) throw new Error("refusing to sign: localStorage DEV__METEOR_WALLET_BASE_URL is set (would redirect the wallet)");
  const acct = await activeAccount();
  if (acct !== P.SIGNER) throw new Error(`refusing to sign: connected account is ${acct ?? "none"}, must be ${P.SIGNER}`);
  if ((await getSelector()).options.network.networkId !== "testnet") throw new Error("refusing to sign: network is not testnet");
}

// On-chain state. Each button's lock:
//   both:    policy-v1 runs the code deployed on Nov 2 (code_hash), has 0 access keys, owner aa5hr.testnet, upgrades not disabled
//   propose: no upgrade pending
//   apply:   the pending upgrade is exactly NEW_CODE_SHA256, its time has come, and the served wasm hashes to it
//   delay:   policy-v1 runs the NEW code, 0 keys, owner aa5hr.testnet, and its params are exactly CURRENT_PARAMS
const sameParams = (a, b) => !!a && Object.keys(b).length === Object.keys(a).length && Object.entries(b).every(([k, v]) => a[k] === v);
async function readState() {
  const acc = await q({ request_type: "view_account", account_id: P.POLICY });
  const keys = acc ? (await q({ request_type: "view_access_key_list", account_id: P.POLICY }))?.keys ?? null : null;
  const cfg = acc ? await view("get_config", {}) : undefined;
  const base = acc?.code_hash === P.DEPLOYED_CODE_HASH && Array.isArray(keys) && keys.length === 0 && cfg?.owner === P.SIGNER && cfg?.upgrades_disabled === false;
  const pending = cfg?.pending_upgrade ?? null;
  const now = Math.floor(Date.now() / 1000);
  const proposeOk = base && pending === null;
  const due = !!pending && pending.code_hash === P.NEW_CODE_SHA256 && now >= pending.executable_at;
  const wasm = base && due ? await loadVerifiedWasm() : null;
  const applyOk = base && due && !!wasm;
  const upgraded = acc?.code_hash === P.NEW_CODE_HASH_B58 && Array.isArray(keys) && keys.length === 0 && cfg?.owner === P.SIGNER;
  const delayOk = upgraded && sameParams(cfg?.params, P.CURRENT_PARAMS);
  $("delay-gate").textContent = !upgraded ? "Locked until policy-v1 runs the new code with no access keys."
    : sameParams(cfg?.params, P.NEW_PARAMS) ? "The 1 hour policy delay is already on: nothing to sign."
    : delayOk ? "Upgraded, and the parameters are as expected. Unlocked."
    : `Locked: the parameters are not the expected ones: ${JSON.stringify(cfg?.params)}`;
  $("gate").textContent = !acc ? `Locked: ${P.POLICY} does not exist.`
    : acc.code_hash === P.NEW_CODE_HASH_B58 ? `policy-v1 runs the new code (${acc.code_hash}): the upgrade is applied. Only step 3 remains.`
    : acc.code_hash !== P.DEPLOYED_CODE_HASH ? `policy-v1 code_hash ${acc.code_hash}: neither the Nov 2 code nor the planned one. Locked.`
    : `policy-v1 code_hash ${acc.code_hash} (the Nov 2 code); access keys: ${keys ? keys.length : "?"}; owner ${cfg?.owner ?? "?"}; upgrades ${cfg?.upgrades_disabled ? "DISABLED" : "enabled"}. ${base ? "OK." : "Locked."}`;
  $("propose-gate").textContent = pending ? `An upgrade is already pending: ${pending.code_hash}, executable ${new Date(pending.executable_at * 1000).toLocaleString()}. Locked.`
    : `No upgrade pending. ${proposeOk ? "Propose unlocked." : "Locked."}`;
  $("apply-gate").textContent = !pending ? "No upgrade pending. Locked."
    : pending.code_hash !== P.NEW_CODE_SHA256 ? `The pending upgrade ${pending.code_hash} is not the planned ${P.NEW_CODE_SHA256}. Locked: cancel it.`
    : now < pending.executable_at ? `Pending, executable ${new Date(pending.executable_at * 1000).toLocaleString()} (in ${Math.ceil((pending.executable_at - now) / 3600)} h). Locked until then.`
    : !wasm ? `Due, but ${P.WASM_FILE} is missing next to this page or does not hash to the planned sha256. Locked.`
    : `Due, and ${P.WASM_FILE} hashes to ${P.NEW_CODE_SHA256}. ${applyOk ? "Apply unlocked." : "Locked."}`;
  return { propose: proposeOk, apply: applyOk, delay: delayOk };
}

function outcomeHash(o) { return o?.transaction?.hash ?? o?.transaction_outcome?.id ?? null; }
function showHashes(targetId, outcomes) {
  const el = $(targetId);
  for (const o of [].concat(outcomes ?? [])) {
    const h = outcomeHash(o);
    const failed = o?.status && typeof o.status === "object" && "Failure" in o.status;
    const li = document.createElement("li");
    if (h) { const a = document.createElement("a"); a.href = `https://testnet.nearblocks.io/txns/${h}`; a.target = "_blank"; a.rel = "noopener"; a.textContent = h; li.append(a); }
    else li.textContent = "(no hash returned)";
    if (failed) li.append(" FAILED: " + JSON.stringify(o.status.Failure));
    el.append(li);
    log(`tx ${h ?? "?"}${failed ? " FAILED" : ""}`);
  }
}

async function signOne(makeTx, outId) {
  await guardSigner();
  const st = await readState();
  const tx = makeTx();
  if (!st[tx.button]) throw new Error(`${tx.title} is locked by on-chain state`);
  if (!window.confirm(`Ask Meteor to sign this transaction?\n\n${P.describe(tx)}`)) { log(`${tx.id}: cancelled`); return; }
  log(`${tx.id} ${tx.title}: sent to Meteor for approval`);
  const w = await (await getSelector()).wallet("meteor-wallet");
  const out = await w.signAndSendTransaction(toSelectorTx(tx));
  showHashes(outId, out);
  refreshState();
}

const BUTTONS = ["propose", "apply", "delay"];
let refreshSeq = 0;
async function refreshState() {
  const seq = ++refreshSeq;
  for (const id of BUTTONS) $(id).disabled = true; // locked while re-reading the chain
  const st = await readState();
  if (seq !== refreshSeq) return; // a newer refresh owns the buttons
  const signerOk = connected === P.SIGNER; // read after the await, so a connect during the read counts
  for (const id of BUTTONS) $(id).disabled = !signerOk || !st[id];
}
const run = (fn) => async () => { try { await fn(); } catch (e) { log(`ERROR: ${e?.message ?? e}`); } };

export async function start() {
  $("propose-desc").textContent = P.describe(P.PROPOSE);
  $("apply-desc").textContent = `FunctionCall apply_upgrade, gas ${P.APPLY_GAS / 10n ** 12n} Tgas, deposit 1 yoctoNEAR, args {"code": <the wasm with sha256 ${P.NEW_CODE_SHA256}>}\nSource: commit ${P.SOURCE_COMMIT}, reproducible build (cargo near build reproducible-wasm).`;
  $("connect").onclick = run(connect);
  $("disconnect").onclick = run(disconnect);
  $("refresh").onclick = run(refreshState);
  $("propose").onclick = run(() => signOne(() => P.PROPOSE, "propose-out"));
  $("delay-desc").textContent = P.describe(P.SET_DELAY);
  $("delay").onclick = run(() => signOne(() => P.SET_DELAY, "delay-out"));
  $("apply").onclick = run(() => signOne(() => P.applyTx(verifiedCodeBase64 ?? ""), "apply-out"));
  if (location.protocol === "file:") log("WARNING: opened from file://. Serve it from http://localhost instead (see README).");
  const s = await getSelector();
  setConnected(await activeAccount());
  s.store.observable.subscribe(() => activeAccount().then((a) => { if (a !== connected) setConnected(a); }));
}

window.__walletPage = { plan: P, toSelectorTx, start, loadVerifiedWasm };
if (!window.__WALLET_PAGE_NO_AUTOSTART) start().catch((e) => log(`ERROR: ${e?.message ?? e}`));
