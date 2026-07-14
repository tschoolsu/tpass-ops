# TSchool 新服務串接指南

> **給誰讀**：第一次在 TSchool 平台開一個新服務、要讓師生「用學校 Google 帳號登入」的部員。
> **讀完你會有**：一個能跑、能登入、能上線的服務。
> **要花多久**：登入串接本身約 30 分鐘（就是複製四個檔）。上線要等有 root 權限的維運部員做前置。
>
> 這份文件是**自給自足**的：所有 code、設定、指令都寫在裡面，照著做就好。
>
> 相關的另外兩份文件：
> - 《TSchool 開發與維運手冊》——`tpass` 指令、主機拓樸、部署排錯。
> - 《T-Pass Design System》——UI 風格規範（本文件不重複它，做畫面時看那份）。

---

## 0. 一分鐘搞懂登入是怎麼運作的

**auth 是發票的，你是驗票的。你永遠拿不到、也不需要任何密鑰。**

```
①  使用者連到你的服務，你的後端發現他沒登入
       │
       └──▶ 302 導去 auth 的 authorize 入口（帶：你的服務 id、你的 callback 網址）
                  │
                  ├─ auth 還沒認得他 → 跑一次 Google 登入
                  └─ 認得了 → 簽一張「只有你驗得過」的 JWT（aud = tpass:你的id）
                             │
②  auth 用一個自動送出的表單，把 token POST 到你的 /api/auth/callback
   （token 全程不出現在網址列、不進瀏覽器歷史、不進 Referer）
       │
③  你的 callback 用 auth 公開的「公鑰」在自己後端驗章 → 驗過才寫進你自己網域的 cookie
       │
④  之後每個請求：讀自己的 cookie → 自己驗章 → 認出使用者。全程不用再打 auth。
```

三個關鍵設計，記住就好：

| 設計 | 白話 | 為什麼 |
| --- | --- | --- |
| **你只拿公鑰** | 你不碰 Google、不碰私鑰、不用呼叫 auth 的 API | 驗章在你自己家做，auth 掛了也不影響已登入的人 |
| **票是一服務一張** | 你的 token `aud=tpass:<你的id>`，拿去別的服務一律驗不過 | 你的服務被打爆，也炸不到別人 |
| **cookie 只留在你家** | cookie 不設 `Domain`（host-only） | 瀏覽器不會把你的通行證送去任何其他服務 |

> ⚠️ **純前端 SPA 接不了**。cookie 是 `HttpOnly`、驗章要在 server 做，所以你**必須有後端**。
> Next.js 的 Route Handler / Server Component 就是後端，沒問題。
> **絕不把 token 放 `localStorage`。**

---

## 1. 登記你的服務

服務 id 是你的身分證。**它同時是**：pm2 程序名 ＝ `tpass` 指令的參數 ＝ 環境變數 `TPASS_SERVICE_ID` ＝ JWT 的 `aud` 後綴 ＝ 你的子網域。**取好就永不改名**（短、全小寫，例：`form`、`msg`、`lost`）。

以下用 `lost`（遺失物）當範例，你自己換掉。

### 1.1 在 ops repo 登記

```bash
scripts/tpass new lost
```

它會互動式問你名稱 / 子網域 / port / 要不要資料庫，寫進頂層的 `services.json`（port 撞車會直接被擋下），重新產生本機 HTTPS 憑證，並**印出所有自動化不了的人工步驟**。照它印的做。

（`services.json` 每個欄位的意思見 **附錄 B**。）

### 1.2 讓 auth 認得你

不做這步的話，authorize 會直接回 `400 Unknown service`。

在 `tpass-auth/.env.local` 的白名單加上你的 id，然後**重啟 auth**：

```bash
AUTH_SERVICE_IDS=portal,form,msg,appeals,lost
```

> 主機上的 auth 也要加同一行——上線那步會處理（見 §5）。

### 1.3 在門戶大廳放一張卡片

編輯 `tpass-portal/src/config/services.ts` 加一筆，使用者才在門戶找得到你的服務。

