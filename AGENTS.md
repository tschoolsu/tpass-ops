# TSchool 數位服務平台 — AI Agent 入口

> 你（AI agent / 工程師）一進到 `tschool/` 先讀這份。這是**地圖與真相來源層級表**，
> 不是內容本身——實質內容在各子專案的權威文件裡，這裡只負責把你導到對的那一份，
> 並標出「哪些舊文件已經被現實取代、別照做」。

---

## 0. 一句話

這是 **TSchool（數位實驗高中）學生會數位服務團隊**的校園服務門戶平台與 SSO 生態系。
師生用學校 Google 帳號**登入一次**，即可通行所有由不同學生團隊獨立開發的子模組
（點餐、場地預約、社團簽到、公告、遺失物…）。

核心機制：**中央發證、各服務本地驗章、頂層 cookie 跨子網域共用**。
auth 用私鑰簽 EdDSA JWT，各服務只拿公鑰（JWKS）在自己後端驗章，**不回呼 auth**。

---

## 1. 目錄地圖（兩個獨立 git repo，不是 monorepo）

| 目錄      | 角色                              | 網域（本機）                 | 一句話                                                                                |
| --------- | --------------------------------- | ---------------------------- | ------------------------------------------------------------------------------------- |
| `tpass-auth/`   | **中央 SSO 發證端**               | `https://auth.lvh.me:3000`   | 跑 Google OAuth → 簽 EdDSA JWT → 寫頂層 cookie + 公開 JWKS。**唯一持有私鑰者。**      |
| `tpass-portal/` | **門戶大廳（消費端 + 參考實作）** | `https://portal.lvh.me:3001` | 讀 cookie、用 JWKS 公鑰本地驗章、渲染服務發射台。其他子模組團隊**照抄它的串接寫法**。 |

> ⚠️ 每個服務子專案各有自己的 `.git`。**頂層 `tschool/` 現在是獨立的 `tpass-ops` git repo**，
> 但**只追蹤 ops 層**（`scripts/`、`deploy/`、`AGENTS.md`、`DEV-SOP.md`、`GIT-REPOS.md`）。
> 各服務子 repo 仍完全獨立、被頂層 `.gitignore` 排除（deny-all 白名單），頂層 git 從不碰它們。
> 🚫 鐵律：**不要 `git add` 子 repo、`deploy/host.env`、`certs/`、`~/`**——機密與服務碼都不進 ops repo。
> （為何以前寫「不要 git init」？因為那時主機 IP/帳號硬寫在文件裡；機密已抽到 gitignored `deploy/host.env` 後，此顧慮消除。）

---

## 2. 真相來源層級表（要動手前先讀對應那份）

**規則：底下這些是權威文件。需要實質資訊時讀它們，不要憑這份 AGENTS.md 的摘要寫 code。**

| 你想知道…                                                                  | 權威文件                                                                       | 狀態                                  |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | ------------------------------------- |
| **登入怎麼串**（cookie、JWT、JWKS、驗章四鐵則、各語言範本）                | `tpass-auth/INTEGRATION.md`（523 行，最完整）、`tpass-portal/INTEGRATION.md`（消費端視角） | 🟢 權威                               |
| **驗章參考實作**（直接照抄）                                               | `tpass-portal/src/lib/tpass-auth.ts`                                                 | 🟢 權威                               |
| **UI 風格 / design system**（顏色、字體、Neobrutalism 邊框陰影、元件模式） | `tpass-portal/docs/design.md`                                                        | 🟢 權威                               |
| **設定怎麼讀**（全 env 驅動，不寫死網域）                                  | `tpass-auth/src/config/auth.ts`、`tpass-portal/src/config/portal.ts`                       | 🟢 權威                               |
| **服務清單怎麼加**                                                         | `tpass-portal/src/config/services.ts` + `tpass-portal/docs/architecture.md`                | 🟢 權威                               |
| **產品願景 / 背景需求**                                                    | `tpass-portal/docs/PRD.md`                                                           | 🟢 v1.1.0 技術段落已對齊實作（見 §5） |

---

## 3. UI 風格 30 秒速覽（細節一律以 `tpass-portal/docs/design.md` 為準）

- **定位**：Playful Tech / Bright Pop Tech。**嚴格 light-only**，白底、糖果色、Neobrutalism。
- **顏色**：一律 **OKLCH**，禁止 hex / rgb。primary 綠、accent 藍。
- **字體**：Plus Jakarta Sans（sans/heading）、Geist Mono（badge / 標籤 / code-like）。
- **Neobrutalism 鐵則**：所有互動元素 = `border-2 border-foreground` + **hard offset shadow**
  （`shadow-[Xpx_Xpx_0_0_...]`），hover 上移、shadow 變大。**禁止 soft shadow（`shadow-md` 等）。**
- **禁止**：dark mode / `dark:` 前綴、hex/rgb、無邊框卡片、`shadow-sm/md`、圓角超過 `rounded-2xl`。

> 🚫 PRD 裡寫的「科技霓虹**暗色調**」是舊草案，**已被現實取代**。不要做暗色或霓虹發光，照 `design.md`。

---

## 4. 登入串接 30 秒速覽（細節一律以 `INTEGRATION.md` 為準）

要把一個新服務接上 SSO，本質只有四步（完整版見 `tpass-auth/INTEGRATION.md §12`）：

1. 在**後端**讀 `tpass_session` cookie（`HttpOnly`，前端 JS 讀不到 → 純前端 SPA 接不了，必須自備薄後端）。
2. 用 `jose` 的 `createRemoteJWKSet` 抓公鑰，`jwtVerify` 驗章。**四鐵則一個都不能少**：
   - `algorithms: ['EdDSA']`（不鎖 = alg confusion 偽造，公鑰被當對稱密鑰）
   - `issuer` 檢查、`audience: 'tschool-sso'` 檢查、`exp` 檢查
