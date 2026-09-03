#!/usr/bin/env bash
# pm2 每次 start / restart / reload 的實際入口：
#   git pull → HEAD 變了才 build → exec next start
# 由同層的 ecosystem.config.js 呼叫，不要手打。
#
# ⚠️ 這不是部署管道。正式換版本仍然只有一條路：本機 `tpass deploy <svc>`
#    （它會 pull + install + 套 schema + build + reload + 健康檢查）。
#    這支負責的是「主機重開機 / pm2 resurrect 之後，工作區與 build 跟 origin 一致」。
#
# 不用 set -e：任何一步失敗都不該讓服務起不來——沿用現有工作區、退回上一版 build
# 繼續跑，比整個服務消失好。
set -uo pipefail

cd "$(dirname "$0")" || exit 1
PORT="${1:-3000}"
say() { echo "[pm2-start] $*"; }

# pm2 從開機自啟（pm2 resurrect）起來時環境很貧瘠，pnpm / node 不一定在 PATH 上。
# 一律「補在後面」：前置會蓋掉正常環境裡的 node（實測過——/usr/local/bin 的舊 node
# 搶先，pnpm 直接因 Node 版本太舊噴 SyntaxError）。
export PATH="$PATH:$HOME/.local/share/pnpm:$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin"

# ── 1. git pull ────────────────────────────────────────────────────────────
before=""
after=""
if [ -d .git ]; then
  before="$(git rev-parse HEAD 2>/dev/null)" || before=""
fi

if [ -n "$before" ]; then
  # --ff-only：主機上的工作區只該是 origin 的鏡像。分岔就大聲失敗，
  # 不要自動 merge 出一個沒人 review 過的狀態。
  if git pull --ff-only --quiet; then
    after="$(git rev-parse HEAD)"
  else
    say "git pull 失敗（網路斷 / 工作區髒 / 分支分岔），沿用現有工作區"
    after="$before"
  fi
else
  say "不是 git repo，跳過 pull"
fi

# ── 2. 有新 commit 才 build ────────────────────────────────────────────────
if [ -n "$after" ] && [ "$after" != "$before" ]; then
  say "$(git rev-parse --short "$before") → $(git rev-parse --short "$after")，需要重新 build"

  if ! command -v pnpm >/dev/null 2>&1; then
    say "⚠️ 找不到 pnpm，跳過 install/build，用現有 .next 啟動"
  else
    # lockfile 動過才 install：install 比 build 更慢，也更容易半途壞掉。
    if git diff --name-only "$before" "$after" | grep -q '^pnpm-lock\.yaml$'; then
      say "pnpm-lock.yaml 有變 → pnpm install --frozen-lockfile"
      pnpm install --frozen-lockfile || say "⚠️ install 失敗，沿用現有 node_modules"
    fi

    # 先把上一版 .next 挪開：next build 失敗會在原地留下半成品，沒有備份就沒有
    # 「退回舊版」可退。代價是丟掉 .next/cache 的 incremental 快取（build 變慢），
    # 換 build 失敗時服務還起得來——這筆划算。
    rm -rf .next.prev
    [ -d .next ] && mv .next .next.prev

    # build 吃的記憶體遠超過 serve 時的 384 MB 上限，這裡覆蓋掉 ecosystem 注入的
    # NODE_OPTIONS，否則 next build 幾乎必定 OOM。
    if NODE_OPTIONS="--max-old-space-size=1536" pnpm build; then
      rm -rf .next.prev
      say "build 成功"
    else
      say "⚠️ build 失敗 → 回滾到上一版 .next（工作區的 code 已是新版，但跑的是舊 build）"
      rm -rf .next
      [ -d .next.prev ] && mv .next.prev .next
    fi
  fi
else
  say "HEAD 未變${after:+（$(git rev-parse --short "$after")）}，跳過 build"
fi

# ── 3. 啟動 ────────────────────────────────────────────────────────────────
NEXT="./node_modules/next/dist/bin/next"
if [ ! -x "$NEXT" ]; then
  say "找不到 ${NEXT}——這個 repo 還沒 pnpm install 過"
  exit 1
fi
if [ ! -d .next ]; then
  say "沒有 .next——這個 repo 還沒 build 過，先跑一次 pnpm build"
  exit 1
fi

# exec：行程 image 被換掉但 PID 不變，pm2 的 max_memory_restart 與 kill_timeout（SIGINT）
# 才會打在真正的 node 上，而不是一個已經結束的 bash。
say "next start -H 127.0.0.1 -p $PORT"
exec "$NEXT" start -H 127.0.0.1 -p "$PORT"