---

## 2. 開專案骨架

一律 **Next.js 16 + React 19**（跟生態系其他五個服務一致）。

> ⚠️ Next 16 有破壞性變更，API 跟你（或 AI）記憶中的可能不一樣。寫 code 前先翻
> `node_modules/next/dist/docs/`。

你的 repo 該長這樣：

```
tpass-lost/
├── README.md                    ← 一頁：是什麼、網址、DB、怎麼跑
├── AGENTS.md                    ← 給 AI agent 的入口（照抄別的服務改）
├── .env.example                 ← 所有 env key + 註解（真值放 .env.local，不進 git）
├── src/config/lost.ts           ← ★ env 必填清單（REQUIRED）
├── src/lib/tpass-auth.ts        ← ★ 驗章核心
└── src/app/api/auth/
    ├── callback/route.ts        ← ★ 收 token
    └── logout/route.ts          ← ★ 登出
```

打星號的四個檔就是登入串接的全部。下一節直接給你完整的 code。

---

## 3. 串登入：複製四個檔

```bash
npm install jose
```

底下把 `lost` / `LOST` 換成你的服務 id 就能用。

### 3.1 `src/config/lost.ts` — 設定集中在這裡（全部從 env 讀）

```ts
import "server-only";

// ★ 這個陣列是「env 必填清單」的唯一真相：
//   本機 `tpass check env lost` 靠它檢查，部署時也靠它在 build 前擋下缺 key 的情況。
//   之後每加一個必填 env，就要加進來。
const REQUIRED = [
  "AUTH_JWKS_URL",
  "AUTH_AUTHORIZE_URL",
  "AUTH_LOGOUT_URL",
  "LOST_SELF_URL",
  "TPASS_SERVICE_ID",
  "JWT_ISSUER",
] as const;

const missing = REQUIRED.filter((key) => !process.env[key]);
if (missing.length > 0) {
  throw new Error(
    `[config/lost] 缺少必填環境變數：${missing.join(", ")}（請檢查 .env.local）`,
  );
}

const self = process.env.LOST_SELF_URL!;
const serviceId = process.env.TPASS_SERVICE_ID!;

// 未登入時導去這裡。returnPath = 登入完成後要回到你站內的哪一頁。
export function loginUrlFor(returnPath = "/"): string {
  const u = new URL(process.env.AUTH_AUTHORIZE_URL!);
  u.searchParams.set("service", serviceId);
  u.searchParams.set("redirect_uri", `${self}/api/auth/callback`);
  u.searchParams.set("next", returnPath);
  return u.toString();
}

export const lostConfig = {
  jwksUrl: process.env.AUTH_JWKS_URL!,       // 公鑰來源，你只 fetch 這個
  loginUrl: loginUrlFor("/"),
  logoutUrl: `${self}/api/auth/logout`,      // 你自己的登出 route
  authLogoutUrl: process.env.AUTH_LOGOUT_URL!,
  selfUrl: self,
  serviceId,
  issuer: process.env.JWT_ISSUER!,
  serviceAudience: `tpass:${serviceId}`,     // ★ 你專屬的 audience
  ownCookieName: "tpass_token",              // ★ 你自己網域的 cookie
  cookieSecure: self.startsWith("https://"),
} as const;
```

### 3.2 `src/lib/tpass-auth.ts` — 驗章核心（**安全四鐵則就在這**）

