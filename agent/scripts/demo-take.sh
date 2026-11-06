#!/usr/bin/env bash
# One take of the demo video, or a rehearsal, against the live testnet deployment.
#
#   ./scripts/demo-take.sh check      # read-only preflight, sends nothing
#   ./scripts/demo-take.sh rehearse   # a refusal and a queued ticket the owner approves; spends no ETH
#   ./scripts/demo-take.sh take       # the six agent sends of the video, in shot order
#
# Run from agent/ on the machine that holds the agent's function-call key. The key is read from
# NEAR_AGENT_KEY, else from the legacy NEAR keychain, else asked for with hidden input; it is never
# printed. The script checks it is the agent's on-chain key (F6TZ...) before anything is sent.
# A take spends 0.0012 testnet ETH (0.0004 + 0.0008) plus fees and uses 6 of the agent's 20 daily
# requests; refusals and queueing spend no ETH. Owner steps (approve, pause, resume) happen in the
# browser in wallet-page-owner/; the script waits for them and checks them on chain.
# Each send prints one outcome line; full links and outcomes go to ~/demo-take-<UTC time>.txt.
set -uo pipefail

MODE="${1:-}"
case "$MODE" in check | rehearse | take) ;; *) echo "usage: $0 check|rehearse|take" >&2; exit 2 ;; esac

CONTRACT="policy-v1.shareexact-chainsig-demo.testnet"
# The agent: the one made by scripts/new-agent.mjs if its key file is here, else the Nov 2 agent.
AGENT_FILE="$HOME/.near-policy-signer/agent-v2.json"
AGENT_ACCOUNT="agent-v1.shareexact-chainsig-demo.testnet"
AGENT_PUBKEY="ed25519:F6TZxxYhxXHvJdVWVkjnyBPm6JzqKdANfNwxw1eM9aAG"
if [ -f "$AGENT_FILE" ]; then
  AGENT_ACCOUNT=$(jq -r .accountId "$AGENT_FILE") && AGENT_PUBKEY=$(jq -r .requestPublicKey "$AGENT_FILE") || { echo "cannot read $AGENT_FILE" >&2; exit 1; }
fi
DERIVED="0xc86A2A2F3FB5a3ac4FcB18076803c76D97AAc43F"
CHAIN=46630
ETH="0x0000000000000000000000000000000000000000"
NEAR_RPC="${NEAR_RPC_URL:-https://test.rpc.fastnear.com}"
EVM_RPC="https://rpc.testnet.chain.robinhood.com"
NB="https://testnet.nearblocks.io"
WEI_NEEDED=1300000000000000 # 0.0012 ETH for the two transfers, plus room for fees
TICKET_TTL_S=900

B=$'\e[1m'; R=$'\e[31m'; G=$'\e[32m'; Y=$'\e[33m'; C=$'\e[36m'; N=$'\e[0m'
say() { printf '%s\n' "$*"; }
note() { printf '%s%s%s\n' "$C" "$*" "$N"; }
warn() { printf '%s%s%s\n' "$Y" "$*" "$N"; }
PAUSED_BY_US=0
die() {
  printf '%sSTOP: %s%s\n' "$R" "$*" "$N"
  [ "$PAUSED_BY_US" = 1 ] && printf '%sTHE CONTRACT MAY STILL BE PAUSED: Resume it in wallet-page-owner now.%s\n' "$R" "$N"
  exit 1
}
wait_enter() { note "$1"; read -r _ || die "no input"; }
clr() { clear 2>/dev/null || printf '\n\n'; }

cd "$(dirname "$0")/.." || die "cannot cd to agent/"
[ -f package.json ] && grep -q '"policy-signer-agent"' package.json || die "run this from the repo's agent/ folder"
grep -q -- "--skip-preview" src/cli.ts || die "this checkout is older than --skip-preview: git pull first"
for t in jq curl node npm; do command -v "$t" >/dev/null || die "$t is not installed"; done
[ -d node_modules ] || { note "Installing the agent's dependencies (npm ci)..."; npm ci --silent || die "npm ci failed"; }

