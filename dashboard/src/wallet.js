// Optional NEAR wallet connection for owner actions, loaded only when the
// owner clicks "Connect wallet". Testnet only, by decision: mainnet waits for
// an external security review.
import { Buffer } from "buffer";
import "@near-wallet-selector/modal-ui/styles.css";

// The wallet libraries use Node's Buffer, which browsers do not provide.
globalThis.Buffer ??= Buffer;

let selector = null;
let modal = null;

export const NETWORK = "testnet";

export async function connect(contractId) {
  if (!contractId.endsWith(".testnet")) {
    throw new Error("The console signs on testnet only; the contract account must end in .testnet");
  }
  if (!selector) {
    const [{ setupWalletSelector }, { setupModal }, { setupMyNearWallet }, { setupMeteorWallet }, { setupHereWallet }] =
      await Promise.all([
        import("@near-wallet-selector/core"),
        import("@near-wallet-selector/modal-ui"),
        import("@near-wallet-selector/my-near-wallet"),
        import("@near-wallet-selector/meteor-wallet"),
        import("@near-wallet-selector/here-wallet"),
      ]);
    selector = await setupWalletSelector({
      network: NETWORK,
      modules: [setupMyNearWallet(), setupMeteorWallet(), setupHereWallet()],
    });
    // Signing in may create a limited key for a view method only. Every owner
    // method needs exactly 1 yoctoNEAR, which a limited key cannot attach, so
    // each owner action still asks the wallet for a full confirmation.
    modal = setupModal(selector, { contractId, methodNames: ["get_config"], description: "Owner console for the policy signer" });
  }
  if (!selector.isSignedIn()) modal.show();
  return selector;
}

export function signedInAccount() {
  if (!selector) return null;
  const accounts = selector.store.getState().accounts;
  return accounts.find((a) => a.active)?.accountId ?? accounts[0]?.accountId ?? null;
}

export function onChange(cb) {
  if (selector) selector.store.observable.subscribe(() => cb(signedInAccount()));
}

/** Send one owner call: 1 yoctoNEAR, 100 Tgas. Returns the transaction hash. */
export async function ownerCall(contractId, methodName, args) {
  if (!selector) throw new Error("Connect a wallet first");
  const wallet = await selector.wallet();
  const outcome = await wallet.signAndSendTransaction({
    receiverId: contractId,
    actions: [{ type: "FunctionCall", params: { methodName, args, gas: "100000000000000", deposit: "1" } }],
  });
  return outcome?.transaction?.hash ?? outcome?.transaction_outcome?.id ?? "sent";
}

export async function disconnect() {
  if (!selector) return;
  const wallet = await selector.wallet();
  await wallet.signOut();
}