```ts
import "server-only";
import { cookies } from "next/headers";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { lostConfig } from "@/config/lost";

export interface TPassClaims {
  sub: string;            // 使用者唯一 id（跨服務一致，可當你 DB 的主鍵）
  email: string;          // 學校信箱
  name: string;           // 顯示名稱
  role: string;           // ⚠️ 目前恆為 "student"，不要拿來做權限
  grade: string | null;   // ⚠️ 目前恆為 null
  exp: number;
}

// createRemoteJWKSet 會自動快取公鑰、依 kid 選鑰、金鑰輪替時重抓。不要自己手刻。
const JWKS = createRemoteJWKSet(new URL(lostConfig.jwksUrl));

export async function verifySession(token: string): Promise<TPassClaims | null> {
  try {
    const { payload } = await jwtVerify(token, JWKS, {
      algorithms: ["EdDSA"],                // 鐵則 1：鎖演算法
      issuer: lostConfig.issuer,            // 鐵則 2：票是這個 auth 簽的
      audience: lostConfig.serviceAudience, // 鐵則 3：票是簽給「我」的
      // 鐵則 4：exp —— jose 預設就會驗，別關掉
    });
    return {
      sub: payload.sub as string,
      email: payload.email as string,
      name: payload.name as string,
      role: payload.role as string,
      grade: (payload.grade as string | null) ?? null,
      exp: payload.exp as number,
    };
  } catch {
    return null; // 過期 / 竄改 / 錯 iss / 錯 aud / 錯演算法 → 一律當「未登入」
  }
}

// 每個請求都用這個認出使用者。
export async function getSession(): Promise<TPassClaims | null> {
  const token = (await cookies()).get(lostConfig.ownCookieName)?.value;
  if (!token) return null;
  return verifySession(token);
}
```

**這四條鐵則缺一不可**：

1. **鎖 `algorithms: ["EdDSA"]`** — 不鎖的話，任何人都能拿你**公開的公鑰**當 HMAC 密鑰去偽造 token（把 header 的 `alg` 改成 `HS256`，沒鎖的函式庫會傻傻地用公鑰當對稱密鑰驗過）。等於誰都能冒充任何人登入。
2. **檢查 `issuer`** — 票是「這個 auth」簽的，不是別人。
3. **檢查 `audience` = `tpass:<你的id>`** — 票是簽給**你**的。漏掉這條，別的服務的 token 就能拿來打你，隔離等於白做。
4. **檢查 `exp`** — 主流函式庫預設會驗，確認你沒關掉。

驗不過 → **一律當「未登入」**，導去登入。**不要把錯誤訊息丟給前端。**

### 3.3 `src/app/api/auth/callback/route.ts` — 收 token

```ts
import { NextResponse, type NextRequest } from "next/server";
import { lostConfig } from "@/config/lost";
import { verifySession } from "@/lib/tpass-auth";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const form = await request.formData();
  const token = form.get("token");
  const next = String(form.get("next") ?? "/");
  if (typeof token !== "string" || !token) {
    return new NextResponse("Bad request", { status: 400 });
  }

  const claims = await verifySession(token);
  if (!claims) return new NextResponse("Invalid token", { status: 401 });

  // next 只能是站內路徑，否則有人能拿你的 callback 當跳板導去釣魚站（Open Redirect）。
  const safeNext = next.startsWith("/") && !next.startsWith("//") ? next : "/";

  const response = NextResponse.redirect(new URL(safeNext, lostConfig.selfUrl), 303);
  response.cookies.set(lostConfig.ownCookieName, token, {
    httpOnly: true,                       // 瀏覽器 JS 讀不到 → XSS 偷不走
    sameSite: "lax",
    secure: lostConfig.cookieSecure,
    path: "/",
    maxAge: Math.max(0, claims.exp - Math.floor(Date.now() / 1000)), // 跟 token 同壽命
    // ★ 不設 domain → host-only。這行「沒寫的東西」就是隔離的來源，別手癢加上去。
  });
  return response;
}
```

### 3.4 `src/app/api/auth/logout/route.ts` — 兩段式登出

登出要清兩個地方：**你自己的 cookie**（只有你能清）＋ **auth 的登入態**。

```ts
import { NextResponse } from "next/server";
import { lostConfig } from "@/config/lost";

export const runtime = "nodejs";

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export async function POST() {
  const authLogout = `${lostConfig.authLogoutUrl}?redirect_uri=${encodeURIComponent(lostConfig.selfUrl)}`;
  const html = `<!doctype html>
