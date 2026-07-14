# TSchool 開發與維運手冊

> **給誰讀**：要在 TSchool 數位服務平台上開發、部署、顧機器的人。
> **這份文件是自給自足的**——所有指令、主機拓樸、排錯步驟都寫在裡面，不需要翻其他文件。
>
> 想「開一個新服務並串登入」→ 看另一份《TSchool 新服務串接指南》。

---

## 0. 全貌：一條管線

指令**只有一個入口**：`scripts/tpass`。不想背指令就直接打 `scripts/tpass`（不帶參數），會跳互動選單；`scripts/tpass ui` 有瀏覽器圖形儀表板。

```
tpass setup ──(一次)──▶ tpass dev ──(日常)──▶ tpass check ──▶ tpass start
                                                                   │
                    git push（開分支 → PR → merge main）            │
                                                                   ▼
                                             tpass deploy ──▶ 正式主機
                                                              （pm2 reload + 健康檢查）
```

### tpass 全指令

| 指令 | 做什麼 | 什麼時候用 |
| --- | --- | --- |
| `tpass setup` | mkcert 憑證 + npm install + 產金鑰 + 建 DB（冪等，重跑安全） | 換新電腦 / 加了新服務 |
| `tpass dev [svc\|all]` | 本機開發：HTTPS + HMR，SSO 全流程可測 | 寫 code 時 |
| `tpass check [svc\|all]` | lint + `tsc --noEmit` | **每次 push 前** |
| `tpass check env [svc\|all]` | 驗 `.env.local` 必填 key 有沒有漏 | 懷疑 env 缺值時 |
| `tpass build [svc\|all]` | `npm run build` | 少用（check 通常夠） |
| `tpass start [svc\|all]` | production smoke：build + start:https | 大改動 push 前 |
| `tpass db setup [svc]` | 建 role + database、補 `DATABASE_URL`、prisma generate + 套 schema | 首次 / schema 改動後 |
| `tpass db reset <svc>` | drop 後重建（會要求打服務 id 確認） | 本機 DB 壞了 |
| `tpass deploy [svc\|all]` | 部署到正式主機 | merge 到 main 後 |
| `tpass status` | 本機 port 探測 + 主機 pm2 狀態 + 主機程式碼版本 | 隨時 |
| `tpass logs <svc> [-f]` | 看主機 log（`-f` 跟隨） | 出事時 |
| `tpass new [id]` | 登記新服務（寫 `services.json` + 印人工步驟） | 開新服務 |
| `tpass list` | 列出服務註冊表 | 隨時 |
| `tpass ui` | 瀏覽器圖形儀表板 | 不想打字時 |

> **🚫 禁止在服務 repo 裸跑 `npm run dev`。** 本機用 HTTPS + mkcert 憑證，而 Node / Next 預設不信任 mkcert 的根憑證，後端去抓 SSO 公鑰（JWKS）會 TLS 失敗——症狀是「登入完馬上被踢回登入頁」。`tpass dev` 把這個坑處理掉了。

### 角色分工

主機上的**部署帳號沒有 root**。

| 角色 | 能做 | 不能做 |
| --- | --- | --- |
| 開發者 / 部署帳號 | `tpass` 全部指令、服務 repo 的 git、主機 `~/tpass` 底下一切、pm2 | nginx、TLS 憑證、建 PostgreSQL role/db、系統套件 |
| 維運部員（有 root） | nginx vhost、certbot、Cloudflare DNS、`sudo -u postgres psql` | —— |

需要 root 的操作，**停下來把指令交給維運部員**（`tpass new` 會自動把該給他們的指令印出來）。

---

## 1. 服務清單（`services.json` = 唯一真相）

所有工具（CLI、pm2 設定、部署腳本）都從頂層 `services.json` 讀服務清單、port、DB 策略。**不要在任何地方另外硬編碼這些資訊。**

| id | 服務 | 目錄 | 本機網址 | 正式網址 | port | DB |
| --- | --- | --- | --- | --- | --- | --- |
| `auth` | SSO 發證 | `tpass-auth/` | `auth.lvh.me:3000` | `auth.tschoolsu.org` | 3000 | — |
| `portal` | 門戶大廳 | `tpass-portal/` | `portal.lvh.me:3001` | `portal.tschoolsu.org` | 3001 | — |
| `form` | T-Form 問卷 | `tpass-form/` | `form.lvh.me:3002` | `form.tschoolsu.org` | 3002 | `t_form` |
| `msg` | T-Msg 跨屆代傳 | `tpass-cross_grade_messages/` | `msg.lvh.me:3003` | `msg.tschoolsu.org` | 3003 | `t_msg` |
| `appeals` | T-Appeals 申訴 | `tpass-appeals/` | `appeals.lvh.me:3004` | `appeals.tschoolsu.org` | 3004 | `t_appeals` |
| `directory` | 目錄服務 | `tpass-directory/` | — | — | 3005 | （**已封存，不部署**） |

**每個服務是一個獨立的 git repo**（不是 monorepo）。頂層 `tschool/` 本身也是一個 repo（`tpass-ops`），只追蹤維運層：`services.json`、`scripts/`、`deploy/`、`docs/`。

git repos：

- `tpass-ops`（頂層，private）、`tpass-auth`、`tpass-portal`、`tpass-form`、`tpass-cross_grade_messages`、`tpass-appeals`、`tpass-directory`（已封存）
- 全部在 GitHub 的 `YC815` 底下。

