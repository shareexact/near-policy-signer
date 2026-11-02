// Agent configuration: everything the agent may touch, validated before start.
import { readFileSync } from "node:fs";
import { z } from "zod";

const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/, "must be 0x followed by 40 hex digits");
const uint = z.string().regex(/^\d+$/, "must be a base-10 integer string");

export const TokenKind = z.enum(["Plain", "StockExact", "StockDirect"]);
export type TokenKind = z.infer<typeof TokenKind>;

export const ConfigSchema = z
  .object({
    near: z.object({
      networkId: z.enum(["testnet", "mainnet"]),
      rpcUrl: z.string().url(),
      contractId: z.string().min(2),
      agentAccountId: z.string().min(2),
      mpcContractId: z.string().min(2),
      path: z.string().min(1),
      /** Gas the agent attaches to `request`, in Tgas. Sign gas + 20 callback + execution. */
      requestGasTgas: z.number().int().min(80).max(300).default(150),
    }),
    chains: z.record(
      z.string().regex(/^\d+$/),
      z.object({
        rpcUrl: z.string().url(),
        explorerTxUrl: z.string().url().optional(),
        /** Broadcasting on a chain listed in `mainnetChainIds` also needs allowMainnet. */
        allowBroadcast: z.boolean().default(false),
      }),
    ),
    mainnetChainIds: z.array(z.number().int()).default([4663]),
    allowMainnet: z.boolean().default(false),
    tokens: z
      .array(
        z.object({
          symbol: z.string().regex(/^[A-Z0-9]{1,12}$/),
          chainId: z.number().int(),
          address,
          kind: TokenKind,
          /** Plain tokens: ERC-20 decimals. Stock Tokens always use 18-decimal shares. */
          decimals: z.number().int().min(0).max(36).default(18),
        }),
      )
      .min(1),
    recipients: z
      .array(z.object({ label: z.string().regex(/^[a-z0-9_-]{1,32}$/), chainId: z.number().int(), address }))
      .min(1),
    fees: z.object({ gasLimit: uint, maxFeePerGas: uint, maxPriorityFeePerGas: uint }),
    /** Stock Tokens: rounding loss accepted, in 18-decimal shares. */
    maxShortfall: uint.default("1"),
    planner: z
      .object({
        provider: z.enum(["rules", "near-ai"]).default("rules"),
        baseUrl: z.string().url().default("https://cloud-api.near.ai/v1"),
        model: z.string().default("zai-org/GLM-5.1-FP8"),
      })
      .default({}),
  })
  .superRefine((c, ctx) => {
    const symbols = new Set<string>();
    for (const t of c.tokens) {
      const key = `${t.chainId}:${t.symbol}`;
      if (symbols.has(key)) ctx.addIssue({ code: "custom", message: `duplicate token ${key}` });
      symbols.add(key);
      if (!c.chains[String(t.chainId)]) ctx.addIssue({ code: "custom", message: `token ${t.symbol} on unknown chain` });
    }
    const labels = new Set<string>();
    for (const r of c.recipients) {
      if (labels.has(r.label)) ctx.addIssue({ code: "custom", message: `duplicate recipient ${r.label}` });
      labels.add(r.label);
    }
  });

export type Config = z.infer<typeof ConfigSchema>;

export function parseConfig(raw: unknown): Config {
  const parsed = ConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
    throw new Error(`invalid agent config:\n  ${issues.join("\n  ")}`);
  }
  return parsed.data;
}

export function loadConfig(path: string): Config {
  return parseConfig(JSON.parse(readFileSync(path, "utf8")));
}

export function findToken(c: Config, symbol: string) {
  const t = c.tokens.find((x) => x.symbol === symbol.toUpperCase());
  if (!t) throw new Error(`token ${symbol} is not in the agent config`);
  return t;
}

export function findRecipient(c: Config, label: string, chainId: number) {
  const r = c.recipients.find((x) => x.label === label.toLowerCase() && x.chainId === chainId);
  if (!r) throw new Error(`recipient ${label} is not in the agent config for chain ${chainId}`);
  return r;
}
