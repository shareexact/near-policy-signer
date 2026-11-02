import { describe, expect, it } from "vitest";
import { findRecipient, findToken, parseConfig } from "../src/config.js";
import { isTransient, lastResult } from "../src/near.js";
import { rawConfig } from "./fixtures.js";

describe("config", () => {
  it("accepts the fixture and fills defaults", () => {
    const c = parseConfig(rawConfig);
    expect(c.near.requestGasTgas).toBe(150);
    expect(c.mainnetChainIds).toEqual([4663]);
    expect(c.planner.provider).toBe("rules");
  });
  it("refuses bad addresses, unknown chains and duplicates", () => {
    const bad = structuredClone(rawConfig);
    bad.recipients[0]!.address = "0x1234";
    expect(() => parseConfig(bad)).toThrow(/recipients\.0\.address/);
    const noChain = structuredClone(rawConfig);
    noChain.tokens[0]!.chainId = 1;
    expect(() => parseConfig(noChain)).toThrow(/unknown chain/);
    const dup = structuredClone(rawConfig);
    dup.recipients.push({ ...dup.recipients[0]! });
    expect(() => parseConfig(dup)).toThrow(/duplicate recipient/);
  });
  it("requires decimals for plain tokens and the zero address for native", () => {
    const noDecimals = structuredClone(rawConfig) as typeof rawConfig & { tokens: { decimals?: number }[] };
    delete noDecimals.tokens[1]!.decimals;
    expect(() => parseConfig(noDecimals)).toThrow(/explicit decimals/);
    const badNative = structuredClone(rawConfig);
    badNative.tokens.push({ symbol: "ETH", chainId: 46630, address: rawConfig.tokens[1]!.address, kind: "Native" } as never);
    expect(() => parseConfig(badNative)).toThrow(/zero address/);
  });
  it("finds only configured tokens and recipients", () => {
    const c = parseConfig(rawConfig);
    expect(findToken(c, "mshr").kind).toBe("StockExact");
    expect(() => findToken(c, "TSLA")).toThrow(/not in the agent config/);
    expect(() => findRecipient(c, "mallory", 46630)).toThrow(/not in the agent config/);
  });
});

describe("near helpers", () => {
  it("retries only waiting-type errors", () => {
    expect(isTransient({ type: "TimeoutError", message: "timed out" })).toBe(true);
    expect(isTransient(new Error("UNKNOWN_TRANSACTION"))).toBe(true);
    expect(isTransient(new Error("InvalidNonce: tx nonce 5 must be larger than 7"))).toBe(false);
    expect(isTransient(new Error("NotEnoughAllowance"))).toBe(false);
  });
  it("reads the final value and refuses unfinished or failed outcomes", () => {
    const value = Buffer.from(JSON.stringify({ status: "REFUSED", reason: "Paused" })).toString("base64");
    expect(lastResult({ status: { SuccessValue: value } })).toEqual({ status: "REFUSED", reason: "Paused" });
    expect(() => lastResult({ status: "Started" })).toThrow(/not final/);
    expect(() => lastResult({ status: { Failure: { x: 1 } } })).toThrow(/failed/);
  });
});
