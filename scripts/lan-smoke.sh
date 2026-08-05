#!/bin/bash
# P2 局域网集成冒烟(单机双 daemon 模拟双设备):
# alpha 驿站 → relay → beta 驿站 → beta 本地投递真实 codex 会话 → 回信 relay 回 alpha
set -e
ANYD="node $(cd "$(dirname "$0")/.." && pwd)/dist/cli.js"
WORK=$(mktemp -d /tmp/anytoany-lan.XXXX)
HOME_A="$WORK/homeA"; HOME_B="$WORK/homeB"
PORT_A=7501; PORT_B=7502
mkdir -p "$HOME_A/.anytoany" "$HOME_B/.anytoany"
TOKEN="lan-smoke-$(date +%s)-token-0123456789abcdef"
printf '%s\n' "$TOKEN" > "$HOME_A/.anytoany/cluster-token"
printf '%s\n' "$TOKEN" > "$HOME_B/.anytoany/cluster-token"
printf 'alpha\n' > "$HOME_A/.anytoany/device-name"
printf 'beta\n'  > "$HOME_B/.anytoany/device-name"

cleanup() { kill "$PID_A" "$PID_B" 2>/dev/null || true; }
trap cleanup EXIT

echo "=== pick a real codex target session (from earlier smoke runs) ==="
TARGET=$($ANYD list --json --limit 0 | python3 -c "
import json,sys
d=json.load(sys.stdin)
c=[s for s in d['sessions'] if s['agent']=='codex' and 'anytoany-smoke' in s['title']]
assert c, 'no smoke codex session found'
print(c[0]['sessionId'])")
echo "TARGET=$TARGET"

echo "=== start daemon beta (:$PORT_B) ==="
ANYTOANY_HOME="$HOME_B" $ANYD start --port $PORT_B --peer "127.0.0.1:$PORT_A" > "$WORK/beta.log" 2>&1 &
PID_B=$!
sleep 2
echo "=== start daemon alpha (:$PORT_A) with static peer to beta ==="
ANYTOANY_HOME="$HOME_A" $ANYD start --port $PORT_A --peer "127.0.0.1:$PORT_B" > "$WORK/alpha.log" 2>&1 &
PID_A=$!
sleep 3

echo "=== alpha directory should include beta's sessions ==="
curl -s "http://127.0.0.1:$PORT_A/api/sessions" | python3 -c "
import json,sys
ss=json.load(sys.stdin)['sessions']
remote=[s for s in ss if s.get('device')=='beta']
print(f'alpha sees {len(ss)} sessions, {len(remote)} from beta')
assert remote, 'no beta sessions aggregated'"

echo "=== send via alpha /api/send to @beta/codex:<target> ==="
MSG_ID=$(curl -s -X POST "http://127.0.0.1:$PORT_A/api/send" -H 'content-type: application/json' -d "{
  \"target\": \"@beta/codex:$TARGET\",
  \"from\": {\"agent\": \"claude\", \"sessionId\": \"a8286d6b-225a-4ebc-a324-0e648b1d88ba\"},
  \"text\": \"LAN smoke: reply once with the marker line saying exactly LAN_ACK, then stop. No further replies in this thread.\"
}" | python3 -c "import json,sys; d=json.load(sys.stdin); assert 'message' in d, d; print(d['message']['id'])")
echo "MSG_ID=$MSG_ID"

echo "=== wait for full round trip (alpha relayed → beta delivered → reply back to alpha) ==="
for i in $(seq 1 60); do
  STATE=$(ANYTOANY_HOME="$HOME_A" $ANYD inbox --all --json | python3 -c "
import json,sys
msgs=json.load(sys.stdin)
orig=[m for m in msgs if m['id']=='$MSG_ID']
reply=[m for m in msgs if m['contextId']=='$MSG_ID' and m['id']!='$MSG_ID']
o=orig[0]['status'] if orig else '?'
r=reply[0]['status'] if reply else '-'
print(f'{o}/{r}')")
  echo "  poll $i: orig/reply = $STATE"
  [ "$STATE" = "delivered/delivered" ] && break
  sleep 5
done

echo "=== final assertion ==="
ANYTOANY_HOME="$HOME_A" $ANYD inbox --all --json | python3 -c "
import json,sys
msgs=json.load(sys.stdin)
orig=[m for m in msgs if m['id']=='$MSG_ID'][0]
replies=[m for m in msgs if m['contextId']=='$MSG_ID' and m['id']!='$MSG_ID']
assert orig['status']=='delivered', f\"orig: {orig['status']} {orig.get('lastError')}\"
assert orig['to'].get('device')=='beta'
assert replies, 'no reply came back to alpha'
r=replies[0]
print('reply text:', r['parts'][0]['text'][:80])
print('reply from device:', r['from'].get('device'))
assert 'LAN_ACK' in r['parts'][0]['text']
assert r['from'].get('device')=='beta'
print('LAN SMOKE PASS: cross-daemon round trip delivered')"
echo "=== beta log tail ==="; tail -5 "$WORK/beta.log"