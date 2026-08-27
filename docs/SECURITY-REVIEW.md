# 安全審查紀錄（2026-07-06 全生態盤點）

> 範圍：tpass-auth（發證端全量）、五個消費端的驗章/授權/DB/上傳/webhook、ops 部署層。
> 逐條有 file:line 佐證，非臆測。狀態：✅ 已修（本輪 PR）/ 📝 已記錄（接受風險或另案）。
> 本輪修正的 PR：各 repo 的 `revamp/contract-v2` 分支。

## 總評

核心底子紮實：OAuth state+PKCE 正確、redirect_uri 後綴繞過已防、email 網域精確比對、
EdDSA 四鐵則全生態守住、私鑰只在 env、無 SQL injection（全 Prisma 無 raw query）、
無 secrets 進 git、admin 授權不信任 JWT 的 placeholder `role`（DB/env allowlist +
每個 action 重查）。以下是發現與處置。

## 發現清單

| ID | 級別 | 服務 | 發現 | 處置 | 狀態 |
| --- | --- | --- | --- | --- | --- |
| H1 | HIGH | 全生態 | 頂層共用 cookie + 單一 audience：任一子網域被攻破/接管 = 全生態帳號淪陷（callback 設 `Domain=.根網域`，全部服務驗同一 `tschool-sso`） | **契約 v2**：per-service token（`aud=tpass:<id>`）+ host-only cookie + authorize/form_post 交付。2026-07-08 以 env 停發 v1；**2026-07-13 v1 程式碼全數移除**（auth 的 `signSession` / `issueLegacyCookie` / 共用 cookie 寫入、四個消費端的 legacy fallback），隔離不再依賴任何設定值 | ✅ **完全關閉** |
| M1 | MED | form | `ANON_HASH_SECRET ?? ""`（`f/[slug]/actions.ts`）未列 REQUIRED——空 secret 時匿名雜湊可被已知 sub 清單暴力反解 | 列入 config REQUIRED（fail closed），程式改讀 `authConfig.anonHashSecret` | ✅ |
| M2 | MED | form | 扁平 admin：任一般 Admin 可讀/匯出**所有**問卷回應與附件（export / files route 只查 `isAdmin`） | 新增 `canReadResponses`：回覆/匯出/附件收斂為「問卷建立者或超管」；問卷編輯維持共管 | ✅ |
| M3 | MED | form | 上傳端點不驗 MIME/accept 清單、不看 `acceptingResponses`、無配額 | 伺服器端驗題目 accept 清單 + 尊重收件開關 + 每人每卷 20 檔配額 | ✅ |
| L1 | LOW | form | `lib/tpass-auth.ts` 留有兩行 `[TEMP DEBUG]` console.error（cookie 名/長度進 log） | 隨 v2 改寫移除 | ✅ |
| L2 | LOW | appeals | 提交無冷卻/去重——可灌爆 DB 與 Discord 頻道 | 30 分鐘冷卻（查最近一筆 Appeal；毫秒級競態可容忍）+ schema 補索引 | ✅ |
| L3 | LOW | msg / appeals | admin 可設任意 https webhook URL（有限 SSRF / 個資外導面） | msg pin `chat.googleapis.com`（警告改強制）；appeals pin `discord.com`/`discordapp.com` | ✅ |
| L4 | LOW | auth | per-service JWT TTL（原 8h）、無即時撤銷機制——身分失守後 token 有效至過期 | **2026-07-27 更新**：TTL 從 8h 降到 `JWT_TTL_SECONDS`（建議 45 分鐘），外洩/濫用窗口縮小 90%+；auth 登入態另拆 `AUTH_SESSION_TTL_SECONDS`（預設 12h，只影響「還算登入」，不影響單一服務 token 的外洩窗口）；ban 額外靠 `Subject.sessionsValidFrom` 讓 auth 登入態立即失效（換不到任何新票），已發出的 per-service 舊票仍活到自己的 `exp`（同一上限）。風險縮小仍接受：無狀態本地驗章（消費端不回呼 auth）是契約 v2 的地基，真正的即時撤銷要放棄這個地基，暫不做 | 📝 |
| I1 | INFO | auth | 單一 kid `tpass-key-1`，無輪替程序 | JWKS 已支援多鑰；輪替 runbook 待未來需要時撰寫 | 📝 |
| I2 | INFO | directory | `/api/internal/admin-sync` 接收端未實作；實作時 bearer secret 要 constant-time 比對、來源 env | directory 已封存，僅記錄 | 📝 |
| I3 | INFO | v2 取捨 | per-service cookie 使單點登出弱化為「auth 不發新票 + 舊票 ≤8h 過期」 | 契約 v2 已文檔化的刻意取捨 | 📝 |

## 已驗證良好（明確查過，無需動作）

- OAuth：state 比對 + PKCE（arctic）、暫存 cookie HttpOnly+Lax 10 分鐘。
- `isAllowedRedirect`：`host === base || host.endsWith("." + base)`——`evil-lvh.me` 類繞過已防；
  scheme 限 http/https；callback 端二次驗證。
