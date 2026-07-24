# TSchool 新服務串接指南

> **給誰讀**：第一次在 TSchool 平台開一個新服務、要讓師生「用學校 Google 帳號登入」的部員。
> **讀完你會有**：一個能跑、能登入、能上線的服務。
> **要花多久**：登入串接本身約 30 分鐘（就是複製四個檔）。上線要等有 root 權限的維運部員做前置。
>
> 這份文件是**自給自足**的：所有 code、設定、指令都寫在裡面，照著做就好。
> **你只需要你自己的 repo**——不需要 ops repo、不需要任何自製指令工具。
> 底下寫的每一行都是原生的 `pnpm` / `ssh`，你看得懂、也自己改得動。
> 套件管理**一律 pnpm**（`brew install pnpm`）；不要用 npm / yarn——鎖檔是 `pnpm-lock.yaml`，
> 混用會生出第二份鎖檔，部署直接炸。
>
> 相關的另外兩份文件：
> - 《TSchool 開發與維運手冊》——主機拓樸、nginx、維運用的 `tpass` 遙控器。
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

## 1. 開工前：跟維運部員要三樣東西

你不需要 ops repo。但有三樣東西只有維運拿得到，先要好再開工：

| 要什麼 | 幹嘛用 | 什麼時候要 |
| --- | --- | --- |
| **服務 id + port** | 你的身分證與門牌（例：`lost` / `3006`）。維運會登記進 `services.json` | 現在 |
| **dev 密鑰包** | 一組**僅限本機**的 Google OAuth client（id + secret）。用來在你自己電腦上跑一份 auth | 現在（§4 要用） |
| **主機 ssh 帳號** | 上線時用。**絕不寫進任何 repo、commit、PR** | 上線時（§5） |

> 🔑 dev 的 Google client 跟正式站是**不同兩組**，dev 只放行 `*.lvh.me` 的回跳。
> 就算外流也動不到正式站。**但還是不要貼進 Slack / commit。**

服務 id 是你的身分證。**它同時是**：pm2 程序名 ＝ 環境變數 `TPASS_SERVICE_ID` ＝ JWT 的 `aud` 後綴 ＝ 你的子網域。**取好就永不改名**（短、全小寫，例：`form`、`msg`、`lost`）。

以下用 `lost`（遺失物）、port `3006` 當範例，你自己換掉。

### 1.1 登記進 `services.json`（維運做）

維運會在 ops repo 加一筆（port 撞車會被擋下），`deployed` 先留 `false`，等你真的上線成功才翻 `true`。
欄位意思見 **附錄 B**。你不用碰這個檔。

### 1.2 讓 auth 認得你

不做這步，authorize 會直接回 `400 Unknown service`。

在 auth 的 `.env.local` 白名單加上你的 id，然後**重啟 auth**：

```bash
AUTH_SERVICE_IDS=portal,form,msg,appeals,lost
```

**本機那份**你自己改（§4.2 會跑到）；**主機那份**上線時改（§5）。兩邊都要。

### 1.3 在門戶大廳放一張卡片

使用者要在 portal 首頁點得到你，才算真的上線。卡片的網址是 **env 驅動**的，所以要動四個地方——**少一個 portal 就會 build 失敗**：

**① `tpass-portal/src/config/services.ts` — `services[]` 加一筆**

```ts
{
  id: "lost",
  name: "遺失物",
  url: process.env.LOST_URL!,   // ← 絕不寫死網域
  icon: "Search",               // lucide-react 的圖示名
  tone: "orange",               // 只能是 green | blue | orange | violet | rose
  roles: ["all"],
  enabled: true,
},
```

**② 同一個檔的 `REQUIRED` 陣列加上你的 key**

```ts
const REQUIRED = ["FORM_URL", "MSG_URL", "APPEALS_URL", "LOST_URL"] as const;
```

**③ portal 的本機 `.env.local`**：`LOST_URL=https://lost.lvh.me:3006`

**④ portal 的主機 `.env.local`**：`LOST_URL=https://lost.tschoolsu.org` → **然後重新部署 portal**（§5）。

