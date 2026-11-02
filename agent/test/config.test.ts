import { describe, expect, it } from "vitest";
import { findRecipient, findToken, parseConfig } from "../src/config.js";
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
  it("finds only configured tokens and recipients", () => {
    const c = parseConfig(rawConfig);
    expect(findToken(c, "mshr").kind).toBe("StockExact");
    expect(() => findToken(c, "TSLA")).toThrow(/not in the agent config/);
    expect(() => findRecipient(c, "mallory", 46630)).toThrow(/not in the agent config/);
  });
});