- Email 閘門：`email_verified` + `endsWith("@" + domain)` 精確比對。
- 全部驗章鎖 `algorithms:["EdDSA"]`（六個 repo 逐一確認）；全在 server 端；無 localStorage token。
- 私鑰只在 `JWT_PRIVATE_KEY` env；`gen-keys.mjs` 不落盤；`.env*`/`*.pem` 全 gitignore；
  `git ls-files` 確認各 repo 只追蹤 `.env.example`（占位值）。
- 授權：**2026-07-27 改為 `permissions` claim + auth 內建 DB（Subject/Grant/AuditLog）+ 網頁後台
  `/admin`**（取代舊的 `AUTH_GROUPS` env 名單，見下方「權限系統上線」）。各消費端只讀
  `session.permissions[serviceId]`（`read`/`role`/`restriction`）本地授權，不再自維護 allowlist；
  細粒度授權（如問卷回覆限 owner/admin）仍在各服務本地，每個 server action 重呼 guard。
  `groups` 曾雙發、降級為過渡期相容層（由 `role` 推導）；**2026-07-27 Phase 7 退場完成**——
  auth 簽發邏輯與五個消費端程式碼已全數移除 `groups`，token 裡不再有這個欄位。
  舊的 `role:"student"` placeholder 與各服務 `SUPER_ADMIN_EMAILS` ∪ DB Admin 表已移除。
- CSRF：狀態變更走 server actions（框架 Origin 檢查）或 SameSite=Lax POST；logout 限 POST。
- DB：無 `$queryRaw` / `Unsafe`；Prisma 參數化。

## 權限系統上線（permissions claim + panel，2026-07-27）

取代舊的 `AUTH_GROUPS` env 名單：auth 新增 DB（Subject/Grant/AuditLog）+ 網頁後台 `/admin`，
JWT 改帶 `permissions` claim（role 三級 + restriction 兩種管制）。以下是這次上線的安全設計與
已接受的風險，逐條記錄（非「發現的漏洞」，而是新功能上線前的自我審查）。

| ID | 級別 | 主題 | 設計 / 風險 | 處置 | 狀態 |
| --- | --- | --- | --- | --- | --- |
| P1 | — | panel 守門模型 | `/admin` 本身的存取權就是這套權限模型自己（serviceId=`auth` 的 Grant，`role∈{admin,moderator}`）+ `AUTH_SUPERADMINS`（env 逃生門，不進 DB，DB 掛掉照樣有效） | 全走 server actions，不開 REST 管理端點（沒有可被繞過 layout 直打的 API 面）；每個 server action 各自呼叫 `requireAuthAdmin()` / `requireAuthModerator()`，不只靠 layout 擋 | ✅ |
| P2 | — | moderator 不可改 role | moderator 能下 warning/ban（含填 reason/到期），但**不能**把任何人（含自己）的 `role` 改成 admin/moderator/default——防止「有管制權限的人」自我提權 | server action 層檢查，非只藏 UI 按鈕 | ✅ |
| P3 | — | superadmin 保護 | 不能 ban／降級 `AUTH_SUPERADMINS` 名單內的人；admin 不能調降自己在 auth 的 role（防手滑把自己鎖在 panel 外、DB 又剛好沒有其他 admin） | server action 層檢查 | ✅ |
| P4 | — | audit log | 每次權限變更（role / restriction / 刪除人員）寫一筆 `AuditLog`（at / actorEmail / targetEmail / serviceId / action / before / after）——「誰把我 ban 的」的追溯需求，一次 insert 是最便宜的保險 | `/admin/audit` 可查閱、可過濾 | ✅ |
| P5 | LOW | fail-open 降級 | 簽章路徑查權限（`permissionsFor` / `overviewFor`）若 DB 查詢失敗，降級為 `{read:true, role:"default"}`，大聲 log 但不擋登入；一般消費端解析 claim 時同樣的安全預設值（缺 claim / 缺 serviceId → `read:true, role:"default"`） | 刻意選擇可用性優先於懲罰漏網——全鎖等於連救火的人都進不去；`AUTH_SUPERADMINS` 走 env、不受這個降級影響，逃生門仍然有效 | 📝 接受風險 |
| P6 | — | reason 不進 URL | ban 原因屬敏感資訊（可能含個資 / 糾紛細節）；`authorize` 導向 `/denied?service=<id>` 只帶 service id，reason 由 `/denied` 頁憑使用者自己的 auth session 重查 DB 取得，不落 URL / Referer / 瀏覽器歷史 / 存取 log | 已實作 | ✅ |

