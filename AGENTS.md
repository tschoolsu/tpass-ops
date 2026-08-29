# TSchool 數位服務平台 — AI Agent 入口

> 你（AI agent / 工程師）一進到 `tschool/` 先讀這份。這是**地圖與真相來源層級表**，
> 不是內容本身——實質內容在各子專案的權威文件裡，這裡只負責把你導到對的那一份，
> 並標出「哪些舊文件已經被現實取代、別照做」。

---

## 0. 一句話

這是 **TSchool（數位實驗高中）學生會數位服務團隊**的校園服務門戶平台與 SSO 生態系。
師生用學校 Google 帳號**登入一次**，即可通行所有由不同學生團隊獨立開發的子模組
（問卷、跨屆代傳、申訴、公告、遺失物…）。

核心機制（**契約 v2**）：**中央發證、per-service token、各服務本地驗章、host-only cookie**。
auth 用私鑰簽 EdDSA JWT（每服務一個 `aud=tpass:<id>`），各服務只拿公鑰（JWKS）
在自己後端驗章，**不回呼 auth**；token 存各服務自己網域的 cookie，不跨子網域共用。

---

## 1. 目錄地圖（多個獨立 git repo，不是 monorepo）

| 目錄 | 角色 | 網域（本機） | 一句話 |
| --- | --- | --- | --- |
| `tpass-auth/` | **中央 SSO 發證端** | `https://auth.lvh.me:3000` | Google OAuth → 簽 per-service EdDSA JWT → 公開 JWKS。**唯一持有私鑰者**；同時是權限真相（Postgres：Subject/Grant/AuditLog）與其管理面板 `/admin` 所在地。 |
| `tpass-portal/` | **門戶大廳（消費端 + 參考實作）** | `https://portal.lvh.me:3001` | 發射台；其他子模組團隊**照抄它的串接寫法**（lib + callback/logout route）。 |
| `tpass-form/` | 問卷系統（T-Form） | `https://form.lvh.me:3002` | 問卷建構/填寫/匯出，PostgreSQL+Prisma。 |
| `tpass-cross_grade_messages/` | 跨屆代傳（T-Msg） | `https://msg.lvh.me:3003` | 訊息廣播到 Google Chat webhook，PostgreSQL+Prisma。 |
| `tpass-appeals/` | 申訴系統（T-Appeals） | `https://appeals.lvh.me:3004` | 申訴收件 + Discord 通知，PostgreSQL+Prisma。 |
| `tpass-notes/` | 共編筆記（T-Notes） | `https://notes.lvh.me:3007` | 學術部共編筆記，**不是 Prisma**——直接用 `pg` + `POSTGRES_URL`，schema 由服務自己 `CREATE TABLE IF NOT EXISTS`（註冊表 `strategy:"none"`）。2026-08-26 納入 ops 部署管道並上線。 |
| `tpass-buddy/` | 直屬配對（T-Buddy） | `https://buddy.lvh.me:3008` | 115 直屬活動限定的臨時服務，無資料庫（狀態是 gitignored 的 `data/pairs.json`）。活動結束就下架。 |
| `tpass-meeting/` | 會議輔助（T-Meeting） | `https://meeting.lvh.me:3009` | 會議記錄/簽到/表決 + API key，`pg`（`strategy:"none"`）。**線上活著但註冊表是 `deployed:false`**：主機那份 npm 裝、目錄屬 root、自帶 `ecosystem.config.js`，`deploy.sh` 跑不動，目前由 **root 的 pm2** 手動跑。上線步驟見 `docs/specs/2026-08-26-platform-hardening-plan.md` 的 A3 註記。 |
| `tpass-vote/` | 選舉系統（T-Vote） | `https://vote.lvh.me:3006` | 開發中，尚未上線（註冊表 `deployed:false`）。設計決策見 memory。 |
| `tpass-directory/` | 目錄服務 | — | **2026-07-05 封存**，不部署；留作參考。 |
| `tpass-auth-js/` | **驗章共用套件** | — | **public repo**，並排 clone（非必要——各服務是用 git URL 安裝它，不是相對路徑）。消費端的驗章四鐵則、callback/logout route handler 都在這裡，有 27 個測試守著。**2026-08-27 起六個消費端都吃它，不要再在服務裡手抄 `lib/tpass-auth.ts`。** |
| `tpass-ui/` | **UI 元件共用套件** | — | **public repo**（v1.0.0），並排 clone（非必要——git URL 安裝：`pnpm add github:tschoolsu/tpass-ui#v1.0.0`）。匯出 `cn/Button/Input/Textarea/Select/Card/Badge/Label/Switch/ConfirmDialog` + `tpass-ui/theme.css`。消費端 `globals.css` 改 `@import "tailwindcss"; @import "tpass-ui/theme.css"; @source "../../node_modules/tpass-ui/dist";`（Tailwind v4 預設不掃 node_modules，`@source` 必加）。`dist/` 進 git、CI 守同步，跟 `tpass-auth-js` 同一套模式。**2026-08-29 起 form/appeals/msg/vote 四個消費端吃它，不要再在服務裡手刻 `src/components/ui/primitives.tsx`。** |
| `tpass-skills/` | **給部員的 Claude Code plugin** | — | **public repo**，同時是 marketplace。三個 skill：`tpass-design`、`tpass-auth`、`tpass-service`，加 `scripts/check.sh`（grep 檢查 hex/rgb/dark:/soft shadow/圓角、手抄驗章、groups、cookie Domain、v1 遺物、硬編碼網域、npm/yarn 鎖檔；消費端限定）。部員安裝：`/plugin marketplace add tschoolsu/tpass-skills` → `/plugin install tpass@tpass-skills`。細節見該 repo README。 |
| `tpass-registry/` | **服務註冊表（唯一真相）** | — | **public repo**，並排 clone。id/目錄/子網域/port/DB 策略/大廳卡片全在 `services.json`；auth 白名單、portal 卡片、pm2、deploy 全部從它派生，**不得另行硬編碼**。 |
| `scripts/tpass` | **唯一 ops 入口（CLI）** | — | dev/check/build/db/deploy/status/logs/new/ui；不帶參數＝互動選單。 |
| `monitoring/` | **監控**（Uptime Kuma 自架） | `https://status.tschoolsu.org` | docker-compose + 狀態頁 CSS + 給部員的部署手冊。**Kuma 本體跑在部員自己的機器上，不是 T-Pass 主機**（監控跟被監控物同機＝主機一死兩個一起消失）。`data/` 是 gitignored 的 SQLite，靠私下傳檔轉交。 |
| `docs/` | ops 文檔 | — | `handbook/`＝**給部員看、手動同步到團隊 HackMD 的四篇**（服務串接指南 / SSO 合約 / Design System / 註冊表 SOP），索引見 `docs/handbook/README.md`。根目錄留 ONBOARDING（開發與維運）/ SECURITY-REVIEW（稽核紀錄）。`docs/specs/` 是跨 repo 功能的實作規格暫存區，不是 ops 文檔。 |

