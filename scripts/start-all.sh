#!/usr/bin/env bash
# 部署前 production smoke：build + start:https（server.mjs，最貼近 prod 的 next start）。
# 抓 dev 模式漏掉的 build / 型別 / RSC / React Compiler 行為差異。
# 用法： scripts/start-all.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(dirname "$SCRIPT_DIR")"

for d in tpass-auth tpass-portal tpass-form tpass-cross_grade_messages tpass-appeals; do
  echo "== build $d =="
  ( cd "$ROOT/$d" && npm run build )
done

label() { case "$1" in tpass-auth) echo auth;; tpass-portal) echo portal;; tpass-form) echo form;; tpass-cross_grade_messages) echo msg;; tpass-appeals) echo appeals;; esac; }

pids=""
cleanup() { trap - INT TERM EXIT; [ -n "$pids" ] && kill $pids 2>/dev/null || true; }
trap cleanup INT TERM EXIT

for d in tpass-auth tpass-portal tpass-form tpass-cross_grade_messages tpass-appeals; do
  echo "▶ start:https $d"
  ( cd "$ROOT/$d" && npm run start:https 2>&1 | sed "s/^/[$(label "$d")] /" ) &
  pids="$pids $!"
done
wait