# Test hooks: a stub agent and stub RPCs (used by the repo's own test of this script). Never set them for a real take.
AGENT_CMD="${DEMO_AGENT_CMD:-npm run --silent cli --}"
[ -n "${DEMO_AGENT_CMD:-}" ] && AGENT_PUBKEY="${DEMO_AGENT_PUBKEY:-$AGENT_PUBKEY}"

rpc_near() { curl -sS --max-time 20 "$NEAR_RPC" -H 'content-type: application/json' -d "$1"; }
view() { # view <method> <json args>  -> the view's JSON on stdout
  if [ -n "${DEMO_VIEW_CMD:-}" ]; then $DEMO_VIEW_CMD "$1" "$2"; return; fi
  local a out
  a=$(printf '%s' "$2" | base64 | tr -d '\n')
  out=$(rpc_near "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"query\",\"params\":{\"request_type\":\"call_function\",\"finality\":\"final\",\"account_id\":\"$CONTRACT\",\"method_name\":\"$1\",\"args_base64\":\"$a\"}}") || return 1
  printf '%s' "$out" | jq -er '.result.result | implode' 2>/dev/null || { warn "view $1 failed: $(printf '%s' "$out" | head -c 200)"; return 1; }
}
agent_keys() {
  if [ -n "${DEMO_KEYS_CMD:-}" ]; then $DEMO_KEYS_CMD; return; fi
  rpc_near "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"query\",\"params\":{\"request_type\":\"view_access_key_list\",\"finality\":\"final\",\"account_id\":\"$AGENT_ACCOUNT\"}}"
}
evm_balance_wei() {
  if [ -n "${DEMO_BALANCE_CMD:-}" ]; then $DEMO_BALANCE_CMD; return; fi
  local hex
  hex=$(curl -sS --max-time 20 "$EVM_RPC" -H 'content-type: application/json' \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"eth_getBalance\",\"params\":[\"$DERIVED\",\"latest\"]}" | jq -er .result) || return 1
  node -e 'console.log(BigInt(process.argv[1]).toString())' "$hex"
}
pubkey_of() { # the public key of the secret key in $1 (env var name), without printing the secret
  node -e 'const {KeyPair}=require("near-api-js"); try { console.log(KeyPair.fromString(process.env[process.argv[1]]).getPublicKey().toString()) } catch { console.log("invalid") }' "$1" 2>/dev/null
}
ge() { node -e 'process.exit(BigInt(process.argv[1]) >= BigInt(process.argv[2]) ? 0 : 1)' "$1" "$2"; }

# ---------------------------------------------------------------- preflight (off camera)
say "${B}Preflight ($MODE), $(date -u '+%Y-%m-%d %H:%M UTC')${N}"
hhmm=$(date -u +%H%M)
if [ "$MODE" != check ] && [ "$hhmm" -ge 2330 ]; then die "it is after 23:30 UTC; the daily caps reset at 00:00 UTC (5 PM MST). Start after 00:05 UTC."; fi