| P7 | LOW | 刪除人員（2026-07-28 補） | panel 可刪 Subject（Grant 隨 `onDelete: Cascade` 一起消失）。風險：**刪除等於解除該人所有服務的管制**，且 ban 寫的 `Subject.sessionsValidFrom` 一併消失——他手上未過期的 auth 登入態（最長 `AUTH_SESSION_TTL_SECONDS`，預設 12h）會立刻復活，比解 ban 還快生效 | 僅 admin（moderator 連 role 都不能改，更不該能整筆抹掉）；不可刪自己、不可刪 `AUTH_SUPERADMINS`；刪前把完整 grant 清單快照進 `AuditLog`（`action: subject.delete`，`before` 存清單）；UI 在危險區塊與確認框各警告一次「刪除不是封鎖，要擋人請用 ban」 | 📝 接受風險 |

對照組：這次上線同時把 L4（TTL / 撤銷機制）的風險面縮小，見上方發現清單 L4 更新。

## 申訴通知的外流面（appeals → Discord，2026-08-26 發現 / 08-27 收斂）

2026-08 平台體檢時發現，來源是加固計畫 A4（`docs/specs/2026-08-26-platform-hardening-plan.md`）。
不是新功能的自我審查，是既有行為被重新評估。

| ID | 級別 | 主題 | 發現 | 處置 | 狀態 |
| --- | --- | --- | --- | --- | --- |
| A4-1 | **MED** | appeals | 每筆申訴的**實名 + 年級 + email + 全文 + 圖片原檔**以 webhook 貼進 Discord，而那個頻道當時是**全體學生會**。申訴的對象很可能就是學生會或其幹部——被申訴人本人看得到申訴人是誰、寫了什麼、附了什麼照片。整條路徑在 `permissions` claim 與 `AuditLog` 之外：auth `/admin` 把 role 降回 `default` 只擋得住後台，Discord 頻道的成員名單不隨之收回，卸任、畢業都不會自動掉；也沒有存取紀錄、沒有保留政策 | 兩半都做：①**程式碼**（`tpass-appeals` `1a1f0ae`）通知收斂成 thread 標題（姓名+時間）+ embed author（姓名·年級）+ 後台深連結 + 附件**數量**，拿掉 email、全文與整條圖片 multipart 路徑；②**頻道**（2026-08-27）Discord 側收斂成只有申訴承辦人可見，**webhook URL 沿用**，舊 thread 跟著權限一起收進去 | ✅ |
| A4-2 | LOW | appeals | 附件位元組直送 Discord CDN，等於在 `/api/files`（admin cookie 保護）之外多開一條**沒有驗證的取檔路徑**——保護等級由最弱那條決定 | 隨 A4-1 一併移除（`collectImageAttachments` 整個刪掉）；通知只報附件數量，連檔名都不送（檔名本身可能是實名或事件描述） | ✅ |
| A4-3 | 📝 | appeals | **頻道那半沒有任何程式碼在守它**：下一任把頻道權限放寬，或把 webhook 改貼回大頻道，外流就回來，而且不會有任何測試或 CI 會紅 | 已在 `src/lib/discord.ts` 檔頭寫死警告、在 `AGENTS.md` 列鐵律；`tpass-appeals/src/lib/discord.test.ts` 有一條直接對整包 request body 斷言找不到 email 與內容字串（擋程式碼那半，擋不了頻道那半）。加固計畫 C3 的上線檢查表已補「通知送到哪、誰看得到」 | 📝 接受風險 |
| A4-4 | LOW | appeals | `src/config/admin.ts` 的 `isAdmin` 是 `role !== "default"`——**任何 moderator 都讀得到全部申訴，沒有分案隔離**。跟 form 的 M2（扁平 admin 可讀所有問卷回應）是同一類問題，form 已修、appeals 未修 | 需要權限模型討論（照 M2 的做法收斂成「承辦人或超管」？申訴沒有「建立者」這個天然的收斂軸，要另想）。加固計畫已記錄為 A 層之外的獨立項目 | 📝 **未處理** |

## 下次審查提醒

- 新服務上線時跑一遍 `tpass-auth/INTEGRATION.md §12` 的驗收清單（含四種假 token 測試）。
- ~~v1 共用 cookie 退場~~ ✅ 2026-07-13 程式碼層面完成，H1 完全關閉。
  主機各 `.env.local` 可能還留著 `JWT_AUDIENCE` / `AUTH_COOKIE_NAME` / `AUTH_COOKIE_DOMAIN` /
  `AUTH_ISSUE_LEGACY_COOKIE` / `TPASS_COOKIE_NAME` —— 已無程式讀取，**不影響安全**，
  下次動主機 env 時順手清掉即可。
- 檢查 Cloudflare 上有無 dangling DNS 子網域（H1 的殘餘面）。
- **A4-4（appeals 的 moderator 扁平化）還開著**——下次審查若它仍未處理，重新評估級別：
  申訴內容的敏感度高於問卷回應，而 form 的同類問題（M2）早就修了。
- 順手確認 appeals 的 Discord 通知**沒有被加回內容**，以及那個頻道**還是只有承辦人**
  （A4-3：這一半沒有程式碼在守）。
