import bs58 from "bs58";
import { createPublicClient, custom, hexToBytes, keccak256, serializeTransaction, type Hex } from "viem";
import { privateKeyToAccount, sign } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { addressFromMpcKey, assemble, readObservation } from "../src/evm.js";

// Anvil/Hardhat default test account #1: a public test key, never funded on a real chain.
const KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as const;
const account = privateKeyToAccount(KEY);
const UNSIGNED = serializeTransaction({
  type: "eip1559",
  chainId: 46630,
  nonce: 0,
  to: "0xc9f9c86933092bbbfff3ccb4b105a4a94bf3bd4e",
  value: 0n,
  data: "0xa9059cbb",
  gas: 120000n,
  maxFeePerGas: 40348000n,
  maxPriorityFeePerGas: 1000000n,
});
const SIGHASH = keccak256(UNSIGNED);

async function mpcShaped(hash: Hex) {
  const sig = await sign({ hash, privateKey: KEY });
  const prefix = sig.yParity === 1 ? "03" : "02";
  return {
    scheme: "Secp256k1",
    big_r: { affine_point: `${prefix}${sig.r.slice(2)}` },
    s: { scalar: sig.s.slice(2) },
    recovery_id: sig.yParity ?? 0,
  };
}

describe("addressFromMpcKey", () => {
  it("turns the MPC's secp256k1:<base58> key into the EVM address", () => {
    const uncompressed = hexToBytes(account.publicKey).slice(1); // drop 0x04
    expect(addressFromMpcKey(`secp256k1:${bs58.encode(uncompressed)}`)).toBe(account.address);
  });
  it("refuses other curves and lengths", () => {
    expect(() => addressFromMpcKey("ed25519:abc")).toThrow(/not a secp256k1 key/);
    expect(() => addressFromMpcKey(`secp256k1:${bs58.encode(new Uint8Array(10))}`)).toThrow(/64-byte/);
  });
});

describe("assemble", () => {
  it("builds a signed transaction that recovers to the expected signer", async () => {
    const out = await assemble(UNSIGNED, SIGHASH, await mpcShaped(SIGHASH), account.address);
    expect(out.signer).toBe(account.address);
    expect(out.signedTx.startsWith("0x02")).toBe(true);
  });
  it("refuses a signature from another key", async () => {
    const other = privateKeyToAccount("0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba");
    await expect(assemble(UNSIGNED, SIGHASH, await mpcShaped(SIGHASH), other.address)).rejects.toThrow(/recovers to/);
  });
  it("refuses a payload that does not match the contract's sighash", async () => {
    const wrong = keccak256("0x01");
    await expect(assemble(UNSIGNED, wrong, await mpcShaped(SIGHASH), account.address)).rejects.toThrow(/sighash/);
  });
});

describe("readObservation", () => {
  it("reads all three values from one pinned block", async () => {
    const blockTags: string[] = [];
    const client = createPublicClient({
      transport: custom({
        async request({ method, params }: { method: string; params: unknown[] }) {
          if (method === "eth_getBlockByNumber") {
            return { number: "0x10", timestamp: "0x6923e0a0", hash: `0x${"11".repeat(32)}`, transactions: [] };
          }
          if (method === "eth_call") {
            blockTags.push(params[1] as string);
            const data = (params[0] as { data: string }).data;
            if (data.startsWith("0x97a4064f")) return `0x${"0".repeat(64)}`; // effectiveAt = 0
            return `0x${(10n ** 18n).toString(16).padStart(64, "0")}`;
          }
          throw new Error(`unexpected ${method}`);
        },
      }),
    });
    const o = await readObservation(client as never, "0xc9f9c86933092bbbfff3ccb4b105a4a94bf3bd4e");
    expect(o).toEqual({
      multiplier: (10n ** 18n).toString(),
      new_multiplier: (10n ** 18n).toString(),
      effective_at: 0,
      block_number: 16,
      block_timestamp: 0x6923e0a0,
    });
    expect(blockTags).toEqual(["0x10", "0x10", "0x10"]);
  });
  it("reports a failed read as null instead of inventing a value", async () => {
    const client = createPublicClient({
      transport: custom({
        async request({ method }: { method: string }) {
          if (method === "eth_getBlockByNumber") return { number: "0x1", timestamp: "0x1", hash: `0x${"11".repeat(32)}`, transactions: [] };
          throw new Error("execution reverted");
        },
      }),
    });
    const o = await readObservation(client as never, "0xc9f9c86933092bbbfff3ccb4b105a4a94bf3bd4e");
    expect(o.new_multiplier).toBeNull();
    expect(o.effective_at).toBeNull();
  });
});
