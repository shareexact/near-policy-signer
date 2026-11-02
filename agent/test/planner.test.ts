import { describe, expect, it } from "vitest";
import { checkProposal, nearAiPlanner, rulePlanner } from "../src/planner.js";
import { config } from "./fixtures.js";

describe("rule planner", () => {
  it("reads common phrasings", async () => {
    expect(await rulePlanner.plan("send 3 MSHR to alice")).toEqual({ amount: "3", token: "MSHR", recipient: "alice" });
    expect(await rulePlanner.plan("please transfer 2.5 shares of mshr to Alice now")).toEqual({
      amount: "2.5",
      token: "MSHR",
      recipient: "alice",
    });
    expect(await rulePlanner.plan("pay 100 USDT to alice")).toMatchObject({ token: "USDT", amount: "100" });
  });
  it("refuses what it cannot read", async () => {
    await expect(rulePlanner.plan("buy some tesla")).rejects.toThrow(/could not read/);
  });
  it("checkProposal rejects tokens and recipients outside the config", async () => {
    expect(() => checkProposal(config, { token: "TSLA", recipient: "alice", amount: "1" })).toThrow();
    expect(() => checkProposal(config, { token: "MSHR", recipient: "mallory", amount: "1" })).toThrow();
  });
});

describe("NEAR AI planner", () => {
  const reply = (content: string) =>
    (async () => new Response(JSON.stringify({ choices: [{ message: { content } }] }))) as unknown as typeof fetch;

  it("calls the OpenAI-compatible endpoint and validates the reply", async () => {
    let seen: { url: string; body: { model: string } } | undefined;
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen = { url, body: JSON.parse(String(init.body)) };
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"token":"MSHR","recipient":"alice","amount":"4"}' } }] }));
    }) as unknown as typeof fetch;
    const p = await nearAiPlanner(config, "key", fetchImpl).plan("send four shares to alice");
    expect(p).toEqual({ token: "MSHR", recipient: "alice", amount: "4" });
    expect(seen?.url).toBe("https://cloud-api.near.ai/v1/chat/completions");
    expect(seen?.body.model).toBe(config.planner.model);
  });
  it("treats a malformed model reply as an error, not a proposal", async () => {
    await expect(nearAiPlanner(config, "k", reply('{"token":"MSHR","amount":4}')).plan("x")).rejects.toThrow();
    await expect(nearAiPlanner(config, "k", reply("sure! sending now")).plan("x")).rejects.toThrow();
  });
});
