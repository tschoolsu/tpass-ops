# TSchool 開發與維運手冊（權威 SOP）

> 從零到能開發、測試、部署、維運的完整路徑。指令只有一個入口：**`scripts/tpass`**。
> 不想背指令就直接打 `scripts/tpass`（不帶參數）——會出互動選單；`tpass ui` 有圖形儀表板。
> 服務清單 / port / DB 的唯一真相 = 頂層 `services.json`，所有工具都從它讀。

---

## 0. 全貌：一條管線、兩種角色

```
tpass setup ──(一次)──▶ tpass dev ──(日常)──▶ tpass check ──▶ tpass build/start
                                                                    │
                     git push（各服務 repo 的分支 → PR → merge main）│
                                                                    ▼
                                              tpass deploy ──▶ 正式主機（pm2 reload
                                                               + 健康檢查 + pm2 save）
```

| 階段 | 指令 | 什麼時候跑 |
| --- | --- | --- |
| 環境準備 | `tpass setup` | 換新電腦 / 加新服務後（冪等，重跑安全） |
| 日常開發 | `tpass dev [svc\|all]` | 寫 code 時（HTTPS + HMR，SSO 全流程可測） |
| 資料庫 | `tpass db setup [svc]` | 首次 / schema 變更後（自動建 role+db+跑 prisma） |
| push 前把關 | `tpass check [svc\|all]` | 每次 push 前（lint + tsc --noEmit） |
| env 驗證 | `tpass check env [svc\|all]` | 懷疑 .env.local 缺 key 時 |
| production 煙測 | `tpass start [svc\|all]` | 大改動 push 前（build + 最貼近 prod 的 start） |
| 部署 | `tpass deploy [svc\|all]` | merge 到 main 後 |
| 看狀態 / log | `tpass status`、`tpass logs <svc>` | 隨時 |
| 圖形介面 | `tpass ui` | 以上全部不想打字時 |

**角色分工**（主機上部署帳號沒有 root）：

| 角色 | 能做什麼 | 不能做什麼 |
| --- | --- | --- |
| 開發者 / 部署帳號 | `tpass` 全部指令、服務 repo 的 git、主機 `~/tpass` 下一切、pm2 | nginx、certbot、建 PostgreSQL role/db、系統套件 |
| 維運部員（root） | nginx vhost、TLS 憑證、Cloudflare DNS、`sudo -u postgres psql` | ——（新服務上線時 `tpass new` 會把要交給 root 的指令印好） |

---

## 1. 一次性環境準備

前置：`brew install mkcert nss node postgresql@17 && brew services start postgresql@17`。

```bash
scripts/tpass setup
```

它會：信任 mkcert 根憑證 → 產涵蓋所有服務子網域的憑證到 `certs/` →
所有服務 `npm install` → 印 EdDSA 金鑰 → 對有 DB 的服務跑 `tpass db setup`
（建 `t_<id>` role+db、補 `DATABASE_URL`、prisma generate + migrate）。

之後手動一次：各 repo `cp .env.example .env.local` 填值（金鑰貼進 auth 的）。
env 必填清單的真相 = 各 repo `src/config/*.ts` 的 `REQUIRED` 陣列；
`tpass check env` 可隨時驗證有沒有漏。

常見雷：

- **Postgres 沒起來**：`brew services start postgresql@17`（`tpass db setup` 也會自動嘗試）。
- **瀏覽器不信任憑證**：重跑 `tpass setup`（會重跑 `mkcert -install`）。
- **`.env.local` 抄了範本沒改值**：`.env.example` 是占位值，金鑰/OAuth/DB 都要換成真值。

## 2. 日常開發

```bash
scripts/tpass dev          # 全部服務（HMR）
scripts/tpass dev form     # 只跑一個
```

- 全部走 HTTPS + `*.lvh.me`（公共 DNS 指向 127.0.0.1，免改 hosts），
  SSO 的 Secure cookie / 跨子網域流程在本機照樣測得到。
- **禁止在服務 repo 裸跑 `npm run dev`**——mkcert 信任與 Next/undici 的 TLS 坑
  都在 `tpass dev` 裡處理掉了。
- 本機 dev 與正式環境**邏輯完全相同，只差 env 值與啟動方式**。

## 3. 測試與 push 前把關

```bash
scripts/tpass check        # lint + tsc，全綠才 push
scripts/tpass check env    # .env.local 必填 key 驗證
scripts/tpass start        # 大改動再跑：build + start:https（抓 RSC/React Compiler 差異）
```

自動檢查之外，**動到登入 / auth 契約時要真人驗證**（Google 登入不能自動化）：

- [ ] `tpass dev` 起全部 → portal 登入 → 開 form / msg 應直接認得（不用重登）。
- [ ] DevTools → Application → Cookies：登入後各服務網域各有一顆 host-only `tpass_token`。
- [ ] 各服務登出 → 自己的 cookie 消失，回 portal。

