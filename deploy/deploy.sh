#!/usr/bin/env bash
# 伺服器上的部署腳本。放在 ~/tpass/deploy/（~/tpass = tpass-ops repo clone，註冊表與它同層）。
# 各服務 repo 住 registry 的 server.servicesRoot 底下（＝ /home/service/<dir>，一個服務一層）。
# 服務清單 / 目錄 / DB 策略全部來自 ../tpass-registry/services.json（唯一真相），不得在此硬編碼。
# 註冊表是並排的 public repo，每次部署前先 pull——主機只認 tpass-registry main 的最新版。
# 對指定服務： git pull →（鎖檔變動才）pnpm install --frozen-lockfile → prisma generate →
#              pnpm run build → 依 db.strategy 套 schema → pm2 startOrReload（zero-downtime；新服務自動首啟）。
# 用法： deploy.sh [<svc>|all]   （預設 all = services.json 中 deployed:true 者）
set -euo pipefail

# 非互動 ssh 不 source rc；pnpm 是無 root 的 standalone 安裝（住在 $PNPM_HOME），此處自帶 PATH。
export PNPM_HOME="${PNPM_HOME:-$HOME/.local/share/pnpm}"
export PATH="$PNPM_HOME:$PATH"
command -v pnpm >/dev/null 2>&1 || {
  echo "❌ 找不到 pnpm。主機一次性安裝（無 root）：curl -fsSL https://get.pnpm.io/install.sh | env PNPM_VERSION=10.27.0 sh -" >&2
  exit 1
}

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(dirname "$SCRIPT_DIR")"
REG_DIR="$ROOT/tpass-registry"
REG="$REG_DIR/services.json"

if [ ! -d "$REG_DIR/.git" ]; then
  echo "❌ 找不到服務註冊表 $REG_DIR" >&2
  echo "   註冊表是並排的 public repo，先 clone 一次：" >&2
  echo "     git -C $ROOT clone https://github.com/tschoolsu/tpass-registry.git" >&2
  exit 1
fi

# 註冊表永遠吃 main 最新版：加服務 / 翻 deployed 只要 merge 進 tpass-registry，
# 不必再改 ops、portal、auth 任何一行程式碼。
echo "==================== registry ===================="
git -C "$REG_DIR" pull --ff-only
node "$REG_DIR/validate.mjs"

[ -f "$REG" ] || { echo "❌ 找不到 $REG" >&2; exit 1; }

# 服務 repo 的家（registry 的 server.servicesRoot；沒宣告就退回舊佈局＝與 ops repo 同層）。
SVC_ROOT="$(node -p "
const r = require('$REG');
const p = (r.server && r.server.servicesRoot) || '';
p.startsWith('~/') ? require('path').join(require('os').homedir(), p.slice(2)) : (p || '$ROOT')
")"
[ -d "$SVC_ROOT" ] || { echo "❌ 服務根目錄 $SVC_ROOT 不存在（registry 的 server.servicesRoot）" >&2; exit 1; }

# 主機上服務不與註冊表並排，`../tpass-registry` 這條相對路徑不成立 → 直接把絕對路徑餵給
# build（pnpm run build 會把服務清單烤進去）。runtime 那份由 ecosystem.config.js 的 env 注入。
export TPASS_REGISTRY_PATH="$REG"

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
  # 用 node 解析（跟 scripts/lib/check.mjs 的 requiredEnvKeys 同一條 regex）。
  # 原本的 awk 版對「單行寫完的 REQUIRED = [...]」會整行跳過 → 那些 key 靜默漏掉，
  # 於是缺 key 不是在這裡被擋下，而是 build 到收集 page data 才炸（2026-07-28 踩到）。
  keys="$(node -e '
