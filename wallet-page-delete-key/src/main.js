import { Buffer } from "buffer";
globalThis.Buffer ??= Buffer;
import { setupWalletSelector } from "@near-wallet-selector/core";
import { setupMeteorWallet } from "@near-wallet-selector/meteor-wallet";
import { actionCreators } from "@near-js/transactions";
import { PublicKey } from "@near-js/crypto";
import * as P from "./plan.js";

const $ = (id) => document.getElementById(id);
const log = (msg) => { const el = $("log"); el.textContent += `[${new Date().toLocaleTimeString()}] ${msg}\n`; };

export function toNajActions(actions) {
  return actions.map((a) => {
    if (a.type !== "DeleteKey") throw new Error(`unknown action ${a.type}`);
    return actionCreators.deleteKey(PublicKey.from(a.publicKey));
  });
}
// The only transaction this page will hand to the wallet: aa5hr.testnet to itself, one DeleteKey of CY9a..., never 9k4y...
function assertPlannedOnly(tx) {
  if (tx.receiverId !== P.SIGNER) throw new Error(`refusing: receiver ${tx.receiverId} is not ${P.SIGNER}`);
  if (tx.actions.length !== 1) throw new Error("refusing: exactly one action per transaction");
  const a = tx.actions[0];
  if (a.type !== "DeleteKey") throw new Error(`refusing: action ${a.type} is not DeleteKey`);
  if (a.publicKey === P.KEEP_KEY) throw new Error("refusing: that is the key Meteor signs with");
  if (a.publicKey !== P.DELETE_KEY) throw new Error(`refusing: key ${a.publicKey} is not ${P.DELETE_KEY}`);
}
export const toSelectorTx = (tx) => (assertPlannedOnly(tx), { signerId: P.SIGNER, receiverId: tx.receiverId, actions: toNajActions(tx.actions) });

// An RPC error is never read as an empty answer: it throws, and the button stays locked.
async function rpc(method, params) {
  let last = null;
  for (const url of P.RPCS) {
    try {
      const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      if (j.error) throw new Error(JSON.stringify(j.error).slice(0, 200));
      return j;
    } catch (e) { last = new Error(`${new URL(url).host}: ${e?.message ?? e}`); }
  }
  throw last;
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

// The button's lock: aa5hr.testnet's key list (read from the chain) has CY9a..., and has 9k4y... with full access,
// so the account keeps a full-access key that Meteor holds.
async function readState() {
  const r = await rpc("query", { finality: "final", request_type: "view_access_key_list", account_id: P.SIGNER });
  const keys = r?.result?.keys;
  if (!Array.isArray(keys)) throw new Error("view_access_key_list returned no key list");
  const perm = (k) => (k.access_key?.permission === "FullAccess" ? "full access" : "function call");
  const has = (pk) => keys.find((k) => k.public_key === pk);
  const del = has(P.DELETE_KEY), keep = has(P.KEEP_KEY);
  const keepOk = keep?.access_key?.permission === "FullAccess";
  $("gate").textContent = `${P.SIGNER} has ${keys.length} key(s): ${keys.map((k) => `${k.public_key.slice(0, 12)}... (${perm(k)})`).join(", ")}. `
    + (!del ? "CY9a... is not there: already deleted, nothing to sign." : !keepOk ? "Locked: 9k4y... (Meteor's key) is not a full-access key of the account." : "Unlocked.");
  return { del: !!del && keepOk };
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

const BUTTONS = ["del"];
async function signOne(tx, outId) {
  await guardSigner();
  const st = await readState();
  if (!st[tx.button]) throw new Error(`${tx.title} is locked by on-chain state`);
  if (!window.confirm(`Ask Meteor to sign this transaction?\n\n${P.describe(tx)}`)) { log(`${tx.id}: cancelled`); return; }
  log(`${tx.id} ${tx.title}: sent to Meteor for approval`);
  const w = await (await getSelector()).wallet("meteor-wallet");
  const out = await w.signAndSendTransaction(toSelectorTx(tx));
  showHashes(outId, out);
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
    $("gate").textContent = `Could not read the chain (${e?.message ?? e}). The button stays locked; press Refresh on-chain state.`;
    log(`ERROR reading the chain: ${e?.message ?? e}`);
    return;
  }
  if (seq !== refreshSeq) return; // a newer refresh owns the buttons
  const signerOk = connected === P.SIGNER; // read after the await, so a connect during the read counts
  for (const id of BUTTONS) $(id).disabled = !signerOk || !st[id];
}
const run = (fn) => async () => { try { await fn(); } catch (e) { log(`ERROR: ${e?.message ?? e}`); } };

export async function start() {
  $("del-desc").textContent = P.describe(P.DEL);
  $("connect").onclick = run(connect);
  $("disconnect").onclick = run(disconnect);
  $("refresh").onclick = run(refreshState);
  $("del").onclick = run(() => signOne(P.DEL, "del-out"));
  if (location.protocol === "file:") log("WARNING: opened from file://. Serve it from http://localhost instead (see README).");
  const s = await getSelector();
  setConnected(await activeAccount());
  s.store.observable.subscribe(() => activeAccount().then((a) => { if (a !== connected) setConnected(a); }));
}

window.__walletPage = { plan: P, toSelectorTx, start };
if (!window.__WALLET_PAGE_NO_AUTOSTART) start().catch((e) => log(`ERROR: ${e?.message ?? e}`));
