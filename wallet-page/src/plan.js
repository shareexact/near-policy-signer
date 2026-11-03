// U3 only: the 4 owner calls from WALLET-SIGNING.md, for the contract under shareexact-chainsig-demo.testnet.
// Public data only, no secrets. No CreateAccount and no AddKey anywhere.
export const NETWORK = "testnet";
export const RPC = "https://rpc.testnet.near.org";
export const SIGNER = "aa5hr.testnet";
export const POLICY = "policy-v1.shareexact-chainsig-demo.testnet";
export const AGENT = "agent-v1.shareexact-chainsig-demo.testnet";
export const EXPECTED_CODE_HASH = "8EtC2o7j51xd7ESB6vJJLCA18CPytCcmZ6HETqcSPows";
const TGAS = 10n ** 12n;
export const OWNER_GAS = 30n * TGAS;
export const ONE_YOCTO = 1n;

// Plain descriptions; turned into wallet-selector (near-js) actions in main.js.
const fc = (methodName, args) => ({ type: "FunctionCall", methodName, args, gas: OWNER_GAS, deposit: ONE_YOCTO });
export const U3 = [
  { id: "U3.1", title: "add_agent", receiverId: POLICY, actions: [fc("add_agent", { agent: AGENT, policy: { enabled: true, label: "demo agent", max_requests_per_day: 20 } })] },
  { id: "U3.2", title: "set_chain", receiverId: POLICY, actions: [fc("set_chain", { chain_id: 46630, policy: { max_fee_per_gas: "1000000000", max_priority_fee_per_gas: "100000000", max_gas_limit: "200000", exact_transfer: "0x2cbaedbf8bf46600cf311c7065f901aad973fd8e", unknown_recipients_need_approval: true } })] },
  { id: "U3.3", title: "set_token", receiverId: POLICY, actions: [fc("set_token", { chain_id: 46630, token: "0x0000000000000000000000000000000000000000", policy: { kind: "Native", max_per_request: "1000000000000000", max_per_day: "5000000000000000", approval_above: "500000000000000" } })] },
  { id: "U3.4", title: "set_recipient", receiverId: POLICY, actions: [fc("set_recipient", { chain_id: 46630, recipient: "0x0C7F5b0f2cbA6a576F92f60205e87F4D28080490", allowed: true })] },
];

export function describe(tx) {
  const lines = [`Signer: ${SIGNER}`, `Receiver: ${tx.receiverId}`, "Actions:"];
  tx.actions.forEach((a, i) => {
    const n = `  ${i + 1}.`;
    if (a.type === "FunctionCall") lines.push(`${n} FunctionCall ${a.methodName}, gas ${a.gas / TGAS} Tgas (${a.gas}), deposit ${a.deposit} yoctoNEAR`, `     args ${JSON.stringify(a.args)}`);
  });
  return lines.join("\n");
}
