import * as walletApi from "./wallet.js";

const $ = (id) => document.getElementById(id);
const DEMO = {
  config: { version: 1, owner: "owner.example.testnet", signer: "v1.signer-prod.testnet", path: "robinhood-46630-1",
    network: "Testnet", paused: false, sign_gas_tgas: 50, sign_deposit_yocto: "1", requests_today: 7,
    pending_upgrade: null, params: { max_requests_per_day: 50, corp_action_window_s: 7200, max_observation_age_s: 120,
      approved_ticket_ttl_s: 900, upgrade_delay_s: 172800 } },
  tokens: [
    { symbol: "MSHR", address: "0x00000000000000000000000000000000000000aa", decimals: 18,
      status: { paused: false, next_nonce: 12, last_signed_nonce: 11, in_flight: null, cap_unit: "shares",
        spent_today: "6000000000000000000", remaining_today: "4000000000000000000", requests_today: 7, max_requests_per_day: 50,
        open_tickets: 1, token: { kind: "StockExact", max_per_request: "5000000000000000000", max_per_day: "10000000000000000000", approval_above: "2000000000000000000" } } },
    { symbol: "USDT", address: "0x00000000000000000000000000000000000000bb", decimals: 6,
      status: { paused: false, next_nonce: 12, last_signed_nonce: 11, in_flight: { request_id: 31, nonce: 12, kind: "transfer", age_s: 4 },
        cap_unit: "raw", spent_today: "940000000", remaining_today: "60000000", requests_today: 7, max_requests_per_day: 50, open_tickets: 1,
        token: { kind: "Plain", max_per_request: "250000000", max_per_day: "1000000000", approval_above: null } } },
  ],
  changes: [
    { id: 2, executable_at: Math.floor(Date.now() / 1000) + 2700,
      change: { AllowRecipient: { chain_id: 46630, recipient: "0x00000000000000000000000000000000000000dd" } } },
  ],
  tickets: [
    { id: 4, agent: "rebalancer.example.testnet", chain_id: 46630, token: "0x00000000000000000000000000000000000000aa",
      recipient: "0x00000000000000000000000000000000000000cc", amount: "4000000000000000000", status: "Pending",
      created_at: 0, expires_at: 0 },
  ],
};

function fmt(value, decimals) {
  const v = BigInt(value ?? 0), base = 10n ** BigInt(decimals);
  const frac = (v % base).toString().padStart(decimals, "0").replace(/0+$/, "").slice(0, 6);
  return `${(v / base).toLocaleString("en-US")}${frac ? "." + frac : ""}`;
}
function el(tag, attrs = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) k === "class" ? (n.className = v) : n.setAttribute(k, v);
  for (const c of children) n.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return n;
}
function short(s) { return s && s.length > 14 ? `${s.slice(0, 8)}...${s.slice(-4)}` : s; }

async function view(rpc, contract, method, args) {
  const res = await fetch(rpc, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "query", params: { request_type: "call_function",
      finality: "final", account_id: contract, method_name: method, args_base64: btoa(JSON.stringify(args)) } }) });
  const body = await res.json();
  if (body.error || body.result?.error) throw new Error(body.error?.data ?? body.error?.message ?? body.result.error);
  return JSON.parse(new TextDecoder().decode(new Uint8Array(body.result.result)));
}

// Owner actions are printed as near-cli (near-cli-rs) commands for the owner
// to sign with their own key, never sent from here.
function ownerCmd(method, args) {
  const contract = $("contract").value || "CONTRACT";
  const owner = $("owner").value || "OWNER";
  const network = contract.endsWith(".testnet") || !$("contract").value ? "testnet" : "mainnet";
  return `near contract call-function as-transaction ${contract} ${method} json-args '${JSON.stringify(args)}' ` +
    `prepaid-gas '100.0 Tgas' attached-deposit '1 yoctoNEAR' sign-as ${owner} network-config ${network} sign-with-keychain send`;
}
function show(id, text) { const n = $(id); n.textContent = text; n.hidden = false; navigator.clipboard?.writeText(text).catch(() => {}); }

// One path for every owner action: the connected wallet when it is the owner's,
// otherwise the near-cli command to sign elsewhere.
let current = null;
async function ownerAction(outId, method, args) {
  const contract = $("contract").value.trim();
  const account = walletApi.signedInAccount();
  if (account && current && account === current.config.owner && contract) {
    show(outId, `Waiting for your wallet to confirm ${method}...`);
    try {
      const hash = await walletApi.ownerCall(contract, method, args);
      show(outId, `Sent ${method}: transaction ${hash}. Reload to see the result.`);
    } catch (err) {
      show(outId, `Not sent: ${err.message ?? err}`);
    }
    return;
  }
  const why = account ? `Connected as ${account}, which is not the owner. ` : "";
  show(outId, `${why}Sign this with the owner account:\n${ownerCmd(method, args)}`);
}