> **git repos**（2026-08-27 核對）：**全部都是 public，包含 `tpass-ops` 本身**（＝頂層）。
> ⚠️ 這代表 **GitHub Actions 的執行紀錄也是公開的**——部署 log 裡不得出現主機位址
> （機密一律走 GitHub Secrets，值會被自動遮成 `***`）。
> `tpass-registry`、`tpass-auth`、`tpass-portal`、`tpass-form`、`tpass-cross_grade_messages`、
> `tpass-appeals`、`tpass-notes`、`tpass-meeting`、`tpass-ui`、`tpass-skills`、`tpass-vote` 都在
> **`tschoolsu` 組織**底下且是 **public**。
> `tpass-buddy` 在 **`YC815`** 個人帳號底下（臨時服務，未轉移）。
> `tpass-directory`（封存）**尚未有 GitHub repo**，只存在於本機。
> ⚠️ `tpass-notes` 與 `tpass-meeting` 是直接在主機上開發出來的，**本機預設沒有 clone**；
> 主機上各服務的 `origin` 多半還指著轉移前的舊擁有者（靠 GitHub 轉址在動）。
> **本機**：全部並排在同一層（`tpass-registry` 與各服務同層），auth / portal 靠
> `../tpass-registry/services.json` 這條相對路徑找註冊表。
> **主機**（2026-08-03 起分岔）：ops repo + `tpass-registry` 在 `~/tpass`，**各服務 repo 一律在
> `/home/service/<dir>`，一個服務一層，那層不放別的東西**。主機上相對路徑不成立，改由 ops 層注入
> 絕對路徑 `TPASS_REGISTRY_PATH`（`ecosystem.config.js` 的 env 管 runtime、`deploy.sh` 的 export 管 build），
> 服務程式碼與 `.env.local` 都不必為此改動。兩條路徑的真相＝`tpass-registry/services.json` 的
> `server.opsRoot` / `server.servicesRoot`，**腳本裡不得寫死**。

