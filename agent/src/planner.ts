// The AI planner: natural language in, a structured proposal out. Its output
// is untrusted. It is validated here against the agent config, and the
// contract enforces everything that matters regardless.
import { z } from "zod";
import { type Config, findRecipient, findToken } from "./config.js";

export const Proposal = z.object({
  token: z.string().regex(/^[A-Za-z0-9]{1,12}$/),
  recipient: z.string().regex(/^[A-Za-z0-9_-]{1,32}$/),
  amount: z.string().regex(/^\d+(\.\d+)?$/),
});
export type Proposal = z.infer<typeof Proposal>;

export interface Planner {
  plan(instruction: string): Promise<Proposal>;
}

const RULE =
  /\b(?:send|transfer|pay|move)\s+(\d+(?:\.\d+)?)\s*(?:shares?\s+of\s+)?([A-Za-z0-9]{1,12})\s+to\s+([A-Za-z0-9_-]{1,32})\b/i;

/** Deterministic parser: works offline and without keys, used in tests and demos. */
export const rulePlanner: Planner = {
  async plan(instruction) {
    const m = RULE.exec(instruction);
    if (!m) throw new Error(`could not read an amount, token and recipient from: "${instruction}"`);
    return Proposal.parse({ amount: m[1], token: m[2]!.toUpperCase(), recipient: m[3]!.toLowerCase() });
  },
};

/** NEAR AI Cloud (OpenAI-compatible chat completions). The key comes from the environment. */
export function nearAiPlanner(config: Config, apiKey: string, fetchImpl: typeof fetch = fetch): Planner {
  const symbols = config.tokens.map((t) => t.symbol).join(", ");
  const labels = config.recipients.map((r) => r.label).join(", ");
  const system =
    "You turn a payment instruction into JSON with keys token, recipient, amount. " +
    `token must be one of: ${symbols}. recipient must be one of: ${labels}. ` +
    "amount is a plain decimal string of the human amount (shares for stock tokens). " +
    "Reply with the JSON object only.";
  return {
    async plan(instruction) {
      const res = await fetchImpl(`${config.planner.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: config.planner.model,
          temperature: 0,
          messages: [
            { role: "system", content: system },
            { role: "user", content: instruction },
          ],
        }),
      });
      if (!res.ok) throw new Error(`planner HTTP ${res.status}`);
      const body = (await res.json()) as { choices?: { message?: { content?: string } }[] };
      const text = body.choices?.[0]?.message?.content ?? "";
      const json = text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
      return Proposal.parse(JSON.parse(json));
    },
  };
}

/** Reject anything outside the config before the contract is ever called. */
export function checkProposal(config: Config, p: Proposal) {
  const token = findToken(config, p.token);
  const recipient = findRecipient(config, p.recipient, token.chainId);
  return { token, recipient };
}