> ⚠️ ②做了但④沒做，portal 下次部署會在 build 前被 env 檢查擋下（`缺少必填變數：LOST_URL`），
> 而且**是下一個要部署 portal 的人踩到**，不是你。這四步要一次做完。

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
pnpm add jose
```

底下把 `lost` / `LOST` 換成你的服務 id 就能用。

### 3.1 `src/config/lost.ts` — 設定集中在這裡（全部從 env 讀）

```ts
import "server-only";

// ★ 這個陣列是「env 必填清單」的唯一真相：
//   服務啟動時靠它報出缺哪些 key，部署時 deploy.sh 也讀它，在 build 前就擋下缺 key 的情況。
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
  groups: string[];       // 授權章：此人在本服務屬於哪些群組（admin / super-admin）。授權只看這個
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
      groups: Array.isArray(payload.groups) ? (payload.groups as string[]) : [],
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

## 4. 在自己電腦上跑起來

要測登入，你得**同時跑兩個東西**：一份 **auth**（發票的）＋ **你的服務**（驗票的）。
兩個都必須是 **HTTPS**，而且都必須跑在 `*.lvh.me` 的子網域上。

> **為什麼不能接正式的 auth 來測？** auth 有 `AUTH_ALLOWED_HOST_SUFFIX` 白名單，
> 正式站只放行 `*.tschoolsu.org` 的回跳網址。你本機的 `lost.lvh.me` 一定被擋
> （`400 Invalid redirect_uri`）。這是防 Open Redirect 的設計，不是 bug。

### 4.1 一次性：做一張本機憑證

Google 登入完要用 HTTPS 回來，你的後端也要用 HTTPS 去抓 auth 的公鑰。所以本機一定要有憑證。

```bash
brew install mkcert nss node pnpm
mkcert -install                                   # 讓系統與瀏覽器信任自簽憑證（只做一次）
mkdir -p ~/tpass-certs && cd ~/tpass-certs
mkcert -cert-file cert.pem -key-file key.pem \
       auth.lvh.me portal.lvh.me lost.lvh.me      # 一張憑證涵蓋你會用到的子網域
```

> `lvh.me` 是一個公共 DNS 名稱，**永遠解析到 `127.0.0.1`**。所以你不用改 `/etc/hosts`，
> 又能拿到真正的子網域——cookie 的 host-only 行為才測得準（用 `localhost` 測不出來）。

### 4.2 一次性：在本機跑一份 auth

```bash
git clone git@github.com:YC815/tpass-auth.git
cd tpass-auth
pnpm install
node scripts/gen-keys.mjs          # 產一組「你自己的」dev EdDSA 金鑰，把印出的兩行貼進下面
cp .env.example .env.local
```

`.env.local` 填成這樣（`GOOGLE_*` 兩行跟維運要）：

```bash
GOOGLE_CLIENT_ID=<維運給的 dev client>
GOOGLE_CLIENT_SECRET=<維運給的 dev secret>
AUTH_BASE_URL=https://auth.lvh.me:3000
AUTH_ALLOWED_HOST_SUFFIX=lvh.me                  # 本機只放行 *.lvh.me
AUTH_ALLOWED_EMAIL_DOMAIN=tschool.tp.edu.tw
AUTH_SERVICE_IDS=portal,form,msg,appeals,lost    # ★ 記得加你的 id（§1.2）
PORTAL_URL=https://portal.lvh.me:3001
JWT_ISSUER=https://auth.lvh.me:3000
JWT_TTL_SECONDS=28800
JWT_PRIVATE_KEY=<gen-keys.mjs 印的>              # 你本機自己的一把
JWT_PUBLIC_KEY=<gen-keys.mjs 印的>
```

> 🔑 你產的 dev 金鑰跟**正式主機那把是不同兩把**，這是刻意的：本機金鑰外流也簽不出正式站認得的票。

起 auth（在 `tpass-auth/`，讓它自己佔一個終端機）：

```bash
pnpm dev           # auth 的 package.json 已經設好 HTTPS + auth.lvh.me:3000
```

### 4.3 你的服務：把 dev 指令寫進 `package.json`

**這是最容易踩坑的一步，三個參數缺一不可。** 直接把這段貼進你 repo 的 `package.json`：

