#!/usr/bin/env node
// policy-agent: plan, preview and send through the policy signer.
//   policy-agent address
//   policy-agent status <SYMBOL>
//   policy-agent plan "send 3 MSHR to alice"
//   policy-agent preview "send 3 MSHR to alice"
//   policy-agent send "send 3 MSHR to alice" [--ticket <id>] [--broadcast]
// Environment: AGENT_CONFIG (default ./agent.config.json), NEAR_AGENT_KEY (send only),
// NEAR_AI_API_KEY (only with planner.provider = "near-ai").
import { type Hex, createPublicClient, http } from "viem";
import { Agent, type Chain } from "./agent.js";
import { findToken, loadConfig } from "./config.js";
import { readObservation } from "./evm.js";
import { nearClient } from "./near.js";
import { nearAiPlanner, rulePlanner } from "./planner.js";

async function main(argv: string[]) {
  const [command, text] = argv;
  const config = loadConfig(process.env.AGENT_CONFIG ?? "agent.config.json");
  // Only `send` needs the agent's key; address, status, plan and preview are read-only.
  const near = await nearClient({ ...config.near, agentKey: process.env.NEAR_AGENT_KEY });
  const chains = (chainId: number): Chain => {
    const c = config.chains[String(chainId)];
    if (!c) throw new Error(`chain ${chainId} is not configured`);
    const client = createPublicClient({ transport: http(c.rpcUrl) });
    return {
      readObservation: (token) => readObservation(client as never, token),
      broadcast: (tx: Hex) => client.request({ method: "eth_sendRawTransaction", params: [tx] }) as Promise<Hex>,
    };
  };
  const planner =
    config.planner.provider === "near-ai"
      ? nearAiPlanner(config, process.env.NEAR_AI_API_KEY ?? fail("NEAR_AI_API_KEY is not set"))
      : rulePlanner;
  const agent = new Agent(config, near, chains, planner);
  const flag = (name: string) => argv.includes(name);
  const option = (name: string) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };

  switch (command) {
    case "address":
      return print({ evmAddress: await agent.evmAddress() });
    case "status": {
      const t = findToken(config, text ?? fail("usage: status <SYMBOL>"));
      return print(await near.view("get_status", { chain_id: t.chainId, token: t.address }));
    }
    case "plan":
      return print(await planner.plan(text ?? fail("usage: plan <instruction>")));
    case "preview": {
      const req = await agent.buildRequest(text ?? fail("usage: preview <instruction>"));
      return print({ request: req, preview: await agent.preview(req) });
    }
    case "send": {
      const ticket = option("--ticket");
      return print(
        await agent.send(text ?? fail("usage: send <instruction>"), {
          broadcast: flag("--broadcast"),
          ticketId: ticket ? Number(ticket) : undefined,
        }),
      );
    }
    default:
      fail("commands: address | status <SYMBOL> | plan <text> | preview <text> | send <text> [--ticket N] [--broadcast]");
  }
}

function print(value: unknown) {
  console.log(JSON.stringify(value, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2));
}

function fail(message: string): never {
  throw new Error(message);
}

main(process.argv.slice(2)).catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