const fs = require("fs"), path = require("path");
const dir = path.join(process.argv[1], "src", "config");
const out = new Set();
if (fs.existsSync(dir)) {
  for (const f of fs.readdirSync(dir).filter((f) => f.endsWith(".ts"))) {
    const src = fs.readFileSync(path.join(dir, f), "utf8");
    for (const m of src.matchAll(/REQUIRED\s*=\s*\[([^\]]*)\]/gs))
      for (const k of m[1].matchAll(/"([A-Z][A-Z0-9_]*)"/g)) out.add(k[1]);
  }
}
console.log([...out].sort().join("\n"));
' "$d")"
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
  dir="$SVC_ROOT/$rel"
  if [ ! -d "$dir/.git" ]; then
    echo "❌ 找不到 $s 的 repo：$dir" >&2
    echo "   服務 repo 一律 clone 在 $SVC_ROOT 底下，一個服務一層（見 docs/ONBOARDING.md §5）。" >&2
    exit 1
  fi
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

  # 鎖檔有變動才重裝。node_modules/.pnpm 是「pnpm 所裝」的指紋：
  # 不存在＝首次部署，或還是 npm 時代裝的舊 node_modules（一次性轉換）——都必須重裝，
  # 否則 pnpm exec 找不到工具、或拿舊依賴去 build。舊 node_modules 先備份成
  # node_modules.npm-bak（tsconfig 已 exclude；也是 pnpm 部署炸掉時的即刻止血包：
  # mv 回來 + pm2 restart 就回到舊世界）。
  if [ ! -d node_modules/.pnpm ]; then
    if [ -d node_modules ]; then
      echo "   node_modules 非 pnpm 所裝（npm 舊裝）→ 備份為 node_modules.npm-bak 後重裝"
      rm -rf node_modules.npm-bak
      mv node_modules node_modules.npm-bak
    else
      echo "   node_modules 不存在（首次部署）→ pnpm install"
    fi
    pnpm install --frozen-lockfile
  elif git diff --name-only "$before" "$after" | grep -q '^pnpm-lock\.yaml$'; then
    echo "   pnpm-lock.yaml 變動 → pnpm install --frozen-lockfile"
    pnpm install --frozen-lockfile
  else
    echo "   依賴未變，略過 pnpm install"
  fi

  strategy="$(svc_strategy "$s")"

  # Prisma CLI 只讀 .env，不讀 .env.local；先把 .env.local 匯進環境再跑。
  # generate 必須在 build 之前：schema.prisma 一改、型別就變，build 的 tsc 檢查靠的是
  # node_modules 裡「上次生成」的 client。這步不能靠 install 順便帶到——
  # 沒有 postinstall 掛 prisma generate，且 pnpm-lock.yaml 沒變時 install 整個被跳過，
  # schema 改了也不會重新生成，build 就會拿舊型別去對新 schema。
  # pnpm exec 只用本地依賴、找不到就報錯——不會像 npx 那樣去抓最新版（major 版差炸 schema）。
  # strategy:"none" ＝ 有資料庫但不用 Prisma（例：直接用 pg）。整段 prisma 都不能碰——
  # 那種 repo 沒有 schema.prisma，prisma generate 會直接失敗。
  if [ -n "$strategy" ] && [ "$strategy" != "none" ]; then
    echo "   prisma generate（確保 client 型別跟得上 schema.prisma）"
    ( set -a; . "$dir/.env.local"; set +a; pnpm exec prisma generate )
  fi

  pnpm run build

  # 套 schema：策略由 services.json 的 db.strategy 決定（migrate = 有 migrations 歷史）。
  case "$strategy" in
    migrate)
      echo "   $s → prisma migrate deploy"
      ( set -a; . "$dir/.env.local"; set +a; pnpm exec prisma migrate deploy )
      ;;
    push)
      echo "   $s → prisma db push（無 migrations 目錄）"
      ( set -a; . "$dir/.env.local"; set +a; pnpm run db:push )
      ;;
    none)
      echo "   $s → 非 Prisma，schema 由服務自己管，部署不套 schema"
      ;;
  esac

  # startOrReload：既有 app zero-downtime reload；registry 新增的服務自動首次啟動。
  # 例外：pm2 reload 不會套用 ecosystem.config.js 改過的 script 路徑——程序還掛在
  # npm 時代的 .bin/next（shell shim，pm2 當 JS require 會炸）時，得 delete 重建（一次性）。
  if pm2 describe "$s" 2>/dev/null | grep -q 'node_modules/\.bin/next'; then
    echo "   pm2 程序還掛在舊 script 路徑（.bin/next）→ delete + start（一次性重建）"
    pm2 delete "$s"
  fi
  # reload 不會搬 cwd：程序還跑在舊目錄（例：搬去 $SVC_ROOT 之前的 ~/tpass/<dir>）時，
  # 只 reload 會安靜地繼續跑舊路徑的 build。cwd 不符就 delete + start 重建。
  cur_cwd="$(pm2 jlist 2>/dev/null | node -e "
let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{
  try { const a=JSON.parse(d).find(p=>p.name===process.argv[1]); console.log(a?a.pm2_env.pm_cwd:''); }
  catch { console.log(''); }
})" "$s" || true)"
  if [ -n "$cur_cwd" ] && [ "$cur_cwd" != "$dir" ]; then
    echo "   pm2 程序的 cwd 是 $cur_cwd，應為 $dir → delete + start（重建）"
    pm2 delete "$s"
  fi
  pm2 startOrReload "$SCRIPT_DIR/ecosystem.config.js" --only "$s" --update-env
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
