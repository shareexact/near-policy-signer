// Regenerates the EIP-1559 test vectors used in policy-signer/src/tests.rs
// with an independent serializer (viem):
//   cd agent && npm ci && npm run vectors
import { encodeFunctionData, keccak256, parseAbi, serializeTransaction } from "viem";

const abi = parseAbi([
  "function transfer(address,uint256)",
  "function transferShares(address,address,uint256,uint256)",
]);
const token = "0xc9f9c86933092bbbfff3ccb4b105a4a94bf3bd4e";
const recipient = "0x000000000000000000000000000000000000dead";
const exactTransfer = "0x8c726dc9d27902515f70596b7f07610f1bf4ecd2";

function vector(to, data, nonce) {
  const unsigned = serializeTransaction({
    type: "eip1559",
    chainId: 46630,
    nonce,
    to,
    value: 0n,
    data,
    gas: 120000n,
    maxFeePerGas: 40348000n,
    maxPriorityFeePerGas: 1000000n,
  });
  return { unsigned, sighash: keccak256(unsigned) };
}

// StockDirect: 1 share of MU at multiplier 1000183456682946507 = 999816576967234660 raw.
const direct = encodeFunctionData({ abi, functionName: "transfer", args: [recipient, 999816576967234660n] });
// StockExact: transferShares(token, recipient, 1 share, 0 shortfall) at nonce 7.
const exact = encodeFunctionData({ abi, functionName: "transferShares", args: [token, recipient, 10n ** 18n, 0n] });

console.log(JSON.stringify({ direct: vector(token, direct, 0), exact: vector(exactTransfer, exact, 7) }, null, 2));
