#!/usr/bin/env bash
# 一次性本機環境準備（冪等，重跑安全）。
# 用法： scripts/setup.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(dirname "$SCRIPT_DIR")"

command -v mkcert >/dev/null 2>&1 || {
  echo "✗ 找不到 mkcert，請先： brew install mkcert nss" >&2
  exit 1
}

echo "== 1) 信任 mkcert 根憑證（已信任會直接略過）=="
mkcert -install

echo "== 2) 產一張涵蓋五網域的憑證 → $ROOT/certs =="
mkdir -p "$ROOT/certs"
( cd "$ROOT/certs" && mkcert -cert-file cert.pem -key-file key.pem \
    auth.lvh.me portal.lvh.me form.lvh.me msg.lvh.me appeals.lvh.me )

echo "== 3) 安裝相依（tpass-auth / tpass-portal / tpass-form / tpass-cross_grade_messages / tpass-appeals）=="
for d in tpass-auth tpass-portal tpass-form tpass-cross_grade_messages tpass-appeals; do
  echo "   -> $d"
  ( cd "$ROOT/$d" && npm install )
done

echo "== 4) 產 EdDSA 簽章金鑰（請貼進 auth/.env.local）=="
( cd "$ROOT/tpass-auth" && node scripts/gen-keys.mjs )

echo "== 5) 資料庫初始化（tpass-form / tpass-cross_grade_messages / tpass-appeals）=="
for d in tpass-form tpass-cross_grade_messages tpass-appeals; do
  if { [ -f "$ROOT/$d/.env.local" ] || [ -f "$ROOT/$d/.env" ]; } \
      && command -v pg_isready >/dev/null 2>&1 && pg_isready -q 2>/dev/null; then
    ( cd "$ROOT/$d" && npm run db:generate && npm run db:push )
  else
    echo "   （略過 $d：未偵測到 .env(.local) 或可用的 Postgres。"
    echo "    填好 DATABASE_URL 後手動跑： cd $d && npm run db:generate && npm run db:push）"
  fi
done

cat <<EOF

────────────────────────────────────────────────────────
接下來手動完成（一次）：
  1. 各 repo 複製 .env.example → .env.local 並填值：
       cp tpass-auth/.env.example   tpass-auth/.env.local
       cp tpass-portal/.env.example tpass-portal/.env.local
       cp tpass-form/.env.example tpass-form/.env.local
       cp tpass-appeals/.env.example tpass-appeals/.env.local
  2. tpass-auth/.env.local：貼上上面印出的 JWT_PRIVATE_KEY / JWT_PUBLIC_KEY 兩行。
  3. 所有 .env.local 都設（本機 HTTPS smoke 用 server.mjs 會讀）：
       TLS_KEY_FILE=$ROOT/certs/key.pem
       TLS_CERT_FILE=$ROOT/certs/cert.pem
  4. tpass-form / tpass-appeals 的 .env.local：設 DATABASE_URL（本機 Postgres，各自獨立的 DB）。

完成後日常開發：
       scripts/dev.sh all        # 內層，有 HMR
       scripts/check.sh          # push 前把關（lint + tsc）
       scripts/start-all.sh      # push 前 production smoke
────────────────────────────────────────────────────────
EOF
