// EVM side: read Stock Token state at one pinned block, derive the contract's
// EVM address from the MPC key, assemble and verify signed transactions.
import bs58 from "bs58";
import {
  type Hex,
  type PublicClient,
  getAddress,
  keccak256,
  parseTransaction,
  recoverTransactionAddress,
  serializeTransaction,
  toHex,
} from "viem";

export const STOCK_ABI = [
  { type: "function", name: "uiMultiplier", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "newUIMultiplier", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "effectiveAt", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
] as const;

/** Mirrors the contract's `Observation`; numbers as decimal strings. */
export interface Observation {
  multiplier: string;
  new_multiplier: string | null;
  effective_at: number | null;
  block_number: number;
  block_timestamp: number;
}

/**
 * Read the three ERC-8056 values from one block, so they describe one
 * moment. A failed read becomes null and the contract refuses the request
 * as ObservationIncomplete; nothing is invented.
 */
export async function readObservation(client: PublicClient, token: Hex): Promise<Observation> {
  const block = await client.getBlock({ blockTag: "latest" });
  const at = { blockNumber: block.number };
  const read = async (fn: (typeof STOCK_ABI)[number]["name"]) => {
    try {
      return (await client.readContract({ address: token, abi: STOCK_ABI, functionName: fn, ...at })) as bigint;
    } catch {
      return null;
    }
  };
  const [multiplier, pending, effectiveAt] = await Promise.all([
    read("uiMultiplier"),
    read("newUIMultiplier"),
    read("effectiveAt"),
  ]);
  return {
    multiplier: (multiplier ?? 0n).toString(),
    new_multiplier: pending === null ? null : pending.toString(),
    effective_at: effectiveAt === null ? null : Number(effectiveAt),
    block_number: Number(block.number),
    block_timestamp: Number(block.timestamp),
  };
}

/**
 * `derived_public_key` on the MPC contract returns "secp256k1:<base58>" of
 * the 64-byte uncompressed key (no 0x04 prefix). The EVM address is the last
 * 20 bytes of its keccak256.
 */
export function addressFromMpcKey(key: string): Hex {
  const [curve, data] = key.split(":");
  if (curve !== "secp256k1" || !data) throw new Error(`not a secp256k1 key: ${key}`);
  let bytes = bs58.decode(data);
  if (bytes.length === 65 && bytes[0] === 4) bytes = bytes.slice(1);
  if (bytes.length !== 64) throw new Error(`expected a 64-byte public key, got ${bytes.length}`);
  return getAddress(`0x${keccak256(toHex(bytes)).slice(-40)}`);
}

/** The MPC `sign` response for secp256k1. */
export interface MpcSignature {
  scheme?: string;
  big_r: { affine_point: string };
  s: { scalar: string };
  recovery_id: number;
}

export interface Assembled {
  signedTx: Hex;
  signer: Hex;
  hash: Hex;
}

/**
 * Combine the contract's unsigned EIP-1559 payload with the MPC signature,
 * then prove it: the payload must hash to the contract's sighash, and the
 * signature must recover to the contract's derived address. Throws otherwise.
 */
export async function assemble(
  unsignedTx: Hex,
  sighash: Hex,
  sig: MpcSignature,
  expectedSigner: Hex,
): Promise<Assembled> {
  if (keccak256(unsignedTx) !== sighash.toLowerCase()) {
    throw new Error("unsigned transaction does not hash to the contract's sighash");
  }
  const point = sig.big_r.affine_point.replace(/^0x/, "");
  if (point.length !== 66) throw new Error("big_r must be a 33-byte compressed point");
  const r = `0x${point.slice(2)}` as Hex;
  const s = `0x${sig.s.scalar.replace(/^0x/, "").padStart(64, "0")}` as Hex;
  if (sig.recovery_id !== 0 && sig.recovery_id !== 1) throw new Error("recovery_id must be 0 or 1");

  const tx = parseTransaction(unsignedTx);
  if (tx.type !== "eip1559") throw new Error("expected an EIP-1559 transaction");
  const signedTx = serializeTransaction(tx, { r, s, yParity: sig.recovery_id });
  const signer = await recoverTransactionAddress({ serializedTransaction: signedTx as `0x02${string}` });
  if (getAddress(signer) !== getAddress(expectedSigner)) {
    throw new Error(`signature recovers to ${signer}, not the contract's address ${expectedSigner}`);
  }
  return { signedTx, signer: getAddress(signer), hash: keccak256(signedTx) };
}
