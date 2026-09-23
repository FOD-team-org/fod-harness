#!/bin/bash
input=$(cat)
cmd=$(printf '%s' "$input" | python3 -c 'import sys,json; print(json.load(sys.stdin).get("tool_input",{}).get("command",""))' 2>/dev/null)
if [[ "$cmd" == *FORBIDDEN_MARKER* ]]; then
  echo "하네스 가드: 이 동작은 승인 필수 목록(store-upload)에 해당합니다. 판단대기에 항목을 만들고 다른 작업을 진행하세요." >&2
  exit 2
fi
exit 0
