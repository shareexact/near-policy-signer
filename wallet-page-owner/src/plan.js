// Owner calls for the testnet contract after its upgrade to the reproducible build of a3ac91e:
//   approve the newest pending ticket, pause and resume, and a demonstration of the policy delay
//   (schedule allowing a new recipient, which must wait 1 hour, then cancel it).
// Checked against policy-signer/src/lib.rs: approve_ticket(ticket_id: u64), set_paused(paused: bool),
// set_recipient(chain_id, recipient, allowed) (scheduled when policy_delay_s > 0), cancel_change(change_id: u64);
// all #[payable] owner-only through assert_owner (exactly 1 yoctoNEAR).
// Public data only, no secrets. FunctionCall only; no CreateAccount, Transfer, AddKey or DeployContract action.
export const NETWORK = "testnet";
// Read-only RPC endpoints, tried in order: a rate-limited or unreachable endpoint falls through to the next.
export const RPCS = ["https://test.rpc.fastnear.com", "https://rpc.testnet.near.org"];
export const SIGNER = "aa5hr.testnet";
export const POLICY = "policy-v1.shareexact-chainsig-demo.testnet";
export const EXPECTED_CODE_HASH = "E1xgsbWL3TwTefBKFAUdLoKiuYME2zEw938T8ycsnbPF"; // reproducible build of a3ac91e
export const CHAIN_ID = 46630;
export const DEMO_RECIPIENT = "0xb0b0000000000000000000000000000000000b0b"; // "bob" in agent/agent.config.judges.json
export const POLICY_DELAY_S = 3600;
export const REREAD_DELAY_MS = 5000;
const TGAS = 10n ** 12n;
export const OWNER_GAS = 30n * TGAS;
export const ONE_YOCTO = 1n;

const fc = (methodName, args) => ({ type: "FunctionCall", methodName, args, gas: OWNER_GAS, deposit: ONE_YOCTO });
export const approve = (ticketId) => ({ id: "O1", button: "approve", title: `approve_ticket ${ticketId}`, receiverId: POLICY, actions: [fc("approve_ticket", { ticket_id: ticketId })] });
export const PAUSE = { id: "O2", button: "pause", title: "set_paused true (pause)", receiverId: POLICY, actions: [fc("set_paused", { paused: true })] };
export const RESUME = { id: "O3", button: "resume", title: "set_paused false (resume)", receiverId: POLICY, actions: [fc("set_paused", { paused: false })] };
export const SCHEDULE = { id: "O4", button: "schedule", title: "set_recipient bob (scheduled: waits 1 hour)", receiverId: POLICY, actions: [fc("set_recipient", { chain_id: CHAIN_ID, recipient: DEMO_RECIPIENT, allowed: true })] };
export const cancel = (changeId) => ({ id: "O5", button: "cancel", title: `cancel_change ${changeId}`, receiverId: POLICY, actions: [fc("cancel_change", { change_id: changeId })] });

export function describe(tx) {
  const lines = [`Signer: ${SIGNER}`, `Receiver: ${tx.receiverId}`, "Actions:"];
  tx.actions.forEach((a, i) => {
    lines.push(`  ${i + 1}. FunctionCall ${a.methodName}, gas ${a.gas / TGAS} Tgas (${a.gas}), deposit ${a.deposit} yoctoNEAR`, `     args ${JSON.stringify(a.args)}`);
  });
  return lines.join("\n");
}
