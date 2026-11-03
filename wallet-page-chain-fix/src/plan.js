// One owner call for policy-v1.shareexact-chainsig-demo.testnet: set_chain 46630 again with exact_transfer cleared.
// No ExactTransfer is deployed on Robinhood Chain testnet, so the chain policy must not name one; with it cleared the
// contract refuses StockExact tokens ("StockExact needs exact_transfer on the chain"). Every other field is unchanged.
// Checked against policy-signer/src/lib.rs @ 88e06a6:
//   #[payable] pub fn set_chain(&mut self, chain_id: u64, policy: ChainPolicy) -> assert_owner(); applies at once with policy_delay_s 0
// Public data only, no secrets. FunctionCall only; no CreateAccount, Transfer or AddKey anywhere.
export const NETWORK = "testnet";
export const RPC = "https://rpc.testnet.near.org";
export const SIGNER = "aa5hr.testnet";
export const POLICY = "policy-v1.shareexact-chainsig-demo.testnet";
export const EXPECTED_CODE_HASH = "8EtC2o7j51xd7ESB6vJJLCA18CPytCcmZ6HETqcSPows";
export const CHAIN_ID = 46630;
const TGAS = 10n ** 12n;
export const OWNER_GAS = 30n * TGAS;
export const ONE_YOCTO = 1n;

// The chain policy as set on Nov 2 (DEPLOYMENT-TESTNET.md row 12), apart from exact_transfer.
export const KEEP = { max_fee_per_gas: "1000000000", max_priority_fee_per_gas: "100000000", max_gas_limit: "200000", unknown_recipients_need_approval: true };
export const NEW_POLICY = { max_fee_per_gas: KEEP.max_fee_per_gas, max_priority_fee_per_gas: KEEP.max_priority_fee_per_gas, max_gas_limit: KEEP.max_gas_limit, exact_transfer: null, unknown_recipients_need_approval: true };

const fc = (methodName, args) => ({ type: "FunctionCall", methodName, args, gas: OWNER_GAS, deposit: ONE_YOCTO });
export const FIX = { id: "F1", button: "fix", title: "set_chain 46630, exact_transfer cleared", receiverId: POLICY, actions: [fc("set_chain", { chain_id: CHAIN_ID, policy: NEW_POLICY })] };

export function describe(tx) {
  const lines = [`Signer: ${SIGNER}`, `Receiver: ${tx.receiverId}`, "Actions:"];
  tx.actions.forEach((a, i) => {
    if (a.type === "FunctionCall") lines.push(`  ${i + 1}. FunctionCall ${a.methodName}, gas ${a.gas / TGAS} Tgas (${a.gas}), deposit ${a.deposit} yoctoNEAR`, `     args ${JSON.stringify(a.args)}`);
  });
  return lines.join("\n");
}