3. 沒有有效 session → 導去 `…/api/auth/login?redirect_uri=<本服務完整網址>`（須在白名單根網域下）。
4. 登出 → `POST …/api/auth/logout`（清頂層 cookie，整個生態系一起登出）。

**所有網址 / 網域都是 env 驅動的**（`AUTH_BASE_URL`、`AUTH_ALLOWED_HOST_SUFFIX`、`JWT_ISSUER`…），
上線換正式網域只改 `.env.local`，不動邏輯。**永遠不要把網域寫死在程式裡。**

---

## 5. PRD 與現實已對齊（v1.1.0）

`tpass-portal/docs/PRD.md` 原為 v1.0.0「Vibe Coding 基底版」草案，技術細節曾與實作牴觸；
**已於 v1.1.0 校正完畢**，現可放心參考。當初校正的重點（供仍記得舊版的人對照）：

| 舊草案寫的                      | 已校正為（現實）                                               |
| ------------------------------- | -------------------------------------------------------------- |
| 「科技霓虹**暗色調**」UI        | **light-only Neobrutalism**（`tpass-portal/docs/design.md`）         |
| `Auth.js (NextAuth)`            | **`arctic` + `jose`** 自建發證（`tpass-auth/` 實作）                 |
| `grade: 11`（number）           | `grade: string \| null`，且**目前恆為 `null`**（未接學籍目錄） |
| payload 隱含「一定有年級/角色」 | `role` **目前恆為 `"student"`**，placeholder，程式要容忍       |
| 子模組「解密 JWT」              | 是**驗章（verify 簽章）**，payload 沒加密                      |

> 各技術細節的**權威來源**仍是 `design.md`（UI）/ `INTEGRATION.md`（串接）/ 實際 code；PRD 給願景與背景。

---

## 6. 給 agent 的鐵律（do / don't）

**Next.js 版本**：本專案用 **Next 16.2.9 + React 19**，API 可能與你的訓練資料不同。
寫 Next code 前先讀 `node_modules/next/dist/docs/`（各子專案 `AGENTS.md` 已警告）。
`tpass-portal` 啟用了 React Compiler。**禁止 `npm run dev`**；檢查用 `npm run lint` + `npx tsc --noEmit`。

**安全 / 架構紅線（來自 INTEGRATION.md，違反就是 bug）：**

- ❌ 消費端不要 import / 複製 auth 的私鑰、`arctic`、OAuth callback。**只需要公鑰。**
- ❌ 不要在前端驗章、不要把 token 塞 `localStorage`、不要關掉 `algorithms: ['EdDSA']` 鎖定。
- ❌ 不要把網域 / issuer / audience 寫死——讀 `config/*`（env 驅動）。
- ❌ 不要嘗試自動化 Google 登入（會被擋、違反條款）。要真人登入時**停下來請使用者手動完成**。
- ✅ UI 一律 light-only Neobrutalism + OKLCH，照 `design.md`。

---

## 7. 新增一個子模組服務的標準流程

1. 在 `tpass-portal/src/config/services.ts` 加一個 `Service` 物件（id / name / url / lucide icon / tone / roles / enabled）。
   發射台會自動渲染卡片，**不必動 UI 元件**。
2. 該服務自己的 repo：照 `tpass-portal/src/lib/tpass-auth.ts` 做後端驗章（§4 四鐵則）。
3. 網域掛在生態系根網域底下（本機 `*.lvh.me`，上線換正式根網域），走 HTTPS。

> 服務數量 > 10 或要讓非技術幹部用 UI 管理時，才把 config 搬資料庫 + 建 `GET /api/services`
> （見 `tpass-portal/docs/architecture.md` 的 Phase 2 條件）。在那之前，**加 config 物件就好，別過度設計。**

---

## 8. 本機跑起來（踩雷重災區看 INTEGRATION.md §9）

- 兩服務都跑 HTTPS，共用 mkcert 憑證；先 `mkcert -install` 信任根憑證。
- 後端 fetch HTTPS JWKS 時 Node 不讀 OS 信任區 → 啟動帶
  `NODE_EXTRA_CA_CERTS="$(mkcert -CAROOT)/rootCA.pem"`（各 repo `package.json` 的 `start:https` 已寫好）。
- `lvh.me` 由公共 DNS 解析到 `127.0.0.1`，**免改 `/etc/hosts`**。
- 真值在各 repo 的 `.env.local`（不進 git）；範本見 `tpass-auth/.env.example`。

---

## 9. 部署主機連線（機密，永不進 git）

> ⚠️ 主機位址與帳號是機密，存在 **gitignored 的 `deploy/host.env`**（範本 `deploy/host.env.example`）。
> **絕對不要**把主機 IP / 帳號寫進任何被追蹤的檔案——包含各服務子 repo、本 `tpass-ops` repo 的文件、
> commit、PR 或 `.env.example`。頂層 `.gitignore` 已把 `deploy/host.env` 排除。

- **需要進主機時**（機密只從 `deploy/host.env` 讀，用本機已裝好的私鑰免密碼）：

  ```bash
  scripts/ssh.sh                 # 開互動 shell
  scripts/ssh.sh 'pm2 list'      # 或帶命令執行
  ```

- **權限**：部署帳號**沒有 root**。任何需要 root 的操作先停下來問使用者，不要自己嘗試 `sudo`。
- **服務怎麼跑**：目前所有專案都由該部署帳號用 **PM2** 起（`pm2 list` / `pm2 logs <name>` / `pm2 restart <name>`）。
  部署 SOP 見頂層 `DEV-SOP.md`（自架 PM2 + Caddy，非 Coolify）。
