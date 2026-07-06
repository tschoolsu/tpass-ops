#!/usr/bin/env bash
# 伺服器上的部署腳本。放在 /srv/tschool/deploy/，三 repo 與本檔同層。
# 對指定服務： git pull →（鎖檔變動才）npm ci → npm run build →
#              tpass-form 額外 prisma migrate deploy → pm2 reload（zero-downtime）。
# 用法： deploy.sh [auth|portal|form|msg|appeals|all]   （預設 all）
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(dirname "$SCRIPT_DIR")"

svc_dir() { case "$1" in auth) echo tpass-auth;; portal) echo tpass-portal;; form) echo tpass-form;; msg) echo tpass-cross_grade_messages;; appeals) echo tpass-appeals;; esac; }

# .env.local 必填 key 檢查。git pull 後、build 前先擋。
# 必填清單的真相來源＝各 config/*.ts 的 REQUIRED 陣列（跟 runtime 同一份，不會漂移），
# 不是 .env.example——.env.example 含本機專用 key（例 TLS_KEY_FILE），上線刻意不設。
# 缺 key 就在這裡清楚報出並中止，不要讓 next build 埋在 page-data 收集階段噴 stack trace。
# 不自動填值：正式網域是「人的知識」，填錯的值比缺值更難查。
check_env() {
  d="$1"
  local_env="$d/.env.local"
  if [ ! -f "$local_env" ]; then
    echo "   ❌ 缺 $local_env（範本見 $d/.env.example）" >&2
    exit 1
  fi
  keys="$(for cfg in "$d"/src/config/*.ts; do
    [ -f "$cfg" ] || continue
    awk '/REQUIRED[[:space:]]*=[[:space:]]*\[/{f=1;next} f&&/\]/{f=0} f{print}' "$cfg"
  done | grep -oE '"[A-Z][A-Z0-9_]*"' | tr -d '"' | sort -u || true)"
  missing=""
  for k in $keys; do
    grep -qE "^[[:space:]]*${k}=" "$local_env" || missing="$missing $k"
  done
  if [ -n "$missing" ]; then
    echo "   ❌ $local_env 缺少必填變數：$missing" >&2
    echo "      對照範本補上真值後重跑（勿直接抄 .env.example 的本機預設值）：" >&2
    for k in $missing; do
      ex="$(grep -E "^[[:space:]]*${k}=" "$d/.env.example" 2>/dev/null | head -1 || true)"
      [ -n "$ex" ] && echo "        # 範本 → $ex" >&2
    done
    exit 1
  fi
  echo "   ✅ env 檢查通過（$(printf '%s\n' $keys | grep -c . || true) 個必填 key）"
}

deploy_one() {
  s="$1"
  dir="$ROOT/$(svc_dir "$s")"
  echo "==================== deploy $s ($dir) ===================="
  cd "$dir"

  before="$(git rev-parse HEAD)"
  git pull --ff-only
  after="$(git rev-parse HEAD)"

  if [ "$before" = "$after" ]; then
    echo "   無新 commit，仍重建以確保一致。"
  fi

  # 維護 env：git 更新可能引入新的必填 key（例：PORTAL_URL）。先擋，再 build。
  check_env "$dir"

  # 鎖檔有變動才重裝（npm ci 較慢）
  if git diff --name-only "$before" "$after" | grep -q '^package-lock\.json$'; then
    echo "   package-lock.json 變動 → npm ci"
    npm ci
  else
    echo "   依賴未變，略過 npm ci"
  fi

  # Prisma CLI 只讀 .env，不讀 .env.local；先把 .env.local 匯進環境再跑。
  # generate 必須在 build 之前：schema.prisma 一改、型別就變，build 的 tsc 檢查靠的是
  # node_modules 裡「上次生成」的 client。這步不能靠 npm ci 順便帶到——
  # form/msg 都沒有 postinstall 掛 prisma generate，且 package-lock.json 沒變時
  # npm ci 整個會被跳過（見上面），schema 改了也不會重新生成，build 就會拿舊型別去對新 schema。
  if [ "$s" = "form" ] || [ "$s" = "msg" ] || [ "$s" = "appeals" ]; then
    echo "   prisma generate（確保 client 型別跟得上 schema.prisma）"
    ( set -a; . "$dir/.env.local"; set +a; npx prisma generate )
  fi

  npm run build

  # form/appeals 無 migrations 目錄 → db push；msg 有 migrations → migrate deploy。
  if [ "$s" = "form" ] || [ "$s" = "appeals" ]; then
    echo "   $s → prisma db push（無 migrations 目錄）"
    ( set -a; . "$dir/.env.local"; set +a; npm run db:push )
  elif [ "$s" = "msg" ]; then
    echo "   msg → prisma migrate deploy"
    ( set -a; . "$dir/.env.local"; set +a; npx prisma migrate deploy )
  fi

  pm2 reload "$s"
  echo "   ✅ $s 部署完成"
}

target="${1:-all}"
case "$target" in
  auth|portal|form|msg|appeals) deploy_one "$target" ;;
  all) for s in auth portal form msg appeals; do deploy_one "$s"; done ;;
  *) echo "用法: $0 [auth|portal|form|msg|appeals|all]" >&2; exit 2 ;;
esac