<html lang="zh-Hant"><head><meta charset="utf-8"><title>登出中…</title></head>
<body onload="document.forms[0].submit()">
<form method="post" action="${escapeHtml(authLogout)}">
<noscript><button type="submit">完成登出</button></noscript>
</form>
</body></html>`;
  const response = new NextResponse(html, {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
  response.cookies.set(lostConfig.ownCookieName, "", {
    httpOnly: true,
    sameSite: "lax",
    secure: lostConfig.cookieSecure,
    path: "/",
    maxAge: 0,
  });
  return response;
}
```

前端就是一個表單：

```tsx
<form method="post" action="/api/auth/logout">
  <button type="submit">登出</button>
</form>
```

> auth 清掉自己的登入態後，會把使用者 303 導回你的服務（網址帶 `?logout=1`——那**純粹是畫面提示**，不是身分憑證，不可拿它當「已登出」的依據）。
>
> 其他服務的 cookie 會留到各自過期（最多 8 小時）。這是「一服務一張票」換來的已知取捨：登出不再是全生態即時，而是「auth 不再發新票 + 舊票自然過期」。

### 3.5 在頁面裡擋登入 / 拿使用者

```tsx
// src/app/page.tsx（Server Component）
import { redirect } from "next/navigation";
import { getSession } from "@/lib/tpass-auth";
import { loginUrlFor } from "@/config/lost";

export default async function Page() {
  const user = await getSession();
  if (!user) redirect(loginUrlFor("/")); // 未登入 → 導去 auth

  return <p>哈囉 {user.name}（{user.email}）</p>;
}
```

> ⚠️ **每個 route handler / server action 都要自己再 `getSession()` 檢查一次**，
> 不能只靠 layout 或頁面擋——layout 擋不住有人直接打你的 API。

### 3.6 `.env.local`（本機）

```bash
TPASS_SERVICE_ID=lost
JWT_ISSUER=https://auth.lvh.me:3000
AUTH_JWKS_URL=https://auth.lvh.me:3000/.well-known/jwks.json
AUTH_AUTHORIZE_URL=https://auth.lvh.me:3000/api/auth/authorize
AUTH_LOGOUT_URL=https://auth.lvh.me:3000/api/auth/logout
LOST_SELF_URL=https://lost.lvh.me:3006
```

**永遠不要把網址寫死在程式裡**——上線時只改這個檔（換成 `*.tschoolsu.org`、沒有 port），程式一行都不用動。同時把這些 key（用占位值）補進 `.env.example` 給下一個人。

> `lvh.me` 這個網域由公共 DNS 直接解析到 `127.0.0.1`，所以本機開發**不用改 `/etc/hosts`**。

---

## 4. 本機測試與驗收

```bash
scripts/tpass dev lost      # 起你的服務
scripts/tpass dev           # 或全部一起起，才測得到「登入一次、全生態通行」
scripts/tpass check lost    # push 前必跑：lint + tsc
```

> **🚫 禁止裸跑 `npm run dev`。** 你的後端要用 HTTPS 去抓 auth 的公鑰（JWKS），而 Node / Next 預設不信任本機的自簽憑證，會直接 TLS 失敗。`tpass dev` 幫你處理掉了。
> 症狀就是「登入完馬上被踢回登入頁」——九成是這個原因。

**Google 登入不能自動化**（會被 Google 擋，也違反條款），這一關一定要真人點。

驗收清單：

- [ ] 開 `https://lost.lvh.me:3006` → 被導去 auth → Google 登入 → 回到你的頁面，看到自己的名字。
- [ ] DevTools → Application → Cookies → `lost.lvh.me`：有一顆 `tpass_token`，而且 **Domain 欄是 `lost.lvh.me`（前面沒有那個點）** ← 這是 host-only 的證據。
- [ ] 先在 portal 登入，再開你的服務 → **不用再登一次**（這就是 SSO）。
- [ ] 按登出 → cookie 消失。
- [ ] **隔離測試**：把 portal 的 `tpass_token` 值複製出來，POST 到你的 `/api/auth/callback` → 必須回 **401**。過得了就是 `audience` 沒驗對，回去看 §3.2 鐵則 3。

