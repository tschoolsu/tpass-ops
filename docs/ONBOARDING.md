# TSchool 開發流程（權威 SOP）

> 從零到能開發、測試、部署的完整路徑。指令只有一個入口：**`scripts/tpass`**。
> 不想背指令就直接打 `scripts/tpass`（不帶參數）——會出互動選單。
> 服務清單 / port / DB 的唯一真相 = 頂層 `services.json`，所有工具都從它讀。

---

## 0. 全貌：一條管線

```
tpass setup ──(一次)──▶ tpass dev ──(日常)──▶ tpass check ──▶ tpass build/start
                                                                    │
                     git push（各服務 repo 的分支 → PR → merge main）│
                                                                    ▼
                                              tpass deploy ──▶ 正式主機（pm2 reload）
```

| 階段 | 指令 | 什麼時候跑 |
| --- | --- | --- |
| 環境準備 | `tpass setup` | 換新電腦 / 加新服務後（冪等，重跑安全） |
| 日常開發 | `tpass dev [svc\|all]` | 寫 code 時（HTTPS + HMR，SSO 全流程可測） |
| 資料庫 | `tpass db setup [svc]` | 首次 / schema 變更後（自動建 role+db+跑 prisma） |
| push 前把關 | `tpass check [svc\|all]` | 每次 push 前（lint + tsc --noEmit） |
| production 煙測 | `tpass start [svc\|all]` | 大改動 push 前（build + 最貼近 prod 的 start） |
| 部署 | `tpass deploy [svc\|all]` | merge 到 main 後 |
| 看狀態 / log | `tpass status`、`tpass logs <svc>` | 隨時 |
| 圖形介面 | `tpass ui` | 以上全部不想打字時 |

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

## 3. push 前

```bash
scripts/tpass check        # lint + tsc，全綠才 push
scripts/tpass start        # 大改動再跑：build + start:https（抓 RSC/React Compiler 差異）
```

各服務 repo 開分支 → push → GitHub PR → merge 到 main。**不直接 push main。**

## 4. 部署

```bash
scripts/tpass deploy form   # 單一服務
scripts/tpass deploy        # 全部（services.json 裡 deployed:true 的）
```

主機端流程（`deploy/deploy.sh`，經 ssh 觸發）：ops repo `git pull` 自我更新 →
服務 repo `git pull --ff-only` → env 必填檢查 → 鎖檔變動才 `npm ci` →
`prisma generate` → `npm run build` → 依 `db.strategy` 套 schema →
`pm2 startOrReload`（zero-downtime）。

主機拓撲、nginx / Cloudflare、需要 root 的操作見 `docs/DEPLOY.md`。
主機連線機密只存在 gitignored 的 `deploy/host.env`（`scripts/ssh.sh` 讀）。

## 5. 新增服務

```bash
scripts/tpass new <id>
```

互動式登記進 `services.json`（port 撞車會直接被 registry 驗證擋下）、重生憑證，
並印出完整人工清單（nginx vhost 給 root 部員、DNS、auth 白名單、portal 卡片…）。
文檔骨架標準見 `docs/SERVICE-TEMPLATE.md`。

## 6. 疑難排解

| 症狀 | 解法 |
| --- | --- |
| 消費端登入後一直掉回登入頁 | 用 `tpass dev` 啟動（處理 JWKS TLS 信任）；檢查 iss/aud env |
| `tpass deploy` 報 git 錯誤 | 主機 `~/tpass` 工作樹不乾淨或尚未 git 化——見 `docs/MERGE-AND-DEPLOY.md` |
| env 缺 key 導致 build 炸 | `tpass check env <svc>` 列出缺哪些；真相在 `src/config/*.ts` REQUIRED |
| Postgres 沒起來 | `brew services start postgresql@17`；`tpass db setup` 會自動嘗試 |
| 憑證過期 / 加了新子網域 | 重跑 `tpass setup`（會重生憑證） |