function setWalletStatus(account) {
  const status = $("wallet-status");
  $("wallet-btn").textContent = account ? `Disconnect ${account}` : "Connect wallet (testnet)";
  if (!account) { status.hidden = true; return; }
  const isOwner = current && account === current.config.owner;
  status.textContent = isOwner
    ? `Connected as the owner (${account}). Owner actions are sent from your wallet; each one asks you to confirm.`
    : `Connected as ${account}. ${current ? `The owner is ${current.config.owner}, so actions show commands instead.` : "Load a contract to check ownership."}`;
  status.hidden = false;
}

$("wallet-btn").onclick = async () => {
  try {
    if (walletApi.signedInAccount()) { await walletApi.disconnect(); setWalletStatus(null); return; }
    const contract = $("contract").value.trim();
    if (!contract) throw new Error("Enter the contract account first");
    await walletApi.connect(contract);
    walletApi.onChange(setWalletStatus);
    setWalletStatus(walletApi.signedInAccount());
  } catch (err) {
    $("error").textContent = err.message ?? String(err);
    $("error").hidden = false;
  }
};

function render(data) {
  current = data;
  setWalletStatus(walletApi.signedInAccount());
  const { config, tokens, tickets } = data;
  const changes = data.changes ?? [];
  const chain = Number($("chain").value || 46630);
  $("badges").replaceChildren(
    el("span", { class: "badge ok" }, config.network),
    el("span", { class: `badge ${config.paused ? "bad" : "ok"}` }, config.paused ? "Paused" : "Running"),
    config.pending_upgrade ? el("span", { class: "badge warn" }, "Upgrade pending") : "",
  );

  $("budgets").replaceChildren(...tokens.map(({ symbol, decimals, status: s }) => {
    if (!s.token) return el("div", { class: "panel" }, `${symbol}: not allowlisted on chain ${chain}`);
    const unitDecimals = s.cap_unit === "shares" ? 18 : decimals;
    const max = BigInt(s.token.max_per_day), spent = BigInt(s.spent_today);
    const pct = max === 0n ? 0 : Number((spent * 1000n) / max) / 10;
    const unit = s.cap_unit === "shares" ? "shares" : symbol;
    return el("div", { class: "panel" },
      el("div", { class: "row" }, el("strong", {}, symbol), el("span", { class: "sub" }, s.token.kind)),
      el("div", { class: "bar" }, el("span", { class: pct >= 100 ? "full" : pct >= 75 ? "hot" : "", style: `width:${Math.min(pct, 100)}%` })),
      el("div", { class: "stats" },
        el("div", { class: "stat" }, el("span", { class: "sub" }, "Spent"), el("b", {}, `${fmt(s.spent_today, unitDecimals)} ${unit}`)),
        el("div", { class: "stat" }, el("span", { class: "sub" }, "Left today"), el("b", {}, `${fmt(s.remaining_today, unitDecimals)} ${unit}`))),
      el("p", { class: "note" },
        `Per request up to ${fmt(s.token.max_per_request, unitDecimals)} ${unit}. `,
        s.token.approval_above ? `Above ${fmt(s.token.approval_above, unitDecimals)} needs your approval.` : "No approval step."));
  }));

  const bySymbol = Object.fromEntries(tokens.map((t) => [t.address.toLowerCase(), t]));
  $("tickets").replaceChildren(...(tickets.length ? tickets.map((t) => {
    const tok = bySymbol[t.token.toLowerCase()];
    const unitDecimals = tok?.status.cap_unit === "shares" || tok?.status.token?.kind !== "Plain" ? 18 : tok.decimals;
    const actions = t.status === "Pending"
      ? el("div", { class: "row" },
          Object.assign(el("button", { type: "button" }, "Approve"), { onclick: () => ownerAction("ticket-cmd", "approve_ticket", { ticket_id: t.id }) }),
          Object.assign(el("button", { type: "button", class: "ghost" }, "Reject"), { onclick: () => ownerAction("ticket-cmd", "reject_ticket", { ticket_id: t.id }) }))
      : el("span", { class: "sub" }, "Waiting for the agent");
    return el("tr", {},
      el("td", {}, `#${t.id}`), el("td", { class: "mono" }, t.agent), el("td", {}, tok?.symbol ?? short(t.token)),
      el("td", {}, fmt(t.amount, unitDecimals)), el("td", { class: "mono" }, short(t.recipient)),
      el("td", {}, el("span", { class: `badge ${t.status === "Pending" ? "warn" : "ok"}` }, t.status)), el("td", {}, actions));
  }) : [el("tr", {}, el("td", { colspan: "7", class: "sub" }, "Nothing waiting."))]));

  const s0 = tokens[0]?.status ?? {};
  const inFlight = s0.in_flight;
  $("signing").replaceChildren(
    el("dt", {}, "Next nonce"), el("dd", {}, s0.next_nonce ?? "0"),
    el("dt", {}, "Last signed"), el("dd", {}, s0.last_signed_nonce ?? "none"),
    el("dt", {}, "In flight"), el("dd", {}, inFlight ? `#${inFlight.request_id} ${inFlight.kind}, nonce ${inFlight.nonce}, ${inFlight.age_s}s` : "none"),
    el("dt", {}, "Requests today"), el("dd", {}, `${s0.requests_today ?? 0} of ${s0.max_requests_per_day ?? config.params.max_requests_per_day}`));

  $("pause").textContent = config.paused ? "Resume" : "Pause";
  $("pause").onclick = () => ownerAction("safety-cmd", "set_paused", { paused: !config.paused });
  $("burn").onclick = () => {
    const nonce = Number(prompt("Nonce to burn", String(s0.last_signed_nonce ?? 0)) ?? NaN);
    if (!Number.isInteger(nonce) || nonce < 0) return;
    const maxFee = prompt("Max fee per gas (wei), above any pending copy and at most 3x the chain cap", "");
    const tip = prompt("Max priority fee per gas (wei), at most the max fee", "");
    if (!/^\d+$/.test(maxFee ?? "") || !/^\d+$/.test(tip ?? "")) return;
    ownerAction("safety-cmd", "burn_nonce", { chain_id: chain, fees: {
      evm_nonce: nonce, gas_limit: "21000", max_fee_per_gas: maxFee, max_priority_fee_per_gas: tip } });
  };

  const nowS = Math.floor(Date.now() / 1000);
  $("changes").replaceChildren(...(changes.length ? changes.map((c) => {
    const [kind, body] = Object.entries(c.change)[0];
    const ready = nowS >= c.executable_at;
    return el("tr", {},
      el("td", {}, `#${c.id}`),
      el("td", { class: "mono" }, `${kind} ${JSON.stringify(body)}`),
      el("td", {}, ready ? "Ready" : new Date(c.executable_at * 1000).toLocaleString()),
      el("td", {}, el("div", { class: "row" },
        Object.assign(el("button", { type: "button", class: ready ? "" : "ghost" }, "Execute"), { disabled: !ready, onclick: () => ownerAction("change-cmd", "execute_change", { change_id: c.id }) }),
        Object.assign(el("button", { type: "button", class: "danger" }, "Cancel"), { onclick: () => ownerAction("change-cmd", "cancel_change", { change_id: c.id }) }))));
  }) : [el("tr", {}, el("td", { colspan: "4", class: "sub" }, "No changes waiting."))]));

  $("config").replaceChildren(...[
    ["Owner", config.owner], ["MPC signer", config.signer], ["Derivation path", config.path],
    ["Sign gas", `${config.sign_gas_tgas} Tgas`], ["Observation max age", `${config.params.max_observation_age_s} s`],
    ["Unit-change window", `${config.params.corp_action_window_s} s`], ["Approved ticket lifetime", `${config.params.approved_ticket_ttl_s} s`],
    ["Upgrade delay", `${config.params.upgrade_delay_s / 3600} h`], ["Pending upgrade", config.pending_upgrade ? config.pending_upgrade.code_hash : "none"],
  ].flatMap(([k, v]) => [el("dt", {}, k), el("dd", {}, v)]));
  $("view").hidden = false;
}

