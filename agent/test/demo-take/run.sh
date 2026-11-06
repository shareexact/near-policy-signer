#!/usr/bin/env bash
# Offline test of scripts/demo-take.sh: a stub agent, stub views and a random key; nothing touches a network.
# Run from agent/ after npm ci: bash test/demo-take/run.sh
set -uo pipefail
cd "$(dirname "$0")/../.." || exit 1
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
H="$PWD/test/demo-take"
KEY=$(node -e 'const {KeyPair}=require("near-api-js"); const k=KeyPair.fromRandom("ed25519"); console.log(k.toString()+" "+k.getPublicKey().toString())')
export DEMO_TEST_DIR="$T" DEMO_AGENT_CMD="$H/stub-agent.sh" DEMO_VIEW_CMD="$H/stub-view.sh" DEMO_KEYS_CMD="$H/stub-keys.sh"
export DEMO_BALANCE_CMD="bash $H/stub-balance.sh" DEMO_TEST_BALANCE=4000000000000000 DEMO_AGENT_PUBKEY="${KEY#* }" HOME="$T"
S=./scripts/demo-take.sh
fails=0
strip() { sed 's/\x1b\[[0-9;]*[mHJ]//g'; }
expect() { if printf '%s' "$2" | grep -qF -- "$3"; then echo "PASS $1"; else echo "FAIL $1: no \"$3\" in:"; printf '%s\n' "$2" | tail -5; fails=$((fails + 1)); fi; }
enters() { yes "" | head -60; }
zero() { if [ "$2" = 0 ]; then echo "PASS $1"; else echo "FAIL $1: $2"; fails=$((fails + 1)); fi; }

out=$($S check </dev/null 2>&1 | strip); expect "check passes read-only" "$out" "Preflight OK."
out=$(NEAR_AGENT_KEY="ed25519:3D4YudUahN1nawWogh8pAKSj92sUNMdbZGjn7kERKzjoTy35oKFRb2t8kB5SLXcUYxFx4MuuGHyH5ZXPwBdA3oKX" $S take </dev/null 2>&1 | strip)
expect "a key that is not the agent's is refused" "$out" "is not the agent's request key"
export NEAR_AGENT_KEY="${KEY%% *}"
rm -f "$T/cfgcount"; out=$(enters | $S take 2>&1 | strip)
for s in "shot 1: PASS" "shot 4: PASS" "shot 6: PASS" "shot 7: PASS" "owner: ticket 7 approved" "shot 9: PASS" "owner: paused" "shot 10: PASS" "owner: resumed" "Done (take)"; do expect "take: $s" "$out" "$s"; done
zero "take: no secret key in the output" "$(printf '%s' "$out" | grep -c -- "${NEAR_AGENT_KEY#ed25519:}")"
log=$(ls "$T"/demo-take-*-take.txt); zero "take: no secret key in the log" "$(grep -c -- "${NEAR_AGENT_KEY#ed25519:}" "$log")"
[ ! -e agent.config.video.json ] && echo "PASS take: the broadcast config is deleted" || { echo "FAIL video config left behind"; fails=$((fails + 1)); }
rm -f "$T/cfgcount"; out=$(enters | SCEN=bad $S take 2>&1 | strip); expect "an unexpected outcome stops the take" "$out" "STOP: stopped"
rm -f "$T/cfgcount"; out=$(enters | SCEN=pausefail $S take 2>&1 | strip); expect "a stop after the pause says to resume" "$out" "MAY STILL BE PAUSED"
out=$(REMAIN=800000000000000 $S take </dev/null 2>&1 | strip); expect "too little budget left" "$out" "of today's ETH budget is left"
out=$(PAUSED=true $S take </dev/null 2>&1 | strip); expect "paused contract" "$out" "the contract is paused"
out=$(AREQ=16 $S take </dev/null 2>&1 | strip); expect "too few requests left" "$out" "requests left today"
out=$(DEMO_TEST_BALANCE=100 $S take </dev/null 2>&1 | strip); expect "derived address not funded" "$out" "top up"
rm -f "$T/cfgcount"; out=$(enters | AREQ=16 $S rehearse 2>&1 | strip)
for s in "shot R1: PASS" "shot 7: PASS" "owner: ticket 7 approved" "left to expire unused"; do expect "rehearse: $s" "$out" "$s"; done
zero "rehearse: no broadcast" "$(printf '%s' "$out" | grep -c -- '--broadcast')"
# The agent made by scripts/new-agent.mjs: its key file is used, and the run uses that account.
mkdir -p "$T/.near-policy-signer"
jq -n --arg pk "${KEY#* }" --arg sk "${KEY%% *}" '{accountId:"policy-signer-agent-v2.testnet",requestPublicKey:$pk,requestSecretKey:$sk}' >"$T/.near-policy-signer/agent-v2.json"
unset NEAR_AGENT_KEY
out=$(AGENT_REG=null $S take </dev/null 2>&1 | strip); expect "new agent not registered yet: stops" "$out" "is not a registered, enabled agent"
rm -f "$T/cfgcount"; out=$(enters | DEMO_EXPECT_AGENT=policy-signer-agent-v2.testnet $S take 2>&1 | strip)
expect "new agent: key read from its file" "$out" "Agent key: $T/.near-policy-signer/agent-v2.json (policy-signer-agent-v2.testnet)"
expect "new agent: the run uses that account" "$out" "shot 10: PASS"
zero "new agent: no secret key in the output" "$(printf '%s' "$out" | grep -c -- "${KEY%% *}")"
echo; [ "$fails" = 0 ] && echo "ALL CHECKS OK" || { echo "$fails FAILED"; exit 1; }
