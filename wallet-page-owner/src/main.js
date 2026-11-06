import { Buffer } from "buffer";
globalThis.Buffer ??= Buffer;
import { setupWalletSelector } from "@near-wallet-selector/core";
import { setupMeteorWallet } from "@near-wallet-selector/meteor-wallet";
import { actionCreators } from "@near-js/transactions";
import * as P from "./plan.js";

const $ = (id) => document.getElementById(id);
const log = (msg) => { const el = $("log"); el.textContent += `[${new Date().toLocaleTimeString()}] ${msg}\n`; };
const ALLOWED = new Set(["approve_ticket", "set_paused", "set_recipient", "cancel_change"]);
// Read from the chain at every refresh and again right before signing.
let current = { pendingTicket: null, bobChange: null };

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
    if (!ALLOWED.has(a.methodName)) throw new Error(`refusing: method ${a.methodName} is not an owner call of this page`);
    const expected = {
      approve_ticket: current.pendingTicket ? JSON.stringify({ ticket_id: current.pendingTicket.id }) : null,
      set_paused: [JSON.stringify(P.PAUSE.actions[0].args), JSON.stringify(P.RESUME.actions[0].args)],
      set_recipient: JSON.stringify(P.SCHEDULE.actions[0].args),
      cancel_change: current.bobChange ? JSON.stringify({ change_id: current.bobChange.id }) : null,
    }[a.methodName];
    const got = JSON.stringify(a.args);
    if (!(Array.isArray(expected) ? expected.includes(got) : got === expected)) throw new Error(`refusing: ${a.methodName} arguments ${got} are not the ones read from the chain`);
  }
}
export const toSelectorTx = (tx) => (assertOwnerCallOnly(tx), { signerId: P.SIGNER, receiverId: tx.receiverId, actions: toNajActions(tx.actions) });

// An RPC error is never read as an empty answer: it throws, and the caller keeps every button locked.
// The one expected error, UNKNOWN_ACCOUNT, is returned so view_account can report a missing account.
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

