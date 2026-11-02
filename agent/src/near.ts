// NEAR side: view calls, the agent's `request` call, and waiting for the
// final outcome (the MPC call yields, so the result can take several blocks).
import { Account, KeyPair, connect, keyStores, transactions } from "near-api-js";
import type { Observation } from "./evm.js";

export interface Fees {
  evm_nonce: number;
  gas_limit: string;
  max_fee_per_gas: string;
  max_priority_fee_per_gas: string;
}

/** Mirrors the contract's `TransferRequest`. */
export interface TransferRequest {
  chain_id: number;
  token: string;
  recipient: string;
  amount: string;
  max_shortfall: string;
  observed: Observation | null;
  fees: Fees;
  ticket_id: number | null;
}

export type Outcome =
  | { status: "REFUSED"; reason: string }
  | { status: "PENDING_APPROVAL"; ticket_id: number; expires_at: number }
  | {
      status: "SIGNED";
      request_id: number;
      chain_id: number;
      nonce: number;
      unsigned_tx: `0x${string}`;
      sighash: `0x${string}`;
      signature: { big_r: { affine_point: string }; s: { scalar: string }; recovery_id: number };
    }
  | { status: "SIGN_FAILED"; request_id: number; error: string };

export interface Preview {
  decision: "SIGN" | "NEEDS_APPROVAL" | "REFUSED";
  refusal: string | null;
  cap_unit: string | null;
  cap_amount: string | null;
  raw: string | null;
  raw_is_estimate: boolean;
  sighash: string | null;
  is_replacement: boolean;
}

/** What the agent needs from NEAR. Implemented below; faked in tests. */
export interface PolicyClient {
  view<T>(method: string, args: object): Promise<T>;
  request(req: TransferRequest): Promise<Outcome>;
  derivedPublicKey(): Promise<string>;
}

export interface NearSettings {
  networkId: string;
  rpcUrl: string;
  contractId: string;
  agentAccountId: string;
  mpcContractId: string;
  path: string;
  requestGasTgas: number;
  /** "ed25519:..." function-call key for `request`. Read-only use needs none. */
  agentKey?: string;
}

export async function nearClient(s: NearSettings): Promise<PolicyClient> {
  const keyStore = new keyStores.InMemoryKeyStore();
  if (s.agentKey) {
    await keyStore.setKey(s.networkId, s.agentAccountId, KeyPair.fromString(s.agentKey as `ed25519:${string}`));
  }
  const near = await connect({ networkId: s.networkId, nodeUrl: s.rpcUrl, keyStore });
  const account = await near.account(s.agentAccountId);
  const provider = near.connection.provider;
  const stringStatus = (o: { status: unknown }) => typeof o.status === "string";

  const view = <T>(contractId: string, methodName: string, args: object) =>
    account.viewFunction({ contractId, methodName, args }) as Promise<T>;

  return {
    view: (method, args) => view(s.contractId, method, args),
    derivedPublicKey: () =>
      view<string>(s.mpcContractId, "derived_public_key", {
        path: s.path,
        predecessor: s.contractId,
        domain_id: 0,
      }),
    async request(req) {
      if (!s.agentKey) throw new Error("NEAR_AGENT_KEY is not set; it is needed to send a request");
      const action = transactions.functionCall(
        "request",
        { request: req },
        BigInt(s.requestGasTgas) * 10n ** 12n,
        0n,
      );
      // A fresh account object per call: near-api-js caches the access key and
      // its nonce, so reusing one would sign the next request with a stale nonce.
      // signTransaction is protected only at the TypeScript level.
      const fresh = (await near.account(s.agentAccountId)) as unknown as {
        signTransaction(receiver: string, actions: unknown[]): Promise<[Uint8Array, unknown]>;
      };
      const [hash, signed] = await fresh.signTransaction(s.contractId, [action]);
      // INCLUDED makes the node validate the transaction first, so a bad nonce,
      // a missing key or an exhausted allowance is reported at once. Then wait
      // for FINAL: the MPC call yields, so the result can take several blocks.
      await provider.sendTransactionUntil(signed as never, "INCLUDED");
      const outcome = await waitFinal(provider, hash, s.agentAccountId);
      if (stringStatus(outcome)) throw new Error(`transaction not final: ${String(outcome.status)}`);
      return lastResult(outcome) as Outcome;
    },
  };
}

type Provider = Awaited<ReturnType<typeof connect>>["connection"]["provider"];

async function waitFinal(provider: Provider, hash: Uint8Array, accountId: string) {
  const deadline = Date.now() + 5 * 60_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      return await provider.txStatus(hash, accountId, "FINAL");
    } catch (e) {
      // Only waiting-type errors are retried; anything else is final.
      if (!isTransient(e)) throw e;
      lastError = e;
      await new Promise((r) => setTimeout(r, 2_000));
    }
  }
  throw new Error(`transaction not final after 5 minutes: ${String(lastError)}`);
}

export function isTransient(e: unknown): boolean {
  const text = `${(e as { type?: string })?.type ?? ""} ${String((e as Error)?.message ?? e)}`;
  return /TIMEOUT|UNKNOWN_TRANSACTION|timed? ?out|ECONNRESET|503|502/i.test(text);
}

/** The return value of the last receipt: `request`'s value or `on_signed`'s. */
export function lastResult(outcome: { status: unknown }): unknown {
  if (typeof outcome.status === "string") throw new Error(`transaction not final: ${outcome.status}`);
  const status = outcome.status as { SuccessValue?: string; Failure?: unknown };
  if (status.Failure) throw new Error(`transaction failed: ${JSON.stringify(status.Failure)}`);
  if (typeof status.SuccessValue !== "string" || status.SuccessValue === "") return null;
  return JSON.parse(Buffer.from(status.SuccessValue, "base64").toString("utf8"));
}

export { Account };