各服務 repo 開分支 → push → GitHub PR → merge 到 main。**不直接 push main。**

## 4. 部署

```bash
scripts/tpass deploy form   # 單一服務
scripts/tpass deploy        # 全部（services.json 裡 deployed:true 的）
```

主機端流程（`deploy/deploy.sh`，經 ssh 觸發，每步失敗都會中止並報明確錯誤）：

1. ops repo `git pull` 自我更新（deploy.sh / services.json 永遠吃最新 main）。
2. 服務 repo `git pull --ff-only`。
3. **env 必填檢查**——缺 key 在 build 前就擋下，並印出缺哪些。
4. `package-lock.json` 有變才 `npm ci`（沒變就跳過，快很多）。
5. `prisma generate` → `npm run build` → 依 `db.strategy` 套 schema
   （`migrate` = `prisma migrate deploy`；`push` = `prisma db push`）。
6. `pm2 startOrReload`（zero-downtime；registry 新增的服務自動首次啟動）。
7. **健康檢查**：對服務 port 打 HTTP，30 秒內拿到 <500 回應才算成功——
   app 起不來不會拿到假 ✅。
8. 全部成功後 `pm2 save`（重開機 resurrect 的就是最後一次成功部署的清單）。

部署完看狀態：

```bash
scripts/tpass status
# == 本機 dev ==          port 探測，看本機 dev 有沒有在跑
# == 主機 pm2 ==          online/↺重啟數/記憶體/uptime
# == 主機程式碼版本 ==     各服務 HEAD vs origin/main；🟠 落後 = 有 merge 還沒部署
scripts/tpass logs form        # 最近 100 行
scripts/tpass logs form -f     # 跟隨
```

**status 判讀**：

- 🔴 not online / ↺ 短時間暴增 → app 在 crash loop，`tpass logs <svc>` 看錯誤。
- ⚪ 未部署但 registry 標 deployed → pm2 裡沒這個 app，需檢查（通常是首次部署沒完成）。
- 🟠 落後 origin/main → GitHub 有新 merge 還沒上，跑 `tpass deploy <svc>`。

**rollback**：不需要特殊機制——在服務 repo `git revert` 出一個新 commit →
merge main → `tpass deploy <svc>`。build 失敗時舊版行程不受影響
（reload 只在 build 成功後才發生）。

## 5. 新增服務

```bash
scripts/tpass new <id>
```

互動式登記進 `services.json`（port 撞車會直接被 registry 驗證擋下）、重生憑證，
並印出完整人工清單（nginx vhost 給 root 部員、DNS、auth 白名單、portal 卡片…）。

- 文檔骨架標準見 `docs/SERVICE-TEMPLATE.md`；SSO 串接照抄 `tpass-portal`
  （契約見 `tpass-auth/INTEGRATION.md`）。
- 首次上線的完整順序（DNS → root 前置 → clone → env → 翻 `deployed:true` → deploy）
  見 `docs/MERGE-AND-DEPLOY.md §6`。

## 6. 監控與疑難排解

| 症狀 | 解法 |
| --- | --- |
| 消費端登入後一直掉回登入頁 | 用 `tpass dev` 啟動（處理 JWKS TLS 信任）；檢查 iss/aud env |
| `tpass deploy` 報 git 錯誤 | 主機 `~/tpass` 工作樹不乾淨或分支飄移——ssh 進去 `git status` 看 |
| `tpass deploy` 健康檢查失敗 | `tpass logs <svc>` 看啟動錯誤；常見是 env 缺值 / DB 連不上 |
| env 缺 key 導致 build 炸 | `tpass check env <svc>` 列出缺哪些；真相在 `src/config/*.ts` REQUIRED |
| Postgres 沒起來 | `brew services start postgresql@17`；`tpass db setup` 會自動嘗試 |
| 憑證過期 / 加了新子網域 | 重跑 `tpass setup`（會重生憑證） |
| 主機重開機後服務沒起來 | `scripts/ssh.sh 'pm2 resurrect'`；正常情況 systemd 的 pm2 服務會自動做 |
| pm2 ↺ 數字很大 | 每次 deploy reload 也會 +1，穩定成長無妨；短時間暴增才是 crash loop |
| 想確認主機是不是最新版 | `tpass status` 的「主機程式碼版本」段，🟢 = HEAD 等於 origin/main |

主機拓撲、nginx / Cloudflare、需要 root 的操作見 `docs/DEPLOY.md`。
主機連線機密只存在 gitignored 的 `deploy/host.env`（`scripts/ssh.sh` 讀）；
進主機：`scripts/ssh.sh`（互動）或 `scripts/ssh.sh '<cmd>'`。