// On-chain state. Each button's lock:
//   all:      policy-v1 runs the upgraded code (code_hash), 0 access keys, get_config.owner == aa5hr.testnet
//   approve:  the newest ticket that is Pending and unexpired exists; the button approves exactly that one
//   pause / resume: paused is false / true
//   schedule: policy_delay_s is 3600, bob is not allowlisted, and no change for bob is scheduled
//   cancel:   a scheduled AllowRecipient for bob on 46630 exists; the button cancels exactly that one
async function readState() {
  const acc = await q({ request_type: "view_account", account_id: P.POLICY });
  const keys = acc ? (await q({ request_type: "view_access_key_list", account_id: P.POLICY }))?.keys ?? null : null;
  const cfg = acc ? await view("get_config", {}) : undefined;
  const base = acc?.code_hash === P.EXPECTED_CODE_HASH && Array.isArray(keys) && keys.length === 0 && cfg?.owner === P.SIGNER;
  const tickets = base ? (await view("list_tickets", { from_index: null, limit: null })) ?? [] : [];
  const scheduled = base ? (await view("list_scheduled_changes", {})) ?? [] : [];
  const bobAllowed = base ? await view("is_recipient_allowed", { chain_id: P.CHAIN_ID, recipient: P.DEMO_RECIPIENT }) : undefined;
  const now = Math.floor(Date.now() / 1000);
  const pending = tickets.filter((t) => t.status === "Pending" && now < t.expires_at).sort((a, b) => b.id - a.id)[0] ?? null;
  const bobChange = scheduled.find((c) => c.change?.AllowRecipient && c.change.AllowRecipient.chain_id === P.CHAIN_ID
    && String(c.change.AllowRecipient.recipient).toLowerCase() === P.DEMO_RECIPIENT) ?? null;
  current = { pendingTicket: pending, bobChange };
  const paused = typeof cfg?.paused === "boolean" ? cfg.paused : null;
  const delayOn = cfg?.params?.policy_delay_s === P.POLICY_DELAY_S;
  $("gate").textContent = !acc ? `Locked: ${P.POLICY} does not exist.`
    : `policy-v1 code_hash ${acc.code_hash} ${acc.code_hash === P.EXPECTED_CODE_HASH ? "(the upgraded code)" : `(expected the upgraded code ${P.EXPECTED_CODE_HASH})`}; access keys: ${keys ? keys.length : "?"}; owner ${cfg?.owner ?? "?"}; paused ${paused}; policy_delay_s ${cfg?.params?.policy_delay_s ?? "?"}. ${base ? "OK." : "Locked."}`;
  $("approve-gate").textContent = pending ? `Newest pending ticket: ${pending.id}, ${pending.amount} (token units) to ${pending.recipient} from ${pending.agent}, expires ${new Date(pending.expires_at * 1000).toLocaleString()}.` : "No pending, unexpired ticket. Locked.";
  $("approve-desc").textContent = pending ? P.describe(P.approve(pending.id)) : "";
  $("approve").textContent = pending ? `Approve ticket ${pending.id} (approve_ticket)` : "Approve ticket";
  $("pause-gate").textContent = `paused: ${paused}. ${base ? (paused ? "Resume unlocked." : "Pause unlocked.") : "Locked."}`;
  $("delay-gate").textContent = !base ? "Locked." : !delayOn ? `Locked: policy_delay_s is ${cfg?.params?.policy_delay_s}, not ${P.POLICY_DELAY_S} (turn it on with wallet-page-upgrade step 3).`
    : bobChange ? `Scheduled: change ${bobChange.id}, allow bob, executable ${new Date(bobChange.executable_at * 1000).toLocaleString()}. Cancel unlocked.`
    : bobAllowed ? "bob is already allowlisted. Locked."
    : "Delay on, bob not allowlisted, nothing scheduled. Schedule unlocked.";
  return {
    approve: base && !!pending,
    pause: base && paused === false,
    resume: base && paused === true,
    schedule: base && delayOn && bobAllowed === false && !bobChange,
    cancel: base && !!bobChange,
  };
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

async function signOne(makeTx, outId, button) {
  await guardSigner();
  const st = await readState();
  if (!st[button]) throw new Error(`${button} is locked by on-chain state`);
  const tx = makeTx();
  if (!window.confirm(`Ask Meteor to sign this transaction?\n\n${P.describe(tx)}`)) { log(`${tx.id}: cancelled`); return; }
  log(`${tx.id} ${tx.title}: sent to Meteor for approval`);
  const w = await (await getSelector()).wallet("meteor-wallet");
  const out = await w.signAndSendTransaction(toSelectorTx(tx));
  showHashes(outId, out);
  // Views read final state, a few blocks behind the transaction: wait before re-reading, so the page never shows the old state.
  log("re-reading the chain in 5 s");
  for (const id of BUTTONS) $(id).disabled = true;
  await new Promise((r) => setTimeout(r, P.REREAD_DELAY_MS));
  await refreshState();
}

const BUTTONS = ["approve", "pause", "resume", "schedule", "cancel"];
let refreshSeq = 0;
async function refreshState() {
  const seq = ++refreshSeq;
  for (const id of BUTTONS) $(id).disabled = true; // locked while re-reading the chain
  let st;
  try { st = await readState(); } catch (e) {
    if (seq !== refreshSeq) return;
    $("gate").textContent = `Could not read the chain (${e?.message ?? e}). Every button stays locked; press Refresh on-chain state.`;
    for (const g of ["approve-gate", "pause-gate", "delay-gate"]) $(g).textContent = "Unknown: the chain could not be read. Locked.";
    log(`ERROR reading the chain: ${e?.message ?? e}`);
    return;
  }
  if (seq !== refreshSeq) return; // a newer refresh owns the buttons
  const signerOk = connected === P.SIGNER; // read after the await, so a connect during the read counts
  for (const id of BUTTONS) $(id).disabled = !signerOk || !st[id];
}
const run = (fn) => async () => { try { await fn(); } catch (e) { log(`ERROR: ${e?.message ?? e}`); } };

export async function start() {
  $("delay-desc").textContent = P.describe(P.SCHEDULE);
  $("connect").onclick = run(connect);
  $("disconnect").onclick = run(disconnect);
  $("refresh").onclick = run(refreshState);
  $("approve").onclick = run(() => signOne(() => P.approve(current.pendingTicket.id), "approve-out", "approve"));
  $("pause").onclick = run(() => signOne(() => P.PAUSE, "pause-out", "pause"));
  $("resume").onclick = run(() => signOne(() => P.RESUME, "pause-out", "resume"));
  $("schedule").onclick = run(() => signOne(() => P.SCHEDULE, "delay-out", "schedule"));
  $("cancel").onclick = run(() => signOne(() => P.cancel(current.bobChange.id), "delay-out", "cancel"));
  if (location.protocol === "file:") log("WARNING: opened from file://. Serve it from http://localhost instead (see README).");
  const s = await getSelector();
  setConnected(await activeAccount());
  s.store.observable.subscribe(() => activeAccount().then((a) => { if (a !== connected) setConnected(a); }));
}

window.__walletPage = { plan: P, toSelectorTx, start };
if (!window.__WALLET_PAGE_NO_AUTOSTART) start().catch((e) => log(`ERROR: ${e?.message ?? e}`));