```json
{
  "packageManager": "pnpm@10.27.0",
  "pnpm": {
    "onlyBuiltDependencies": ["@prisma/client", "@prisma/engines", "prisma", "sharp", "unrs-resolver"]
  },
  "scripts": {
    "dev": "NODE_TLS_REJECT_UNAUTHORIZED=0 next dev --experimental-https --experimental-https-key $HOME/tpass-certs/key.pem --experimental-https-cert $HOME/tpass-certs/cert.pem -H lost.lvh.me -p 3006"
  }
}
```

> `packageManager` 讓所有人的 pnpm 自動對齊同一版；`onlyBuiltDependencies` 是 pnpm 10 的
> build-script 白名單（pnpm 預設不跑依賴的 postinstall——不放行的話 sharp / prisma 的原生
> 二進位會裝不齊，**本機看起來沒事、上了主機才炸**）。五個服務都是同一份，照抄即可。

三個參數各自在解決什麼：

| 參數 | 不加會怎樣 |
| --- | --- |
| `--experimental-https...` | 沒有 HTTPS，Google 不肯回跳，`Secure` cookie 也寫不進去 |
| `-H lost.lvh.me -p 3006` | 跑在 `localhost` 上 → cookie 網域、`redirect_uri`、`aud` 全部對不上，登入必失敗 |
| `NODE_TLS_REJECT_UNAUTHORIZED=0` | **登入成功後馬上被踢回登入頁，而且沒有任何錯誤訊息** ← 看下面 |

**第三個值得花 30 秒讀懂，不然你會 debug 一整天。**
你的後端要去 fetch auth 的公鑰（`https://auth.lvh.me:3000/.well-known/jwks.json`）。
但 Next（Turbopack）server 端用的 fetch（undici）**不吃 `NODE_EXTRA_CA_CERTS`**——
也就是它**不信任你 mkcert 簽的憑證**。結果是抓公鑰失敗 → 驗章失敗 → 你的 callback 默默回 401 →
使用者被丟回登入頁，無限鬼打牆。關掉本機的 TLS 驗證就是為了繞開這件事。

> ⚠️ `NODE_TLS_REJECT_UNAUTHORIZED=0` **只准出現在本機的 `dev` 指令裡**。
> 不要寫進 `.env`、不要寫進 `build` / `start`。正式主機走真憑證，根本不需要它——
> 把它帶上主機等於關掉所有 TLS 驗證，那是資安事故。
>
> 另外注意：**auth 自己不能加這行**（上面 §4.2 的指令就沒有）。它要去驗 Google 的真憑證。

### 4.4 跑起來

開兩個終端機：

```bash
cd tpass-auth  && pnpm dev      # 終端機 1：發證端 → https://auth.lvh.me:3000
cd tpass-lost  && pnpm dev      # 終端機 2：你的服務 → https://lost.lvh.me:3006
```

然後開 `https://lost.lvh.me:3006`。

**Google 登入不能自動化**（會被 Google 擋，也違反條款），這一關一定要真人點。

### 4.5 push 前必跑

```bash
pnpm lint
pnpm exec tsc --noEmit
```

兩個都綠才 push。沒有別的魔法，就這兩行。

### 4.6 驗收清單

五項全過才算串好。**都不需要跑 portal**，兩個終端機就測得完。

- [ ] **登得進**：開 `https://lost.lvh.me:3006` → 被導去 auth → Google 登入 → 回到你的頁面，看到自己的名字。
- [ ] **cookie 是 host-only**：DevTools → Application → Cookies → `lost.lvh.me`：有一顆 `tpass_token`，
      而且 **Domain 欄是 `lost.lvh.me`——前面沒有那個點**。有點（`.lvh.me`）就是你設了 `Domain`，
      通行證會外洩給其他服務，回去看 §3 紅線。
- [ ] **登得出**：按登出 → cookie 消失。
- [ ] **SSO 真的有效**：在 DevTools 只刪掉 `lost.lvh.me` 的 `tpass_token`（**留著 `auth.lvh.me` 的
      `tpass_auth_session`**）→ 重新整理 → 你會被導去 auth，然後 **auth 不會叫你再點一次 Google，
      直接把你送回來**。這就是「登入一次、全生態通行」。
