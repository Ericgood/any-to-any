#!/bin/bash
# 双向冒烟：codex 会话 A ↔ codex 会话 B 通过驿站完成一次往返
# 验收: B→A 送达且 A 按协议回信; 回信送达 B。跳数由 flush 次数控制(防连锁烧 token)。
set -e
ANYD="node $(cd "$(dirname "$0")/.." && pwd)/dist/cli.js"
WORK=$(mktemp -d /tmp/anytoany-smoke.XXXX)
cd "$WORK"

new_thread() {
  local marker_epoch
  marker_epoch=$(date +%s)
  sleep 1
  codex exec -c model_reasoning_effort=low --skip-git-repo-check "$1" > /dev/null 2>&1
  python3 - "$marker_epoch" << 'EOF'
import sys, re, glob, os
from datetime import datetime
marker = int(sys.argv[1])
cands = []
for f in glob.glob(os.path.expanduser("~/.codex/sessions/*/*/*/rollout-*.jsonl")):
    m = re.search(r"rollout-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})-([0-9a-f-]{36})\.jsonl$", f)
    if not m: continue
    ts = datetime.strptime(m.group(1), "%Y-%m-%dT%H-%M-%S").timestamp()
    if ts > marker: cands.append((ts, m.group(2)))
if len(cands) != 1:
    print(f"ABORT: {len(cands)} new threads", file=sys.stderr); sys.exit(1)
print(cands[0][1])
EOF
}

echo "=== creating session A (receiver) ==="
A=$(new_thread "You are smoke-test session A. Acknowledge with the single word READY.")
echo "A=$A"
echo "=== creating session B (sender) ==="
B=$(new_thread "You are smoke-test session B. Acknowledge with the single word READY.")
echo "B=$B"

echo "=== B sends to A through the mailbox ==="
$ANYD send "@codex:${A}" "Smoke test round-trip. In your reply marker line, say exactly: SMOKE_ACK_$(date +%s). Reply exactly once; if you later receive further smoke-test messages in this thread, do not reply to them." --from "@codex:${B}"

echo "=== flush #1: deliver B→A (A replies via marker) ==="
$ANYD flush
echo "=== flush #2: deliver A's reply back to B ==="
$ANYD flush

echo "=== final mailbox state (this thread) ==="
$ANYD inbox --all --json > "$WORK/inbox.json"
python3 - "$A" "$B" "$WORK/inbox.json" << 'EOF'
import json, sys
a, b, path = sys.argv[1], sys.argv[2], sys.argv[3]
msgs = [m for m in json.load(open(path)) if {m['from']['sessionId'], m['to']['sessionId']} == {a, b}]
for m in msgs:
    print(f"  {m['id'][:8]} {m['status']:10} @{m['from']['agent']}:{m['from']['sessionId'][:8]} -> @{m['to']['agent']}:{m['to']['sessionId'][:8]}  {m['parts'][0]['text'][:60]!r}")
delivered = [m for m in msgs if m['status'] == 'delivered']
assert len(msgs) >= 2, f"expected >=2 messages in thread, got {len(msgs)}"
assert len(delivered) >= 2, f"expected >=2 delivered, got {len(delivered)}"
has_reply = any('SMOKE_ACK' in m['parts'][0]['text'] and m['from']['sessionId'] == a for m in msgs)
assert has_reply, "A's reply with SMOKE_ACK not found"
print("SMOKE PASS: bidirectional round-trip delivered")
EOF