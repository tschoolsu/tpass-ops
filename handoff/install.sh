#!/usr/bin/env bash
# T-Pass 主機：把 pm2 這一層裝起來。在主機上跑，不要在本機跑。
#
#   ./install.sh          先看它要做什麼（不會動到任何東西）
#   ./install.sh --apply  真的執行
#
# 冪等：重複跑結果一樣。不需要 sudo（最後的開機自啟那行除外，會印出來給你貼）。
set -uo pipefail

APPLY=0
[ "${1:-}" = "--apply" ] && APPLY=1

HERE="$(cd "$(dirname "$0")" && pwd)"
# 路徑可覆蓋，只為了讓這支腳本能在真主機以外的地方被測試。正式環境不要設這兩個。
OPS_ROOT="${TPASS_OPS_ROOT:-$HOME/tpass}"
SVC_ROOT="${TPASS_SERVICES_ROOT:-/home/service}"
REG="$SVC_ROOT/service.json"

# 有自己 ecosystem.config.js 的服務（id:目錄）。那個檔跟著服務 repo 進 git。
OWN="auth:tpass-auth portal:tpass-portal form:tpass-form msg:tpass-cross_grade_messages appeals:tpass-appeals meeting:tpass-meeting"
# 還沒有自己那份、走 ops 層共用設定的服務
FALLBACK="notes"

fail=0
step() { echo; echo "── $* ──────────────────────────────────"; }
ok()   { echo "   ✓ $*"; }
warn() { echo "   ⚠ $*"; }
bad()  { echo "   ✗ $*"; fail=1; }
run()  {
  if [ "$APPLY" = 1 ]; then echo "   + $*"; "$@"
  else echo "   (dry-run) $*"; fi
}

# ── 1. 前置檢查 ─────────────────────────────────────────────────────────────
step "1. 前置檢查"
for c in git node pnpm pm2; do
  if command -v "$c" >/dev/null 2>&1; then ok "$c $($c --version 2>&1 | head -1)"
  else bad "找不到 ${c}"; fi
done
[ -d "$OPS_ROOT/deploy" ] && ok "ops repo：$OPS_ROOT" || bad "找不到 ops repo：$OPS_ROOT"
[ -d "$SVC_ROOT" ] && ok "服務根目錄：$SVC_ROOT" || bad "找不到服務根目錄：$SVC_ROOT"

for pair in $OWN; do
  id="${pair%%:*}"; dir="${pair#*:}"
  if [ ! -d "$SVC_ROOT/$dir" ]; then bad "${id}：$SVC_ROOT/$dir 不存在（還沒 clone？）"; continue; fi
  [ -d "$SVC_ROOT/$dir/node_modules" ] || warn "${id}：還沒 pnpm install 過"
  [ -d "$SVC_ROOT/$dir/.next" ]        || warn "${id}：還沒 build 過"
done
for id in $FALLBACK; do
  [ -f "$OPS_ROOT/deploy/ecosystem.config.js" ] || bad "找不到 ops 層共用設定（$id 要用）"
done

if [ "$fail" = 1 ]; then
  echo; echo "✗ 前置檢查沒過，先把上面的 ✗ 修掉再跑。"; exit 1
fi

# ── 2. 註冊表 ───────────────────────────────────────────────────────────────
step "2. 放註冊表到 $REG"
if [ -f "$REG" ] && cmp -s "$HERE/service.json" "$REG"; then
  ok "已經是最新，不用動"
else
  if [ -f "$REG" ]; then
    warn "$REG 已存在且內容不同，會被覆蓋（舊的備份到 ${REG}.bak）"
    run cp "$REG" "${REG}.bak"
  fi
  run cp "$HERE/service.json" "$REG"
  run chmod 644 "$REG"
fi

# ── 3. 各服務 repo：設 upstream + pull ──────────────────────────────────────
# git 失敗只警告不中斷：pm2-start.sh 每次啟動還會再 pull 一次，這裡不是最後機會。
# 輸出收在變數裡，成功印一行、失敗才把原因攤開——否則七個 repo 的 git 噪音會淹掉重點。
step "3. 各服務 repo 設 upstream 並拉最新"
git_try() {
  label="$1"; shift
  if [ "$APPLY" != 1 ]; then echo "   (dry-run) $*"; return 0; fi
  out="$("$@" 2>&1)"
  if [ $? -eq 0 ]; then
    ok "$label"
  else
    warn "$label 失敗 → $(echo "$out" | grep -v "^hint:" | grep -v "^$" | head -1)"
  fi
}