> ⚠️ 每個服務子專案各有自己的 `.git`。頂層 `tschool/` 是獨立的 **`tpass-ops`** git repo，
> 只追蹤 ops 層（`scripts/`、`deploy/`、`docs/`、這些 md）。
> 各服務子 repo 與 `tpass-registry/` 被頂層 `.gitignore`（deny-all 白名單）排除，頂層 git 從不碰它們。
> 🚫 鐵律：**不要 `git add` 子 repo、`tpass-registry/`、`deploy/host.env`、`certs/`、`~/`**——機密與服務碼都不進 ops repo。
> 🚫 **`tpass-registry` 是公開的**：任何密鑰、密碼、主機位址都不得出現在那裡。

---

## 2. 真相來源層級表（要動手前先讀對應那份）

**規則：底下這些是權威文件。需要實質資訊時讀它們，不要憑這份 AGENTS.md 的摘要寫 code。**

| 你想知道… | 權威文件 | 狀態 |
| --- | --- | --- |
| **登入怎麼串**（契約：authorize/callback、四鐵則、payload、錯誤碼、各語言範本） | `tpass-auth/INTEGRATION.md` | 🟢 **權威** |
| **開一個新服務 → 串登入 → 上線**（部員動手版，Next.js，自給自足） | `docs/handbook/01-new-service.md` | 🟢 權威（人類讀這份） |
| **驗章實作**（不要再手抄） | 套件 **`tpass-auth-js`**（`github:tschoolsu/tpass-auth-js`）；用法參考 `tpass-portal/src/config/portal.ts` + `src/app/api/auth/{callback,logout}/route.ts` | 🟢 權威 |
| **開發 / 部署 / 主機 / nginx / Cloudflare / 排錯**（自給自足） | `docs/ONBOARDING.md`（`tpass` CLI 為唯一入口） | 🟢 權威 |
| **服務清單 / port / DB 策略 / 大廳卡片** | `tpass-registry/services.json`（唯一真相，public repo）；欄位定義見該 repo `README.md` | 🟢 權威 |
| **改服務註冊表**（新增服務 / 改欄位 / 上線翻 `deployed` / 主機紅線 / 改完誰重部署） | `docs/handbook/04-registry-sop.md` | 🟢 權威 |
| **監控 / 告警 / 備份死人開關**（現況、紅線、轉換狀態） | `docs/ONBOARDING.md` §6；部員部署版＝`monitoring/HANDOFF.md` | 🟢 權威 |
| **安全審查發現與狀態** | `docs/SECURITY-REVIEW.md` | 🟢 權威 |
| **權限怎麼管**（role/restriction、ban/warning、panel 操作） | auth 的 `/admin` panel（實際管理介面）＋ `tpass-auth/INTEGRATION.md` §3（claim 契約與生效時間） | 🟢 權威 |
| **UI 風格 / design system** | `tpass-portal/docs/design.md` | 🟢 權威 |
| **UI 元件怎麼用**（不要手刻 primitives） | `tpass-ui` repo README | 🟢 權威 |
| **給部員的 agent 規則**（skill / check.sh） | `tpass-skills` repo README | 🟢 權威 |
| **設定怎麼讀**（全 env 驅動） | 各 repo `src/config/*.ts`（REQUIRED 陣列＝env 必填真相） | 🟢 權威 |
| **產品願景 / 背景需求** | `tpass-portal/docs/PRD.md` | 🟢 v1.1.0 已對齊實作 |

---

## 3. UI 風格 30 秒速覽（細節一律以 `tpass-portal/docs/design.md` 為準）