---

## 5. 上線

主機上**部署帳號沒有 root**。標記 `[root]` 的步驟你做不了，要把指令交給維運部員（`tpass new` 已經幫你把指令印好了）。

| # | 誰做 | 做什麼 |
| --- | --- | --- |
| 1 | 你 | Cloudflare DNS：`lost.tschoolsu.org` A record → 主機 IP，**先開灰雲（DNS only）** |
| 2 | **[root]** | nginx server block（反向代理到 `127.0.0.1:3006`）+ `certbot` 簽 TLS 憑證 |
| 3 | 你 | `curl` 直連確認 200 → **切回橘雲** |
| 4 | **[root]** | 有資料庫的話：建 `t_lost` role + database |
| 5 | 你 | 主機上 `git clone` 你的 repo 到 `~/tpass/tpass-lost`，寫 `.env.local`（正式網域、沒有 port） |
| 6 | 你 | 主機的 `tpass-auth/.env.local`，`AUTH_SERVICE_IDS` 加上 `lost` |
| 7 | 你 | ops repo：`services.json` 把 `deployed` 改成 `true` → PR → merge main |
| 8 | 你 | `scripts/tpass deploy auth`（讓白名單生效）→ `scripts/tpass deploy lost` |
| 9 | 你 | `scripts/tpass status` 看服務 online → 瀏覽器真人走一次登入 |

> **灰雲 / 橘雲為什麼要來回切？** Let's Encrypt 簽憑證時的驗證請求必須**直接打到主機**，Cloudflare 橘雲代理會把它接走，導致簽不到憑證。所以：先灰雲 → 簽好 → 再切橘雲（橘雲能隱藏源站 IP、擋攻擊、快取）。

部署失敗？`scripts/tpass logs lost` 看錯誤。要 rollback 就 `git revert` → merge → 再 deploy（build 失敗時舊版程序不受影響，不會停機）。

---

## 6. 卡住了？對照這張表

| 症狀 | 原因 / 解法 |
| --- | --- |
| 登入完**馬上被踢回登入頁**（本機） | 十之八九是裸跑了 `npm run dev`（後端抓不到 JWKS）。改用 `scripts/tpass dev` |
| authorize 回 `400 Unknown service` | 你的 id 沒進 auth 的 `AUTH_SERVICE_IDS`，加了要**重啟 auth** |
| authorize 回 `400 Invalid redirect_uri` | `redirect_uri` 要是完整網址，且網域要在生態系底下（防 Open Redirect） |
| authorize 回 `400 Invalid next` | `next` 必須是站內路徑（`/` 開頭、且不是 `//` 開頭） |
| 一直跳 `/?error=domain` | 你登入的 Google 帳號不是學校網域的信箱 |
| callback 收到 token 但驗不過（401） | `aud` 對不上。你驗的是 `tpass:<id>`？這個 id 跟 authorize 帶的 `service` 一樣嗎？ |
| 驗章一直失敗，但 token 看起來很正常 | `iss` 字串差一個 port 或結尾斜線也會失敗。跟 auth 的 `JWT_ISSUER` 逐字比對 |
| 前端 JS 讀不到 cookie | **這是正常的**（`HttpOnly`）。身分只在後端拿；前端要的話自己開一個 `/api/me` |
| 登入幾小時後失效 | 正常，token 壽命 8 小時 |
| `tpass check env` 說缺 key | 對照你 `src/config/lost.ts` 的 `REQUIRED` 陣列補 `.env.local` |
| 部署被擋，說 env 缺 key | 同上，但要補的是**主機上**的 `.env.local` |

---

## 7. 紅線（違反就是 bug，code review 會被打回）

