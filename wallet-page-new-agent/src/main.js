import { Buffer } from "buffer";
globalThis.Buffer ??= Buffer;
import { setupWalletSelector } from "@near-wallet-selector/core";
import { setupMeteorWallet } from "@near-wallet-selector/meteor-wallet";
import { actionCreators } from "@near-js/transactions";
import * as P from "./plan.js";

const $ = (id) => document.getElementById(id);
const log = (msg) => { const el = $("log"); el.textContent += `[${new Date().toLocaleTimeString()}] ${msg}\n`; };
// Read from the chain and the two fields at every refresh, and again right before signing.
let current = { agent: null, pk: null, plans: {} };

export function toNajActions(actions) {
  return actions.map((a) => {
    if (a.type !== "FunctionCall") throw new Error(`unknown action ${a.type}`);
    return actionCreators.functionCall(a.methodName, a.args, a.gas, a.deposit);
  });
}
const shape = (tx) => JSON.stringify({ r: tx.receiverId, a: tx.actions.map((a) => [a.type, a.methodName, a.args, String(a.gas), String(a.deposit)]) });
// The page hands the wallet only a transaction equal to one of the plans the last chain read unlocked.
function assertPlannedOnly(tx) {
  if (tx.actions.length !== 1) throw new Error("refusing: exactly one action per transaction");
  const ok = Object.values(current.plans).some((p) => p && shape(p) === shape(tx));
  if (!ok) throw new Error("refusing: this transaction is not one the on-chain state unlocked");
}
export const toSelectorTx = (tx) => (assertPlannedOnly(tx), { signerId: P.SIGNER, receiverId: tx.receiverId, actions: toNajActions(tx.actions) });