- **定位**：Playful Tech / Bright Pop Tech。**嚴格 light-only**，白底、糖果色、Neobrutalism。
- **顏色**：一律 **OKLCH**，禁止 hex / rgb。primary 綠、accent 藍。
- **字體**：Plus Jakarta Sans（sans/heading）、Geist Mono（badge / 標籤 / code-like）。
- **Neobrutalism 鐵則**：所有互動元素 = `border-2 border-foreground` + **hard offset shadow**
  （`shadow-[Xpx_Xpx_0_0_...]`），hover 上移、shadow 變大。**禁止 soft shadow（`shadow-md` 等）。**
- **禁止**：dark mode / `dark:` 前綴、hex/rgb、無邊框卡片、`shadow-sm/md`、圓角超過 `rounded-2xl`。
- **元件一律 import 自 `tpass-ui`**（`Button`/`Input`/`Card`/`ConfirmDialog`…），不要手刻 primitives。

---

## 4. 登入串接 30 秒速覽（細節一律以 `tpass-auth/INTEGRATION.md` 為準）

契約 v2，新服務接 SSO 本質五步（完整版見 `tpass-auth/INTEGRATION.md §12`）：

1. 服務 id 登記：對 `tpass-registry` 開 PR（**就這一處**；auth 白名單與 portal 卡片都從它派生）。
2. 未登入 → 導去 `…/api/auth/authorize?service=<id>&redirect_uri=<自己的callback>&next=<路徑>`。
3. 自備 `POST /api/auth/callback`：用 `jose` + JWKS 驗章（**四鐵則**：`algorithms:['EdDSA']`
   / `issuer` / `audience: 'tpass:<id>'` / `exp`）→ 寫**自己網域的 host-only HttpOnly cookie**。
4. 每請求後端讀自己的 cookie、同樣四鐵則驗章（`HttpOnly` → 純前端 SPA 接不了，要薄後端）。
5. 登出：自己的 `POST /api/auth/logout` 清自己 cookie，再鏈到 auth logout。

**所有網址 / id 都是 env 驅動**（`AUTH_AUTHORIZE_URL`、`TPASS_SERVICE_ID`、`JWT_ISSUER`…），
上線只改 `.env.local`。**永遠不要把網域寫死在程式裡。**

> 🕰 **v1（共用頂層 cookie `tpass_session`、aud `tschool-sso`）已於 2026-07-13 從程式碼中
> 完全移除**——auth 不再有簽發路徑，消費端不再有 fallback。**不要再寫任何 v1 相關的東西**
> （`Domain=.<根網域>` 的 cookie、`JWT_AUDIENCE`、`TPASS_COOKIE_NAME`）；若在舊文件或舊
> 分支看到它們，那是歷史，不是現況。

---

## 5. 給 agent 的鐵律（do / don't）

**Next.js 版本**：本專案用 **Next 16.2.x + React 19**，API 可能與你的訓練資料不同。
寫 Next code 前先讀 `node_modules/next/dist/docs/`（各子專案 `AGENTS.md` 已警告）。
**跑 dev**：本機必須是 HTTPS + `-H <svc>.lvh.me -p <port>`，且**消費端**要
`NODE_TLS_REJECT_UNAUTHORIZED=0`（Next server 端 fetch 不吃 `NODE_EXTRA_CA_CERTS`，
抓不到 auth 的 JWKS → 登入靜默鬼打牆）。這串已寫進各服務 `package.json` 的 `dev`，
所以 `pnpm dev` 是對的；`scripts/tpass dev` 是一次跑多個服務的捷徑。
**auth 不加那個 flag**（要驗 Google 真憑證），**主機永遠不加**（資安事故）。
agent 檢查一律 `pnpm lint` + `pnpm exec tsc --noEmit`（`scripts/tpass check` 做的就是這兩行，
外加前置的 `pnpm exec next typegen`——route 型別是 `.next/types/` 的產物，全新 clone 上少了它 tsc 必紅）。
**套件管理一律 pnpm**（`pnpm add` / `pnpm install`）；不要用 npm / yarn，不要生出 `package-lock.json`。

**安全 / 架構紅線（違反就是 bug）：**

