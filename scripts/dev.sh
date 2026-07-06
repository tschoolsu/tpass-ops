#!/usr/bin/env bash
# 本機內層 dev 迴圈：next dev 跑 HTTPS(mkcert) + *.lvh.me 子網域 + HMR。
# SSO 流程（HTTPS / Secure cookie / 跨子網域）在此模式照樣測得到。
# 用法： scripts/dev.sh [auth|portal|form|msg|appeals|all]   （預設 all）
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(dirname "$SCRIPT_DIR")"
CERT="$ROOT/certs/cert.pem"
KEY="$ROOT/certs/key.pem"

[ -f "$CERT" ] && [ -f "$KEY" ] || {
  echo "✗ 找不到憑證 $CERT / $KEY，請先跑： scripts/setup.sh" >&2
  exit 1
}

# 讓本機跑的 node 工具信任 mkcert 根憑證（獨立 node 腳本有效）。
# 注意：Next(Turbopack) 的 server 端 fetch(undici) 不吃這個變數，消費端的 JWKS 抓取
# 要另外處理（見 run_one 裡的 NODE_TLS_REJECT_UNAUTHORIZED）。
export NODE_EXTRA_CA_CERTS="$(mkcert -CAROOT)/rootCA.pem"

# 服務對照（與各 server.mjs 的預設一致）：name -> dir / hostname / port
svc_dir()  { case "$1" in auth) echo tpass-auth;;   portal) echo tpass-portal;;        form) echo tpass-form;;       msg) echo tpass-cross_grade_messages;; appeals) echo tpass-appeals;; esac; }
svc_host() { case "$1" in auth) echo auth.lvh.me;; portal) echo portal.lvh.me;; form) echo form.lvh.me;; msg) echo msg.lvh.me;; appeals) echo appeals.lvh.me;; esac; }
svc_port() { case "$1" in auth) echo 3000;;   portal) echo 3001;;          form) echo 3002;;         msg) echo 3003;;         appeals) echo 3004;; esac; }

run_one() {
  s="$1"
  dir="$ROOT/$(svc_dir "$s")"; host="$(svc_host "$s")"; port="$(svc_port "$s")"
  cd "$dir"
  # 消費端(portal/form)在 dev 要去抓本機 mkcert 簽的 auth.lvh.me JWKS，但 Next 的 undici
  # 不吃 NODE_EXTRA_CA_CERTS / --use-system-ca，會 UNABLE_TO_VERIFY_LEAF_SIGNATURE，
  # 導致驗章默默失敗、登入後一直掉回登入頁。dev-only 對消費端關閉 TLS 驗證即可。
  # auth 不關（它要驗 Google 真憑證）；正式環境走真憑證，完全不經過這個 script。
  if [ "$s" != auth ]; then
    export NODE_TLS_REJECT_UNAUTHORIZED=0
  fi
  exec ./node_modules/.bin/next dev \
    --experimental-https \
    --experimental-https-key "$KEY" \
    --experimental-https-cert "$CERT" \
    -H "$host" -p "$port"
}

target="${1:-all}"
case "$target" in
  auth|portal|form|msg|appeals)
    echo "▶ $target → https://$(svc_host "$target"):$(svc_port "$target")"
    run_one "$target"
    ;;
  all)
    pids=""
    cleanup() { trap - INT TERM EXIT; [ -n "$pids" ] && kill $pids 2>/dev/null || true; }
    trap cleanup INT TERM EXIT
    for s in auth portal form msg appeals; do
      echo "▶ $s → https://$(svc_host "$s"):$(svc_port "$s")"
      ( run_one "$s" 2>&1 | sed "s/^/[$s] /" ) &
      pids="$pids $!"
    done
    wait
    ;;
  *)
    echo "用法: $0 [auth|portal|form|msg|appeals|all]" >&2
    exit 2
    ;;
esac
