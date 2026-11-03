// Step 8 owner calls (brief steps 8.4 and 8.5) for policy-v1.shareexact-chainsig-demo.testnet.
// Checked against policy-signer/src/lib.rs @ 88e06a6:
//   #[payable] pub fn approve_ticket(&mut self, ticket_id: u64)   -> assert_owner(): assert_one_yocto + predecessor == owner
//   #[payable] pub fn set_paused(&mut self, paused: bool)         -> assert_owner(); immediate
// Public data only, no secrets. FunctionCall only; no CreateAccount, Transfer or AddKey anywhere.
export const NETWORK = "testnet";
export const RPC = "https://rpc.testnet.near.org";
export const SIGNER = "aa5hr.testnet";
export const POLICY = "policy-v1.shareexact-chainsig-demo.testnet";
export const EXPECTED_CODE_HASH = "8EtC2o7j51xd7ESB6vJJLCA18CPytCcmZ6HETqcSPows";
export const TICKET_ID = 1; // from NEAR tx of `send "send 0.0008 ETH to alice"`: PENDING_APPROVAL ticket 1, 8e14 wei to alice
const TGAS = 10n ** 12n;
export const OWNER_GAS = 30n * TGAS;
export const ONE_YOCTO = 1n;

const fc = (methodName, args) => ({ type: "FunctionCall", methodName, args, gas: OWNER_GAS, deposit: ONE_YOCTO });
export const OWNER = [
  { id: "O1", button: "approve", title: `approve_ticket ${TICKET_ID}`, receiverId: POLICY, actions: [fc("approve_ticket", { ticket_id: TICKET_ID })] },
  { id: "O2", button: "pause", title: "set_paused true (pause)", receiverId: POLICY, actions: [fc("set_paused", { paused: true })] },
  { id: "O3", button: "resume", title: "set_paused false (resume)", receiverId: POLICY, actions: [fc("set_paused", { paused: false })] },
];

export function describe(tx) {
  const lines = [`Signer: ${SIGNER}`, `Receiver: ${tx.receiverId}`, "Actions:"];
  tx.actions.forEach((a, i) => {
    if (a.type === "FunctionCall") lines.push(`  ${i + 1}. FunctionCall ${a.methodName}, gas ${a.gas / TGAS} Tgas (${a.gas}), deposit ${a.deposit} yoctoNEAR`, `     args ${JSON.stringify(a.args)}`);
  });
  return lines.join("\n");
}
