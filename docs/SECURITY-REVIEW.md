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
| L4 | LOW | auth | JWT TTL 8h、無撤銷機制——身分失守後 token 有效至過期 | 接受風險（授權每請求查 DB allowlist 已緩解）；未來如需即時撤銷再做 iat-cutoff | 📝 |
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
- 授權：`resolveClaims` 的 `role:"student"` 是 placeholder，無任何消費端拿它做權限；
  全部用 `SUPER_ADMIN_EMAILS` 種子 ∪ DB Admin 表，且每個 server action 重呼 guard。
- CSRF：狀態變更走 server actions（框架 Origin 檢查）或 SameSite=Lax POST；logout 限 POST。
- DB：無 `$queryRaw` / `Unsafe`；Prisma 參數化。

## 下次審查提醒

- 新服務上線時跑一遍 `tpass-auth/INTEGRATION.md §12` 的驗收清單（含四種假 token 測試）。
- ~~v1 共用 cookie 退場~~ ✅ 2026-07-13 程式碼層面完成，H1 完全關閉。
  主機各 `.env.local` 可能還留著 `JWT_AUDIENCE` / `AUTH_COOKIE_NAME` / `AUTH_COOKIE_DOMAIN` /
  `AUTH_ISSUE_LEGACY_COOKIE` / `TPASS_COOKIE_NAME` —— 已無程式讀取，**不影響安全**，
  下次動主機 env 時順手清掉即可。
- 檢查 Cloudflare 上有無 dangling DNS 子網域（H1 的殘餘面）。
