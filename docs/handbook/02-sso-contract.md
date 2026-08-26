---
title: T-Pass SSO 串接合約（契約 v2）
tags: T-Pass, 手冊
---

> **這份是同步副本。** 技術權威在 [`tschoolsu/tpass-auth`](https://github.com/tschoolsu/tpass-auth) 的 `INTEGRATION.md`——
> 那份跟 auth 的程式碼放在一起，改契約的人改的是那份。要改內容請改來源再同步過來。
> 同步自 `tpass-auth@f1b3b93`（2026-08-21）。

# T-Pass SSO 串接指南（權威合約・契約 v2）

> 這份文件是 **T-Pass 中央發證服務（auth）** 的對接合約，給兩種讀者：
>
> 1. **人類工程師** — 想把自己的校園服務接上「一次登入、全生態系通行」。
> 2. **AI coding agent（例如 Claude Code）** — 要直接照這份文件幫某個服務寫出串接程式碼。
>    → 如果你是 agent，先讀最後的 [§12 給 AI agent 的實作指令](#12-給-ai-agent-的實作指令)。
>
> auth 的職責：**跑 Google OAuth 確認身分**、**對每個服務簽發只在該服務有效的 EdDSA JWT**、
> **公開 JWKS 公鑰**。你的服務 **不需要、也拿不到任何密鑰**；你只用公鑰在自己後端本地驗章。
>
> ✅ **v1（跨子網域共用 cookie）已於 2026-07-13 從程式碼完全移除**，只剩 v2 一條路。
> 見 [附錄 A](#附錄-av1-已移除歷史)。

---

## 0. 一分鐘心智模型

```
┌──────────────┐ 1. 未登入 → 導去 auth /authorize   ┌──────────────────────────┐
│   你的服務    │ ─────────────────────────────────▶ │   auth.lvh.me（本服務）    │
│  foo.lvh.me  │                                    │ - 沒登入態→先跑Google OAuth │
│              │ ◀───────────────────────────────── │ - 簽 aud=tpass:foo 的 JWT  │
└──────────────┘ 2. form POST token 到你的 callback  └──────────────────────────┘
       │ 3. 你的 callback 用 JWKS 公鑰「本地驗章」，             │
       │    驗過才寫進「你自己的」host-only cookie               │（啟動時抓一次即可）
       └────────────── 4. 之後每個請求讀自己的 cookie ◀─ JWKS 公鑰 ─┘
                         本地驗章認出使用者（全程不回呼 auth）
```

關鍵設計：

- **非對稱簽章**：auth 用私鑰簽、你用公鑰驗。私鑰永遠不出 auth；驗章在你自己後端做，
  **不需要每次請求都打 auth** → auth 當機也不影響「已登入者」被你認出。
- **per-service token（v2 核心）**：每個服務拿到的 token `aud=tpass:<你的服務id>`，
  **只在你的服務驗得過**。就算某個服務被攻破、或某個子網域被接管，攻擊者拿到的 token
  在其他服務一律無效——爆炸半徑只有單一服務。
- **host-only cookie**：token 存在**你自己網域**的 cookie（不設 `Domain`），
  別的子網域根本收不到，瀏覽器不會把你的通行證送去任何其他服務。

---

## 1. 環境與網域（本測試階段的具體值）

| 角色 | 網址（本機測試階段） | 說明 |
| --- | --- | --- |
| 中央發證 auth | `https://auth.lvh.me:3000` | 本服務 |
| 範例消費端 portal | `https://portal.lvh.me:3001` | 門戶（同時是參考實作） |
| 你的服務 | `https://<你的子網域>.lvh.me:<port>` | 必須在 `*.lvh.me` 底下 |

> **為什麼是 `lvh.me`？** `lvh.me` 及其所有子網域由公共 DNS 直接解析到 `127.0.0.1`，
> 且 `.me` 是 Google OAuth 接受的公共 TLD。本機開發**不需要改 `/etc/hosts`**。
> **上線後**換正式網域（`*.tschoolsu.org`）。**所有網址都是 env 驅動的**（見 §10），不要寫死。

---

## 2. 契約速查（先看這張表）

| 項目 | 值 |
| --- | --- |
| **你的服務 id** | 對 `tschoolsu/tpass-registry`（public）開 PR 登記進 `services.json`，例 `form`。auth 的發證白名單由它派生，不需另外設 env |
| **授權入口** | `GET https://auth.lvh.me:3000/api/auth/authorize?service=<id>&redirect_uri=<你的 callback 完整網址>&next=<站內路徑>` |
| **token 交付方式** | auth 以自動送出的 `<form method="post">` 把 `token` + `next` POST 到你的 callback（token 不進 URL / Referer / 歷史） |
| **你要提供的 callback** | `POST <你的服務>/api/auth/callback`（收 `token`+`next`，驗章後寫自己的 cookie，303 到 `next`） |
| **你自己的 cookie** | 名稱建議 `tpass_token`；**host-only（不設 Domain）**、`HttpOnly`、`Secure`、`SameSite=Lax`、`Path=/`、`Max-Age` ≤ token 剩餘壽命 |
| **簽章演算法** | `EdDSA`（Ed25519）— 驗章時**必須鎖死** |
| **JWT header** | `{ "alg": "EdDSA", "kid": "tpass-key-1", "typ": "JWT" }` |
| **issuer（`iss`）** | `https://auth.lvh.me:3000` — 驗章時**必須檢查** |
| **audience（`aud`）** | `tpass:<你的服務id>`（例 `tpass:form`）— 驗章時**必須檢查**，不是 v1 的 `tschool-sso` |
| **JWKS 公鑰來源** | `GET https://auth.lvh.me:3000/.well-known/jwks.json` |
| **登出** | 你自己的 `POST /api/auth/logout`：清自己的 cookie → form POST 到 auth `POST /api/auth/logout?redirect_uri=<你的完整網址>`（清 auth 登入態） |
| **per-service token 有效期** | `JWT_TTL_SECONDS`（auth 端設定，建議 45 分鐘＝2700 秒；必填、無內建預設）——也是權限變更（ban／降級）對已發 token 的生效延遲上限，見 [§3.5](#35-權限變更的生效時間) |
| **auth 登入態（session）有效期** | `AUTH_SESSION_TTL_SECONDS`（auth 端設定，選填，預設 43200 秒＝12 小時）——這是「還算登入」的期間，刻意跟上面的 per-service token 分開設定，太短會逼使用者對每個服務都重跑一次 Google OAuth |
| **被封鎖（ban）** | `authorize` 查到你在該服務 `restriction=ban`（未過期）→ 不簽 token，302 到 `<issuer>/denied?service=<id>`（reason 不進 URL，該頁憑 auth 自己的登入態重查資料庫），見 [§7.3](#73-被封鎖ban) |

---

## 3. JWT Payload 欄位定義

你的 callback 收到的 `token` 是一個 JWT。`permissions` 是唯一的授權本體，形狀依你的服務類型而不同
（§3.1／§3.2）。舊版曾有 `groups` 過渡期相容層，已於 Phase 7（2026-07-27）從程式碼與 payload
全面移除，退場紀錄見附錄 B。

### 3.1 一般服務 token

一般服務（`aud=tpass:<你的服務id>`，不在 auth 的 `AUTH_OVERVIEW_SERVICE_IDS` 內）的
`permissions` 只帶**自己**這把 key——最小揭露，別的服務的 ban/warning 原因不會外洩給你：

```json
{
  "sub": "104857600293847561029",
  "email": "b11302042@tschool.tp.edu.tw",
  "name": "林大明",
  "entryYear": 114,
  "permissions": {
    "form": { "read": true, "role": "admin" }
  },
  "iss": "https://auth.lvh.me:3000",
  "aud": "tpass:form",
  "iat": 1750000000,
  "exp": 1750002700
}
```

### 3.2 大廳（overview）token

服務 id 若在 auth 的 `AUTH_OVERVIEW_SERVICE_IDS`（選填，預設只有 `portal`）內，`permissions`
帶**全服務的 map**（含 `auth` 自己）——這是大廳顯示每個服務 ban/warning 徽章、以及判斷
「這個人是不是任何服務的 admin/moderator」（要不要顯示「權限管理」入口）的資料來源：

```json
{
  "sub": "104857600293847561029",
  "email": "b11302042@tschool.tp.edu.tw",
  "name": "林大明",
  "entryYear": 114,
  "permissions": {
    "auth":    { "read": true,  "role": "admin" },
    "form":    { "read": true,  "role": "admin" },
    "msg":     { "read": true,  "role": "default" },
    "appeals": { "read": false, "role": "default", "restriction": "ban", "reason": "濫用申訴系統", "until": 1750100000 },
    "vote":    { "read": true,  "role": "default", "restriction": "warning", "reason": "多次投票異常" }
  },
  "iss": "https://auth.lvh.me:3000",
  "aud": "tpass:portal",
  "iat": 1750000000,
  "exp": 1750002700
}
```

### 3.3 欄位定義

| 欄位 | 型別 | 必有 | 意義 |
| --- | --- | --- | --- |
| `sub` | `string` | ✓ | 使用者唯一識別碼（來自 Google 的 `sub`，跨服務一致、可當主鍵） |
| `email` | `string` | ✓ | 學校信箱，已通過 `email_verified` 與網域白名單 |
| `name` | `string` | ✓ | 顯示名稱 |
| `entryYear` | `number` | ✗ | 民國入學學年度（如 `114`）。**可能不存在**：老師／職務帳號沒有屆別，舊 token 也還沒有這個欄位。缺少時請 fallback 回信箱前三碼，見下方說明 |
| `permissions` | `Record<string, PermissionEntry>` | ✓ | **權限本體**，見下方型別與 §3.4 |
| `iss` | `string` | ✓ | 簽發者，必為 §2 的 issuer |
| `aud` | `string` | ✓ | 受眾，必為 `tpass:<你的服務id>` |
| `iat` / `exp` | `number` | ✓ | 簽發 / 到期時間（Unix 秒） |

`PermissionEntry`：

```ts
type Role        = "admin" | "moderator" | "default";
type Restriction = "none"  | "warning"   | "ban";

interface PermissionEntry {
  read: boolean;             // 必有。唯一必看欄位，auth 已經算好（= restriction !== "ban"）
  role: Role;                // 必有。admin 隱含 moderator
  restriction?: Restriction; // 省略＝none
  reason?: string;           // 只在 restriction !== "none" 時出現
  until?: number;            // 選填 Unix 秒，管制到期自動解除（過期即視同 none，role 不受影響）
}
```

> ⚠️ **解析安全預設值（務必實作）**：`permissions` 缺、或缺你要查的 serviceId 這把 key
> （舊票、或非 overview 服務去查別的 serviceId）→ 一律當成 `{ read: true, role: "default" }`，
> 不要因為缺資料就誤鎖使用者。參考實作：`tpass-portal/src/lib/tpass-auth.ts` 的 `permOf()`。

> 📅 **`entryYear` 與年級**：年級不要自己從信箱算。信箱前三碼是入學學年度，但**休學復學的人
> 信箱沿用、前綴不變**，直接推算會多算一級（休學兩年甚至算出高四而變成空值）。auth 的
> `/admin` panel 可以對這種人設定屆別覆寫，結果就放在 `entryYear`。
>
> 解析規則（務必照做）：
>
> ```ts
> const entry = typeof payload.entryYear === "number"
>   ? payload.entryYear
>   : parseEntryYearFromEmail(email);   // fallback：舊 token 沒有這個 claim
> const academicYear = month >= 8 ? rocYear : rocYear - 1;   // 學年度 8 月跳新
> const grade = entry === null ? null : academicYear - entry + 1;   // 取 1..3，其餘視為 null
> ```
>
> **fallback 這條是必要的**，不是可有可無：token TTL 只有 45 分鐘，但 auth 升級後的那段
> 轉場期，使用者手上的舊 token 還沒有這個 claim。少了 fallback，那段時間全部人的年級會變空白。

### 3.4 權限模型

- **`role`**：三級，`admin` 隱含 `moderator` 的所有能力。`default` 是一般使用者，不用特別判斷。
- **`restriction`**：`warning`（提醒，仍可使用）與 `ban`（禁止使用）。**呈現方式由各模組自訂**——
  `warning` 沒有固定版型，`tpass-portal/src/components/WarningBanner.tsx` 是可抄的範本。
- **`read` 是唯一必看欄位**：auth 已經把 `restriction !== "ban"` 算成這個布林值，你不需要自己重
  算 ban 邏輯。消費端守門就一行：

  ```ts
  if (!perm.read) redirect(`${process.env.AUTH_DENIED_URL}?service=${TPASS_SERVICE_ID}`);
  ```

  正常情況下這行幾乎不會觸發——`authorize` 在簽 token 前就攔截了 ban（見 §7.3），你拿到的票本來
  就是「當下沒被 ban」的。這行是防「舊票在被 ban 之後、過期之前」窗口的防禦層，細節見 §3.5。
- 權限真相與管理介面都在 auth（DB + `/admin` panel）；**你的服務不再自維護 admin allowlist**。

### 3.5 權限變更的生效時間

- 管理員在 auth 的 `/admin` panel 改權限，寫的是資料庫；**你手上已簽出的 per-service token
  不會被追改**。生效延遲上限＝簽發當時的 `JWT_TTL_SECONDS`（建議 45 分鐘）——使用者下次換票
  （token 過期後重新走 authorize）才會拿到新權限。panel 存檔後會顯示「最晚 HH:MM 生效」。
- 例外：**被 ban 的人，auth 登入態立即失效**（`Subject.sessionsValidFrom`，panel ban 時寫入
  `now()`）——他換不到任何新的 per-service token，即使你手上的 token 還沒過期也續不了。已經
  拿到手、還沒過期的舊 per-service token 仍會活到自己的 `exp`（同一個上限）。
- **刻意不做即時 revocation**：無狀態本地驗章（消費端驗完全不回呼 auth）是契約 v2 的地基——
  要做到「改權限立刻生效」等於要求每個請求都回頭問 auth，等於放棄 v2 換來的隔離與可用性。
  這個取捨已在 `docs/SECURITY-REVIEW.md` 立案接受。

### 3.6 已退場：`groups` claim

舊版曾有 `groups` claim（由 `permissions` 的 `role` 推導而來的過渡期相容層），已於 Phase 7
（2026-07-27）從 auth 簽發邏輯與所有消費端程式碼中移除。**新串接的服務只認 `permissions`**，
不會再看到 `groups` 欄位。歷史推導規則與退場時程見附錄 B。

---

## 4. JWKS 公鑰格式

```
GET https://auth.lvh.me:3000/.well-known/jwks.json
Cache-Control: public, max-age=3600
```

```json
{
  "keys": [
    { "kty": "OKP", "crv": "Ed25519", "alg": "EdDSA", "use": "sig",
      "kid": "tpass-key-1", "x": "11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo" }
  ]
}
```

- `kid` 用於**金鑰輪替**：請用會「依 `kid` 自動選鑰」的函式庫（`jose` 的
  `createRemoteJWKSet`、PyJWT 的 `PyJWKClient`），不要自己抓第一把硬用。
- 這裡**只有公鑰**（`x`），沒有私鑰（`d`）。這是刻意的。
- 可以快取（`max-age=3600`）；`createRemoteJWKSet` 會自動快取 + 遇到未知 `kid` 時重抓（含冷卻）。

> [!IMPORTANT]
> **輪替期間 `keys` 會有兩把**（新舊各一），這是正常狀態。
>
> 消費端只要照上面用 `createRemoteJWKSet` 就完全不受影響。但**如果你自作聰明「抓第一把來用」，
> 輪替一開始就會驗不過**——因為舊 token 的 `kid` 指向第二把。
>
> 實測（2026-08-01）：輪替期間若 token **沒有 `kid`**，`createRemoteJWKSet` 會回
> `ERR_JWKS_MULTIPLE_MATCHING_KEYS`。auth 簽的票一律帶 `kid`，所以正常流程不會遇到；
> 但這也是「不要自己手刻選鑰邏輯」的第二個理由。

### 4.1 發證端金鑰輪替 runbook（維運用，消費端不需要做任何事）

auth 端由三個選填 env 控制，**平時全部留空 = 與輪替前行為完全一致**：

| env | 用途 |
| --- | --- |
| `JWT_KID` | 目前簽章用的 `kid`。留空預設 `tpass-key-1` |
| `JWT_PREV_PUBLIC_KEY` | 上一把**公鑰**（PEM）。輪替 overlap 期間才填 |
| `JWT_PREV_KID` | 上一把的 `kid`。**必須與 `JWT_KID` 不同**，撞名會在啟動時直接報錯 |

後兩者**要同時填**才會生效。輪替步驟：

1. 產一組新金鑰對。
2. auth 設定：`JWT_PRIVATE_KEY` / `JWT_PUBLIC_KEY` 換成新的、`JWT_KID` 給一個新名字（例 `tpass-key-2`）；
   同時把**舊公鑰**填進 `JWT_PREV_PUBLIC_KEY`、舊 kid 填進 `JWT_PREV_KID`。重新部署 auth。
   → 此時 JWKS 公開兩把；新票用新鑰簽，舊票仍驗得過。
3. **等待至少 `JWT_TTL_SECONDS`**（建議直接等 `AUTH_SESSION_TTL_SECONDS`，預設 12 小時），
   讓所有舊鑰簽出的 token 自然過期。
4. 清空 `JWT_PREV_PUBLIC_KEY` 與 `JWT_PREV_KID`，重新部署 auth。舊鑰正式下架。

> [!CAUTION]
> **第 3 步不能省。** auth 驗章嚴格依 `kid` 選鑰、認不得就失敗，**沒有「每把都試一遍」的
> fallback**——那種 fallback 會讓舊鑰下架後仍然驗得過，輪替永遠收不了尾。
> 所以 overlap 期間縮太短，等於讓還沒過期的舊票直接失效（使用者被登出）。

---

## 5. 驗章規則（安全關鍵，逐條必做）

驗一個 token 時，**一定**要同時滿足這四條，缺一不可：

1. **鎖演算法 `algorithms: ['EdDSA']`。**
   <br>❗ **不鎖 = 可被偽造任意身分**（algorithm confusion：攻擊者把 header `alg` 改成 `HS256`，
   拿你公開的 JWKS 公鑰位元組當 HMAC 密鑰簽假 token；沒鎖的函式庫會「用公鑰當對稱密鑰」驗過）。
2. **檢查 `issuer` == `https://auth.lvh.me:3000`。** 票是「這個 auth」簽的。
3. **檢查 `audience` == `tpass:<你的服務id>`。** 票是簽給**你**的——別的服務的 token、
   v1 的共用 token，在你這裡都必須驗不過。這就是 v2 的爆炸半徑隔離。
4. **檢查 `exp` 沒過期。**（主流函式庫預設就會檢查，但確認沒被關掉。）

驗不過 → **一律當成「未登入」**，導去授權入口；**不要把例外訊息丟給前端**。

---

## 6. ⚠️ 最重要的限制：純前端 SPA 接不了，必須有後端

token 只該存在 **`HttpOnly`** cookie（防 XSS 竊 token），且 callback 要驗章——都是後端的活。

- ✅ 可以做的地方：Server Component / Route Handler / Middleware / Express / 任何 server。
- ❌ 不行的地方：瀏覽器 JS（`document.cookie` 讀不到 HttpOnly cookie）。

**純前端 SPA 必須自備一層薄後端**（`/api/auth/callback`、`/api/me` 之類），
前端跟「自己的後端」要身分，不是跟 auth 要。**絕不把 token 放 `localStorage`。**

---

## 7. 登入 / 登出流程

### 7.1 登入（authorize → form_post → callback）

你的後端判定「沒有有效 session」時，把使用者導去授權入口。三個參數都必填：

```
https://auth.lvh.me:3000/api/auth/authorize
  ?service=foo                                            ← 你登記的服務 id
  &redirect_uri=https://foo.lvh.me:3002/api/auth/callback  ← 你的 callback 完整網址
  &next=/dashboard                                         ← 完成後回到你站內哪個路徑
```

整個流程：

```
你的服務（未登入，想去 /dashboard）
  → 302 導去 auth /api/auth/authorize?service=foo&redirect_uri=...&next=/dashboard
    → auth 有登入態？
        沒有 → 307 去 accounts.google.com 跑 OAuth → 回 auth → 寫 auth 自己的
               host-only session cookie → 302 回到 authorize（同參數）
        有   → 簽 aud=tpass:foo 的 token
    → auth 回一頁自動送出的 <form method="post" action="你的 callback">
      （hidden 欄位：token、next；token 全程不出現在 URL）
  → 你的 POST /api/auth/callback：
      1. 驗章（§5 四鐵則，aud=tpass:foo）
      2. 驗過 → Set-Cookie: tpass_token=<token>（host-only、HttpOnly、Secure、Lax）
      3. 檢查 next 是站內路徑（以 / 開頭、非 //）→ 303 導去 next ✅
```

**authorize 可能的錯誤**（都是你串接時要修的設定問題，不是使用者錯）：
- `/service-error?reason=unknown-service` — `service` 不在服務註冊表裡，先到 `tschoolsu/tpass-registry` 開 PR 登記。
- `400 Invalid redirect_uri` — callback 網址不是完整網址、或 hostname 不在 `*.lvh.me`（防 Open Redirect）。
- `400 Invalid next` — `next` 必須是站內路徑（`/` 開頭且非 `//` 開頭）。

**登入失敗**（auth 會導回它自己的首頁並帶 query）：`/?error=domain`（email 不在允許網域）、
`/?error=oauth`（跟 Google 換 token 失敗）。

### 7.2 登出（兩段式：清自己 + 清 auth）

v2 的登出是**你自己的 route**（因為你自己的 cookie 只有你能清）：

```
你的頁面 <form method="post" action="/api/auth/logout">登出</form>
  → 你的 POST /api/auth/logout：
      1. 清自己的 tpass_token cookie
      2. 回一頁自動送出的 form POST 到
         https://auth.lvh.me:3000/api/auth/logout?redirect_uri=https://foo.lvh.me:3002
  → auth 清掉自己的登入態
  → 303 導回你的服務（帶 ?logout=1，純畫面提示，不是身分憑證）
```

其他服務的 per-service cookie 會留到各自 `exp` 過期（≤ `JWT_TTL_SECONDS`）——這是 v2 用「隔離」
換來的已知取捨：登出不再是全生態即時，而是「auth 不再發新票 + 舊票自然過期」。

### 7.3 被封鎖（ban）

`authorize`（§7.1 步驟 2）簽 token 前會先查你在該服務的權限。若查到 `restriction=ban`
且未過期：

```
auth 有登入態 → 查權限 → restriction=ban（未過期）
  → 不簽 token，302 到 <issuer>/denied?service=<你的服務id>
```

- **`reason` 絕不進 URL**——`/denied` 頁憑使用者的 auth 登入態重查資料庫拿原因，query string
  只帶 `service`，不會在瀏覽器歷史 / Referer / log 裡留下管制原因。
- `/denied` 是 auth 自己的頁面（不是你的服務要做的事），畫面含原因、解封時間（若有 `until`）、
  申訴連結（`AUTH_APPEAL_URL`，選填）、回門戶、登出。
- 你的服務**不會**在正常流程中收到 `read:false` 的 token——ban 在這裡就被攔下了。§3.5 講的
  「舊票窗口」才會讓你的 callback/守門邏輯真的遇到 `read:false`，那是防禦層，不是主流程。

---

## 8. 參考實作（可直接抄）

> 標準參考實作在 **`portal` 服務**：`../tpass-portal/src/lib/tpass-auth.ts`（驗章核心）、
> `../tpass-portal/src/config/portal.ts`（設定）、`../tpass-portal/src/app/api/auth/callback/route.ts`
> （token 接收）、`../tpass-portal/src/app/api/auth/logout/route.ts`（登出鏈）。**照抄這四個檔**，
> 只把 `portal` 換成你的服務 id。

### 8.1 Node / TypeScript（`jose`）— 驗章核心

```ts
// lib/tpass-auth.ts
import { createRemoteJWKSet, jwtVerify } from "jose";

const ISSUER = process.env.JWT_ISSUER!;                  // https://auth.lvh.me:3000
const AUDIENCE = `tpass:${process.env.TPASS_SERVICE_ID!}`; // tpass:foo
const JWKS = createRemoteJWKSet(new URL(process.env.AUTH_JWKS_URL!));

export async function verifyToken(token: string) {
  try {
    const { payload } = await jwtVerify(token, JWKS, {
      algorithms: ["EdDSA"],  // ★ 1. 鎖演算法
      issuer: ISSUER,          // ★ 2. 檢查 iss
      audience: AUDIENCE,      // ★ 3. 檢查 aud（exp 由 jose 自動檢查 = 4）
    });
    return payload; // { sub, email, name, permissions, ... }（§3）
  } catch {
    return null;    // 過期 / 竄改 / 錯 iss/aud / 錯 alg → 一律視為未登入
  }
}
```

### 8.2 Next.js — callback route（收 token、寫自己的 cookie）

```ts
// app/api/auth/callback/route.ts
import { NextResponse, type NextRequest } from "next/server";
import { verifyToken } from "@/lib/tpass-auth";

export async function POST(request: NextRequest) {
  const form = await request.formData();
  const token = form.get("token");
  const next = String(form.get("next") ?? "/");
  if (typeof token !== "string") return new NextResponse("Bad request", { status: 400 });

  const claims = await verifyToken(token);            // §5 四鐵則
  if (!claims) return new NextResponse("Invalid token", { status: 401 });

  // next 只能是站內路徑（防 Open Redirect）
  const safeNext = next.startsWith("/") && !next.startsWith("//") ? next : "/";
  const res = NextResponse.redirect(new URL(safeNext, process.env.FOO_SELF_URL!), 303);
  res.cookies.set("tpass_token", token, {
    httpOnly: true,
    sameSite: "lax",
    secure: true,
    path: "/",
    maxAge: Math.max(0, (claims.exp as number) - Math.floor(Date.now() / 1000)),
    // 注意：不設 domain → host-only，這就是隔離的來源
  });
  return res;
}
```

### 8.3 讀 session（每個請求）

```ts
// 續 lib/tpass-auth.ts
import { cookies } from "next/headers";

export async function getSession() {
  const token = (await cookies()).get("tpass_token")?.value;
  if (!token) return null;
  return verifyToken(token);
}
```

### 8.4 Next.js — 登出 route（兩段式）

```ts
// app/api/auth/logout/route.ts
import { NextResponse } from "next/server";

export async function POST() {
  const authLogout = `${process.env.AUTH_LOGOUT_URL}?redirect_uri=${encodeURIComponent(process.env.FOO_SELF_URL!)}`;
  const html = `<!doctype html><meta charset="utf-8"><body onload="document.forms[0].submit()">
<form method="post" action="${authLogout}"><noscript><button>完成登出</button></noscript></form>`;
  const res = new NextResponse(html, {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
  res.cookies.set("tpass_token", "", { httpOnly: true, sameSite: "lax", secure: true, path: "/", maxAge: 0 });
  return res;
}
```

### 8.5 其他語言（通用演算法）

```
登入： 沒 session → 302 去 auth /api/auth/authorize?service=<id>&redirect_uri=<callback>&next=<path>
callback（POST，form-encoded token+next）：
  1. 用 JWKS 公鑰驗 token：鎖 EdDSA、iss、aud=tpass:<id>、exp（四者不可省）
  2. 驗過 → Set-Cookie（host-only、HttpOnly、Secure、Lax、Max-Age≤剩餘壽命）
  3. 303 → next（必須站內路徑）
每請求： 讀自己 cookie → 同樣四鐵則驗章 → 認出使用者
登出：   清自己 cookie → form POST auth /api/auth/logout?redirect_uri=<self>
```

（Python 用 `pyjwt[crypto]` + `PyJWKClient`；Go 用 `lestrrat-go/jwx`；Java 用 `nimbus-jose-jwt`。）

---

## 9. 本機開發環境注意事項（最容易踩雷）

1. **信任 mkcert 根憑證**：`mkcert -install` 一次（tpass-ops 的 `tpass setup` 會處理）。
2. **★ 後端 fetch JWKS 時要讓 runtime 信任 mkcert CA**：Node 不讀 OS 信任區，
   啟動帶 `NODE_EXTRA_CA_CERTS="$(mkcert -CAROOT)/rootCA.pem"`；
   Next dev（Turbopack/undici）連這個都不吃，`tpass dev` 已對消費端自動處理。
   上線換公開 CA 後不需要。
3. **`lvh.me` 免改 `/etc/hosts`**。
4. **Next.js 沒有原生 HTTPS**：production smoke 用 `server.mjs`（可抄本 repo 的）。

---

## 10. 設定都是 env 驅動（不要寫死網址）

| 你需要的 env | 本階段值 | 上線會變 |
| --- | --- | --- |
| `TPASS_SERVICE_ID` | 你登記的服務 id（例 `foo`） | 不變 |
| `JWT_ISSUER` | `https://auth.lvh.me:3000` | ✓ 換正式網域 |
| `AUTH_JWKS_URL` | `<issuer>/.well-known/jwks.json` | 隨 issuer 變 |
| `AUTH_AUTHORIZE_URL` | `<issuer>/api/auth/authorize` | 隨 issuer 變 |
| `AUTH_LOGOUT_URL` | `<issuer>/api/auth/logout` | 隨 issuer 變 |
| `<SVC>_SELF_URL` | `https://foo.lvh.me:3002` | ✓ 換正式網域 |
| `AUTH_DENIED_URL`（選填） | `<issuer>/denied` | 隨 issuer 變（沒設就用 `AUTH_AUTHORIZE_URL` 的 origin 自動推導，通常不用另外設）——`read:false` 守門（§3.4）要導去的頁面 |

（六個必填 + 一個選填。**不要**再加 `JWT_AUDIENCE` / `TPASS_COOKIE_NAME`——那是已移除的 v1 遺物。）

---

## 11. 疑難排解（FAQ）

| 症狀 | 可能原因 / 解法 |
| --- | --- |
| 後端 fetch JWKS 報 TLS 錯 | 沒設 `NODE_EXTRA_CA_CERTS`（§9.2），或用 `tpass dev` 啟動 |
| 被導去 `/service-error?reason=unknown-service` | 服務 id 不在 `tpass-registry` 的 `services.json`，登記並 merge 後重新部署 auth |
| authorize 回 `400 Invalid redirect_uri` | callback 不是完整網址、或 hostname 不在根網域白名單 |
| callback 收到 token 但驗不過 | aud 對不上——你驗的是 `tpass:<id>`？id 與 authorize 的 `service` 一致？ |
| 登入後又立刻被導回登入 | ①cookie 沒寫成功（Secure 但你走 http？）②每請求驗章用錯 aud ③cookie 名不一致 |
| 一直 `/?error=domain` | 登入的 Google 帳號不在允許網域 |
| 驗章一直失敗但 token 看起來正常 | 沒鎖 `algorithms:['EdDSA']`、或 iss/aud 字串不一致（port、結尾斜線） |
| token 過一段時間就失效 | 正常，per-service token TTL＝`JWT_TTL_SECONDS`（建議 45 分鐘）；auth 登入態撐比較久（`AUTH_SESSION_TTL_SECONDS`，預設 12 小時），過期後重走 authorize 會自動換到新票 |
| 純前端拿不到 cookie | 正常（HttpOnly），需要薄後端（§6） |

---

## 12. 給 AI agent 的實作指令

**前置確認：**
1. 服務**有沒有後端**？純前端 SPA → 停下來告訴使用者要先加薄後端（§6）。
2. 服務網域在 `*.lvh.me`（本機）/ 正式根網域底下、走 HTTPS？
3. 服務 id 已登記進 `tschoolsu/tpass-registry` 的 `services.json`？沒有→先開 PR 登記。

**實作步驟：**
1. `pnpm add jose`（或該語言 JOSE 函式庫）。
2. 設定模組集中放 env（§10 那七個），全部從 env 讀。
3. 驗章模組：`createRemoteJWKSet` + `jwtVerify` 鎖 `algorithms:['EdDSA']` + `issuer` +
   `audience: 'tpass:<id>'`，失敗回 null（§5 四鐵則）。
4. `POST /api/auth/callback`：驗 token → 寫 host-only `HttpOnly` cookie → 303 到站內 `next`（§8.2）。
5. 每請求在 server 端讀自己的 cookie → 驗章（§8.3）。
6. 未登入 → 302 去 authorize（§7.1 三參數）。
7. `POST /api/auth/logout`：清自己 cookie → form POST auth logout（§8.4）。
8. 本機啟動用 tpass-ops 的 `tpass dev <id>`（自動處理 mkcert / TLS 信任）。

**完工前自我驗收（不需 Google 也能測）：**
- [ ] `algorithms` 確實鎖成 `['EdDSA']`（grep 確認）。
- [ ] issuer、audience 都檢查，audience 是 `tpass:<id>` 不是 `tschool-sso`。
- [ ] cookie host-only（**沒有** `domain` 屬性）、HttpOnly、Secure、Lax。
- [ ] callback 對「過期 / 竄改 / 錯 aud / HS256+公鑰簽」四種假 token 都回 401。
- [ ] callback 的 `next` 擋掉 `https://evil.com`、`//evil.com`（只允許站內路徑）。
- [ ] 前端 JS 沒有讀 token、`localStorage` 沒有 token。
- [ ] `permOf(session)` 解析用了安全預設值（缺 claim / 缺 serviceId → `{read:true, role:"default"}`），且 `read===false` 時確實導去 `AUTH_DENIED_URL?service=<id>`（§3.4）。
- [ ] `restriction==="warning"` 有呈現給使用者看（版型自訂，可抄 `WarningBanner`），不是只解析出來沒顯示。

**絕對不要做：**
- ❌ 不要自動化 Google 登入（會被擋、違反條款）。要真人登入時停下來請使用者操作。
- ❌ 不要 import / 複製 auth 的私鑰、`arctic`、OAuth callback。消費端**只需要公鑰**。
- ❌ 不要在前端驗章、不要把 token 塞 `localStorage`、不要關 `algorithms` 鎖定、
     不要把 cookie 設成 `Domain=.<根網域>`（那是 v1，正在退場）。

---

## 附錄 A：v1（已移除，歷史）

v1 = auth 簽單一 `aud=tschool-sso` 的 JWT，寫進 `Domain=.<根網域>` 的共用 cookie
`tpass_session`，所有子網域共享。**缺陷：任何一個子網域被攻破或接管，等於全生態帳號淪陷。**

退場歷程：

| 日期 | 動作 |
| --- | --- |
| 2026-07-07 | 契約 v2 上線；auth 雙軌簽發（v1 + v2），消費端有 v1 fallback |
| 2026-07-08 | auth 以 env `AUTH_ISSUE_LEGACY_COOKIE=0` **停發** v1 cookie；舊票 8 小時內全數過期 |
| **2026-07-13** | **v1 程式碼全數移除**：auth 的 `signSession()` / `issueLegacyCookie` / 共用 cookie 寫入，四個消費端的 fallback，以及 `JWT_AUDIENCE` / `AUTH_COOKIE_NAME` / `AUTH_COOKIE_DOMAIN` / `TPASS_COOKIE_NAME` 等 env |

**為什麼一定要連程式碼一起刪**：`issueLegacyCookie` 的預設值是「發」——只要主機 `.env.local`
裡那顆 `0` 掉了（重建 env、抄 `.env.example` 漏帶、換主機），v1 就會自己復活，而消費端的
fallback 會照單全收。隔離不能靠一個設定值撐著；把路砍掉，它才是結構上成立的。

> 現在只有一條路：per-service token（`aud=tpass:<id>`）+ host-only cookie。
> 在任何地方看到 `tschool-sso`、`tpass_session`、`Domain=.<根網域>`，那都是歷史，不是現況。

---

## 附錄 B：`groups` claim 退場時程（已結案，2026-07-27）

`groups` 曾是 §3.6 講的過渡期相容層，由 `permissions` 的 `role` 推導而來，從來不是獨立真相。

| 階段 | 狀態 |
| --- | --- |
| 開發期雙發 | auth 同時簽 `groups` + `permissions`；`AUTH_GROUPS` env 當時已停用，改由 DB（Subject/Grant）推導，僅 `scripts/seed-from-env.mjs` 讀一次性灌資料用 |
| 消費端遷移 | 各服務（form/msg/appeals/vote…）把授權判斷從 `groups.includes(...)` 改成 `permOf(session).role`／`.read`，開發期內完成，未曾在正式站雙發過 |
| **退場（2026-07-27）** | 從 auth `sign()` payload 移除 `groups` 欄位、刪 `groupsFromRole()`；五個消費端同步移除 `TPassClaims.groups` 與解析行；本文件同步移除相關欄位與範例 |

**結案說明**：雙發期本質上等於開發期——`groups` 從未在正式站單獨上線過一段時間，正式站部署
是直接從「全部服務讀 `groups`」跳到「全部服務讀 `permissions`」，六個服務一次一起上，不存在
正式站雙軌並行的窗口。`scripts/seed-from-env.mjs` 仍保留，供正式站部署當下把 `AUTH_GROUPS`
一次性灌進 DB；灌完即可從主機 `.env` 移除該變數，該腳本屆時也可一併刪除。
