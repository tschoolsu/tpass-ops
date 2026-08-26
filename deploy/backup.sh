#!/usr/bin/env bash
# 伺服器上的每日備份腳本。放在 ~/tpass/deploy/（與 deploy.sh 同層，同樣的路徑約定）。
#
# 備份什麼（全部從 ../tpass-registry/services.json 派生，不得在此硬編碼服務名）：
#   1. 每個 enabled 且 db != null 的服務 → pg_dump（custom format，已壓縮）
#   2. 每個 enabled 服務的 <dir>/data/ 目錄（存在且非空才打包）
#      ——這是通用規則不是為某個服務開的特例：任何把狀態寫在 data/ 的服務都自動被涵蓋。
#
# 為什麼用各服務 .env.local 的連線字串而不是 peer auth：部署帳號的 PG role 有
# CREATEDB/CREATEROLE 但不是 superuser，直接 `pg_dump t_form` 會是 permission denied。
#
# 送到哪：rclone remote（BACKUP_REMOTE，設在 gitignored 的 deploy/backup.env）。
# 目的地無關——換 R2 / S3 / B2 只改那一行設定，不改這支腳本。
#
# 失敗怎麼辦：任何一步失敗 → Discord webhook + 非零退出。
# 「安靜地少備份一個庫」是最危險的失敗模式，所以只有「主機上根本沒有這個服務」才 skip。
#
# 用法： backup.sh [--dry-run]
set -euo pipefail
set -o errtrace   # ERR trap 要能在函式內觸發

# cron 的 PATH 不含 ~/.local/bin（rclone 裝在那裡，無 root 安裝）。這是 cron 最常見的死法。
export PATH="$HOME/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(dirname "$SCRIPT_DIR")"
REG="$ROOT/tpass-registry/services.json"
CONF="$SCRIPT_DIR/backup.env"
STATUS_FILE="$HOME/.tpass-backup-status"
LOG="$HOME/tpass-backup.log"

DRY_RUN=0
[ "${1:-}" = "--dry-run" ] && DRY_RUN=1

# log 自我截斷（logrotate 要 root）。就地覆寫同一個 inode，cron 的 >> fd 才不會寫到孤兒檔。
if [ -f "$LOG" ] && [ "$(wc -l < "$LOG")" -gt 4000 ]; then
  printf '%s\n' "$(tail -n 2000 "$LOG")" > "$LOG"
fi

[ -f "$REG" ] || { echo "❌ 找不到 $REG" >&2; exit 1; }
[ -f "$CONF" ] || {
  echo "❌ 缺 $CONF —— cp deploy/backup.env.example deploy/backup.env 並填值（不進 git）" >&2
  exit 1
}
# backup.env 的格式由我們自己控制（只有兩個無空白的值），source 是安全的。
# shellcheck source=/dev/null
. "$CONF"
BACKUP_REMOTE="${BACKUP_REMOTE:-}"
BACKUP_DISCORD_WEBHOOK="${BACKUP_DISCORD_WEBHOOK:-}"
KEEP_DAILY="${BACKUP_KEEP_DAILY:-7d}"
KEEP_WEEKLY="${BACKUP_KEEP_WEEKLY:-28d}"
[ -n "$BACKUP_REMOTE" ] || { echo "❌ $CONF 缺 BACKUP_REMOTE" >&2; exit 1; }

command -v rclone >/dev/null 2>&1 || {
  echo "❌ 找不到 rclone。主機一次性安裝（無 root，主機沒有 unzip 所以用 python3 解壓）：" >&2
  echo "   curl -fsSL https://downloads.rclone.org/rclone-current-linux-amd64.zip -o /tmp/rclone.zip" >&2
  echo "   mkdir -p ~/.local/bin && python3 -m zipfile -e /tmp/rclone.zip /tmp/rclone-x" >&2
  echo "   mv /tmp/rclone-x/*/rclone ~/.local/bin/ && chmod +x ~/.local/bin/rclone" >&2
  exit 1
}

# 服務 repo 的家（與 deploy.sh 同一段邏輯，唯一真相 = registry 的 server.servicesRoot）
SVC_ROOT="$(node -p "
const r = require('$REG');
const p = (r.server && r.server.servicesRoot) || '';
p.startsWith('~/') ? require('path').join(require('os').homedir(), p.slice(2)) : (p || '$ROOT')
")"
[ -d "$SVC_ROOT" ] || { echo "❌ 服務根目錄 $SVC_ROOT 不存在" >&2; exit 1; }