- ❌ 消費端不要 import / 複製 auth 的私鑰、`arctic`、OAuth callback。**只需要公鑰。**
- ❌ 不要在前端驗章、不要把 token 塞 `localStorage`、不要關掉 `algorithms: ['EdDSA']` 鎖定。
- ❌ 不要在服務裡復活一份手抄的 `src/lib/tpass-auth.ts`（2026-08-27 六份全部刪掉了）。驗章要改就去 `tpass-auth-js` 改，那裡有測試；服務端只留 `config/*.ts` 那一行綁定。
- ❌ 不要在服務裡復活 `src/components/ui/primitives.tsx`（2026-08-29 四個消費端全刪，portal/auth 本來就沒有）。元件要改就去 `tpass-ui` 改，服務端只 import。
- ❌ 不要把網域 / issuer / audience / 服務清單寫死——讀 `config/*`（env）與 `tpass-registry`。
- ❌ **不要在 portal 或 auth 裡硬編碼服務清單**（曾經有過：portal 的卡片陣列 + `<SVC>_URL` env、
  auth 的 `AUTH_SERVICE_IDS`，兩者都已於 2026-07-31 廢除）。大廳卡片與發證白名單一律派生自
  `tpass-registry/services.json`；卡片網址由 `subdomain` + `domains` + `port` 推導，不入檔。
- ❌ 權限判斷一律讀 JWT 的 `permissions` claim（`perm.role`／`perm.read`，見
  `tpass-auth/INTEGRATION.md` §3）；`groups` 已於 2026-07-27 全面移除（不是 deprecated，是
  不存在），token 裡不會再有這個欄位，別再寫或讀 `groups.includes(...)`；
  各服務**不自維護 admin allowlist**——名單在 auth 的 `/admin` panel 管，不是 env、不是 DB。
- ❌ 不要嘗試自動化 Google 登入（會被擋、違反條款）。要真人登入時**停下來請使用者手動完成**。
- ❌ 消費端 cookie 不要設 `Domain=.<根網域>`（那是 v1，正在退場）。
- ✅ UI 一律 light-only Neobrutalism + OKLCH，照 `design.md`。

---

## 6. 本機跑起來（詳見 `docs/ONBOARDING.md`）

```bash
git clone https://github.com/tschoolsu/tpass-registry.git   # 一次性：註冊表必須並排存在，否則 auth/portal 起不來
scripts/tpass setup    # 一次性：mkcert + pnpm install + 金鑰 + DB（冪等）
scripts/tpass dev      # 日常：全服務 HTTPS + HMR（SSO 全流程可測）
scripts/tpass check    # push 前：lint + tsc
scripts/tpass ui       # 不想打字：本機圖形儀表板
```

- `lvh.me` 由公共 DNS 解析到 `127.0.0.1`，**免改 `/etc/hosts`**。
- 真值在各 repo 的 `.env.local`（不進 git）；範本見各 repo `.env.example`；
  必填清單真相＝`src/config/*.ts` 的 REQUIRED（`tpass check env` 可驗）。

---

## 7. 部署主機連線（機密，永不進 git）

> ⚠️ 主機位址與帳號是機密，存在 **gitignored 的 `deploy/host.env`**（範本 `host.env.example`）。
> **絕對不要**把主機 IP / 帳號寫進任何被追蹤的檔案、commit、PR。

- 部署：**首選是 GitHub Actions**——repo 的 Actions 分頁 → `deploy` → Run workflow，
  輸入服務 id（`all` / `ping` 也可）。任何有 repo 寫入權的人都能按，不需要主機憑證。
  本機 `scripts/tpass deploy [svc|all]` 保留不動，是那條管道壞掉時的逃生路徑。
  看狀態 `tpass status`；看 log `tpass logs <svc>`。
- 進主機：`scripts/ssh.sh`（互動）或 `scripts/ssh.sh '<cmd>'`。
- **agent 拿不到 root**。維運者本人在主機上有 sudo（要打自己的登入密碼），但 agent 無從代打——
  要動 nginx / 建 PostgreSQL role/db 的指令，**印出來交給人在主機貼一次**，不要嘗試代跑
  （`tpass new` 會印好）。主機細節見 `docs/ONBOARDING.md §5`。
