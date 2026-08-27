# TSchool 開發與維運手冊

> **給誰讀**：要在 TSchool 數位服務平台上開發、部署、顧機器的人。
> **這份文件是自給自足的**——所有指令、主機拓樸、排錯步驟都寫在裡面，不需要翻其他文件。
>
> 想「開一個新服務並串登入」→ 看另一份《TSchool 新服務串接指南》。

---

## 0. 你是哪一種人？

**先確認你需不需要這份文件。**

| 你的情況 | 看哪裡 |
| --- | --- |
| 我要開發一個服務（寫 code、串登入、把它上線） | **《TSchool 新服務串接指南》**。那份是自給自足的：只用原生 `pnpm` / `ssh`，**不需要 ops repo，也不需要 `tpass`**。你不必讀這份 |
| 我要顧整個生態系（管註冊表、開新子網域、部署別人的服務、看機器） | **這份**。你會拿到 ops repo（`tpass-ops`），裡面有 `tpass` 遙控器 |

> ### `tpass` 不是規定，是遙控器
>
> `scripts/tpass` 是給**同時顧五六個服務**的人用的省時工具——它會一次對所有 repo 做事，
> 而且知道主機在哪（位址存在 gitignored 的 `deploy/host.env`）。
>
> **它底下沒有任何魔法。** 每一個指令都對應得到你自己打得出來的原生指令（見下表）。
> 部員不用它、不知道它存在，一樣能把服務寫完、測完、上線。**這是刻意的**——
> 工具鏈不該是入門的門檻。

### tpass 指令 ↔ 它其實在做什麼

左邊是遙控器，右邊是它按下去的東西。**右邊才是真相**；不確定 tpass 幹了什麼，就看右邊。

| `tpass` 指令 | 等價的原生指令 |
| --- | --- |
| `tpass dev <svc>` | `next dev --experimental-https --experimental-https-{key,cert} certs/… -H <svc>.lvh.me -p <port>`（消費端另加 `NODE_TLS_REJECT_UNAUTHORIZED=0`，見下方⚠️） |
| `tpass check <svc>` | `pnpm lint` && `pnpm exec tsc --noEmit` ← **就這兩行,沒別的** |
| `tpass check env <svc>` | 比對 `.env.local` 與該 repo `src/config/*.ts` 的 `REQUIRED` 陣列 |
| `tpass build <svc>` | `pnpm build` |
| `tpass start <svc>` | `pnpm build` && `pnpm start:https` |
| `tpass setup` | `mkcert -install` → 產憑證到 `certs/` → 各 repo `pnpm install` → `node scripts/gen-keys.mjs` → 建本機 DB |
| `tpass db setup <svc>` | `createuser` / `createdb` → 寫 `DATABASE_URL` → `pnpm exec prisma generate` + 套 schema |
| `tpass deploy <svc>` | `ssh <主機> 'cd ~/tpass && git pull --ff-only && ./deploy/deploy.sh <svc>'` |
| `tpass logs <svc>` | `ssh <主機> 'pm2 logs <svc> --lines 100'` |
| `tpass status` | 本機 port 探測 + `ssh <主機> 'pm2 jlist'` + 各 repo `HEAD` vs `origin/main` |
| `tpass env get <svc>` | `ssh <主機> 'cat /home/service/<dir>/.env.local'`（密文預設遮罩，`--show` 顯示） |
| `tpass env set <svc> K=V` | 單鍵 upsert 主機 `/home/service/<dir>/.env.local`（值走 stdin，不進 argv） |
| `tpass env unset <svc> K` | 移除主機 `.env.local` 的一個 key |
| `tpass db create <svc>` | `ssh <主機> 'createuser / createdb'` + 寫入遠端 `DATABASE_URL`（見 §4.2） |
| `tpass new <id>` | 寫一筆進 `tpass-registry/services.json` + 印出需要 root 的人工步驟（**PR 仍要自己開**） |
| `tpass list` / `tpass ui` | 讀 `tpass-registry/services.json` 印出來 / 開瀏覽器儀表板 |

不帶參數直接打 `scripts/tpass` 會跳互動選單。

> ⚠️ **本機 dev 那個 `NODE_TLS_REJECT_UNAUTHORIZED=0` 不是隨便加的。**
> Next（Turbopack）server 端的 fetch（undici）**不吃 `NODE_EXTRA_CA_CERTS`**，所以消費端後端
> 去抓 auth 的 JWKS 公鑰時**不信任 mkcert 簽的憑證** → 驗章默默失敗 → **登入完馬上被踢回登入頁，
> 而且沒有錯誤訊息**。這是本專案最貴的一個坑。
> 規則：**只有本機、只有消費端**能關。auth 不能關（它要驗 Google 的真憑證），
> 主機不能關（走真憑證，關掉就是資安事故）。

### 角色分工

主機上的**部署帳號給部員用時視同沒有 root**（維運者本人有 sudo，需打登入密碼；agent 代跑不了，
需要 root 的指令一律印出來交給人在主機貼）。

| 角色 | 能做 | 不能做 |
| --- | --- | --- |
| 部員（服務開發者） | 自己的 repo、對 `tpass-registry` 開 PR、ssh 進主機部署自己的服務、pm2 | nginx、TLS 憑證、建 PostgreSQL role/db、系統套件、**merge registry PR** |
| 維運（顧生態系） | 上面全部 + ops repo + `tpass` + merge registry PR | 同上（除非他也有 root） |
| 有 root 的維運 | nginx vhost、certbot、Cloudflare DNS、`sudo -u postgres psql` | —— |

需要 root 的操作，**停下來把指令交給有 root 的人**。

---

## 1. 服務清單（`tpass-registry` = 唯一真相）

服務清單住在**並排的公開 repo** `tschoolsu/tpass-registry` 的 `services.json`。從它派生的東西有四樣：

| 消費者 | 派生出什麼 |
| --- | --- |
| `tpass-auth` | 可以發證的服務白名單（build 時讀 `../tpass-registry/services.json`） |
| `tpass-portal` | 大廳卡片：顯示名、圖示、配色、網址（同上，build 時讀） |
| `deploy/ecosystem.config.js` | pm2 的 app 清單（只取 `deployed:true`） |
| `deploy/deploy.sh`、`scripts/tpass` | 目錄、port、DB 策略 |

