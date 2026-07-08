# Merge 與上線 Runbook（2026-07 ops 大改版專用）

> 這輪改版動了：ops repo（registry + CLI + docs）、auth（契約 v2）、四個消費端
> （v2 + 安全修正）。**本檔是把這些 PR 安全推上線的一次性完整步驟**——照順序做，
> 每步都可停下來，不會把生態系弄掛。做完後本檔的 §5 之後仍是長期參考（新服務上線）。

## 執行狀態（2026-07-08 更新）

| 步驟 | 狀態 |
| --- | --- |
| §0 Merge、§1 本機 env、§2 主機 git 化、§3 主機 env、§4 form baseline、§5 部署 | ✅ 完成（2026-07-07 上線；07-08 全量重建驗證） |
| §6 appeals 首次上線 | ⏳ 待 root 部員完成 DNS / nginx / DB 前置（清單見該節） |
| §7.1 停發 v1 legacy cookie | ✅ 2026-07-08 完成（主機 `AUTH_ISSUE_LEGACY_COOKIE=0` 已部署） |
| §7.2 消費端移除 v1 fallback 與 legacy env | ⏳ 擇日（不影響運作） |

---

## 0. Merge 順序（GitHub 上）

1. **tpass-ops**（`ops-revamp` 分支）——只影響工具與文檔，最安全，先合。
2. **tpass-auth**（`revamp/contract-v2`）——向後相容：v1 cookie 照發（預設
   `AUTH_ISSUE_LEGACY_COOKIE=1`），舊消費端不受影響。
3. **四個消費端**（各自 `revamp/contract-v2`）——任意順序；它們有 v1 fallback，
   auth 先上就能無縫。
4. 全部 merge 後，各 repo 本機 `git switch main && git pull`。

## 1. 本機 env 補值（merge 後、部署前）

新必填 key（不補的話 `tpass check env` / 服務啟動會明確報缺）：

```bash
# tpass-auth/.env.local 追加：
AUTH_SERVICE_IDS=portal,form,msg,appeals
# （選）AUTH_ISSUE_LEGACY_COOKIE=1   ← 預設就是 1，可不寫

# 每個消費端 .env.local 追加（id 各自換）：
AUTH_AUTHORIZE_URL=https://auth.lvh.me:3000/api/auth/authorize
TPASS_SERVICE_ID=portal   # form / msg / appeals
```

本機驗證：`scripts/tpass check env all` 全綠 → `scripts/tpass dev` →
瀏覽器走一次真人 Google 登入（portal → form 互通）。

## 2. 主機一次性：把 ~/tpass 變成 tpass-ops 的 clone

現況：`~/tpass/` 只是普通目錄（deploy/ 手動拷貝、無版控）。git 化後每次
`tpass deploy` 自動同步 deploy.sh / services.json。**全程不碰 pm2，零停機。**

```bash
# (a) 給主機一把唯讀 deploy key（本機執行；或用 GitHub UI 加）
scripts/ssh.sh 'ssh-keygen -t ed25519 -N "" -f ~/.ssh/tpass_ops_deploy -q; cat ~/.ssh/tpass_ops_deploy.pub'
gh repo deploy-key add <(scripts/ssh.sh 'cat ~/.ssh/tpass_ops_deploy.pub') -R YC815/tpass-ops -t "tpass-host"

# (b) 主機上 git 化（idempotent；服務 repo 被 .gitignore 天然排除）
scripts/ssh.sh '
  cd ~/tpass &&
  git init -b main &&
  git remote add origin git@github.com:YC815/tpass-ops.git &&
  GIT_SSH_COMMAND="ssh -i ~/.ssh/tpass_ops_deploy" git fetch origin &&
  git checkout -f origin/main -- . &&
  git reset origin/main &&
  git branch --set-upstream-to=origin/main main &&
  git config core.sshCommand "ssh -i ~/.ssh/tpass_ops_deploy" &&
  rm -f deploy/deploy.sh.bak.* &&
  git status --short
'
# git status 應該乾淨（服務 repo 全被 ignore）。deploy/host.env 主機端不需要。
```