- [ ] **★ 隔離測試（最重要，能抓出最致命的 bug）**：在瀏覽器直接開這個網址——
      注意 `service` 是**別人**（`portal`），但 `redirect_uri` 指向**你的** callback：

      https://auth.lvh.me:3000/api/auth/authorize?service=portal&redirect_uri=https://lost.lvh.me:3006/api/auth/callback&next=/

      auth 會簽一張 `aud=tpass:portal` 的票 POST 給你。**你的 callback 必須回 401。**
      如果它讓你登入了，代表你沒驗 `audience`——**別人服務的票在你家能用**，隔離全毀。
      回去看 §3.2 鐵則 3。

---

## 5. 上線

主機上**部署帳號沒有 root**。標記 **[root]** 的步驟你做不了，要把指令交給維運部員。

| # | 誰做 | 做什麼 |
| --- | --- | --- |
| 1 | 你 | Cloudflare DNS：`lost.tschoolsu.org` A record → 主機 IP，**先開灰雲（DNS only）** |
| 2 | **[root]** | nginx server block（反向代理到 `127.0.0.1:3006`）+ `certbot` 簽 TLS 憑證 |
| 3 | 你 | `curl` 直連確認 200 → **切回橘雲** |
| 4 | **[root]** | 有資料庫的話：建 `t_lost` role + database，把 `DATABASE_URL` 給你 |
| 5 | 維運 | ops repo：`services.json` 的 `lost` 把 `deployed` 改成 `true` → merge main |
| 6 | 你 | 主機上 `git clone` 你的 repo 到 `~/tpass/tpass-lost`，寫 `.env.local`（正式網域、**沒有 port**） |
| 7 | 你 | 主機 `~/tpass/tpass-auth/.env.local`：`AUTH_SERVICE_IDS` 加上 `lost` |
| 8 | 你 | 主機 `~/tpass/tpass-portal/.env.local`：加 `LOST_URL=https://lost.tschoolsu.org`（§1.3 的第 ④ 步） |
| 9 | 你 | 部署 `auth` → `portal` → `lost`（見 §5.1） |
| 10 | 你 | 瀏覽器真人走一次登入，跑一遍 §4.6 的驗收清單（把 `lvh.me:3006` 換成正式網域） |

> **灰雲 / 橘雲為什麼要來回切？** Let's Encrypt 簽憑證時的驗證請求必須**直接打到主機**，Cloudflare 橘雲代理會把它接走，導致簽不到憑證。所以：先灰雲 → 簽好 → 再切橘雲（橘雲能隱藏源站 IP、擋攻擊、快取）。

### 5.1 部署（ssh 進主機，跑四行）

主機上**已經有一支 `deploy.sh`**，你不用自己記那串。它對指定服務會做：
**env 必填檢查**（缺 key 在 build 前就擋下）→ `git pull` → 需要時 `pnpm install --frozen-lockfile` →
`prisma generate` → `pnpm build` → 套 DB schema → `pm2` zero-downtime reload → **健康檢查**（打你的 port，30 秒內沒有健康回應就算失敗）。

```bash
ssh <帳號>@<主機>                     # 位址與帳號跟維運要。★ 絕不寫進任何 repo / commit / PR

cd ~/tpass && git pull --ff-only      # 先更新 ops（services.json、deploy.sh 才是最新的）

./deploy/deploy.sh auth               # ① 白名單生效，否則你的服務會收到 400 Unknown service
./deploy/deploy.sh portal             # ② 門戶卡片生效（LOST_URL 是新的必填 key，不部署 portal 就看不到你）
./deploy/deploy.sh lost               # ③ 你的服務首次啟動
```

**順序有意義**，別跳過前兩個。

看狀態與 log（都在主機上）：

```bash
pm2 status                 # 所有服務活著沒
pm2 logs lost --lines 100  # 你的服務的錯誤
```

**Rollback**：在你的 repo `git revert` 出一個新 commit → merge 進 main → 再跑一次 `./deploy/deploy.sh lost`。
不需要特殊機制。**build 失敗時舊版程序完全不受影響，不會停機**——deploy.sh 是先 build 成功才 reload 的。