**不要在任何地方另外硬編碼這些資訊**——包括不要在這份文件裡再抄一張服務表。
現在有哪些服務、port 是多少，一律以 `cat ~/tpass/tpass-registry/services.json` 或 `scripts/tpass list` 為準。

因為 auth 與 portal 是在 **build 時**把註冊表烤進去的，所以 registry merge 之後**必須重新部署這兩個**才會生效。`deploy.sh` 每次執行都會先 `git pull` 註冊表，所以主機永遠只認 `tpass-registry` main 的最新版。

**每個服務是一個獨立的 git repo**（不是 monorepo）。頂層 `tschool/` 本身也是一個 repo（`tpass-ops`），只追蹤維運層：`scripts/`、`deploy/`、`docs/`。

git repos（全部在 GitHub 的 **`tschoolsu` 組織**底下，2026-08-01 核對）：

- **private**：`tpass-ops`（頂層）——**唯一一個私有的**
- **public**：`tpass-registry`（服務註冊表，部員 fork + PR 的地方）、`tpass-auth`、`tpass-portal`、`tpass-form`、`tpass-cross_grade_messages`、`tpass-appeals`
- **還沒有 GitHub repo**：`tpass-vote`（只在本機，有 commit 但無 remote）、`tpass-directory`（本機封存）

> ⚠️ 五個服務 repo 是 **public**。若這不是刻意的，要儘早改——公開的是原始碼與 `.env.example`，
> 真值都在各機器的 `.env.local`（不進 git），但公開範圍應該是有意識的決定，不是預設值。

> 🚫 **鐵律**：頂層 ops repo 絕對不要 `git add` 服務子 repo、`tpass-registry/`、`deploy/host.env`、`certs/`。機密與服務程式碼都不進 ops repo。
>
> 🚫 **`tpass-registry` 是公開的**：那裡面永遠不該出現任何密鑰、密碼或主機位址。

---

## 2. 一次性環境準備

前置（macOS）：

```bash
brew install mkcert nss node pnpm postgresql@17
brew services start postgresql@17
```

然後：

```bash
scripts/tpass setup
```

它會做：信任 mkcert 根憑證 → 產出涵蓋所有服務子網域的憑證到 `certs/` → 所有服務 `pnpm install` → 印出 EdDSA 金鑰對 → 對有 DB 的服務跑 `tpass db setup`（建 role + database、補 `DATABASE_URL`、prisma generate + migrate）。

> `auth` 現在也有 DB（`t_auth`，Prisma：`Subject`/`Grant`/`AuditLog`——存權限真相，供 `/admin`
> panel 與簽章路徑查詢）。跟其他服務走同一套：`tpass setup` 或單獨 `tpass db setup auth` 都會
> 建 role/db、跑 migrate，本機不需要額外步驟。

**接著手動做一次**：每個 repo `cp .env.example .env.local` 並填入真值（金鑰貼進 auth 的那份）。

- `.env.example` 裡是**占位值**，金鑰 / Google OAuth / DB 密碼都要換成真的。
- 「哪些 env 是必填」的真相 = 各 repo `src/config/*.ts` 裡的 `REQUIRED` 陣列。
- 隨時可用 `scripts/tpass check env` 驗證有沒有漏。

常見雷：

| 症狀 | 解法 |
| --- | --- |
| Postgres 沒起來 | `brew services start postgresql@17`（`tpass db setup` 也會自動嘗試） |
| 瀏覽器不信任憑證 | 重跑 `scripts/tpass setup`（會重跑 `mkcert -install`） |
| 服務啟動就報缺 env | 照 `.env.example` 補齊；`tpass check env <svc>` 會列出缺哪些 |

---

## 3. 日常開發

```bash
scripts/tpass dev          # 全部服務一起跑（測 SSO 互通最方便）
scripts/tpass dev form     # 只跑一個
```

- 全部走 HTTPS + `*.lvh.me`。`lvh.me` 由公共 DNS 直接解析到 `127.0.0.1`，**不用改 `/etc/hosts`**。
- 本機與正式環境**邏輯完全相同，只差 env 的值與啟動方式**。

**不想用 tpass？** 一個服務開一個終端機，在該 repo 打 `pnpm dev` 就好——

```bash
cd tpass-auth && pnpm dev      # 終端機 1
cd tpass-form && pnpm dev      # 終端機 2
```

因為**正確的那串已經寫死在各服務的 `package.json` 裡了**（HTTPS + 正確的 `-H` 與 `-p`
+ 消費端的 `NODE_TLS_REJECT_UNAUTHORIZED=0`）。`tpass dev` 只是幫你把這幾個一次平行起起來。

> 📁 **憑證路徑全生態統一在 `$HOME/tpass-certs`**——那是部員版的路徑（他們沒有 ops repo）。
> `tpass setup` 會自動把 `~/tpass-certs` symlink 到 ops 的 `certs/`，所以你這邊也通。
> 這樣文件與 `package.json` 不用分兩種寫法。

### push 前把關

```bash
pnpm lint              # 這兩行才是真相
pnpm exec tsc --noEmit
```

全綠才 push。要一次掃過所有 repo 就用 `scripts/tpass check`（它做的就是上面兩行）。

```bash
scripts/tpass check env    # .env.local 必填 key 驗證
scripts/tpass start        # 大改動再跑：build + start（抓 dev 抓不到的 build 期問題）
```

自動檢查之外，**動到登入相關的東西時要真人驗證**（Google 登入不能自動化，也不准嘗試自動化——會被 Google 擋且違反條款）：

- [ ] `tpass dev` 起全部 → 在 portal 登入 → 開 form / msg / appeals，應該直接認得你，不用重登。
- [ ] DevTools → Application → Cookies：每個服務網域各有一顆自己的 `tpass_token`，且 **Domain 欄沒有前導點**（host-only）。
- [ ] 在任一服務登出 → 該服務的 cookie 消失。

**流程**：各服務 repo 開分支 → push → GitHub PR → merge 到 main。**不直接 push main。**

---

## 4. 部署