> 各服務 repo 的 clone 也建議換成各自的唯讀 deploy key（同 (a) 作法），
> 或沿用現有的拉取方式——deploy.sh 只做 `git pull --ff-only`。

## 3. 主機 env 補值

```bash
scripts/ssh.sh   # 進主機後：
# ~/tpass/tpass-auth/.env.local 追加：
#   AUTH_SERVICE_IDS=portal,form,msg,appeals
# 每個消費端 ~/tpass/<dir>/.env.local 追加（網域用正式的）：
#   AUTH_AUTHORIZE_URL=https://auth.tschoolsu.org/api/auth/authorize
#   TPASS_SERVICE_ID=<id>
```

## 4. Prisma baseline 標記（form；一次性，不動資料）

form 從 `db push` 改為正式 migrations。既有的 prod DB 要先告訴 Prisma
「baseline 已套用」：

```bash
scripts/ssh.sh 'cd ~/tpass/tpass-form && set -a && . .env.local && set +a && npx prisma migrate resolve --applied 0_init'
```

（msg 本來就走 migrations，不用動。appeals 尚未上線，首次部署直接 `migrate deploy`。）

## 5. 部署（照順序，每步之間可驗證）

```bash
scripts/tpass deploy auth      # ① auth 先上（v1 照發 + 新增 authorize）
# 驗證：瀏覽器開 https://auth.tschoolsu.org/api/auth/authorize?service=portal&redirect_uri=https://portal.tschoolsu.org/api/auth/callback&next=/
#       未登入應導去 Google；舊服務登入照常運作（v1 cookie 仍在發）。

scripts/tpass deploy portal    # ② 消費端逐一
scripts/tpass deploy form
scripts/tpass deploy msg
# 每上一個就真人走一次登入，確認 v2 cookie（DevTools 看 tpass_token，host-only）生效。

scripts/tpass status           # ③ 總檢查（pm2 全 online）
```

## 6. appeals 首次上線（獨立時程，不急）

> 程式面已就緒（2026-07-08）：repo 預設分支已整理為 `main`（含契約 v2），
> 本機 lint + tsc 全綠。剩下 1–3 需 root / Cloudflare 權限，4–6 部署帳號可做。

1. Cloudflare DNS：`appeals.tschoolsu.org` A record → 主機 IP（灰雲）。
2. [root] nginx server block（port 3004）+ certbot → 切橘雲（`docs/DEPLOY.md §5`）。
3. [root] `sudo -u postgres psql -c "CREATE ROLE t_appeals LOGIN PASSWORD '<強密碼>';"`、
   `CREATE DATABASE t_appeals OWNER t_appeals;`
4. 主機：`git clone <tpass-appeals repo> ~/tpass/tpass-appeals`、建 `.env.local`
   （對照 `.env.example`，正式網域 + 上面的 DATABASE_URL）。
5. tpass-ops：`services.json` 把 appeals 的 `deployed` 改 `true` → commit → merge。
6. `scripts/tpass deploy appeals`（deploy.sh 會自動健康檢查 + `pm2 save`）。

## 7. 收尾（全部消費端 v2 驗證通過後，擇日）

1. auth `.env.local`：`AUTH_ISSUE_LEGACY_COOKIE=0` → `scripts/tpass deploy auth`。
   從此不再發 Domain=.root 的共用 cookie；舊 cookie ≤8h 自然過期。
2. （之後任何時候）消費端移除 v1 fallback 與 `JWT_AUDIENCE` / `TPASS_COOKIE_NAME` env。
3. `docs/SECURITY-REVIEW.md` 把 H1 標記為完全關閉；順手檢查 Cloudflare 有無
   dangling DNS 子網域。

## 人工驗證清單（每次大版部署後）

- [ ] `tpass status`：pm2 全 online、↺ 沒暴增。
- [ ] 真人 Google 登入：portal 登入 → form / msg 都認得（遷移期靠 fallback）。
- [ ] DevTools：登入後有 host-only `tpass_token`（新）；登出後兩顆 cookie 都消失。
- [ ] 錯誤票測試：拿 portal 的 token 打 form 的 callback 應 401（aud 隔離生效）。
- [ ] 問卷匿名/上傳、msg 廣播、appeals 提交各走一次。
