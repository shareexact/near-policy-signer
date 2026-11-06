#!/usr/bin/env bash
# stub agent: canned outputs by instruction; SCEN=bad makes shot 6 come back queued
if [ -n "${DEMO_EXPECT_AGENT:-}" ] && [ "$(jq -r .near.agentAccountId "$AGENT_CONFIG")" != "$DEMO_EXPECT_AGENT" ]; then echo "stub: config agent is $(jq -r .near.agentAccountId "$AGENT_CONFIG")" >&2; exit 1; fi
case "$*" in
  *"0.002 ETH to alice --skip-preview"*) echo '{"kind":"refused","reason":"AmountCapExceeded","stage":"request","nearTx":"AAA1","links":{"near":"https://testnet.nearblocks.io/txns/AAA1111111111111111"}}' ;;
  *"0.0004 ETH to alice --broadcast"*) echo '{"kind":"signed","signedTx":"0x02","hash":"0xh","signer":"0xc86A2A2F3FB5a3ac4FcB18076803c76D97AAc43F","broadcast":"0xb1","nearTx":"BBB","links":{"near":"https://testnet.nearblocks.io/txns/BBB22222222222","evm":"https://explorer.testnet.chain.robinhood.com/tx/0xb1b1b1b1b1b1b1b1"}}' ;;
  *"alice-old"*) if [ "${SCEN:-}" = bad ]; then echo '{"kind":"queued","ticketId":9,"expiresAt":1,"nearTx":"Q","links":{"near":"x"}}'; else echo '{"kind":"refused","reason":"LookalikeRecipient","stage":"request","nearTx":"CCC","links":{"near":"https://testnet.nearblocks.io/txns/CCC33333333333"}}'; fi ;;
  *"0.0008 ETH to alice --ticket"*) echo '{"kind":"signed","signedTx":"0x02","hash":"0xh","signer":"0xc86A2A2F3FB5a3ac4FcB18076803c76D97AAc43F","broadcast":"0xb2","nearTx":"EEE","links":{"near":"https://testnet.nearblocks.io/txns/EEE5555555555","evm":"https://explorer.testnet.chain.robinhood.com/tx/0xb2b2b2b2b2b2b2"}}' ;;
  *"0.0008 ETH to alice"*) echo '{"kind":"queued","ticketId":7,"expiresAt":1793990000,"nearTx":"DDD","links":{"near":"https://testnet.nearblocks.io/txns/DDD444444444444"}}' ;;
  *"0.0004 ETH to alice --skip-preview"*) [ "${SCEN:-}" = pausefail ] && { echo '{"kind":"refused","reason":"AmountCapExceeded","stage":"request","nearTx":"F","links":{"near":"x"}}'; exit 0; }; echo '{"kind":"refused","reason":"Paused","stage":"request","nearTx":"FFF","links":{"near":"https://testnet.nearblocks.io/txns/FFF66666666666"}}' ;;
  *) echo "unexpected stub call: $*" >&2; exit 1 ;;
esac
