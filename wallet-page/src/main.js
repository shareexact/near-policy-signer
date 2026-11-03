import { Buffer } from "buffer";
globalThis.Buffer ??= Buffer;
import { setupWalletSelector } from "@near-wallet-selector/core";
import { setupMeteorWallet } from "@near-wallet-selector/meteor-wallet";
import { actionCreators } from "@near-js/transactions";
import * as P from "./plan.js";

const $ = (id) => document.getElementById(id);
const log = (msg) => { const el = $("log"); el.textContent += `[${new Date().toLocaleTimeString()}] ${msg}\n`; };

// wallet-selector 10.x takes near-js Action objects (core src/lib/wallet/transactions.types.d.ts: `Action = NAJAction`).
export function toNajActions(actions) {
  return actions.map((a) => {
    switch (a.type) {
      case "FunctionCall": return actionCreators.functionCall(a.methodName, a.args, a.gas, a.deposit);
      default: throw new Error(`unknown action ${a.type}`);
    }
  });
}
function assertOwnerCallOnly(tx) {
  if (tx.receiverId !== P.POLICY) throw new Error(`refusing: receiver ${tx.receiverId} is not ${P.POLICY}`);
  for (const a of tx.actions) if (a.type !== "FunctionCall" || a.deposit !== 1n || a.gas !== P.OWNER_GAS) throw new Error("refusing: only FunctionCall, 1 yocto, 30 Tgas is allowed");
}
export const toSelectorTx = (tx) => (assertOwnerCallOnly(tx), { signerId: P.SIGNER, receiverId: tx.receiverId, actions: toNajActions(tx.actions) });

async function rpc(method, params) {
  const r = await fetch(P.RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j = await r.json();
  return j;
}
async function viewAccount(id) {
  const j = await rpc("query", { request_type: "view_account", finality: "final", account_id: id });
  return j.result ?? null;
}
async function keyList(id) {
  const j = await rpc("query", { request_type: "view_access_key_list", finality: "final", account_id: id });
  return j.result?.keys ?? null;
}

let selector = null;
let connected = null;

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
  const s = await getSelector();
  const wallet = await s.wallet("meteor-wallet");
  // No contractId: a plain connect. No dApp function-call key is requested for any contract.
  // @meteorwallet/sdk 1.0.24 requestSignIn does console.log() of the random local dApp key pair it
  // creates (src/MeteorWallet.ts:263). Mute console.log during sign-in so that key is not printed.
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
  const s = await getSelector();
  const st = s.store.getState();
  return st.accounts.find((a) => a.active)?.accountId ?? st.accounts[0]?.accountId ?? null;
}

async function guardSigner() {
  // @meteorwallet/sdk envConfig.ts lets localStorage DEV__METEOR_WALLET_BASE_URL replace https://wallet.meteorwallet.app.
  if (window.localStorage.getItem("DEV__METEOR_WALLET_BASE_URL") != null) throw new Error("refusing to sign: localStorage DEV__METEOR_WALLET_BASE_URL is set (would redirect the wallet)");
  const acct = await activeAccount();
  if (acct !== P.SIGNER) throw new Error(`refusing to sign: connected account is ${acct ?? "none"}, must be ${P.SIGNER}`);
  if ((await getSelector()).options.network.networkId !== "testnet") throw new Error("refusing to sign: network is not testnet");
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
  if (!(await u3Ready())) throw new Error("U3 is locked: policy-v1 has no verified code or still has keys");
  const text = P.describe(tx);
  if (!window.confirm(`Ask Meteor to sign this transaction?\n\n${text}`)) { log(`${tx.id}: cancelled`); return; }
  log(`${tx.id}: sent to Meteor for approval`);
  const w = await (await getSelector()).wallet("meteor-wallet");
  const out = await w.signAndSendTransaction(toSelectorTx(tx));
  showHashes(outId, out);
  refreshState();
}

async function signU3Batch() {
  await guardSigner();
  if (!(await u3Ready())) throw new Error("U3 is locked: policy-v1 has no verified code or still has keys");
  const text = P.U3.map((t, i) => `Transaction ${i + 1} of 4\n${P.describe(t)}`).join("\n\n");
  if (!window.confirm(`Ask Meteor to sign these 4 transactions?\n\n${text}`)) { log("U3: cancelled"); return; }
  log("U3: sent 4 transactions to Meteor for approval");
  const w = await (await getSelector()).wallet("meteor-wallet");
  const out = await w.signAndSendTransactions({ transactions: P.U3.map(toSelectorTx) });
  showHashes("u3-out", out);
}

async function u3Ready() {
  const acc = await viewAccount(P.POLICY);
  const keys = acc ? await keyList(P.POLICY) : null;
  const hashOk = acc?.code_hash === P.EXPECTED_CODE_HASH;
  const keysOk = Array.isArray(keys) && keys.length === 0;
  $("u3-gate").textContent = !acc
    ? `Locked: ${P.POLICY} does not exist.`
    : `policy-v1 code_hash ${acc.code_hash} ${hashOk ? "(matches)" : `(expected ${P.EXPECTED_CODE_HASH})`}; access keys: ${keys ? keys.length : "?"} ${keysOk ? "(empty, ok)" : "(must be 0)"}. ${hashOk && keysOk ? "U3 unlocked." : "Locked."}`;
  return hashOk && keysOk;
}

async function refreshState() {
  const signerOk = connected === P.SIGNER;
  const ready = await u3Ready();
  for (const id of ["u3", "u3-1", "u3-2", "u3-3", "u3-4"]) $(id).disabled = !signerOk || !ready;
}

const run = (fn) => async () => { try { await fn(); } catch (e) { log(`ERROR: ${e?.message ?? e}`); } };

export async function start() {
  $("u3-desc").textContent = P.U3.map((t, i) => `Transaction ${i + 1} of 4 (${t.title})\n${P.describe(t)}`).join("\n\n");
  $("connect").onclick = run(connect);
  $("disconnect").onclick = run(disconnect);
  $("refresh").onclick = run(refreshState);
  $("u3").onclick = run(signU3Batch);
  P.U3.forEach((t, i) => { $(`u3-${i + 1}`).onclick = run(async () => { if (!(await u3Ready())) throw new Error("U3 is locked"); await signOne(t, "u3-out"); }); });
  if (location.protocol === "file:") log("WARNING: opened from file://. Serve it from http://localhost instead (see README).");
  const s = await getSelector();
  setConnected(await activeAccount());
  s.store.observable.subscribe(() => activeAccount().then((a) => { if (a !== connected) setConnected(a); }));
}

window.__walletPage = { plan: P, toSelectorTx, start };
if (!window.__WALLET_PAGE_NO_AUTOSTART) start().catch((e) => log(`ERROR: ${e?.message ?? e}`));
