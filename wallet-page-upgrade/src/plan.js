// The testnet contract upgrade, signed by the owner in Meteor Wallet, in two steps:
//   1. propose_upgrade(code_hash): announces the new code on chain; it can be applied no earlier than
//      upgrade_delay_s (48 hours) later, and the owner can cancel_upgrade in between.
//   2. apply_upgrade(code): after the delay, deploys exactly the wasm whose sha256 was proposed and calls migrate.
// Checked against policy-signer/src/lib.rs: both are #[payable] owner-only (assert_owner: exactly 1 yoctoNEAR).
// The wasm is the reproducible build of commit SOURCE_COMMIT (CI artifact policy-signer-reproducible-wasm);
// anyone can rebuild it with `cargo near build reproducible-wasm` and compare the sha256.
// Public data only, no secrets. FunctionCall only; no CreateAccount, Transfer, AddKey or DeployContract action.
export const NETWORK = "testnet";
export const RPC = "https://rpc.testnet.near.org";
export const SIGNER = "aa5hr.testnet";
export const POLICY = "policy-v1.shareexact-chainsig-demo.testnet";
export const DEPLOYED_CODE_HASH = "8EtC2o7j51xd7ESB6vJJLCA18CPytCcmZ6HETqcSPows"; // 88e06a6, base58 as NEAR reports it
export const SOURCE_COMMIT = "a3ac91e3a581e9f01c665ec6e455ba39a55c9bdf";
export const NEW_CODE_SHA256 = "c166e5635d8df6d25528acfa611c8ee81228650dced0b2f6a986ef6687d95e5a"; // hex, as propose_upgrade takes it
export const WASM_FILE = "policy_signer.wasm"; // served next to index.html for step 2
const TGAS = 10n ** 12n;
export const PROPOSE_GAS = 30n * TGAS;
export const APPLY_GAS = 300n * TGAS;
export const ONE_YOCTO = 1n;

export const PROPOSE = {
  id: "U1", button: "propose", title: "propose_upgrade", receiverId: POLICY,
  actions: [{ type: "FunctionCall", methodName: "propose_upgrade", args: { code_hash: NEW_CODE_SHA256 }, gas: PROPOSE_GAS, deposit: ONE_YOCTO }],
};
// The apply action's args are filled from the verified wasm file at click time.
export const applyTx = (codeBase64) => ({
  id: "U2", button: "apply", title: "apply_upgrade", receiverId: POLICY,
  actions: [{ type: "FunctionCall", methodName: "apply_upgrade", args: { code: codeBase64 }, gas: APPLY_GAS, deposit: ONE_YOCTO }],
});

// Step 3, after the upgrade: turn on the policy delay (1 hour) with every other parameter at the value the
// deployment has had since Nov 2 (the contract defaults). With the delay at 0 this applies at once; from then on
// every loosening, and any ownership transfer, waits an hour and can be cancelled.
export const NEW_CODE_HASH_B58 = "E1xgsbWL3TwTefBKFAUdLoKiuYME2zEw938T8ycsnbPF"; // NEW_CODE_SHA256 as NEAR reports a code hash
export const CURRENT_PARAMS = {
  max_observation_age_s: 120, max_clock_skew_s: 15, corp_action_window_s: 7200, max_requests_per_day: 50,
  pending_ticket_ttl_s: 86400, approved_ticket_ttl_s: 900, max_open_tickets: 20, upgrade_delay_s: 172800, policy_delay_s: 0,
};
export const NEW_PARAMS = { ...CURRENT_PARAMS, policy_delay_s: 3600 };
export const SET_DELAY = {
  id: "U3", button: "delay", title: "set_params (policy_delay_s 3600)", receiverId: POLICY,
  actions: [{ type: "FunctionCall", methodName: "set_params", args: { params: NEW_PARAMS }, gas: PROPOSE_GAS, deposit: ONE_YOCTO }],
};

export function describe(tx) {
  const lines = [`Signer: ${SIGNER}`, `Receiver: ${tx.receiverId}`, "Actions:"];
  tx.actions.forEach((a, i) => {
    const args = a.methodName === "apply_upgrade" ? `{"code": <${Math.floor((a.args.code.length * 3) / 4)} bytes of wasm, sha256 ${NEW_CODE_SHA256}>}` : JSON.stringify(a.args);
    lines.push(`  ${i + 1}. FunctionCall ${a.methodName}, gas ${a.gas / TGAS} Tgas (${a.gas}), deposit ${a.deposit} yoctoNEAR`, `     args ${args}`);
  });
  return lines.join("\n");
}
