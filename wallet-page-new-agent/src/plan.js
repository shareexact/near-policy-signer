// A new agent for the testnet deployment, in three owner transactions (aa5hr.testnet, in Meteor):
//   1. create the agent's account: testnet.create_account {new_account_id, new_public_key} with a 0.5 NEAR deposit,
//      the public key made by agent/scripts/new-agent.mjs (then that script gives the account its only key,
//      a function-call key for policy-v1 method `request`, and deletes the full-access key);
//   2. add_agent on policy-v1: with policy_delay_s 3600 it is scheduled, not applied (`change_scheduled`);
//   3. execute_change for that change, once its executable_at has passed.
// Checked against policy-signer/src/lib.rs: add_agent(agent, policy: AgentPolicy {enabled, label, max_requests_per_day}),
// execute_change(change_id: u64); both #[payable] owner-only (exactly 1 yoctoNEAR). The `testnet` account is NEAR's
// testnet registrar (create_account creates <name>.testnet with one full-access key and transfers the deposit).
// Public data only, no secrets. FunctionCall only.
export const NETWORK = "testnet";
export const RPCS = ["https://test.rpc.fastnear.com", "https://rpc.testnet.near.org"];
export const SIGNER = "aa5hr.testnet";
export const POLICY = "policy-v1.shareexact-chainsig-demo.testnet";
export const REGISTRAR = "testnet";
export const EXPECTED_CODE_HASH = "E1xgsbWL3TwTefBKFAUdLoKiuYME2zEw938T8ycsnbPF"; // reproducible build of a3ac91e
export const POLICY_DELAY_S = 3600;
export const DEFAULT_AGENT = "policy-signer-agent-v2.testnet";
export const AGENT_POLICY = { enabled: true, label: "demo agent v2", max_requests_per_day: 20 };
export const REREAD_DELAY_MS = 5000;
const TGAS = 10n ** 12n;
export const OWNER_GAS = 30n * TGAS;
export const CREATE_GAS = 100n * TGAS;
export const ONE_YOCTO = 1n;
export const CREATE_DEPOSIT = 500_000_000_000_000_000_000_000n; // 0.5 NEAR: the agent's gas money and storage

export const NAME_RE = /^[a-z0-9]+([-_][a-z0-9]+)*\.testnet$/;
export const PK_RE = /^ed25519:[1-9A-HJ-NP-Za-km-z]{43,44}$/;

const fc = (methodName, args, gas = OWNER_GAS, deposit = ONE_YOCTO) => ({ type: "FunctionCall", methodName, args, gas, deposit });
export const create = (agent, publicKey) => ({ id: "N1", button: "create", title: `create ${agent} (0.5 NEAR from ${SIGNER})`, receiverId: REGISTRAR,
  actions: [fc("create_account", { new_account_id: agent, new_public_key: publicKey }, CREATE_GAS, CREATE_DEPOSIT)] });
export const schedule = (agent) => ({ id: "N2", button: "schedule", title: `add_agent ${agent} (scheduled: waits 1 hour)`, receiverId: POLICY,
  actions: [fc("add_agent", { agent, policy: AGENT_POLICY })] });
export const execute = (changeId) => ({ id: "N3", button: "execute", title: `execute_change ${changeId}`, receiverId: POLICY,
  actions: [fc("execute_change", { change_id: changeId })] });

const near = (y) => `${Number(y / 10n ** 21n) / 1000} NEAR`;
export function describe(tx) {
  const lines = [`Signer: ${SIGNER}`, `Receiver: ${tx.receiverId}`, "Actions:"];
  tx.actions.forEach((a, i) => {
    lines.push(`  ${i + 1}. FunctionCall ${a.methodName}, gas ${a.gas / TGAS} Tgas (${a.gas}), deposit ${a.deposit === ONE_YOCTO ? "1 yoctoNEAR" : `${near(a.deposit)} (${a.deposit} yoctoNEAR)`}`, `     args ${JSON.stringify(a.args)}`);
  });
  return lines.join("\n");
}