> 維運部員手上有個本機遙控器（`tpass deploy lost`），做的就是上面這四行 ssh 指令。
> 你不需要它——效果一模一樣。

---

## 6. 卡住了？對照這張表

| 症狀 | 原因 / 解法 |
| --- | --- |
| 登入完**馬上被踢回登入頁**（本機） | 九成是 dev 指令少了 `NODE_TLS_REJECT_UNAUTHORIZED=0`，後端抓不到 auth 的 JWKS 公鑰（§4.3）。log 裡找 `UNABLE_TO_VERIFY_LEAF_SIGNATURE` |
| 登入完**馬上被踢回登入頁**（主機） | 這裡跟 TLS 無關，**絕不要**在主機加 `NODE_TLS_REJECT_UNAUTHORIZED`。查 `iss` / `aud` 有沒有對上（往下兩列） |
| 瀏覽器說憑證不安全 | 憑證沒涵蓋你的子網域。重跑 §4.1 的 `mkcert`，把 `lost.lvh.me` 加進去；`mkcert -install` 也要跑過 |
| authorize 回 `400 Unknown service` | 你的 id 沒進 auth 的 `AUTH_SERVICE_IDS`，加了要**重啟 auth** |
| authorize 回 `400 Invalid redirect_uri` | `redirect_uri` 要是完整網址，且網域要在生態系底下（防 Open Redirect） |
| authorize 回 `400 Invalid next` | `next` 必須是站內路徑（`/` 開頭、且不是 `//` 開頭） |
| 一直跳 `/?error=domain` | 你登入的 Google 帳號不是學校網域的信箱 |
| callback 收到 token 但驗不過（401） | `aud` 對不上。你驗的是 `tpass:<id>`？這個 id 跟 authorize 帶的 `service` 一樣嗎？ |
| 驗章一直失敗，但 token 看起來很正常 | `iss` 字串差一個 port 或結尾斜線也會失敗。跟 auth 的 `JWT_ISSUER` 逐字比對 |
| 前端 JS 讀不到 cookie | **這是正常的**（`HttpOnly`）。身分只在後端拿；前端要的話自己開一個 `/api/me` |
| 登入幾小時後失效 | 正常，token 壽命 8 小時 |
| 服務一啟動就報「缺少必填環境變數」 | 對照你 `src/config/lost.ts` 的 `REQUIRED` 陣列補 `.env.local`（那個陣列就是必填清單的真相） |
| 部署被擋，說 env 缺 key | 同上，但要補的是**主機上**的 `.env.local`。deploy.sh 在 build 前就先擋，這是故意的 |
| 上線了，但 **portal 首頁看不到你的卡片** | §1.3 的四步沒做完——最常漏的是第 ④ 步（主機 portal 的 `.env.local` 加 `LOST_URL`）+ 重新部署 portal |
| 部署 portal 時報 `缺少必填變數：LOST_URL` | 你把 `LOST_URL` 加進 `REQUIRED` 了，但主機 portal 的 `.env.local` 沒加。§1.3 第 ④ 步 |

---

## 7. 紅線（違反就是 bug，code review 會被打回）

- ❌ 不要在**前端**驗章、不要把 token 塞 `localStorage`。
- ❌ 不要拿掉 `algorithms: ["EdDSA"]`。（等於開放任何人偽造身分）
- ❌ 不要把 cookie 設 `Domain=.tschoolsu.org`。（通行證會外洩到其他服務，隔離全毀）
- ✅ 管理員權限就讀 JWT 的 `groups`（`groups.includes("admin")`，`super-admin` 隱含 `admin`）。名單維護在**中央**（auth 的 `AUTH_GROUPS` 設定），你的服務**不要**自維護 allowlist / DB 名單。細粒度授權（能讀哪筆資料）仍在你服務本地做。
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
  "groups": ["admin"],
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
| `groups` | `string[]` | **授權章**：此人在本服務屬於哪些群組（`["admin"]` 等），非管理員為 `[]`。授權只讀這個；名單維護在中央（auth `AUTH_GROUPS`） |
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
