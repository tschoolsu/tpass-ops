#!/usr/bin/env bash
# push 前把關：對三 repo 跑 lint + tsc --noEmit（不靠跑 dev server 驗證）。
# 用法： scripts/check.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(dirname "$SCRIPT_DIR")"

fail=0
for d in tpass-auth tpass-portal tpass-form tpass-cross_grade_messages tpass-appeals; do
  echo "== $d : lint =="
  ( cd "$ROOT/$d" && npm run lint ) || fail=1
  echo "== $d : tsc --noEmit =="
  ( cd "$ROOT/$d" && npx tsc --noEmit ) || fail=1
done

if [ "$fail" -eq 0 ]; then
  echo "✅ all green"
else
  echo "❌ 有錯誤，見上方輸出" >&2
  exit 1
fi
