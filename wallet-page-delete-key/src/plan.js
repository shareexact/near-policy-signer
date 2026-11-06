// One transaction on the owner account aa5hr.testnet: delete its second full-access key, CY9a..., added on Nov 2
// (DEPLOYMENT-TESTNET.md row 10). The key Meteor signs with, 9k4y..., stays; the page refuses anything else.
// Public data only, no secrets. One DeleteKey action; no FunctionCall, Transfer, AddKey or DeleteAccount.
export const NETWORK = "testnet";
// Read-only RPC endpoints, tried in order: a rate-limited or unreachable endpoint falls through to the next.
export const RPCS = ["https://test.rpc.fastnear.com", "https://rpc.testnet.near.org"];
export const SIGNER = "aa5hr.testnet";
export const KEEP_KEY = "ed25519:9k4yvZ8M7yezqHa6yzDoKr1m9nfv8HER5Bux9NUEmgYf"; // Meteor's key: must remain
export const DELETE_KEY = "ed25519:CY9aCwrmVaPMzMJLbxAxFGwGhEKgSgar5UKuVqLGZcaQ";
export const REREAD_DELAY_MS = 5000;

export const DEL = { id: "K1", button: "del", title: `DeleteKey ${DELETE_KEY}`, receiverId: SIGNER, actions: [{ type: "DeleteKey", publicKey: DELETE_KEY }] };

export function describe(tx) {
  const lines = [`Signer: ${SIGNER}`, `Receiver: ${tx.receiverId}`, "Actions:"];
  tx.actions.forEach((a, i) => { if (a.type === "DeleteKey") lines.push(`  ${i + 1}. DeleteKey ${a.publicKey}`); });
  lines.push(`Stays on the account: ${KEEP_KEY} (full access, Meteor)`);
  return lines.join("\n");
}
