#!/usr/bin/env bash
# 伺服器上的部署腳本。放在 ~/tpass/deploy/（~/tpass = tpass-ops repo clone，各服務 repo 同層）。
# 服務清單 / 目錄 / DB 策略全部來自 ../services.json（唯一真相），不得在此硬編碼。
# 對指定服務： git pull →（鎖檔變動才）npm ci → prisma generate → npm run build →
#              依 db.strategy 套 schema → pm2 startOrReload（zero-downtime；新服務自動首啟）。
# 用法： deploy.sh [<svc>|all]   （預設 all = services.json 中 deployed:true 者）
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(dirname "$SCRIPT_DIR")"
REG="$ROOT/services.json"

[ -f "$REG" ] || { echo "❌ 找不到 $REG（~/tpass 應該是 tpass-ops repo 的 clone；見 docs/ONBOARDING.md §5）" >&2; exit 1; }

# 從註冊表查欄位（node 一定在——主機本來就跑 Next）
svc_dir()      { node -p "const s=require('$REG').services.find(x=>x.id===process.argv[1]);s?s.dir:''" "$1"; }
svc_port()     { node -p "const s=require('$REG').services.find(x=>x.id===process.argv[1]);s?s.port:''" "$1"; }
svc_strategy() { node -p "const s=require('$REG').services.find(x=>x.id===process.argv[1]);(s&&s.db&&s.db.strategy)||''" "$1"; }
deployed_ids() { node -p "require('$REG').services.filter(s=>s.deployed).map(s=>s.id).join(' ')"; }

# 部署後健康檢查：pm2 reload 回 ✓ 只代表行程換好了，不代表 app 活著
# （啟動時炸掉會被 pm2 無限重啟，表面仍是 online）。對 app 的 port 打 HTTP，
# 30 秒內拿到 <500 的回應才算部署成功，否則非零退出——不發假 ✅。
health_check() {
  s="$1"; port="$2"; code=""
  for _ in $(seq 1 30); do
    code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 "http://127.0.0.1:$port/" || true)"
    if [ "$code" != "000" ] && [ "$code" -lt 500 ] 2>/dev/null; then
      echo "   ✅ 健康檢查通過（:$port → HTTP $code）"
      return 0
    fi
    sleep 1
  done
  echo "   ❌ $s 健康檢查失敗（:$port 30 秒內無健康回應，最後狀態=${code:-無回應}）" >&2
  echo "      看 log：tpass logs $s（本機發動）或主機上 pm2 logs $s --lines 100" >&2
  exit 1
}

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
  rel="$(svc_dir "$s")"
  if [ -z "$rel" ]; then
    echo "❌ services.json 裡沒有服務「$s」" >&2
    exit 2
  fi
  dir="$ROOT/$rel"
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

  # 鎖檔有變動才重裝（npm ci 較慢）。node_modules 不存在（首次部署的 fresh clone）
  # 必裝——否則 npx 會抓最新版 prisma（major 版差直接炸 schema 驗證）。
  if [ ! -d node_modules ]; then
    echo "   node_modules 不存在（首次部署）→ npm ci"
    npm ci
  elif git diff --name-only "$before" "$after" | grep -q '^package-lock\.json$'; then
    echo "   package-lock.json 變動 → npm ci"
    npm ci
  else
    echo "   依賴未變，略過 npm ci"
  fi

  strategy="$(svc_strategy "$s")"

  # Prisma CLI 只讀 .env，不讀 .env.local；先把 .env.local 匯進環境再跑。
  # generate 必須在 build 之前：schema.prisma 一改、型別就變，build 的 tsc 檢查靠的是
  # node_modules 裡「上次生成」的 client。這步不能靠 npm ci 順便帶到——
  # 沒有 postinstall 掛 prisma generate，且 package-lock.json 沒變時 npm ci 整個被跳過，
  # schema 改了也不會重新生成，build 就會拿舊型別去對新 schema。
  if [ -n "$strategy" ]; then
    echo "   prisma generate（確保 client 型別跟得上 schema.prisma）"
    ( set -a; . "$dir/.env.local"; set +a; npx prisma generate )
  fi

  npm run build

  # 套 schema：策略由 services.json 的 db.strategy 決定（migrate = 有 migrations 歷史）。
  case "$strategy" in
    migrate)
      echo "   $s → prisma migrate deploy"
      ( set -a; . "$dir/.env.local"; set +a; npx prisma migrate deploy )
      ;;
    push)
      echo "   $s → prisma db push（無 migrations 目錄）"
      ( set -a; . "$dir/.env.local"; set +a; npm run db:push )
      ;;
  esac

  # startOrReload：既有 app zero-downtime reload；registry 新增的服務自動首次啟動。
  pm2 startOrReload "$SCRIPT_DIR/ecosystem.config.js" --only "$s"
  health_check "$s" "$(svc_port "$s")"
  echo "   ✅ $s 部署完成"
}

target="${1:-all}"
if [ "$target" = "all" ]; then
  for s in $(deployed_ids); do deploy_one "$s"; done
else
  deploy_one "$target"
fi

# 全部成功才更新開機快照——重開機時 pm2 resurrect 的就是「最後一次成功部署」的清單。
pm2 save
echo "   ✅ pm2 save（開機快照已更新）"