# 註冊表查詢（node 一定在——主機本來就跑 Next）。刻意不 pull tpass-registry：
# 備份要用的是「主機此刻實際部署的樣子」，不是 main 的最新版；而且沒網路時也該備得起來。
db_rows()  { node -p "require('$REG').services.filter(s=>s.enabled&&s.db).map(s=>[s.id,s.dir,s.db.name].join('|')).join('\n')"; }
svc_rows() { node -p "require('$REG').services.filter(s=>s.enabled).map(s=>[s.id,s.dir].join('|')).join('\n')"; }

STAMP="$(date +%F)"
TS="$(date -Is)"
TMP="$(mktemp -d)"
STEP="啟動"
trap 'rm -rf "$TMP"' EXIT

notify_fail() {
  rc="$1"
  msg="🔴 **T-Pass 備份失敗**（$(hostname)）
時間：$TS
卡在：$STEP（exit $rc）
最後幾行 log：
\`\`\`
$(tail -n 15 "$LOG" 2>/dev/null || echo '（無 log）')
\`\`\`
排查：\`tpass logs\` 不管用，這支是 cron 跑的 → ssh 進主機看 $LOG"
  if [ -n "$BACKUP_DISCORD_WEBHOOK" ]; then
    jq -n --arg c "$msg" '{content:$c}' \
      | curl -sS -m 15 -X POST -H 'Content-Type: application/json' -d @- "$BACKUP_DISCORD_WEBHOOK" >/dev/null \
      || echo "⚠️  Discord 通知也失敗了" >&2
  fi
  echo "❌ 備份失敗於：$STEP" >&2
}
trap 'rc=$?; notify_fail "$rc"; exit "$rc"' ERR

echo "==================== 備份 $TS ===================="
[ "$DRY_RUN" = "1" ] && echo "（--dry-run：只 dump 到本機暫存，不上傳、不刪舊檔）"
echo "暫存：$TMP"

# ---------- 1. 資料庫 ----------
SKIPPED=""
DUMPED=0
while IFS='|' read -r id dir dbname; do
  [ -n "$id" ] || continue
  envfile="$SVC_ROOT/$dir/.env.local"
  if [ ! -f "$envfile" ]; then
    SKIPPED="$SKIPPED
  - $id：主機上沒有 $dir/.env.local（未部署）"
    continue
  fi
  # 不用 `. .env.local` —— 值含空白又沒加引號會炸（ONBOARDING 疑難排解表已有這一列），
  # 而 notes 那份 .env.local 是 root 寫的，格式不受我們控制。逐行抽單一 key 最安全。
  # key 名不統一：Prisma 服務是 DATABASE_URL，notes（db.strategy:"none"）是 POSTGRES_URL。
  url=""
  for key in DATABASE_URL POSTGRES_URL; do
    v="$(grep -m1 "^[[:space:]]*$key=" "$envfile" 2>/dev/null | cut -d= -f2- | sed -e 's/^["'"'"']//' -e 's/["'"'"']$//')" || true
    if [ -n "$v" ]; then url="$v"; break; fi
  done
  if [ -z "$url" ]; then
    STEP="讀 $id 的連線字串"
    echo "❌ $envfile 裡找不到 DATABASE_URL 或 POSTGRES_URL" >&2
    exit 1
  fi
  STEP="pg_dump $id（$dbname）"
  echo "-- $STEP"
  # --no-owner --no-privileges：還原到別台機器（例如驗證用的 Docker）時不需要相同的 role 存在。
  # --format=custom 本身已壓縮，不再另外 gzip。
  pg_dump --format=custom --no-owner --no-privileges --dbname="$url" --file="$TMP/$id-$dbname.dump"
  [ -s "$TMP/$id-$dbname.dump" ] || { echo "❌ $id 的 dump 是空檔" >&2; exit 1; }
  echo "   $(du -h "$TMP/$id-$dbname.dump" | cut -f1)"
  DUMPED=$((DUMPED + 1))
done <<EOF
$(db_rows)
EOF

# ---------- 2. 檔案狀態（<dir>/data/）----------
FILES=0
while IFS='|' read -r id dir; do
  [ -n "$id" ] || continue
  d="$SVC_ROOT/$dir/data"
  [ -d "$d" ] || continue
  [ -n "$(ls -A "$d" 2>/dev/null | grep -v '^\.gitkeep$' || true)" ] || continue
  STEP="打包 $id 的 data/"
  echo "-- $STEP"
  tar czf "$TMP/$id-data.tar.gz" -C "$SVC_ROOT/$dir" data
  echo "   $(du -h "$TMP/$id-data.tar.gz" | cut -f1)"
  FILES=$((FILES + 1))
done <<EOF
$(svc_rows)
EOF

[ "$DUMPED" -gt 0 ] || { STEP="檢查備份內容"; echo "❌ 一個資料庫都沒備到" >&2; exit 1; }

# ---------- 3. MANIFEST ----------
STEP="寫 MANIFEST"
# 先算好雜湊再寫檔 —— 直接在重導向區塊裡跑 sha256sum 會把「寫到一半的 MANIFEST 自己」
# 也算進去，那個數字永遠對不起來，反而讓驗證的人以為檔案壞了。
SUMS="$(cd "$TMP" && sha256sum -- *)"
{
  echo "backup:     $TS"
  echo "host:       $(hostname)"
  echo "ops-commit: $(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || echo '?')"
  echo "databases:  $DUMPED    data-archives: $FILES"
  echo
  echo "$SUMS"
  if [ -n "$SKIPPED" ]; then
    echo
    echo "skipped:$SKIPPED"
  fi
} > "$TMP/MANIFEST.txt"

TOTAL="$(du -sb "$TMP" | cut -f1)"
echo "-- 共 $DUMPED 個資料庫 + $FILES 份 data/，$(du -sh "$TMP" | cut -f1)"
[ -n "$SKIPPED" ] && echo "-- 略過（主機上沒有）：$SKIPPED"

if [ "$DRY_RUN" = "1" ]; then
  echo "✅ dry-run 完成（沒有上傳）"
  exit 0
fi

# ---------- 4. 上傳 ----------
# --drive-use-trash=false：Google Drive 預設刪到垃圾桶，仍然佔配額。其他 backend 忽略此旗標。
RCLONE_FLAGS=(--drive-use-trash=false --stats-one-line --stats=0)
STEP="上傳到 $BACKUP_REMOTE/daily/$STAMP"
echo "-- $STEP"
rclone copy "$TMP" "$BACKUP_REMOTE/daily/$STAMP" "${RCLONE_FLAGS[@]}"

if [ "$(date +%u)" = "7" ]; then
  STEP="上傳週備份 $BACKUP_REMOTE/weekly/$STAMP"
  echo "-- $STEP"
  rclone copy "$TMP" "$BACKUP_REMOTE/weekly/$STAMP" "${RCLONE_FLAGS[@]}"
fi

# ---------- 5. 保留策略 ----------
# 一天一次 → --min-age 7d 等於留 7 份日備、28d 留 4 份週備。
# 清理失敗不該讓整次備份算失敗（檔案已經安全上去了），所以只警告。
STEP="清理過期備份"
echo "-- $STEP（日備 >$KEEP_DAILY、週備 >$KEEP_WEEKLY）"
for kind in daily weekly; do
  case "$kind" in
    daily)  age="$KEEP_DAILY" ;;
    weekly) age="$KEEP_WEEKLY" ;;
  esac
  # weekly/ 要等第一個星期天才存在。對不存在的目錄跑 delete 會噴三行紅字 ——
  # 每天噴的假警報會讓人停止看告警，所以先確認目錄在不在。
  rclone lsf "$BACKUP_REMOTE/$kind" >/dev/null 2>&1 || continue
  {
    rclone delete "$BACKUP_REMOTE/$kind" --min-age "$age" "${RCLONE_FLAGS[@]}" &&
    rclone rmdirs "$BACKUP_REMOTE/$kind" --leave-root
  } || echo "⚠️  清理 $kind 失敗（本次備份本身已上傳成功）" >&2
done

# ---------- 6. 狀態檔 ----------
# Discord 只能告訴你「跑了但失敗」。「cron 根本沒觸發」它不會響——這個檔案就是第二道防線，
# tpass status 會讀它並顯示「最後備份：X 小時前」。
STEP="寫狀態檔"
jq -n \
  --arg at "$TS" \
  --arg remote "$BACKUP_REMOTE/daily/$STAMP" \
  --argjson databases "$DUMPED" \
  --argjson archives "$FILES" \
  --argjson bytes "$TOTAL" \
  '{at:$at, remote:$remote, databases:$databases, archives:$archives, bytes:$bytes}' \
  > "$STATUS_FILE"

echo "✅ 備份完成 → $BACKUP_REMOTE/daily/$STAMP"
