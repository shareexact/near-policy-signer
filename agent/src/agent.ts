// One end-to-end send: plan, read, preview, request, verify, and broadcast
// only when asked to.
import { type Hex, parseTransaction } from "viem";
import { type Config } from "./config.js";
import { type MpcSignature, type Observation, addressFromMpcKey, assemble } from "./evm.js";
import type { PolicyClient, Preview, RequestOutcome, TransferRequest } from "./near.js";
import { type Planner, checkProposal } from "./planner.js";
import { parseAmount } from "./units.js";

export interface Chain {
  readObservation(token: Hex): Promise<Observation>;
  broadcast(signedTx: Hex): Promise<Hex>;
}

export interface SendOptions {
  broadcast: boolean;
  ticketId?: number;
  /**
   * Skip the agent's own read-only preview and submit `request` directly, as a
   * compromised agent would. The contract applies the same checks and records a
   * refusal on chain as a `refused` event. For demonstrations and tests.
   */
  skipPreview?: boolean;
}

/** `nearTx` is the NEAR transaction that carried `request`; absent for a preview refusal. */
export type SendResult =
  | { kind: "refused"; reason: string; stage: "preview" }
  | { kind: "refused"; reason: string; stage: "request"; nearTx?: string }
  | { kind: "queued"; ticketId: number; expiresAt: number; nearTx?: string }
  | { kind: "sign_failed"; error: string; nearTx?: string }
  | { kind: "signed"; signedTx: Hex; hash: Hex; signer: Hex; broadcast: Hex | null; nearTx?: string };

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
    const isStock = token.kind === "StockExact" || token.kind === "StockDirect";
    const amount = parseAmount(proposal.amount, isStock ? 18 : (token.decimals ?? 18));
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
    // The MPC call needs the contract's sign gas, the 20 Tgas callback and the
    // contract's own execution; too little fails closed but wastes allowance.
    const cfg = await this.near.view<{ sign_gas_tgas: number }>("get_config", {});
    if (this.config.near.requestGasTgas < cfg.sign_gas_tgas + 40) {
      throw new Error(
        `requestGasTgas ${this.config.near.requestGasTgas} is below the contract's sign gas ${cfg.sign_gas_tgas} + 40`,
      );
    }
    const req = await this.buildRequest(instruction, opts.ticketId);
    // Check broadcasting is allowed before anything is signed: a signature that
    // cannot be broadcast still uses up a nonce and today's budget.
    if (opts.broadcast) this.assertMayBroadcast(req.chain_id);
    if (!opts.skipPreview) {
      const preview = await this.preview(req);
      if (preview.decision === "REFUSED") return { kind: "refused", reason: preview.refusal ?? "unknown", stage: "preview" };
    }

    const outcome: RequestOutcome = await this.near.request(req);
    const nearTx = outcome.near_tx;
    switch (outcome.status) {
      case "REFUSED":
        return { kind: "refused", reason: outcome.reason, stage: "request", nearTx };
      case "PENDING_APPROVAL":
        return { kind: "queued", ticketId: outcome.ticket_id, expiresAt: outcome.expires_at, nearTx };
      case "SIGN_FAILED":
        return { kind: "sign_failed", error: outcome.error, nearTx };
      case "SIGNED": {
        const expected = await this.evmAddress();
        const a = await assemble(outcome.unsigned_tx, outcome.sighash, outcome.signature as MpcSignature, expected);
        // The contract built the transaction; still check it is for the chain
        // and nonce this agent asked for before it can be broadcast.
        // viem's parseTransaction leaves `nonce` undefined when the RLP field is empty, i.e. nonce 0.
        const tx = parseTransaction(a.signedTx);
        const txNonce = tx.nonce ?? 0;
        if (tx.chainId !== req.chain_id || outcome.chain_id !== req.chain_id || txNonce !== req.fees.evm_nonce) {
          throw new Error(`signed transaction is for chain ${tx.chainId} nonce ${txNonce}, not the request's`);
        }
        let sent: Hex | null = null;
        if (opts.broadcast) {
          this.assertMayBroadcast(outcome.chain_id);
          sent = await this.chains(outcome.chain_id).broadcast(a.signedTx);
        }
        return { kind: "signed", signedTx: a.signedTx, hash: a.hash, signer: a.signer, broadcast: sent, nearTx };
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
