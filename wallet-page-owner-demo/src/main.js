import { Buffer } from "buffer";
globalThis.Buffer ??= Buffer;
import { setupWalletSelector } from "@near-wallet-selector/core";
import { setupMeteorWallet } from "@near-wallet-selector/meteor-wallet";
import { actionCreators } from "@near-js/transactions";
import * as P from "./plan.js";

const $ = (id) => document.getElementById(id);
const log = (msg) => { const el = $("log"); el.textContent += `[${new Date().toLocaleTimeString()}] ${msg}\n`; };
const ALLOWED = new Set(["approve_ticket", "set_paused"]);

export function toNajActions(actions) {
  return actions.map((a) => {
    if (a.type !== "FunctionCall") throw new Error(`unknown action ${a.type}`);
    return actionCreators.functionCall(a.methodName, a.args, a.gas, a.deposit);
  });
}
function assertOwnerCallOnly(tx) {
  if (tx.receiverId !== P.POLICY) throw new Error(`refusing: receiver ${tx.receiverId} is not ${P.POLICY}`);
  if (tx.actions.length !== 1) throw new Error("refusing: exactly one action per transaction");
  for (const a of tx.actions) {
    if (a.type !== "FunctionCall" || a.deposit !== 1n || a.gas !== P.OWNER_GAS) throw new Error("refusing: only FunctionCall, 1 yocto, 30 Tgas is allowed");
    if (!ALLOWED.has(a.methodName)) throw new Error(`refusing: method ${a.methodName} is not approve_ticket or set_paused`);
  }
}
export const toSelectorTx = (tx) => (assertOwnerCallOnly(tx), { signerId: P.SIGNER, receiverId: tx.receiverId, actions: toNajActions(tx.actions) });

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

// On-chain state. Each button has its own lock:
//   all:     policy-v1 code_hash == expected, 0 access keys, get_config.owner == aa5hr.testnet
//   approve: get_ticket(TICKET_ID).status == "Pending" and not expired
//   pause:   get_config.paused == false        resume: get_config.paused == true
async function readState() {
  const acc = await q({ request_type: "view_account", account_id: P.POLICY });
  const keys = acc ? (await q({ request_type: "view_access_key_list", account_id: P.POLICY }))?.keys ?? null : null;
  const cfg = acc ? await view("get_config", {}) : undefined;
  const ticket = acc ? await view("get_ticket", { ticket_id: P.TICKET_ID }) : undefined;
  const base = acc?.code_hash === P.EXPECTED_CODE_HASH && Array.isArray(keys) && keys.length === 0 && cfg?.owner === P.SIGNER;
  const now = Math.floor(Date.now() / 1000);
  const approveOk = base && ticket?.status === "Pending" && now < ticket.expires_at;
  const paused = typeof cfg?.paused === "boolean" ? cfg.paused : null;
  $("gate").textContent = !acc ? `Locked: ${P.POLICY} does not exist.`
    : `policy-v1 code_hash ${acc.code_hash} ${acc.code_hash === P.EXPECTED_CODE_HASH ? "(matches)" : `(expected ${P.EXPECTED_CODE_HASH})`}; access keys: ${keys ? keys.length : "?"}; owner ${cfg?.owner ?? "?"}. ${base ? "OK." : "Locked."}`;
  $("approve-gate").textContent = ticket ? `ticket ${ticket.id}: ${ticket.status}, ${ticket.amount} wei to ${ticket.recipient}, expires ${new Date(ticket.expires_at * 1000).toLocaleString()}. ${approveOk ? "Approve unlocked." : "Locked (must be Pending and unexpired)."}`
    : `ticket ${P.TICKET_ID}: not found. Locked.`;
  $("pause-gate").textContent = `paused: ${paused}. ${base ? (paused ? "Resume unlocked." : "Pause unlocked.") : "Locked."}`;
  return { approve: approveOk, pause: base && paused === false, resume: base && paused === true };
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

async function signOne(tx, outId) {
  await guardSigner();
  const st = await readState();
  if (!st[tx.button]) throw new Error(`${tx.title} is locked by on-chain state`);
  if (!window.confirm(`Ask Meteor to sign this transaction?\n\n${P.describe(tx)}`)) { log(`${tx.id}: cancelled`); return; }
  log(`${tx.id} ${tx.title}: sent to Meteor for approval`);
  const w = await (await getSelector()).wallet("meteor-wallet");
  const out = await w.signAndSendTransaction(toSelectorTx(tx));
  showHashes(outId, out);
  refreshState();
}

const BUTTONS = ["approve", "pause", "resume"];
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
  const [ap, pa, re] = P.OWNER;
  $("approve-desc").textContent = P.describe(ap);
  $("pause-desc").textContent = `Pause:\n${P.describe(pa)}\n\nResume:\n${P.describe(re)}`;
  $("connect").onclick = run(connect);
  $("disconnect").onclick = run(disconnect);
  $("refresh").onclick = run(refreshState);
  $("approve").onclick = run(() => signOne(ap, "approve-out"));
  $("pause").onclick = run(() => signOne(pa, "pause-out"));
  $("resume").onclick = run(() => signOne(re, "pause-out"));
  if (location.protocol === "file:") log("WARNING: opened from file://. Serve it from http://localhost instead (see README).");
  const s = await getSelector();
  setConnected(await activeAccount());
  s.store.observable.subscribe(() => activeAccount().then((a) => { if (a !== connected) setConnected(a); }));
}

window.__walletPage = { plan: P, toSelectorTx, start };
if (!window.__WALLET_PAGE_NO_AUTOSTART) start().catch((e) => log(`ERROR: ${e?.message ?? e}`));
