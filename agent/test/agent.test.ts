import bs58 from "bs58";
import { hexToBytes, keccak256, serializeTransaction, type Hex } from "viem";
import { privateKeyToAccount, sign } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { Agent, type Chain } from "../src/agent.js";
import { parseConfig } from "../src/config.js";
import type { Outcome, PolicyClient, Preview, TransferRequest } from "../src/near.js";
import { rulePlanner } from "../src/planner.js";
import { config, rawConfig, TOKEN } from "./fixtures.js";

const KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as const;
const contractKey = privateKeyToAccount(KEY);
const mpcKey = `secp256k1:${bs58.encode(hexToBytes(contractKey.publicKey).slice(1))}`;

function fakeNear(outcome: (r: TransferRequest) => Promise<Outcome>, preview: Partial<Preview> = {}) {
  const calls: { method: string; args: unknown }[] = [];
  const client: PolicyClient = {
    async view<T>(method: string, args: object) {
      calls.push({ method, args });
      if (method === "get_nonce_state") return { next: 3 } as T;
      if (method === "preview") return { decision: "SIGN", refusal: null, ...preview } as T;
      throw new Error(method);
    },
    request: outcome,
    derivedPublicKey: async () => mpcKey,
  };
  return { client, calls };
}

function fakeChain() {
  const sent: Hex[] = [];
  const chain: Chain = {
    async readObservation() {
      return { multiplier: "1000000000000000000", new_multiplier: "1000000000000000000", effective_at: 0, block_number: 9, block_timestamp: 1 };
    },
    async broadcast(tx) {
      sent.push(tx);
      return keccak256(tx);
    },
  };
  return { chain, sent };
}

async function signedOutcome(r: TransferRequest, key: `0x${string}` = KEY): Promise<Outcome> {
  const unsigned = serializeTransaction({
    type: "eip1559",
    chainId: r.chain_id,
    nonce: r.fees.evm_nonce,
    to: r.token as Hex,
    value: 0n,
    data: "0xa1774ea4",
    gas: BigInt(r.fees.gas_limit),
    maxFeePerGas: BigInt(r.fees.max_fee_per_gas),
    maxPriorityFeePerGas: BigInt(r.fees.max_priority_fee_per_gas),
  });
  const sighash = keccak256(unsigned);
  const s = await sign({ hash: sighash, privateKey: key });
  return {
    status: "SIGNED",
    request_id: 1,
    chain_id: r.chain_id,
    nonce: r.fees.evm_nonce,
    unsigned_tx: unsigned,
    sighash,
    signature: { big_r: { affine_point: `02${s.r.slice(2)}` }, s: { scalar: s.s.slice(2) }, recovery_id: s.yParity ?? 0 },
  };
}

describe("Agent", () => {
  it("builds the request from config, chain state and the contract's next nonce", async () => {
    const { client } = fakeNear(async () => ({ status: "REFUSED", reason: "x" }));
    const agent = new Agent(config, client, () => fakeChain().chain, rulePlanner);
    const r = await agent.buildRequest("send 2.5 MSHR to alice");
    expect(r).toMatchObject({ chain_id: 46630, token: TOKEN, amount: "2500000000000000000", ticket_id: null });
    expect(r.fees.evm_nonce).toBe(3);
    expect(r.observed?.block_number).toBe(9);
    const plain = await agent.buildRequest("pay 100 USDT to alice");
    expect(plain.amount).toBe("100000000");
    expect(plain.observed).toBeNull();
  });

  it("stops at a preview refusal and never calls request", async () => {
    let requested = false;
    const { client } = fakeNear(async () => {
      requested = true;
      return { status: "REFUSED", reason: "x" };
    }, { decision: "REFUSED", refusal: "AmountCapExceeded" });
    const res = await new Agent(config, client, () => fakeChain().chain, rulePlanner).send("send 9 MSHR to alice", { broadcast: true });
    expect(res).toEqual({ kind: "refused", reason: "AmountCapExceeded", stage: "preview" });
    expect(requested).toBe(false);
  });

  it("reports a queued request with its ticket", async () => {
    const { client } = fakeNear(async () => ({ status: "PENDING_APPROVAL", ticket_id: 7, expires_at: 99 }));
    const res = await new Agent(config, client, () => fakeChain().chain, rulePlanner).send("send 4 MSHR to alice", { broadcast: true });
    expect(res).toEqual({ kind: "queued", ticketId: 7, expiresAt: 99 });
  });

  it("verifies the signature and broadcasts only when asked", async () => {
    const { chain, sent } = fakeChain();
    const { client } = fakeNear((r) => signedOutcome(r));
    const agent = new Agent(config, client, () => chain, rulePlanner);
    const dry = await agent.send("send 1 MSHR to alice", { broadcast: false });
    expect(dry).toMatchObject({ kind: "signed", signer: contractKey.address, broadcast: null });
    expect(sent).toHaveLength(0);
    const live = await agent.send("send 1 MSHR to alice", { broadcast: true });
    expect(live.kind === "signed" && live.broadcast).toBeTruthy();
    expect(sent).toHaveLength(1);
  });

  it("refuses to broadcast a signature from the wrong key", async () => {
    const { chain, sent } = fakeChain();
    const { client } = fakeNear((r) => signedOutcome(r, "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba"));
    await expect(
      new Agent(config, client, () => chain, rulePlanner).send("send 1 MSHR to alice", { broadcast: true }),
    ).rejects.toThrow(/recovers to/);
    expect(sent).toHaveLength(0);
  });

  it("refuses to broadcast where the config does not allow it", async () => {
    const locked = parseConfig({ ...rawConfig, chains: { "46630": { rpcUrl: "https://x.example", allowBroadcast: false } } });
    const { chain, sent } = fakeChain();
    const { client } = fakeNear((r) => signedOutcome(r));
    await expect(new Agent(locked, client, () => chain, rulePlanner).send("send 1 MSHR to alice", { broadcast: true })).rejects.toThrow(
      /not enabled/,
    );
    expect(sent).toHaveLength(0);
  });

  it("passes an approved ticket through", async () => {
    let seen: TransferRequest | undefined;
    const { client } = fakeNear(async (r) => {
      seen = r;
      return { status: "REFUSED", reason: "TicketInvalid" };
    });
    await new Agent(config, client, () => fakeChain().chain, rulePlanner).send("send 4 MSHR to alice", { broadcast: false, ticketId: 7 });
    expect(seen?.ticket_id).toBe(7);
  });
});