git_try "ops repo 更新" git -C "$OPS_ROOT" pull --ff-only
for d in "$SVC_ROOT"/*/; do
  [ -d "$d.git" ] || continue
  name="$(basename "$d")"
  br="$(git -C "$d" rev-parse --abbrev-ref HEAD 2>/dev/null)"
  if [ -z "$(git -C "$d" rev-parse --abbrev-ref "@{upstream}" 2>/dev/null)" ]; then
    git_try "$name 設 upstream origin/${br}" git -C "$d" branch --set-upstream-to="origin/$br" "$br"
  fi
  git_try "$name pull" git -C "$d" pull --ff-only
done

# ── 4. port 一致性 ──────────────────────────────────────────────────────────
# 設定檔跟著服務 repo 進 git，所以第 3 步的 pull 之後才驗它們在不在。
step "4. pm2 設定檔與 port 檢查"
for pair in $OWN; do
  id="${pair%%:*}"; dir="${pair#*:}"
  [ -f "$SVC_ROOT/$dir/ecosystem.config.js" ] || bad "${id}：缺 $SVC_ROOT/$dir/ecosystem.config.js（repo 沒拉到最新？）"
  if [ -f "$SVC_ROOT/$dir/pm2-start.sh" ]; then
    [ -x "$SVC_ROOT/$dir/pm2-start.sh" ] || run chmod +x "$SVC_ROOT/$dir/pm2-start.sh"
  else
    bad "${id}：缺 $SVC_ROOT/$dir/pm2-start.sh（repo 沒拉到最新？）"
  fi
done
[ "$fail" = 1 ] && { echo; echo "✗ 設定檔沒到位，先把那幾個 repo 拉到最新。"; exit 1; }

for pair in $OWN; do
  id="${pair%%:*}"; dir="${pair#*:}"
  a="$(node -p "const s=require('$HERE/service.json').services.find(x=>x.id==='$id');s?s.port:''" 2>/dev/null)"
  b="$(node -p "require('$SVC_ROOT/$dir/ecosystem.config.js').apps[0].args" 2>/dev/null)"
  if [ "$a" = "$b" ]; then ok "$id → $a"
  else bad "${id}：service.json 寫 $a ，ecosystem.config.js 寫 $b —— 兩邊要一致"; fi
done
dups="$(for pair in $OWN; do node -p "require('$SVC_ROOT/${pair#*:}/ecosystem.config.js').apps[0].args" 2>/dev/null; done | sort | uniq -d)"
[ -n "$dups" ] && bad "有 port 重複：$dups （同一台機器只有第一個起得來）"
if [ "$fail" = 1 ]; then echo; echo "✗ port 有問題，修掉再跑。"; exit 1; fi

# ── 5. 重建 pm2 app ─────────────────────────────────────────────────────────
step "5. 重建 pm2 app"
echo "   （必須 delete 重建：script / interpreter / env / max_memory_restart"
echo "     這些欄位 pm2 只在第一次建立 app 時吃，restart 與 reload 都不會套用新值）"
run pm2 delete all
for pair in $OWN; do
  dir="$SVC_ROOT/${pair#*:}"
  if [ "$APPLY" = 1 ]; then
    echo "   + (cd $dir && pm2 start ecosystem.config.js)"
    ( cd "$dir" && pm2 start ecosystem.config.js )
  else
    echo "   (dry-run) cd $dir && pm2 start ecosystem.config.js"
  fi
done
for id in $FALLBACK; do
  run pm2 start "$OPS_ROOT/deploy/ecosystem.config.js" --only "$id"
done
run pm2 save

# ── 6. 驗收 ─────────────────────────────────────────────────────────────────
step "6. 驗收"
if [ "$APPLY" = 1 ]; then
  pm2 list
  echo
  for pair in $OWN; do
    id="${pair%%:*}"
    port="$(node -p "const s=require('$HERE/service.json').services.find(x=>x.id==='$id');s?s.port:''")"
    code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "http://127.0.0.1:$port/" 2>/dev/null)"
    [ -z "$code" ] && code=000
    case "$code" in
      2*|3*|4*) ok "$id :$port → HTTP $code" ;;
      *)        bad "$id :$port → 連不上（HTTP $code ），看 pm2 logs $id" ;;
    esac
  done
else
  echo "   (dry-run) pm2 list + 逐一 curl 127.0.0.1:<port>"
fi

echo
if [ "$APPLY" = 1 ]; then
  echo "════════════════════════════════════════════════════════"
  echo "還差一件事要你自己做（要 sudo，腳本不代跑）："
  echo
  echo "  pm2 startup     # 執行後照它印出來的那行 sudo 指令貼一次"
  echo "  pm2 save"
  echo
  echo "另外確認 nginx 的 upstream port 跟上面的表一致（要 root）。"
  echo "════════════════════════════════════════════════════════"
  echo
  if [ "$fail" = 1 ]; then
    echo "✗ 有服務沒起來（上面標 ✗ 的那幾個）。"
    echo "  先看 pm2 logs <服務名> --lines 100 找原因，修好後 pm2 restart <服務名>。"
    exit 1
  fi
  echo "✓ 裝完了，七個服務都活著。"
else
  echo "以上是 dry-run。確認沒問題就跑： ./install.sh --apply"
fi
