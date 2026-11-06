#!/usr/bin/env bash
D="$DEMO_TEST_DIR"
case "$1" in
  get_status) echo "{\"paused\":${PAUSED:-false},\"next_nonce\":4,\"in_flight\":null,\"remaining_today\":\"${REMAIN:-5000000000000000}\",\"requests_today\":3,\"max_requests_per_day\":50}" ;;
  get_agent_usage) echo "{\"spent_today\":\"0\",\"requests_today\":${AREQ:-2}}" ;;
  get_agent) if [ "${AGENT_REG:-}" = null ]; then echo null; else echo '{"enabled":true,"label":"demo agent","max_requests_per_day":20}'; fi ;;
  get_ticket) echo '{"id":7,"status":"Approved"}' ;;
  get_config) n=$(cat $D/cfgcount 2>/dev/null || echo 0); n=$((n+1)); echo $n > $D/cfgcount
     if [ $n -eq 1 ]; then echo '{"paused":true}'; else echo '{"paused":false}'; fi ;;
esac