if [ "$MODE" != check ]; then
  if [ -z "${NEAR_AGENT_KEY:-}" ] && [ -f "$AGENT_FILE" ]; then
    DEMO_CAND=$(jq -r '.requestSecretKey // empty' "$AGENT_FILE"); export DEMO_CAND
    if [ -n "$DEMO_CAND" ] && [ "$(pubkey_of DEMO_CAND)" = "$AGENT_PUBKEY" ]; then NEAR_AGENT_KEY="$DEMO_CAND"; note "Agent key: $AGENT_FILE ($AGENT_ACCOUNT)."; fi
    unset DEMO_CAND
  fi
  if [ -z "${NEAR_AGENT_KEY:-}" ]; then
    for f in "$HOME/.near-credentials/testnet/$AGENT_ACCOUNT.json" "$HOME"/.near-credentials/testnet/"$AGENT_ACCOUNT"/*.json; do
      [ -f "$f" ] || continue
      DEMO_CAND=$(jq -r '.private_key // empty' "$f" 2>/dev/null); export DEMO_CAND
      if [ -n "$DEMO_CAND" ] && [ "$(pubkey_of DEMO_CAND)" = "$AGENT_PUBKEY" ]; then NEAR_AGENT_KEY="$DEMO_CAND"; note "Agent key found in the NEAR keychain."; break; fi
    done
    unset DEMO_CAND
  fi
  if [ -z "${NEAR_AGENT_KEY:-}" ]; then
    printf '%s' "${C}Paste the agent's secret key (ed25519:..., hidden), then Enter: ${N}"
    read -rs NEAR_AGENT_KEY || die "no key"; echo
  fi
  export NEAR_AGENT_KEY
  [ "$(pubkey_of NEAR_AGENT_KEY)" = "$AGENT_PUBKEY" ] || die "that key is not the agent's request key ${AGENT_PUBKEY:0:12}..."
  say "${G}ok${N}  agent key is ${AGENT_PUBKEY:0:12}... (not printed)"
fi

keys=$(agent_keys) || die "cannot read $AGENT_ACCOUNT's keys"
printf '%s' "$keys" | jq -e --arg k "$AGENT_PUBKEY" --arg c "$CONTRACT" '.result.keys | length == 1 and .[0].public_key == $k
  and .[0].access_key.permission.FunctionCall.receiver_id == $c and .[0].access_key.permission.FunctionCall.method_names == ["request"]' >/dev/null \
  || die "$AGENT_ACCOUNT should have exactly one key, $AGENT_PUBKEY, for $CONTRACT method request"
say "${G}ok${N}  $AGENT_ACCOUNT: one function-call key, method request"

status=$(view get_status "{\"chain_id\":$CHAIN,\"token\":\"$ETH\"}") || die "cannot read get_status"
paused=$(printf '%s' "$status" | jq -r .paused)
[ "$paused" = false ] || die "the contract is paused: Resume it in wallet-page-owner first"
[ "$(printf '%s' "$status" | jq -r .in_flight)" = null ] || die "a request is in flight: $(printf '%s' "$status" | jq -c .in_flight)"
remaining=$(printf '%s' "$status" | jq -r '.remaining_today // "0"')
say "${G}ok${N}  not paused; nothing in flight; remaining today: $remaining wei (0.0012 ETH = 1200000000000000)"
creq=$(printf '%s' "$status" | jq -r .requests_today); cmax=$(printf '%s' "$status" | jq -r .max_requests_per_day)
usage=$(view get_agent_usage "{\"agent\":\"$AGENT_ACCOUNT\",\"chain_id\":$CHAIN,\"token\":\"$ETH\"}") || die "cannot read get_agent_usage"
areq=$(printf '%s' "$usage" | jq -r .requests_today)
agent=$(view get_agent "{\"agent\":\"$AGENT_ACCOUNT\"}") || die "cannot read get_agent"
[ "$(printf '%s' "$agent" | jq -r '.enabled // false')" = true ] || die "$AGENT_ACCOUNT is not a registered, enabled agent of the contract yet (wallet-page-new-agent steps 2 and 3)"
amax=$(printf '%s' "$agent" | jq -r .max_requests_per_day)
say "${G}ok${N}  $AGENT_ACCOUNT is a registered agent ($(printf '%s' "$agent" | jq -r .label))"
say "      requests today: agent $areq of $amax, contract $creq of $cmax"
balance=$(evm_balance_wei) || die "cannot read the derived address's balance on $CHAIN"
say "      derived address $DERIVED on $CHAIN: $balance wei"

case "$MODE" in take) need_req=6 ;; rehearse) need_req=2 ;; *) need_req=0 ;; esac
if [ "$need_req" -gt 0 ]; then
  [ $((areq + need_req)) -le "$amax" ] || die "the agent has $((amax - areq)) requests left today; a $MODE needs $need_req. Wait for 00:00 UTC."
  [ $((creq + need_req)) -le "$cmax" ] || die "the contract has $((cmax - creq)) requests left today; a $MODE needs $need_req."
fi
if [ "$MODE" = take ]; then
  ge "$remaining" 1200000000000000 || die "only $remaining wei of today's ETH budget is left; a take needs 1200000000000000. Wait for 00:00 UTC."
  ge "$balance" "$WEI_NEEDED" || die "top up $DERIVED on $CHAIN to at least 0.005 ETH (a take needs about 0.0013)"
fi
say "${G}Preflight OK.${N}"
[ "$MODE" = check ] && exit 0

# ---------------------------------------------------------------- the sends
VIDEO_CFG="agent.config.video.json"
jq --arg a "$AGENT_ACCOUNT" '.chains["46630"].allowBroadcast = true | .near.agentAccountId = $a' agent.config.judges.json >"$VIDEO_CFG" || die "cannot write $VIDEO_CFG"
trap 'rm -f "$VIDEO_CFG"' EXIT
export AGENT_CONFIG="$VIDEO_CFG"

LOG="$HOME/demo-take-$(date -u +%Y%m%dT%H%M%SZ)-$MODE.txt"
: >"$LOG"
declare -a SUMMARY=()
LAST=""

record() { SUMMARY+=("$1"); printf '%s\n' "$1" >>"$LOG"; }

# run <shot> <expect jq filter> <agent args...>: shows the command, waits for Enter, runs it, prints one outcome line.
run() {
  local shot="$1" expect="$2"; shift 2
  local shown="agent"
  for a in "$@"; do case "$a" in *" "*) shown+=" \"$a\"" ;; *) shown+=" $a" ;; esac; done
  clr
  printf '%s$ %s%s' "$B" "$shown" "$N"
  read -r _ || die "no input"
  local out
  out=$($AGENT_CMD "$@" 2>&1)
  if ! printf '%s' "$out" | jq -e . >/dev/null 2>&1; then
    printf '%s%s%s\n' "$R" "$(printf '%s' "$out" | tail -n 3)" "$N"
    record "shot $shot: ERROR $(printf '%s' "$out" | tail -n 1)"
    LAST=""
    return 1
  fi
  printf '%s' "$out" | jq -c '{kind, reason, stage, ticketId, signer} | with_entries(select(.value != null))
    | if .signer then .signer |= .[0:6] + "..." + .[-4:] else . end'
  printf '%s' "$out" | jq -r '.links // {} | to_entries[] | "\(.key) tx ...\(.value[-10:])"'
  LAST="$out"
  local verdict
  if printf '%s' "$out" | jq -e "$expect" >/dev/null; then verdict="PASS"; else verdict="UNEXPECTED"; fi
  record "shot $shot: $verdict $(printf '%s' "$out" | jq -c '{kind, reason, stage, ticketId, broadcast} | with_entries(select(.value != null))') $(printf '%s' "$out" | jq -r '[.links // {} | .[]] | join(" ")')"
  [ "$verdict" = PASS ] || { echo; warn "Not what this shot needs (expected: $expect)."; }
  echo
  wait_enter "[Enter] next step"
  [ "$verdict" = PASS ]
}
ask_continue() { warn "$1"; note "Type c and Enter to continue anyway, or just Enter to stop."; local a; read -r a; [ "$a" = c ] || die "stopped; see $LOG"; }

poll_view() { # poll_view <method> <args> <jq test> <seconds>
  local i
  for ((i = 0; i < $4; i += 3)); do
    view "$1" "$2" 2>/dev/null | jq -e "$3" >/dev/null 2>&1 && return 0
    sleep 3
  done
  return 1
}

owner_step() { # owner_step <instruction> <view> <args> <jq test> <what>
  clr
  say "${B}Owner step, in the browser (wallet-page-owner):${N}"
  say "$1"
  wait_enter "[Enter] when Meteor has confirmed it"
  note "Checking on chain..."
  poll_view "$2" "$3" "$4" 60 || ask_continue "the chain does not show $5 yet"
  record "owner: $5 (checked on chain)"
}

note "Start the screen recording now. Every step waits for Enter; the prompts are cut in the edit."
wait_enter "[Enter] to begin"

if [ "$MODE" = take ]; then
  run 1 '.kind=="refused" and .stage=="request" and .reason=="AmountCapExceeded" and (.links.near != null)' \
    send "send 0.002 ETH to alice" --skip-preview || ask_continue "shot 1 did not give an on-chain AmountCapExceeded refusal"
  run 4 '.kind=="signed" and .broadcast != null' \
    send "send 0.0004 ETH to alice" --broadcast || ask_continue "shot 4 was not signed and broadcast"
  run 6 '.kind=="refused" and .stage=="request" and .reason=="LookalikeRecipient" and (.links.near != null)' \
    send "send 0.0004 ETH to alice-old" --skip-preview || ask_continue "shot 6 did not give an on-chain LookalikeRecipient refusal"
fi
if [ "$MODE" = rehearse ]; then
  run R1 '.kind=="refused" and .stage=="request" and .reason=="AmountCapExceeded" and (.links.near != null)' \
    send "send 0.002 ETH to alice" --skip-preview || ask_continue "the refusal was not on chain"
fi

run 7 '.kind=="queued" and (.ticketId|type)=="number"' send "send 0.0008 ETH to alice" || die "the request was not queued; nothing to approve"
TICKET=$(printf '%s' "$LAST" | jq -r .ticketId)
QUEUED_AT=$(date +%s)
owner_step "  1. Refresh on-chain state. It must say: ${B}Newest pending ticket: $TICKET${N}
  2. Approve ticket $TICKET, then approve in Meteor (approve_ticket, 1 yoctoNEAR)." \
  get_ticket "{\"ticket_id\":$TICKET}" '.status == "Approved"' "ticket $TICKET approved"

if [ "$MODE" = rehearse ]; then
  record "rehearsal: ticket $TICKET left to expire unused (no ETH spent)"
else
  [ $(($(date +%s) - QUEUED_AT)) -lt $((TICKET_TTL_S - 60)) ] || warn "the approval may expire before the send"
  run 9 '.kind=="signed" and .broadcast != null' \
    send "send 0.0008 ETH to alice" --ticket "$TICKET" --broadcast || ask_continue "shot 9 was not signed and broadcast"
  PAUSED_BY_US=1
  owner_step "  Pause (set_paused true), then approve in Meteor." get_config '{}' '.paused == true' "paused"
  run 10 '.kind=="refused" and .stage=="request" and .reason=="Paused" and (.links.near != null)' \
    send "send 0.0004 ETH to alice" --skip-preview || ask_continue "shot 10 did not give an on-chain Paused refusal"
  owner_step "  Resume (set_paused false) right away, then approve in Meteor." get_config '{}' '.paused == false' "resumed"
  PAUSED_BY_US=0
fi

clr
say "${B}Done ($MODE).${N} You can stop the recording."
say ""
for s in "${SUMMARY[@]}"; do
  case "$s" in *UNEXPECTED* | *ERROR*) printf '%s%s%s\n' "$R" "${s:0:160}" "$N" ;; *) printf '%s\n' "${s:0:160}" ;; esac
done
{
  echo
  echo "For the screenshots (shots 2, 3, 5):"
  echo "  $NB/address/$CONTRACT  (access keys: none)"
  echo "  $NB/address/$AGENT_ACCOUNT  (access keys: one function-call key)"
  echo "  shot 2 = the near link of shot 1; shot 5 = the evm link of shot 4"
} | tee -a "$LOG"
paused_now=$(view get_config '{}' | jq -r .paused)
[ "$paused_now" = false ] || warn "THE CONTRACT IS STILL PAUSED: Resume it in wallet-page-owner now."
say ""
say "Outcomes and full links: $LOG (no keys in it). Send me that file."