- ❌ 不要在**前端**驗章、不要把 token 塞 `localStorage`。
- ❌ 不要拿掉 `algorithms: ["EdDSA"]`。（等於開放任何人偽造身分）
- ❌ 不要把 cookie 設 `Domain=.tschoolsu.org`。（通行證會外洩到其他服務，隔離全毀）
- ❌ 不要拿 JWT 的 `role` 做權限判斷——它恆為 `"student"`，是 placeholder。要做管理員權限，用你自己服務內的 allowlist（super-admin 的 env 一律叫 `SUPER_ADMIN_EMAILS`，別自己發明名字）。
- ❌ 不要 import 或複製 auth 的私鑰、`arctic`、Google OAuth callback。**你只需要公鑰。**
- ❌ 不要把網域 / issuer / audience 寫死在程式裡——全部走 env。
- ❌ 不要嘗試自動化 Google 登入。要測就真人點。
- ✅ 每個 server action / route handler 內部都要重新檢查登入，不能只靠 layout。
- ✅ 對外的 webhook / callback 網址要 pin 官方網域（例如只允許 `discord.com`），不要讓管理員填任意 URL。

---

## 附錄 A：JWT payload 有哪些欄位

你的 callback 收到的 token，解開後長這樣：

```json
{
  "sub": "104857600293847561029",
  "email": "b11302042@tschool.tp.edu.tw",
  "name": "林大明",
  "role": "student",
  "grade": null,
  "iss": "https://auth.lvh.me:3000",
  "aud": "tpass:lost",
  "iat": 1750000000,
  "exp": 1750028800
}
```

| 欄位 | 型別 | 意義 |
| --- | --- | --- |
| `sub` | `string` | 使用者唯一識別碼（來自 Google，跨服務一致，**可以當你 DB 的主鍵**） |
| `email` | `string` | 學校信箱（已通過驗證與網域白名單） |
| `name` | `string` | 顯示名稱 |
| `role` | `string` | ⚠️ **placeholder，目前一律 `"student"`**。不要拿來做權限判斷 |
| `grade` | `string \| null` | ⚠️ **目前一律 `null`**。注意型別是 `string` 不是 `number` |
| `iss` | `string` | 簽發者，驗章時必須檢查 |
| `aud` | `string` | 受眾，必為 `tpass:<你的服務id>`，驗章時必須檢查 |
| `iat` / `exp` | `number` | 簽發 / 到期時間（Unix 秒）。token 壽命 8 小時 |

其他規格：

- **簽章演算法**：`EdDSA`（Ed25519）。驗章時必須鎖死。
- **公鑰來源（JWKS）**：`GET <auth 網址>/.well-known/jwks.json`，可快取一小時。用會「依 `kid` 自動選鑰」的函式庫（`jose` 的 `createRemoteJWKSet`），不要自己抓第一把硬用——之後金鑰輪替你才不會壞掉。
- **token 交付方式**：auth 用自動送出的 `<form method="post">` 把 `token` 和 `next` POST 給你，所以 token 不會出現在網址、歷史紀錄、Referer 裡。

---

## 附錄 B：`services.json` 欄位定義

頂層的 `services.json` 是**服務清單的唯一真相**——所有工具（CLI、pm2 設定、部署腳本）都從它讀。**不要在別的地方另外硬編碼服務清單、port、目錄名。**

```jsonc
{
  "id": "lost",              // 短名。＝pm2 程序名＝tpass 參數＝TPASS_SERVICE_ID＝aud 後綴。永不改名
  "name": "T-Lost 遺失物",    // 顯示名稱
  "dir": "tpass-lost",       // repo 目錄名（本機與主機一致）
  "subdomain": "lost",       // 本機＝lost.lvh.me；正式＝lost.tschoolsu.org
  "port": 3006,              // 內部 port。撞車會被驗證擋下
  "db": {                    // 沒有資料庫就填 null
    "name": "t_lost",        // 資料庫名（慣例 t_<id>）
    "user": "t_lost",        // 專屬 role（慣例 t_<id>）
    "strategy": "migrate"    // migrate = 有 migrations 歷史（標準做法）；push 僅限原型
  },
  "enabled": true,           // false = 本機工具全部跳過（封存用）
  "deployed": false          // true = 納入部署。首次上線成功後才翻 true
}
```
