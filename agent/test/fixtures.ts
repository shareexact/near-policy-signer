import { parseConfig } from "../src/config.js";

export const TOKEN = "0xc9f9c86933092bbbfff3ccb4b105a4a94bf3bd4e";
export const PLAIN = "0x2222222222222222222222222222222222222222";
export const ALICE = "0x000000000000000000000000000000000000dead";

export const rawConfig = {
  near: {
    networkId: "testnet",
    rpcUrl: "https://rpc.testnet.near.org",
    contractId: "policy.example.testnet",
    agentAccountId: "agent.example.testnet",
    mpcContractId: "v1.signer-prod.testnet",
    path: "robinhood-46630-1",
  },
  chains: { "46630": { rpcUrl: "https://rpc.testnet.chain.robinhood.com", allowBroadcast: true } },
  tokens: [
    { symbol: "MSHR", chainId: 46630, address: TOKEN, kind: "StockExact" },
    { symbol: "USDT", chainId: 46630, address: PLAIN, kind: "Plain", decimals: 6 },
  ],
  recipients: [{ label: "alice", chainId: 46630, address: ALICE }],
  fees: { gasLimit: "120000", maxFeePerGas: "40348000", maxPriorityFeePerGas: "1000000" },
};

export const config = parseConfig(rawConfig);