// An RPC error is never read as an empty answer: it throws and every button stays locked.
// UNKNOWN_ACCOUNT is the one expected error: it means "no such account".
async function rpc(method, params) {
  let last = null;
  for (const url of P.RPCS) {
    try {
      const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      if (j.error && j.error.cause?.name !== "UNKNOWN_ACCOUNT") throw new Error(JSON.stringify(j.error).slice(0, 200));
      return j;
    } catch (e) { last = new Error(`${new URL(url).host}: ${e?.message ?? e}`); }
  }
  throw last;
}
const q = async (params) => (await rpc("query", { finality: "final", ...params })).result ?? null;
async function view(method, args) {
  const r = await q({ request_type: "call_function", account_id: P.POLICY, method_name: method, args_base64: btoa(JSON.stringify(args)) });
  if (!Array.isArray(r?.result)) throw new Error(`view ${method}: ${JSON.stringify(r?.error ?? r).slice(0, 200)}`);
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

const isRequestKey = (k) => k.access_key?.permission?.FunctionCall?.receiver_id === P.POLICY
  && JSON.stringify(k.access_key.permission.FunctionCall.method_names) === JSON.stringify(["request"]);
const keyText = (keys) => keys.map((k) => `${k.public_key.slice(0, 14)}... ${k.access_key.permission === "FullAccess" ? "full access" : `function call ${JSON.stringify(k.access_key.permission.FunctionCall?.method_names)} on ${k.access_key.permission.FunctionCall?.receiver_id}`}`).join("; ");

// The locks:
//   create:   the agent name is a valid top-level testnet name that does not exist yet, and the public key is an ed25519 key;
//   schedule: policy-v1 is the upgraded code with no keys, owned by aa5hr.testnet, delay 3600; the agent account has exactly one key,
//             a function-call key for policy-v1 method request; it is not registered and nothing is scheduled for it;
//   execute:  the scheduled add_agent for this agent, with exactly the planned policy, and its time has come.
async function readState() {
  const agent = $("agent-in").value.trim(), pk = $("pk-in").value.trim();
  const nameOk = P.NAME_RE.test(agent) && agent.length <= 64, pkOk = P.PK_RE.test(pk);
  const acc = await q({ request_type: "view_account", account_id: P.POLICY });
  const keys = acc ? (await q({ request_type: "view_access_key_list", account_id: P.POLICY }))?.keys ?? null : null;
  const cfg = acc ? await view("get_config", {}) : undefined;
  const base = acc?.code_hash === P.EXPECTED_CODE_HASH && Array.isArray(keys) && keys.length === 0 && cfg?.owner === P.SIGNER;
  const delayOn = cfg?.params?.policy_delay_s === P.POLICY_DELAY_S;
  const agentKeys = nameOk ? ((await q({ request_type: "view_access_key_list", account_id: agent }))?.keys ?? null) : null;
  const registered = base && nameOk ? await view("get_agent", { agent }) : null;
  const scheduled = base ? await view("list_scheduled_changes", {}) : [];
  const change = scheduled.find((c) => c.change?.SetAgent?.agent === agent) ?? null;
  const now = Math.floor(Date.now() / 1000);
  const onlyRequestKey = Array.isArray(agentKeys) && agentKeys.length === 1 && isRequestKey(agentKeys[0]);
  const policyOk = change && JSON.stringify(change.change.SetAgent.policy) === JSON.stringify(P.AGENT_POLICY);

  const st = {
    create: nameOk && pkOk && agentKeys === null,
    schedule: base && delayOn && nameOk && onlyRequestKey && registered == null && !change,
    execute: base && !!policyOk && registered == null && now >= change.executable_at + 5,
  };
  current = { agent, pk, plans: { create: st.create ? P.create(agent, pk) : null, schedule: st.schedule ? P.schedule(agent) : null, execute: st.execute ? P.execute(change.id) : null } };

  $("gate").textContent = !acc ? `Locked: ${P.POLICY} does not exist.`
    : `policy-v1 code_hash ${acc.code_hash} ${acc.code_hash === P.EXPECTED_CODE_HASH ? "(the upgraded code)" : "(unexpected)"}; access keys: ${keys ? keys.length : "?"}; owner ${cfg?.owner ?? "?"}; policy_delay_s ${cfg?.params?.policy_delay_s ?? "?"}. ${base ? "OK." : "Locked."}`;
  $("create-gate").textContent = !nameOk ? "Enter the agent account (a name ending in .testnet). Locked."
    : agentKeys !== null ? `${agent} exists: ${keyText(agentKeys)}. Nothing to create.`
    : !pkOk ? `${agent} does not exist yet. Enter the public key (ed25519:...). Locked.`
    : `${agent} does not exist yet. Unlocked.`;
  $("schedule-gate").textContent = !nameOk ? "Locked."
    : agentKeys === null ? `${agent} does not exist yet. Locked.`
    : registered != null ? `${agent} is already registered: ${JSON.stringify(registered)}. Nothing to do.`
    : change ? `Already scheduled: change ${change.id}, executable ${new Date(change.executable_at * 1000).toLocaleString()}.`
    : !onlyRequestKey ? `${agent} keys: ${keyText(agentKeys)}. Locked until it has only the request key (run new-agent.mjs finish).`
    : !delayOn ? "Locked: the policy delay is not 3600." : st.schedule ? `${agent}: one function-call key for request. Unlocked.` : "Locked.";
  $("execute-gate").textContent = registered != null ? `${agent} is registered: ${JSON.stringify(registered)}. Done.`
    : !change ? "Nothing scheduled for this agent. Locked."
    : !policyOk ? `Change ${change.id} is not the planned add_agent: ${JSON.stringify(change.change)}. Locked.`
    : st.execute ? `Change ${change.id} is executable since ${new Date(change.executable_at * 1000).toLocaleString()}. Unlocked.`
    : `Change ${change.id}: executable from ${new Date(change.executable_at * 1000).toLocaleString()}. Locked until then.`;
  for (const b of ["create", "schedule", "execute"]) $(`${b}-desc`).textContent = current.plans[b] ? P.describe(current.plans[b]) : "";
  return st;
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

const BUTTONS = ["create", "schedule", "execute"];
async function signOne(button) {
  await guardSigner();
  const st = await readState();
  const tx = current.plans[button];
  if (!st[button] || !tx) throw new Error(`${button} is locked by on-chain state`);
  if (!window.confirm(`Ask Meteor to sign this transaction?\n\n${P.describe(tx)}`)) { log(`${tx.id}: cancelled`); return; }
  log(`${tx.id} ${tx.title}: sent to Meteor for approval`);
  const w = await (await getSelector()).wallet("meteor-wallet");
  const out = await w.signAndSendTransaction(toSelectorTx(tx));
  showHashes(`${button}-out`, out);
  log("re-reading the chain in 5 s");
  for (const id of BUTTONS) $(id).disabled = true;
  await new Promise((r) => setTimeout(r, P.REREAD_DELAY_MS));
  await refreshState();
}

let refreshSeq = 0;
async function refreshState() {
  const seq = ++refreshSeq;
  for (const id of BUTTONS) $(id).disabled = true; // locked while re-reading the chain
  let st;
  try { st = await readState(); } catch (e) {
    if (seq !== refreshSeq) return;
    current = { agent: null, pk: null, plans: {} };
    $("gate").textContent = `Could not read the chain (${e?.message ?? e}). Every button stays locked; press Refresh on-chain state.`;
    for (const g of ["create-gate", "schedule-gate", "execute-gate"]) $(g).textContent = "Unknown: the chain could not be read. Locked.";
    log(`ERROR reading the chain: ${e?.message ?? e}`);
    return;
  }
  if (seq !== refreshSeq) return; // a newer refresh owns the buttons
  const signerOk = connected === P.SIGNER;
  for (const id of BUTTONS) $(id).disabled = !signerOk || !st[id];
}
const run = (fn) => async () => { try { await fn(); } catch (e) { log(`ERROR: ${e?.message ?? e}`); } };
const store = { get: (k) => { try { return window.localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { window.localStorage.setItem(k, v); } catch {} } };

export async function start() {
  $("agent-in").value = store.get("nps-agent") ?? P.DEFAULT_AGENT;
  $("pk-in").value = store.get("nps-agent-pk") ?? "";
  let t = null;
  const onInput = () => { store.set("nps-agent", $("agent-in").value.trim()); store.set("nps-agent-pk", $("pk-in").value.trim()); clearTimeout(t); t = setTimeout(refreshState, 400); };
  $("agent-in").oninput = onInput; $("pk-in").oninput = onInput;
  $("connect").onclick = run(connect);
  $("disconnect").onclick = run(disconnect);
  $("refresh").onclick = run(refreshState);
  for (const b of BUTTONS) $(b).onclick = run(() => signOne(b));
  if (location.protocol === "file:") log("WARNING: opened from file://. Serve it from http://localhost instead (see README).");
  const s = await getSelector();
  setConnected(await activeAccount());
  s.store.observable.subscribe(() => activeAccount().then((a) => { if (a !== connected) setConnected(a); }));
}

window.__walletPage = { plan: P, toSelectorTx, start };
if (!window.__WALLET_PAGE_NO_AUTOSTART) start().catch((e) => log(`ERROR: ${e?.message ?? e}`));