$("demo").onclick = () => { $("error").hidden = true; render(DEMO); };
$("connect").onsubmit = async (e) => {
  e.preventDefault();
  $("error").hidden = true;
  try {
    const rpc = $("rpc").value.trim(), contract = $("contract").value.trim(), chain = Number($("chain").value);
    const tokens = $("tokens").value.split(",").map((s) => s.trim()).filter(Boolean).map((s) => {
      const [symbol, address, decimals] = s.split(":");
      if (!/^0x[0-9a-fA-F]{40}$/.test(address ?? "")) throw new Error(`bad token entry "${s}"`);
      return { symbol, address, decimals: Number(decimals ?? 18) };
    });
    const config = await view(rpc, contract, "get_config", {});
    const withStatus = await Promise.all(tokens.map(async (t) => ({ ...t,
      status: await view(rpc, contract, "get_status", { chain_id: chain, token: t.address }) })));
    if (!withStatus.length) withStatus.push({ symbol: "-", address: "0x0000000000000000000000000000000000000000", decimals: 18,
      status: await view(rpc, contract, "get_status", { chain_id: chain, token: null }) });
    const tickets = await view(rpc, contract, "list_tickets", { from_index: 0, limit: 50 });
    const changes = await view(rpc, contract, "list_scheduled_changes", {});
    if (!$("owner").value) $("owner").value = config.owner;
    render({ config, tokens: withStatus, tickets, changes });
  } catch (err) {
    $("error").textContent = `Could not load: ${err.message}`;
    $("error").hidden = false;
  }
};