### 首選：GitHub Actions（不需要主機憑證）

**[tpass-ops → Actions → deploy → Run workflow](https://github.com/tschoolsu/tpass-ops/actions/workflows/deploy.yml)**，
在輸入框打服務 id 就好：

| 輸入 | 做什麼 |
| --- | --- |
| `all`（預設） | 註冊表裡所有 `deployed:true` 的服務 |
| `form` / `buddy` / … | 單一服務 |
| `ping` | **不部署**，只回答「CI 那把金鑰還連得上主機嗎」 |

合法的 id 是**現場去抓 `tpass-registry/services.json` 算出來的**，不寫死在 workflow 裡
——新服務上線時這個檔案一行都不用改。打錯會在幾秒內紅燈並印出可用清單。

**任何有 `tpass-ops` 寫入權的人都能按**，不必拿到主機位址、帳號或任何金鑰。
每次執行的 log 裡有 `📌 部署版本：<sha> <commit 標題>`，那份紀錄本身就是稽核軌跡。
同一時間只允許一個部署在跑（`concurrency`），兩個人同時按不會在主機上互相踩。

> ⚠️ **`tpass-ops` 是 public repo，Actions 的 log 也是公開的。**
> 主機位址 / 帳號 / 金鑰全部走 GitHub Secrets，值在 log 裡自動被遮成 `***`。
> 之後往 `deploy.sh` 加任何 `echo` 時，記得它會被全世界看到。

**它是怎麼運作的**（三個檔案，沒有別的）：

1. `.github/workflows/deploy.yml` — 在 GitHub 借來的臨時 Linux 上跑，
   從 Secrets 佈好 SSH 金鑰，然後 `ssh <主機> "<服務 id>"`。
2. 主機 `~/.ssh/authorized_keys` 裡 CI 那把金鑰前面掛了
   `command="~/tpass/deploy/ci-deploy.sh",restrict` — **強制命令**：
   送什麼指令過來 sshd 都丟掉，一律改跑那支包裝層，原字串塞進 `$SSH_ORIGINAL_COMMAND`。
3. `deploy/ci-deploy.sh` — 把那個字串當服務 id 白名單過濾（`^[a-z0-9_-]+$`），
   然後 `git pull` + `./deploy/deploy.sh <svc>`。跟本機 `tpass deploy` 是同一條路。

所以 **「有 repo 寫入權」＝「能按部署」，不等於「主機上那個帳號的 shell」**。
拿到那把私鑰也開不了互動 shell、跑不了任意指令。

**CI 金鑰是獨立的一把**（`github-actions-deploy`），不是任何人本人那把
——撤銷 CI 權限只要刪掉 `authorized_keys` 裡那一行，不影響個人連線。
私鑰只存在 GitHub Secrets，**讀不回來**；要換就重產一把、重設 secret、重寫那一行。

### 逃生路徑：本機直連

GitHub 掛了、Actions 壞了、或你就是想看即時輸出：

```bash
scripts/tpass deploy form   # 單一服務
scripts/tpass deploy        # 全部（registry 裡 deployed:true 的）
```

**手動等價（部員就是這樣做的，效果一模一樣）**——真正的部署腳本 `deploy.sh` **住在主機上**：

```bash
ssh <帳號>@<主機>                     # 位址與帳號絕不進 git
cd ~/tpass && git pull --ff-only      # 更新 ops（deploy.sh 本身吃最新 main）
./deploy/deploy.sh form               # 或 all；註冊表由 deploy.sh 自己 pull
```

`tpass deploy` 就只是幫你打這三行。

### 主機端每次部署做什麼

`deploy.sh` 在主機上跑，但**觸發永遠來自 ssh**——主機上不裝任何遠端部署工具（效能預算留給產品本身）。主機只有 ssh + git + node + pnpm + pm2 + nginx + PostgreSQL。

> pnpm 在主機上是 **standalone 安裝**（部署帳號無 root）：
> `curl -fsSL https://get.pnpm.io/install.sh | env PNPM_VERSION=10.27.0 sh -`（裝到 `~/.local/share/pnpm`）。
> 非互動 ssh 不會 source `.bashrc`，所以 `deploy.sh` 自己把 `$PNPM_HOME` 加進 PATH，找不到會直接報錯並印出安裝指令。

每一步失敗都會中止並印出明確錯誤：

1. ops repo `git pull` 自我更新（部署腳本永遠吃最新 main）。
2. **註冊表 `git pull` + 驗證**（`tpass-registry` 永遠吃最新 main；驗證不過就中止，不拿壞掉的清單去部署）。
3. 服務 repo `git pull --ff-only`。
4. **env 必填檢查**——解析該 repo `src/config/*.ts` 的 `REQUIRED`，缺 key 在 build 前就擋下並印出缺哪些。
5. `pnpm-lock.yaml` 有變才 `pnpm install --frozen-lockfile`（沒變就跳過，快很多）。
   `node_modules` 不是 pnpm 裝的（首次部署、或 npm 時代的舊裝）也會強制重裝——舊的先備份成 `node_modules.npm-bak`。
6. `prisma generate`（有 DB 的服務；`pnpm exec`，只用鎖定版本，不會抓最新）。
7. `pnpm build`。
8. 套 DB schema：依註冊表的 `db.strategy` 跑 `prisma migrate deploy`（標準）或 `prisma db push`（僅限原型）。
9. `pm2 startOrReload`——既有服務零停機 reload；註冊表新增的服務會自動首次啟動。
10. **健康檢查**：對服務 port 打 HTTP，30 秒內拿到 <500 回應才算成功（app 起不來不會拿到假的 ✅）。
11. 全部成功後 `pm2 save`（主機重開機後 resurrect 的就是最後一次成功部署的清單）。

### rollback

不需要特殊機制：在服務 repo `git revert` 出一個新 commit → merge main → `tpass deploy <svc>`。

build 失敗時舊版行程**不受影響**（reload 只在 build 成功之後才發生）。

> ⚠️ **這只救程式碼，不救資料。** 第 8 步的 `prisma migrate deploy` 是對正式庫直接動手的——
> migration 砍掉一個欄位，那個欄位的資料就永久沒了，revert 也長不回來。
> 砍欄位 / 改型別的 migration 上線前，先手動備一次：`tpass backup run`（見 §6.1）。

### 4.1 改主機的 env（不需 root）

本機與主機的值本來就不同（正式網域、正式金鑰、正式 `DATABASE_URL`）。`.env.local` 是**部署帳號自己擁有**的檔（`/home/service/<dir>/.env.local`），改它不需要 root：

```bash
tpass env get <svc>            # 看主機的值，密文預設遮罩
tpass env get <svc> --show     # 顯示密文
tpass env set <svc> KEY=VALUE  # 單鍵 upsert：只碰目標行，其餘含註解 byte 不動
tpass env unset <svc> KEY      # 移除一個 key
```

改完**要 `tpass deploy <svc>` 才會套用**（Next 在 build/啟動時讀 env）。

- 值走 **stdin**，不進 `argv`（主機上 `ps` 看不到）、不進 git、不回瀏覽器。
- 寫入是原子的（tmp → mv），中斷不會留下半個檔。

> [!IMPORTANT]
> **值含空白時務必加引號。** `deploy.sh` 會用 shell `source` 匯入 `.env.local`，未加引號的空白會讓該行被當成指令執行，部署中止且錯誤訊息（`command not found`）指不到真正原因。
> 2026-08-01 就因為 `AUTH_SUPERADMINS=a@x.com, b@y.com` 少了引號，auth 部署中斷過一次。

等價原生指令：`ssh <主機> 'vi /home/service/<dir>/.env.local'`——`tpass env` 只是讓你不必進主機、且避免手滑改到別行。

### 4.2 在主機建資料庫（一次性 root 授權後免 root）

```bash
tpass db create <svc>          # 建 role+db（冪等）、生成隨機密碼、寫進遠端 DATABASE_URL
```

只建**空庫** + 寫連線字串；schema 仍由 `tpass deploy` 的 `prisma migrate deploy` / `db push` 套用。

**前提兩件**：

1. 主機的 `/home/service/<dir>` **已經 clone**（要把 `DATABASE_URL` 寫進該目錄的 `.env.local`，目錄不存在會直接失敗）。
2. 部署帳號已取得建庫權——由 **root 在主機跑一次**（`<deploy_user>` ＝ `deploy/host.env` 的 `DEPLOY_USER`）：

```bash
sudo -u postgres psql -c "CREATE ROLE <deploy_user> LOGIN CREATEDB CREATEROLE;"
# 確認 pg_hba.conf 有：
#   local all all peer                              （socket，給部署帳號用）
#   host  all all 127.0.0.1/32 scram-sha-256        （TCP，給 app 用）
```

授權後部署帳號經 peer auth 即有 `CREATEDB` / `CREATEROLE`（**非 superuser**，最小權限），之後建庫全自助。per-service role 另配隨機密碼供 app 走 TCP 連線，只寫進遠端 `.env.local`。

> 這兩項也在 `tpass ui`：每張卡片有「🔧 env」面板與「🗄 建 DB」按鈕。

---

## 5. 主機拓樸

```
   使用者
     │  https（橘色雲：Cloudflare 代理 + 邊緣 TLS）
     ▼
  Cloudflare  ──►  主機:443
                      │
              nginx（root 管，vhost: tschool-sso，依 hostname 反向代理）
     ┌────────────────┼──────────────┬──────────────┬──────────────┐
 auth.…          portal.…         form.…         msg.…        appeals.…
     │                │              │              │              │
127.0.0.1:3000  127.0.0.1:3001  …:3002        …:3003         …:3004
 (pm2: auth)     (pm2: portal)   (pm2: form)   (pm2: msg)    (pm2: appeals)
 next start      next start      next start    next start    next start
     │                               │             │              │
     └───────────────────────┬───────┴─────────────┴──────────────┘
                         PostgreSQL（每服務專屬 user + db：t_auth / t_form / t_msg / t_appeals）
```

- **對外入口是 nginx**（不是 Caddy）。vhost 在 `/etc/nginx/sites-available/tschool-sso`、憑證在 `/etc/letsencrypt/`——都是 root 擁有，改動要維運者本人 sudo。
- **TLS 在 nginx / Cloudflare 終結**；pm2 跑的 Next.js 是純 HTTP，只綁 `127.0.0.1`。
- app 的 `Secure` cookie 由 env 裡的網址是不是 `https://` 推導出來。

### 主機目錄

```
~/tpass/                    ← ops repo 的 clone：只有 ops 層
├── deploy/{deploy.sh, ecosystem.config.js}
├── scripts/  docs/
├── tpass-registry/         ← ★ 服務註冊表（public repo，並排 clone；deploy.sh 每次自己 pull）

/home/service/              ← ★ 服務 repo 的家：一個服務一層，這層不放別的東西
├── tpass-auth/
├── tpass-portal/
├── tpass-form/  tpass-cross_grade_messages/  tpass-appeals/  …
```

兩條路徑的真相都在註冊表的 `server` 區塊（`opsRoot` / `servicesRoot`），`deploy.sh` 與
`ecosystem.config.js` 都從那裡讀——**不要在任何腳本裡寫死主機路徑**。

> ⚠️ **主機與本機的佈局在這裡分岔**（2026-08-03 起）。本機仍是「全部並排在同一層」，所以
> auth / portal 的 `../tpass-registry/services.json` 相對路徑照常成立；主機上服務不與註冊表
> 並排，那條路徑不成立，改由 ops 層注入絕對路徑 `TPASS_REGISTRY_PATH`：
> `ecosystem.config.js` 的 env 管 runtime、`deploy.sh` 的 export 管 build。
> **服務程式碼與 `.env.local` 都不用寫這個 key**——但你若在主機上手動跑 `pnpm run build`，
> 記得自己帶：`TPASS_REGISTRY_PATH=~/tpass/tpass-registry/services.json pnpm run build`。

### 進主機

```bash
scripts/ssh.sh              # 互動
scripts/ssh.sh '<cmd>'      # 跑單一指令
```

> 🔒 **主機位址與帳號是機密**，只存在 gitignored 的 `deploy/host.env`（範本 `deploy/host.env.example`）。
> **絕對不要**把主機 IP / 帳號寫進任何被 git 追蹤的檔案、commit、PR、或這份文件。

### 本機 vs 正式：只有 env 的值不同

| 項目 | 本機 | 正式 |
| --- | --- | --- |
| 怎麼跑 | `tpass dev`（HMR）/ `tpass start` | pm2 → `next start -H 127.0.0.1` |
| TLS | mkcert 自簽 | nginx（Let's Encrypt）+ Cloudflare |
| 網域類 env | `*.lvh.me:<port>` | `*.tschoolsu.org`（無 port） |
| JWT 金鑰對 | `tpass setup` 產的 | **另外產一組**，絕不重用 dev 金鑰、絕不進 git |
| 資料庫 | 本機 `t_<id>@localhost` | 主機 per-service user + db（root 建） |

### 新子網域上線：灰雲 → 橘雲儀式

1. Cloudflare DNS 先開 **灰色雲（DNS only）**——Let's Encrypt 的 HTTP-01 驗證必須直接打到主機，橘雲代理會把驗證請求接走，導致簽不到憑證。
2. **[root]** nginx server block + `certbot certonly`。
3. `curl` 直連主機確認 200 → **切回橘色雲**（隱藏源站 IP、WAF、快取）。

---

## 6. 監控

兩層，擋的是不同的東西：

| 層 | 誰在看 | 擋什麼 |
| --- | --- | --- |
| **UptimeRobot**（外部，5 分鐘一次，全天無休） | 機器 | 站掛了。**主機整台死掉時只有它叫得出來**——跑在主機上的東西都跟著死了。 |
| ~~備份的死人開關~~ | — | **尚未啟用**。「每日備份根本沒跑」目前只有 `tpass status` 會顯示，要人主動去看。見下。 |
| **`tpass status`**（本機發動，人主動跑） | 人 | 看得比較深：pm2 重啟數、記憶體、程式碼版本落後幾個 commit、最後備份時間、監控覆蓋率 |

前者回答「有沒有事」，後者回答「到底怎麼了」。**收到告警之後跑的是後者。**

```bash
scripts/tpass status
# == 本機 dev ==        port 探測，看本機有沒有在跑
# == 主機 pm2 ==        online / ↺重啟數 / 記憶體 / uptime
# == 主機程式碼版本 ==   各服務 HEAD vs origin/main
# == 監控 ==            UptimeRobot 各 monitor 的 up/down + 漏掉監控的服務
# == 備份 ==            最後一次成功備份是多久以前

scripts/tpass logs form        # 最近 100 行
scripts/tpass logs form -f     # 跟隨
```

**status 怎麼判讀**：

| 看到 | 意思 | 怎麼辦 |
| --- | --- | --- |
| 🔴 not online / ↺ 短時間暴增 | app 在 crash loop | `tpass logs <svc>` 看錯誤 |
| ⚪ 未部署但 registry 標 deployed | pm2 裡沒這個 app | 通常是首次部署沒完成 |
| 🟠 落後 origin/main | GitHub 有新 merge 還沒上線 | `tpass deploy <svc>` |
| 🟢 | HEAD = origin/main | 沒事 |
| ↺ 數字很大但穩定成長 | **正常**——每次 deploy reload 都會 +1 | 不用管 |
| ⚠️ `<svc>` 沒有監控 | registry 標 `deployed` 但 UptimeRobot 上沒有對應 monitor | 去補一個（見下） |
| 🔴 超過 30 小時沒備份 | cron 沒觸發 | §6.1。**目前沒有任何東西會主動告訴你這件事**——死人開關還沒接 |

### 線上監控與告警（UptimeRobot）

免費方案，50 個 monitor、5 分鐘間隔。**帳號刻意開在學生會官方信箱**，理由同 §6.2 的
Google 專案——個人帳號會隨畢業停用，監控跟著消失。

**有哪些 monitor**（清單真相＝註冊表：每個 `deployed:true` 的服務一個 HTTP monitor）：

| monitor | 網址 | 正常回什麼 |
| --- | --- | --- |
| auth / portal / form / msg / appeals / buddy | `https://<subdomain>.tschoolsu.org/` | auth 回 **200**，其餘五個回 **307**（未登入導去 auth） |
| 根網域 | `https://tschoolsu.org/` | **301** → `portal.tschoolsu.org`（2026-08-27 起，見下）。monitor 已從 Paused 開回來。 |

> ⚠️ **消費端回 307 不是錯誤。** 建 monitor 時務必把「視為 up 的狀態碼」放寬到
> **2xx + 3xx**（等價於 `deploy.sh` 健康檢查用的「HTTP < 500」）。只收 200 的話
> 五個服務會全天誤報 down，然後沒人再看告警——假警報比沒有告警更糟。

> 🕳 **根網域那條踩過一次坑**：Cloudflare 的 redirect rule 目標主機名寫成跟來源一樣
> （少了 `portal.`），apex 轉給自己 → `ERR_TOO_MANY_REDIRECTS`。而且**瀏覽器測不出來**
> ——301 會被永久快取，自己的 Chrome 存著舊的正確轉址所以「連進去正常」，
> 只有沒被快取過的路徑才現形。**改轉址只認 `curl -I` 或無痕視窗。**
> 現在是一條規則吃兩個主機名：`http.host in {"tschoolsu.org" "www.tschoolsu.org"}`
> → 靜態 `https://portal.tschoolsu.org`，301。

**告警送到哪**（兩個管道，七個 monitor 都掛上，`threshold:0` 一偵測到就發）：

| 管道 | 去哪 |
| --- | --- |
| Email | `studentcouncil@tschool.tp.edu.tw`（註冊時自動建） |
| Discord webhook | 維運頻道，**與備份失敗告警同一條** |

> ⚠️ **還沒接手機推播。** 這兩個都是「要有人去看」才成立的管道，半夜不會把人叫醒。
> 要補：手機裝 UptimeRobot App、用同一個帳號登入，它會自動變成第三個通知管道。

> 🔑 API key 雖然是唯讀的，**讀得出 Discord webhook 的完整網址**——當機密保管，
> 只放 gitignored 的 `deploy/host.env`，不要貼進 issue / PR / 任何被追蹤的檔案。

**多久會發現**：免費方案 5 分鐘間隔，加上判定要連續失敗，實際落在 **5～7 分鐘**。
2026-08-26 實測 `pm2 stop buddy`：6.6 分鐘後告警，復原後 4.5 分鐘發恢復通知。
**這是方案的硬限制，看到「6 分鐘才叫」不要以為是設定錯了。**

**`tpass status` 怎麼看得到監控**：填本機 `deploy/host.env` 的 `UPTIMEROBOT_API_KEY`（唯讀 key，
gitignored，**不放主機**——這是本機工具用的）。沒填就整段安靜跳過，不是錯誤。
它做一件 UptimeRobot 網頁做不到的事：**拿 monitor 清單對照註冊表，抓出「`deployed:true`
卻沒有人幫它開監控」的服務。**

**新服務上線時要記得加一個 monitor**——沒有自動化。`tpass status` 的 `⚠️ 沒有監控` 是補救，
預防在 `docs/handbook/04-registry-sop.md` 翻 `deployed:true` 前的檢查表。

### 備份的死人開關（🚧 尚未啟用，程式碼已就緒）

**這個洞還開著**：備份的第三種失敗是腳本**從未執行**（crontab 被清、cron 服務死了、
主機重開後沒起來）。那種時候 Discord 不會響，因為根本沒有東西發得出告警；
`tpass status` 的時間戳停住不動，但那要人主動去看。**沉默看起來跟成功一模一樣。**

死人開關等的是「好消息沒來」，不是壞消息：備份成功時去 ping 一個外部服務，
超過週期沒收到就由**那個外部服務**告警。UptimeRobot 免費方案沒有 heartbeat
（官網行銷頁寫「全方案都有」，產品裡是 Solo 以上——**以產品裡看到的為準**）。

**要啟用的話，`deploy/backup.sh` 那段已經寫好了**，只差一串 URL：

1. https://healthchecks.io 註冊（免費 20 個 check，用學生會官方信箱）
2. 建一個 check：Name `tpass-backup`、Period **1 day**、Grace **1 hour**
   （cron 是每日 04:15 → 約 25 小時沒 ping 就叫）
3. 複製它的 ping URL，**一條 ssh** 寫進主機：

```bash
scripts/ssh.sh "printf 'BACKUP_HEARTBEAT_URL=%s\n' 'https://hc-ping.com/<uuid>' >> ~/tpass/deploy/backup.env"
tpass backup run          # 驗證：healthchecks 那頁應該立刻變綠
```

沒填就完全不動作，不會報錯。**`--dry-run` 也不會 ping**——那段在 dry-run 的 `exit 0`
之後，假的心跳比沒有心跳更糟。

### 🚧 規劃中：改用自架的 Uptime Kuma（2026-08-27，部員提案）

**狀態：尚未執行。** 部員提議改用 [Uptime Kuma](https://github.com/louislam/uptime-kuma)
（開源自架監控），由**部員自己的主機**部署，部長先拉下來設定、部員負責上線。
下面是決定要不要換、以及換的時候必須守住的東西。

**它解決什麼**（真的有價值，不是換個好看的）：

- **內建 push monitor＝死人開關**。上面那個「🚧 尚未啟用」的洞它直接補掉，
  而且不必再多開一個 healthchecks.io 帳號。`backup.sh` 的 `BACKUP_HEARTBEAT_URL`
  照樣能用——**填 Kuma 的 push URL 就好，腳本一行都不用改**。
- 檢查間隔可以短於 5 分鐘，UptimeRobot 免費方案「5～7 分鐘才叫」的硬限制消失。
- monitor 數量無上限，新服務上線不必省著開。
- 不必把 Discord webhook 交給第三方（UptimeRobot 的唯讀 API key 讀得出 webhook 全文）。
  Kuma 支援 Discord 通知，可以送同一條維運頻道。

**換的時候不可以違反的兩條**：

1. 🔴 **監控絕對不能跟被監控的東西住同一台機器。** 主機自己死掉時，只有跑在主機外的
   東西叫得出來——這是 `scripts/lib/monitor.mjs` 檔頭那句話的全部意義。
   部員那台是另一台機器就沒問題，但**要確認過，不要假設**。
2. 🔴 **不要急著關掉 UptimeRobot。** 至少並行到 Kuma 連續叫對幾次為止。
   並行期間 Kuma 死掉還有 UptimeRobot 兜著；直接切過去的話，
   **監控自己死掉是靜默的**——沒有東西會來告訴你「你的監控不見了」。

**交接風險比 UptimeRobot 更重，要先想好**：UptimeRobot 那邊的處理是「帳號開在
`studentcouncil@` 官方信箱，不隨個人畢業」（見上）。自架版沒有這個解——
**機器本身屬於一個部員**。他畢業、退部、或那台主機停掉，監控就整個消失。
換之前先講好：那台機器是誰的、帳單誰付、他離開時交給誰。這題 C5（交接重疊期）躲不掉。

**工程成本（具體）**：`tpass status` 的「== 監控 ==」那段打的是 UptimeRobot v2 API
（`scripts/lib/monitor.mjs`）。那段唯一的價值是**拿 monitor 清單對照註冊表，抓出
「`deployed:true` 卻沒有人開監控」的服務**——換到 Kuma 要重寫成打它的 API。
**並行期間可以先不動**：UptimeRobot 還在，那段就還準。真的關掉 UptimeRobot 那天再改，
不要為了還沒發生的事先改。


---

## 6.1 備份與還原

**排程**：主機 cron 每日 04:15 跑 `~/tpass/deploy/backup.sh`，把每個資料庫的 `pg_dump`
與各服務的檔案狀態目錄傳到主機以外的備份庫（rclone remote，目前是 Google Drive）。
日備留 7 份、週備（週日那份）留 4 份。

**備份什麼是從註冊表派生的**，不是寫死的清單：`enabled && db != null` 的服務各一個 dump，
加上任何 `enabled` 服務底下非空的 `<dir>/data/` 與 `<dir>/uploads/`。新服務上線後
**自動被涵蓋**，不必改腳本。收兩個目錄名是因為 `data/` 是本專案的慣例（buddy 的
`pairs.json`），而後來納管的 notes 與 meeting 把使用者上傳檔寫在 `uploads/`；
要再收第三個名字就改 `backup.sh` 的 `STATE_DIRS`。

```bash
tpass status                          # 尾巴會顯示「最後備份 X 小時前」
tpass backup list                     # 備份庫上有哪些備份
tpass backup run                      # 手動備一次（動 migration 之前跑這個）
tpass backup run --dry-run            # 只 dump 不上傳，測腳本用
tpass backup restore <日期> <svc>     # 還原驗證
tpass backup install-cron             # 裝排程（冪等）
tpass backup setup                    # 一次性：主機裝 rclone + 搬 remote 設定
```

### 怎麼真的還原一個資料庫

`tpass backup restore` 做的是**驗證**：在 Docker 的 `postgres:18` 容器裡還原、印出每張表的
列數並跟主機對照，跑完就把容器收掉。**它不會碰主機。** 這是刻意的——還原到正式庫是不可逆的，
不該是一個打錯就發生的指令。

真的要覆蓋主機資料庫時（資料被誤刪、migration 出事），在主機上手動做，一步一步：

```bash
scripts/ssh.sh                                   # 進主機
~/.local/bin/rclone copy tpass-backup:tpass-backups/daily/<日期>/<svc>-<db>.dump /tmp/
pm2 stop <svc>                                   # 先停服務，避免邊寫邊還原
pg_dump --format=custom --no-owner --no-privileges \
  --dbname="$(grep -m1 '^DATABASE_URL=' /home/service/<dir>/.env.local | cut -d= -f2-)" \
  --file=/tmp/before-restore.dump                # 還原前先備現況，這步不要跳過
pg_restore --clean --if-exists --no-owner --no-privileges \
  --dbname="$(grep -m1 '^DATABASE_URL=' /home/service/<dir>/.env.local | cut -d= -f2-)" \
  /tmp/<svc>-<db>.dump
pm2 start <svc>
```

### 失敗會怎麼讓你知道

兩道防線，因為它們擋的是不同的失敗：

| 防線 | 擋什麼 |
| --- | --- |
| Discord webhook（`deploy/backup.env` 的 `BACKUP_DISCORD_WEBHOOK`） | 腳本跑了但失敗 |
| `tpass status` 的「最後備份 X 小時前」，超過 30 小時標紅 | **cron 根本沒觸發**——webhook 不會響 |
| 🚧 死人開關（`backup.env` 的 `BACKUP_HEARTBEAT_URL`）——**尚未啟用**，程式碼已就緒 | 同上，但**不必有人主動去看**。沒接之前，「cron 沒觸發」仍然只有主動跑 `tpass status` 才看得到（見 §6） |

### 設定放哪

`~/tpass/deploy/backup.env`（主機上，**gitignored**，範本是 `backup.env.example`）：
remote 名稱、Discord webhook、保留天數。Google 的 OAuth token 在主機
`~/.config/rclone/rclone.conf`（600），一樣不進 git。

### 已知限制

- **備份沒有加密**。風險是「Google 帳號或 rclone token 外洩 = 全校申訴內容外洩」。
- **備份存在 `studentcouncil@` 的「我的雲端硬碟」**（官方帳號，不隨個人畢業消失；見 §6.2）。
  改用**共用雲端硬碟**（rclone 的 `team_drive`）會更穩——不綁任何單一帳號。尚未做。
- **只有每日全量，沒有 PITR**。最壞情況是丟失最近 24 小時的資料。
- **「cron 沒觸發」還沒有主動告警**。死人開關的程式碼在，外部 check 還沒接（見 §6）。

---

## 6.2 Google Cloud 專案與 OAuth 憑證

T-Pass 用到 Google 的兩件事**在同一個 Cloud 專案**：`tpass`（編號 `440951527365`），
擁有者是 `studentcouncil@tschool.tp.edu.tw`。**刻意掛在學生會官方帳號**——個人學生帳號
會隨畢業停用，專案與備份會一起消失。（2026-08-26 從個人帳號的 `tpass-dev` 專案搬過來。）

| 用途 | OAuth client 類型 | 憑證放哪 |
| --- | --- | --- |
| auth 的 Google 登入 | 網頁應用程式 | `tpass-auth/.env.local` 的 `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`（主機與本機各一份，值相同） |
| 每日備份寫入 Drive | 桌面應用程式（rclone） | `~/.config/rclone/rclone.conf`（主機與本機各一份，600） |

同意畫面（Google 驗證平台 →「目標對象」）必須維持 **內部（Internal）**。三個理由：

- 外部＋「測試中」的 app，refresh token **7 天到期** → 每日備份會在某天靜默死掉
- 外部有 100 名測試使用者上限，全校師生一定爆
- 內部的涵蓋範圍正好等於 `AUTH_ALLOWED_EMAIL_DOMAIN`（`tschool.tp.edu.tw`），Google 端與 auth 自己的檢查同一條線

代價：**校外帳號（畢業生 gmail）在 Google 那層就被擋**。要開放校友必須改回外部並送審。

### redirect URI（改網域時唯一要同步的地方）

redirect URI 不是 env，是程式碼推導的：`${AUTH_BASE_URL}/api/auth/callback/google`
（`tpass-auth/src/config/auth.ts`）。後台登記的必須**一字不差**，目前兩條：

```
https://auth.tschoolsu.org/api/auth/callback/google      # 主機
https://auth.lvh.me:3000/api/auth/callback/google        # 本機 dev
```

### 換掉 auth 的 OAuth 憑證

**OAuth client 不能跨專案搬移**——換專案就是建新 client 再換 env。

```bash
# 0. 在目標專案建「網頁應用程式」client，填上面兩條 redirect URI
tpass env get auth --show | grep GOOGLE                              # 1. 先抄舊值，回滾要用
tpass env set auth GOOGLE_CLIENT_ID=<新的>                           # 2.
printf '%s' '<新密鑰>' | tpass env set auth GOOGLE_CLIENT_SECRET --stdin  # 3. 值不進 shell 歷史
tpass deploy auth                                                    # 4.
# 5. 無痕視窗開 https://portal.tschoolsu.org 跑一次登入
# 6. 本機 tpass-auth/.env.local 換成同一組
# 7. 驗證通過後才停用舊 client / 舊專案
```

**已發出的 JWT 不受影響**——token 是 auth 自己用 EdDSA 簽的，Google 只在登入那一刻參與。
使用者最多下次登入多按一次同意畫面。回滾＝把第 1 步抄的舊值寫回去再 `tpass deploy auth`。

### 動 Google 後台時的紅線

- ❌ 不要刪除或重新產生 rclone 那組 client 的密鑰 → 現有 refresh token 立刻作廢，**備份靜默死掉**
- ❌ 不要把 `drive.file` 從同意畫面的「資料存取權」拿掉 → 同上
- ❌ 不要把同意畫面改回「外部」→ 見上面三個理由
- ⚠️ `drive.file` 是 **per-client × per-user**：換 client 或換授權帳號後，**新 token 看不到舊的備份檔**，
  舊檔會留在原帳號的 Drive 直到手動刪。要換 rclone 授權，先用舊設定 `rclone purge` 清乾淨再換。

---

## 7. 疑難排解

| 症狀 | 原因 / 解法 |
| --- | --- |
| `tpass status` 說「超過 30 小時沒備份」 | cron 沒跑或腳本掛了。`scripts/ssh.sh 'crontab -l'` 確認排程還在，再看 `scripts/ssh.sh 'tail -50 ~/tpass-backup.log'` |
| Discord 說備份失敗 | 訊息裡有卡住的步驟。最常見是 rclone 的 Google token 過期 → 本機 `rclone config reconnect tpass-backup:` 後 `tpass backup setup` 重搬設定 |
| 登入噴 `redirect_uri_mismatch` | Google 後台登記的 redirect URI 跟 `${AUTH_BASE_URL}/api/auth/callback/google` 不一致（注意結尾斜線、http/https）。見 §6.2 |
| 登入噴 `invalid_client` | `GOOGLE_CLIENT_ID/SECRET` 貼錯，或兩者不是同一個專案的。`tpass env get auth --show \| grep GOOGLE` 比對 |
| 登入被 `access_blocked` / 組織政策擋下 | 同意畫面不是「內部」，或登入者不在 `tschool.tp.edu.tw`。見 §6.2 |
| 本機登入後一直被踢回登入頁 | dev 指令少了 `NODE_TLS_REJECT_UNAUTHORIZED=0`，消費端後端抓不到 auth 的 JWKS（見 §0 的 ⚠️）。log 裡找 `UNABLE_TO_VERIFY_LEAF_SIGNATURE`。**主機上出現這症狀跟 TLS 無關**，去查 `iss` / `aud` |
| `tpass deploy` 報 git 錯誤 | 主機 `~/tpass` 工作樹不乾淨（主機上不該手改檔案）。`scripts/ssh.sh 'git -C ~/tpass status'` 看 |
| `tpass deploy` 健康檢查失敗 | `tpass logs <svc>` 看啟動錯誤；最常見是 env 缺值或 DB 連不上 |
| 部署被擋，說 env 缺 key | 對照該 repo `.env.example`，用 `tpass env set <svc> KEY=VALUE` 補**主機上**的 `.env.local`（真相是 `src/config/*.ts` 的 REQUIRED，見 §4.1） |
| 部署時報 `command not found`，指向一個 email 或網址 | 主機 `.env.local` 裡某個值含空白卻沒加引號。`deploy.sh` 用 shell `source` 匯入，未加引號的空白會被當成指令（見 §4.1） |
| `tpass db create` 連不上 postgres | 部署帳號尚未取得建庫權——由 root 跑一次 §4.2 的 `CREATE ROLE … LOGIN CREATEDB CREATEROLE` |
| `tpass db create` 說主機目錄不存在 | 要先在主機 `git clone` repo 到 `/home/service/<dir>`，`db create` 才有地方寫 `DATABASE_URL`（見 §4.2） |
| 部署後 502 | `tpass logs <svc>` 看 pm2 有沒有活；或 nginx 反代的 port 與註冊表不一致 |
| 服務登記了，大廳還是沒卡片 | 註冊表 merge 之後**沒有重新部署 portal**。auth / portal 是在 build 時把清單烤進去的 |
| auth / portal 起不來，說讀不到註冊表 | 本機：`tpass-registry` 沒與服務並排 clone。主機：`~/tpass/tpass-registry` 沒 clone，或你手動跑 build 沒帶 `TPASS_REGISTRY_PATH`（正常部署由 `deploy.sh` / `ecosystem.config.js` 注入）。錯誤訊息裡有完整路徑 |
| 部署完了，服務跑的還是舊 code | pm2 程序的 cwd 還指在舊目錄（例如搬去 `/home/service` 之前的路徑）。`deploy.sh` 會自己偵測 cwd 不符並 delete + start；手動查：`scripts/ssh.sh 'pm2 describe <id>'` 看 cwd |
| 切橘雲後 5xx / 憑證錯 | 憑證還沒簽好就切橘雲了——回灰雲、簽好、再切 |
| Postgres 沒起來 | `brew services start postgresql@17` |
| `tpass db setup <svc>` 卡在 `prisma migrate dev`，說沒權限建資料庫 | 已知坑：`db.mjs` 建 role 時只給 `LOGIN`，沒給 `CREATEDB`。本機 `migrate dev` 會另外開一個 shadow database 來算 migration diff，需要這個權限；正式站部署用的是 `migrate deploy`，**不建 shadow db，不需要 `CREATEDB`**，所以主機不受影響。本機解法：`psql -d postgres -c "ALTER ROLE t_<id> CREATEDB"` 補一次，冪等，之後 `tpass db setup <svc>` 就會過 |
| 憑證過期 / 加了新子網域 | 重跑 `scripts/tpass setup`（會重生憑證） |
| 主機重開機後服務沒起來 | `scripts/ssh.sh 'pm2 resurrect'`（正常情況 systemd 會自動做） |
| pm2 裡根本沒這個 app | `scripts/ssh.sh 'cd ~/tpass && pm2 startOrReload deploy/ecosystem.config.js --only <id> && pm2 save'` |
