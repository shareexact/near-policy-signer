// One end-to-end send: plan, read, preview, request, verify, and broadcast
// only when asked to.
import type { Hex } from "viem";
import { type Config } from "./config.js";
import { type MpcSignature, type Observation, addressFromMpcKey, assemble } from "./evm.js";
import type { Outcome, PolicyClient, Preview, TransferRequest } from "./near.js";
import { type Planner, checkProposal } from "./planner.js";
import { parseAmount } from "./units.js";

export interface Chain {
  readObservation(token: Hex): Promise<Observation>;
  broadcast(signedTx: Hex): Promise<Hex>;
}

export interface SendOptions {
  broadcast: boolean;
  ticketId?: number;
}

export type SendResult =
  | { kind: "refused"; reason: string; stage: "preview" | "request" }
  | { kind: "queued"; ticketId: number; expiresAt: number }
  | { kind: "sign_failed"; error: string }
  | { kind: "signed"; signedTx: Hex; hash: Hex; signer: Hex; broadcast: Hex | null };

export class Agent {
  constructor(
    private readonly config: Config,
    private readonly near: PolicyClient,
    private readonly chains: (chainId: number) => Chain,
    private readonly planner: Planner,
  ) {}

  async evmAddress(): Promise<Hex> {
    return addressFromMpcKey(await this.near.derivedPublicKey());
  }

  async buildRequest(instruction: string, ticketId?: number): Promise<TransferRequest> {
    const proposal = await this.planner.plan(instruction);
    const { token, recipient } = checkProposal(this.config, proposal);
    const isStock = token.kind !== "Plain";
    const amount = parseAmount(proposal.amount, isStock ? 18 : token.decimals);
    const chain = this.chains(token.chainId);
    const observed = isStock ? await chain.readObservation(token.address as Hex) : null;
    const nonce = await this.near.view<{ next: number }>("get_nonce_state", { chain_id: token.chainId });
    return {
      chain_id: token.chainId,
      token: token.address.toLowerCase(),
      recipient: recipient.address.toLowerCase(),
      amount: amount.toString(),
      max_shortfall: isStock ? this.config.maxShortfall : "0",
      observed,
      fees: {
        evm_nonce: nonce.next,
        gas_limit: this.config.fees.gasLimit,
        max_fee_per_gas: this.config.fees.maxFeePerGas,
        max_priority_fee_per_gas: this.config.fees.maxPriorityFeePerGas,
      },
      ticket_id: ticketId ?? null,
    };
  }

  async preview(req: TransferRequest): Promise<Preview> {
    return this.near.view<Preview>("preview", { agent: this.config.near.agentAccountId, request: req });
  }

  async send(instruction: string, opts: SendOptions): Promise<SendResult> {
    const req = await this.buildRequest(instruction, opts.ticketId);
    const preview = await this.preview(req);
    if (preview.decision === "REFUSED") return { kind: "refused", reason: preview.refusal ?? "unknown", stage: "preview" };

    const outcome: Outcome = await this.near.request(req);
    switch (outcome.status) {
      case "REFUSED":
        return { kind: "refused", reason: outcome.reason, stage: "request" };
      case "PENDING_APPROVAL":
        return { kind: "queued", ticketId: outcome.ticket_id, expiresAt: outcome.expires_at };
      case "SIGN_FAILED":
        return { kind: "sign_failed", error: outcome.error };
      case "SIGNED": {
        const expected = await this.evmAddress();
        const a = await assemble(outcome.unsigned_tx, outcome.sighash, outcome.signature as MpcSignature, expected);
        let sent: Hex | null = null;
        if (opts.broadcast) {
          this.assertMayBroadcast(outcome.chain_id);
          sent = await this.chains(outcome.chain_id).broadcast(a.signedTx);
        }
        return { kind: "signed", signedTx: a.signedTx, hash: a.hash, signer: a.signer, broadcast: sent };
      }
    }
  }

  private assertMayBroadcast(chainId: number) {
    const chain = this.config.chains[String(chainId)];
    if (!chain?.allowBroadcast) throw new Error(`broadcasting on chain ${chainId} is not enabled in the config`);
    if (this.config.mainnetChainIds.includes(chainId) && !this.config.allowMainnet) {
      throw new Error(`chain ${chainId} is a mainnet; set allowMainnet to broadcast there`);
    }
  }
}
