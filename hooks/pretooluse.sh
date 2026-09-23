#!/bin/sh
node_bin=${FODH_NODE:-node}
if ! command -v "$node_bin" >/dev/null 2>&1; then
  echo "하네스 가드: Node 실행 파일을 찾을 수 없습니다. FODH_NODE를 설정하세요." >&2
  exit 2
fi
exec "$node_bin" "${0%/*}/pretooluse.mjs"