> 🚫 **鐵律**：頂層 ops repo 絕對不要 `git add` 服務子 repo、`deploy/host.env`、`certs/`。機密與服務程式碼都不進 ops repo。

---

## 2. 一次性環境準備

前置（macOS）：

```bash
brew install mkcert nss node postgresql@17
brew services start postgresql@17
```

然後：

```bash
scripts/tpass setup
```

它會做：信任 mkcert 根憑證 → 產出涵蓋所有服務子網域的憑證到 `certs/` → 所有服務 `npm install` → 印出 EdDSA 金鑰對 → 對有 DB 的服務跑 `tpass db setup`（建 role + database、補 `DATABASE_URL`、prisma generate + migrate）。

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
scripts/tpass dev          # 全部服務一起跑（測 SSO 互通要這樣）
scripts/tpass dev form     # 只跑一個
```

- 全部走 HTTPS + `*.lvh.me`。`lvh.me` 由公共 DNS 直接解析到 `127.0.0.1`，**不用改 `/etc/hosts`**。
- 本機與正式環境**邏輯完全相同，只差 env 的值與啟動方式**。

### push 前把關

```bash
scripts/tpass check        # lint + tsc，全綠才 push
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

```bash
scripts/tpass deploy form   # 單一服務
scripts/tpass deploy        # 全部（registry 裡 deployed:true 的）
```

### 主機端每次部署做什麼

部署動作全部從本機經 ssh 觸發，**主機上不裝任何部署工具**（效能預算留給產品本身）。主機只有 ssh + git + node + pm2 + nginx + PostgreSQL。

每一步失敗都會中止並印出明確錯誤：

1. ops repo `git pull` 自我更新（部署腳本、`services.json` 永遠吃最新 main）。
2. 服務 repo `git pull --ff-only`。
3. **env 必填檢查**——解析該 repo `src/config/*.ts` 的 `REQUIRED`，缺 key 在 build 前就擋下並印出缺哪些。
4. `package-lock.json` 有變才 `npm ci`（沒變就跳過，快很多）。
5. `prisma generate`（有 DB 的服務）。
6. `npm run build`。
7. 套 DB schema：依 `services.json` 的 `db.strategy` 跑 `prisma migrate deploy`（標準）或 `prisma db push`（僅限原型）。
8. `pm2 startOrReload`——既有服務零停機 reload；registry 新增的服務會自動首次啟動。
9. **健康檢查**：對服務 port 打 HTTP，30 秒內拿到 <500 回應才算成功（app 起不來不會拿到假的 ✅）。
10. 全部成功後 `pm2 save`（主機重開機後 resurrect 的就是最後一次成功部署的清單）。

### rollback

不需要特殊機制：在服務 repo `git revert` 出一個新 commit → merge main → `tpass deploy <svc>`。

build 失敗時舊版行程**不受影響**（reload 只在 build 成功之後才發生）。

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
                                      │             │              │
                                 PostgreSQL（每服務專屬 user + db：t_form / t_msg / t_appeals）
```

- **對外入口是 nginx**（不是 Caddy）。vhost 在 `/etc/nginx/sites-available/tschool-sso`、憑證在 `/etc/letsencrypt/`——都是 root 擁有，部署帳號無 sudo。
- **TLS 在 nginx / Cloudflare 終結**；pm2 跑的 Next.js 是純 HTTP，只綁 `127.0.0.1`。
- app 的 `Secure` cookie 由 env 裡的網址是不是 `https://` 推導出來。

### 主機目錄

```
~/tpass/                    ← 就是 ops repo 的 clone
├── services.json           ← 服務註冊表
├── deploy/{deploy.sh, ecosystem.config.js}
├── tpass-auth/  tpass-portal/  tpass-form/  …   ← 各服務 repo 並排 clone
```

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

```bash
scripts/tpass status
# == 本機 dev ==        port 探測，看本機有沒有在跑
# == 主機 pm2 ==        online / ↺重啟數 / 記憶體 / uptime
# == 主機程式碼版本 ==   各服務 HEAD vs origin/main

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

---

## 7. 疑難排解

| 症狀 | 原因 / 解法 |
| --- | --- |
| 本機登入後一直被踢回登入頁 | 十之八九是裸跑了 `npm run dev`（後端抓不到 JWKS）。改用 `tpass dev` |
| `tpass deploy` 報 git 錯誤 | 主機 `~/tpass` 工作樹不乾淨（主機上不該手改檔案）。`scripts/ssh.sh 'git -C ~/tpass status'` 看 |
| `tpass deploy` 健康檢查失敗 | `tpass logs <svc>` 看啟動錯誤；最常見是 env 缺值或 DB 連不上 |
| 部署被擋，說 env 缺 key | 對照該 repo `.env.example` 補**主機上**的 `.env.local`（真相是 `src/config/*.ts` 的 REQUIRED） |
| 部署後 502 | `tpass logs <svc>` 看 pm2 有沒有活；或 nginx 反代的 port 與 `services.json` 不一致 |
| 切橘雲後 5xx / 憑證錯 | 憑證還沒簽好就切橘雲了——回灰雲、簽好、再切 |
| Postgres 沒起來 | `brew services start postgresql@17` |
| 憑證過期 / 加了新子網域 | 重跑 `scripts/tpass setup`（會重生憑證） |
| 主機重開機後服務沒起來 | `scripts/ssh.sh 'pm2 resurrect'`（正常情況 systemd 會自動做） |
| pm2 裡根本沒這個 app | `scripts/ssh.sh 'cd ~/tpass && pm2 startOrReload deploy/ecosystem.config.js --only <id> && pm2 save'` |
