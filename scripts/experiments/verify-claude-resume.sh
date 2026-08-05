#!/bin/bash
# R1 验证（需在用户已登录 claude 的真实终端跑，沙盒环境拿不到 Keychain 登录态）
# 预期最后输出: ALPHA —— 证明 claude -p --resume 携带完整历史
set -e
DIR=$(mktemp -d /tmp/anytoany-r1.XXXX)
cd "$DIR"
echo "workdir: $DIR"
SID=$(claude -p "Reply with exactly the single word: ALPHA" --output-format json | python3 -c "import json,sys;print(json.load(sys.stdin)['session_id'])")
echo "session created: $SID"
echo "--- resume answer (expect ALPHA):"
claude -p --resume "$SID" "Earlier you replied with one single word. Reply with exactly that word, nothing else."
