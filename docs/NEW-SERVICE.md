# T-Pass 服務串接指南

> 在 TSchool 平台建立新服務，並接入 T-Pass 單一登入（SSO）的完整指引。

| | |
|---|---|
| **適用對象** | 首次建立服務、需讓師生以學校 Google 帳號登入的開發成員 |
| **預期成果** | 一個可執行、可登入、可上線的服務 |
| **預估時間** | 登入串接約 30 分鐘；上線另需維運成員完成前置作業 |
| **相依文件** | 《開發與維運手冊》、《T-Pass Design System》 |

## 目錄

- [簡介](#簡介)
- [運作原理](#運作原理)
- [事前準備](#事前準備)
  - [服務註冊](#服務註冊)
- [專案結構](#專案結構)
- [整合登入](#整合登入)
  - [設定檔](#設定檔)
  - [驗章核心](#驗章核心)
  - [接收 token](#接收-token)
  - [登出](#登出)
  - [頁面守門](#頁面守門)
  - [環境變數](#環境變數)
- [授權：權限管理（permissions claim）](#授權權限管理permissions-claim)
  - [權限模型](#權限模型)
  - [解析權限：擴充 tpass-auth.ts](#解析權限擴充-tpass-authts)
  - [權限判斷函式](#權限判斷函式)
  - [於頁面與 API 守門](#於頁面與-api-守門)
  - [呈現警告：WarningBanner](#呈現警告warningbanner)
  - [細粒度授權](#細粒度授權)
  - [管理權限：auth 的 /admin panel](#管理權限auth-的-admin-panel)
  - [驗收：授權](#驗收授權)
- [本機開發](#本機開發)
  - [建立本機憑證](#建立本機憑證)
  - [啟動本機 auth](#啟動本機-auth)
  - [設定 dev 指令](#設定-dev-指令)
  - [啟動服務](#啟動服務)
  - [提交前檢查](#提交前檢查)
  - [驗收清單](#驗收清單)
- [部署](#部署)
  - [部署指令](#部署指令)
- [疑難排解](#疑難排解)
- [安全規範](#安全規範)
- [參考：JWT Payload](#參考jwt-payload)
- [參考：services.json 欄位](#參考servicesjson-欄位)

## 簡介

T-Pass 是 TSchool 平台的單一登入機制。師生以學校 Google 帳號登入一次，即可通行所有子服務。其架構遵循一項核心原則：**auth 負責發證，各服務負責驗證；服務不持有、也不需要任何私鑰。**

本指南是自給自足的：所有程式碼、設定、指令皆完整寫在文件中，依序操作即可完成串接。新服務只需要自己的 repo，加上對公開的 `YC815/tpass-registry` 開一個 PR——不需要存取 ops repo，也不需要任何自製工具，文件中使用的皆為原生 `git` / `pnpm` / `ssh` 指令。

> [!IMPORTANT]
> 套件管理一律使用 pnpm，鎖檔為 `pnpm-lock.yaml`。混用 npm 或 yarn 會產生第二份鎖檔，導致部署失敗。

另有兩份相依文件，適用於不同階段：

- 《TSchool 開發與維運手冊》——主機拓樸、nginx、維運層的工具。
- 《T-Pass Design System》——UI 風格規範，本文件不重複其內容，設計畫面時請參閱該份文件。

## 運作原理

T-Pass 的角色分工可以概括為一句話：**auth 負責發證，服務負責驗證。服務永遠拿不到、也不需要任何私鑰。**

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

三個關鍵設計如下：

| 設計 | 說明 | 目的 |
| --- | --- | --- |
| **服務只持有公鑰** | 服務不接觸 Google、不接觸私鑰，也不需要呼叫 auth 的 API | 驗章在服務自己的後端完成，auth 故障不影響已登入的使用者 |
| **票證一服務一張** | token 的 `aud=tpass:<你的id>`，用於其他服務一律驗證失敗 | 單一服務被攻擊，不會波及其他服務 |
| **cookie 限定本服務網域** | cookie 不設 `Domain`（host-only） | 瀏覽器不會把通行證送往任何其他服務 |

> [!IMPORTANT]
> 純前端 SPA 無法完成此串接。cookie 為 `HttpOnly`，驗章須在 server 端進行，因此服務必須具備後端。Next.js 的 Route Handler / Server Component 即可作為後端。**絕不將 token 存放於 `localStorage`。**

## 事前準備

新服務不需要 ops repo，但有兩項資源僅維運成員持有，需先取得後才能開始：

| 項目 | 用途 | 取得時機 |
| --- | --- | --- |
| **dev 密鑰包** | 一組僅限本機使用的 Google OAuth client（id + secret），用於本機執行 auth | 開始前（〈本機開發〉會用到） |
| **主機 ssh 帳號** | 上線時使用。**絕不寫入任何 repo、commit、PR** | 上線時（見〈部署〉） |

> [!IMPORTANT]
> dev 的 Google client 與正式站是不同的兩組，dev 僅放行 `*.lvh.me` 的回跳網址。即使外流也不影響正式站，但仍不應貼入 Slack 或提交至版本控制。

服務 id 是服務的身分識別，同時對應：pm2 程序名 ＝ 環境變數 `TPASS_SERVICE_ID` ＝ JWT 的 `aud` 後綴 ＝ 服務子網域。**id 一經選定即不再更名**（建議短、全小寫，例：`form`、`msg`、`lost`）。

以下以 `lost`（遺失物）、port `3007` 為範例，實作時請替換為實際服務 id 與 port。

### 服務註冊

**整個註冊只有這一步：對 `YC815/tpass-registry` 開一個 PR，在 `services.json` 加一個物件。**

這個 repo 是公開的，任何人都能 fork + PR，不需要事先被加成 collaborator。merge 之後：

- **auth 的發證白名單**自動包含你（否則 authorize 會把使用者導去 `/service-error?reason=unknown-service`）
- **portal 大廳的卡片**自動出現（等 `deployed` 翻成 `true` 之後，見〈部署〉）
- **部署腳本與 pm2** 自動認得你的目錄與 port

除此之外**不需要改任何其他 repo 的程式碼**——不必碰 portal，也不必碰 auth。

```bash
gh repo fork YC815/tpass-registry --clone      # 或到 GitHub 網頁按 Fork 再 git clone
cd tpass-registry
git checkout -b add-lost
```

在 `services.json` 的 `services` 陣列末端加一筆（完整欄位說明見〈參考：services.json 欄位〉）：

```jsonc
{
  "id": "lost",
  "name": "T-Lost 遺失物",
  "dir": "tpass-lost",
  "subdomain": "lost",
  "port": 3007,                                       // 撞車會被 CI 擋下
  "db": { "name": "t_lost", "user": "t_lost", "strategy": "migrate" },
  "enabled": true,
  "deployed": false,                                  // 首次上線成功後才翻 true
  "portal": {                                         // 沒有這塊 = 不進大廳
    "label": "遺失物",
    "icon": "Search",                                 // lucide 的 PascalCase 名
    "tone": "orange",                                 // green|blue|orange|violet|rose
    "roles": ["all"]
  }
}
```

送出前先在本機驗一次（不需安裝任何依賴），然後開 PR：

```bash
node validate.mjs
git commit -am "registry: 登記 lost（遺失物）"
git push -u origin add-lost
gh pr create --fill
```

> [!NOTE]
> **卡片網址不寫在這裡**——它由 `subdomain` + `port` + 頂層 `domains` 自動推導成
> `https://lost.lvh.me:3007`（本機）或 `https://lost.tschoolsu.org`（正式）。
> 這也是為什麼你的程式碼裡**永遠不該寫死網域**。

## 專案結構

服務一律採用 **Next.js 16 + React 19**（與生態系其他服務一致）。

> [!WARNING]
> Next 16 存在破壞性變更，其 API 可能與既有認知不同。撰寫程式碼前請先參閱 `node_modules/next/dist/docs/`。

repo 結構如下：

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

標星號的四個檔案即登入串接的全部內容，詳見〈整合登入〉。

## 整合登入

```bash
pnpm add jose
```

以下範例將 `lost` / `LOST` 替換為實際服務 id 即可使用。

### 設定檔

`src/config/lost.ts` — 設定集中於此，全部透過 env 讀取：

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

### 驗章核心

`src/lib/tpass-auth.ts` — 驗章核心，安全四鐵則實作於此：

```ts
import "server-only";
import { cookies } from "next/headers";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { lostConfig } from "@/config/lost";

// 權限 claim 契約：role 三級（admin 隱含 moderator）、restriction 省略＝none、
// read 是唯一必看欄位（auth 已經算好 = restriction !== "ban"）。詳見〈授權：權限管理〉。
export type Role = "admin" | "moderator" | "default";
export type Restriction = "none" | "warning" | "ban";

export interface PermissionEntry {
  read: boolean;
  role: Role;
  restriction?: Restriction;
  reason?: string;
  until?: number;
}

export type PermissionMap = Record<string, PermissionEntry>;

export interface TPassClaims {
  sub: string;            // 使用者唯一 id（跨服務一致，可當你 DB 的主鍵）
  email: string;          // 學校信箱
  name: string;           // 顯示名稱
  // 權限本體：一般服務 token 只含自己一把 key（{ lost: {...} }）。授權判斷一律看這裡。
  permissions: PermissionMap;
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
      permissions: (payload.permissions as PermissionMap | undefined) ?? {},
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

// 安全預設值：claim 缺 permissions、或缺你要查的 serviceId 這把 key（舊票／查別服務）
// → 視為「能讀、預設角色」，不因缺資料而誤鎖使用者。不傳 serviceId 預設查自己這個服務。
const DEFAULT_PERMISSION_ENTRY: PermissionEntry = { read: true, role: "default" };

export function permOf(
  session: TPassClaims,
  serviceId: string = lostConfig.serviceId,
): PermissionEntry {
  return session.permissions[serviceId] ?? { ...DEFAULT_PERMISSION_ENTRY };
}
```

四鐵則缺一不可：

1. **鎖定 `algorithms: ["EdDSA"]`**——若不鎖定，任何人皆可利用公開的公鑰偽造 token（將 header 的 `alg` 改為 `HS256`，未鎖定演算法的函式庫會將公鑰誤用為對稱密鑰驗證通過），等同任何人皆可冒充任意使用者登入。
2. **檢查 `issuer`**——確保票證由指定的 auth 簽發，而非其他來源。
3. **檢查 `audience` = `tpass:<你的id>`**——確保票證是簽發給本服務的。遺漏此檢查，其他服務的 token 即可用於冒用本服務，服務隔離形同虛設。
4. **檢查 `exp`**——主流函式庫預設會驗證，需確認未被關閉。

驗證失敗一律視為「未登入」並導向登入流程。**不應將錯誤訊息回傳給前端。**

### 接收 token

`src/app/api/auth/callback/route.ts`：

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

### 登出

`src/app/api/auth/logout/route.ts` — 登出須清除兩處：本服務自身的 cookie（僅本服務可清除）與 auth 的登入態。

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

前端僅需一個表單：

```tsx
<form method="post" action="/api/auth/logout">
  <button type="submit">登出</button>
</form>
```

> [!NOTE]
> auth 清除自身登入態後，會將使用者以 303 導回本服務（網址附帶 `?logout=1`，此參數僅為畫面提示，不具身分憑證效力，不可作為「已登出」的判斷依據）。
>
> 其他服務的 cookie 會保留至各自過期（最長＝auth 端 `JWT_TTL_SECONDS`，建議 45 分鐘）。這是「一服務一張票」設計下的已知取捨：登出不再是全生態即時生效，而是「auth 不再發新票 + 舊票自然過期」。

### 頁面守門

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

> [!WARNING]
> 每個 route handler / server action 都必須各自呼叫 `getSession()` 進行檢查，不能僅依賴 layout 或頁面層級的攔截——layout 無法阻擋直接呼叫 API 的請求。

### 環境變數

`.env.local`（本機）：

```bash
TPASS_SERVICE_ID=lost
JWT_ISSUER=https://auth.lvh.me:3000
AUTH_JWKS_URL=https://auth.lvh.me:3000/.well-known/jwks.json
AUTH_AUTHORIZE_URL=https://auth.lvh.me:3000/api/auth/authorize
AUTH_LOGOUT_URL=https://auth.lvh.me:3000/api/auth/logout
LOST_SELF_URL=https://lost.lvh.me:3007
```

網址不應寫死於程式碼中——上線時僅需修改此檔（改為 `*.tschoolsu.org`，不含 port），程式碼無需異動。同時將這些 key（以佔位值表示）補入 `.env.example`，供後續維護者參考。

> [!NOTE]
> `lvh.me` 這個網域由公共 DNS 直接解析到 `127.0.0.1`，因此本機開發不需修改 `/etc/hosts`。

## 授權：權限管理（permissions claim）

登入（authentication）確認「你是誰」；授權（authorization）決定「你能做什麼」。兩者是不同的機制，需分別實作。T-Pass 的授權模型：**auth 於 token 中蓋上 `permissions` 章（per-service 的 role + 管制狀態），各服務讀取 `permissions` 於本地判斷權限。** 服務不自行維護管理員名單、不查詢資料庫——名單維護在 auth 的 **`/admin` 網頁 panel**，不是環境變數。

### 權限模型

`permissions` 是 `Record<服務id, PermissionEntry>`，一般服務 token 只含自己一把 key：

```ts
type Role        = "admin" | "moderator" | "default";
type Restriction = "none"  | "warning"   | "ban";

interface PermissionEntry {
  read: boolean;             // 必有。唯一必看欄位，auth 已經算好（= restriction !== "ban"）
  role: Role;                // 必有。admin 隱含 moderator
  restriction?: Restriction; // 省略＝none
  reason?: string;           // 只在 restriction !== "none" 時出現
  until?: number;            // 選填 Unix 秒，管制到期自動解除
}
```

- **`role`**：三級，`admin` 隱含 `moderator` 的所有能力，`default` 是一般使用者。
- **`restriction`**：`warning`（提醒，仍可使用，呈現方式自訂）與 `ban`（禁止使用，auth 已在
  `authorize` 階段攔截，正常情況下你的服務根本收不到 ban 者的新票）。
- **`read`** 是唯一必看欄位：`if (!perm.read) redirect(deniedUrl)` 就是完整的 ban 守門邏輯。
- 權限變更（在 `/admin` panel 存檔）最長 `JWT_TTL_SECONDS`（auth 端設定，建議 45 分鐘）後生效
  ——這是換票成本換來的取捨，細節與 ban 立即失效的例外見 `tpass-auth/INTEGRATION.md` §3.5。

> [!NOTE]
> 舊版曾有 `groups` claim（`groups.includes("admin")`），已於 2026-07-27 從 auth 簽發邏輯
> 與所有消費端程式碼中移除。**新服務只認 `permissions`**，不會也不應該再寫 `groups.includes(...)`。

### 解析權限：擴充 tpass-auth.ts

若照〈驗章核心〉的範例，`permOf()` 已經在 `src/lib/tpass-auth.ts` 裡了（缺 claim 或缺該
serviceId 這把 key 時安全預設為 `{read:true, role:"default"}`，不會因缺資料誤鎖使用者）。
接下來的權限判斷都建立在它之上。

### 權限判斷函式

新增 `src/config/admin.ts`，將 role 判斷收斂於單一處：

```ts
import "server-only";
import { permOf, type TPassClaims } from "@/lib/tpass-auth";

export function isAdmin(session: TPassClaims | null | undefined): boolean {
  return !!session && permOf(session).role === "admin";
}

export function isModeratorOrAbove(session: TPassClaims | null | undefined): boolean {
  return !!session && permOf(session).role !== "default";
}
```

新增 `src/lib/guard.ts`，提供各層重用的守門函式：

```ts
import "server-only";
import { redirect } from "next/navigation";
import { getSession, permOf, type TPassClaims } from "@/lib/tpass-auth";
import { isAdmin } from "@/config/admin";
import { loginUrlFor, lostConfig } from "@/config/lost";

export class ForbiddenError extends Error {
  constructor() {
    super("Forbidden");
    this.name = "ForbiddenError";
  }
}

export async function requireSession(returnPath = "/"): Promise<TPassClaims> {
  const session = await getSession();
  if (!session) redirect(loginUrlFor(returnPath));
  // read 守門：正常情況 ban 在 authorize 就被攔下；這裡是給「舊票在被 ban 之後、
  // 過期之前」窗口用的防禦層（見 tpass-auth/INTEGRATION.md §3.5）。
  if (!permOf(session).read) redirect(`${process.env.AUTH_DENIED_URL}?service=${lostConfig.serviceId}`);
  return session;
}

export async function requireAdmin(returnPath = "/admin"): Promise<TPassClaims> {
  const session = await requireSession(returnPath);
  if (!isAdmin(session)) throw new ForbiddenError();
  return session;
}
```

> [!NOTE]
> `AUTH_DENIED_URL` 是選填 env：沒設就用 `AUTH_AUTHORIZE_URL` 的 origin 自動推導
> `<origin>/denied`，通常不用另外設。想自訂就在 `.env.local` 加一行即可。

### 於頁面與 API 守門

後台頁面以 layout 統一攔截：未登入者導向登入頁，已登入但非管理員者顯示禁止存取畫面。

```tsx
// src/app/admin/layout.tsx
import { redirect } from "next/navigation";
import { getSession } from "@/lib/tpass-auth";
import { isAdmin } from "@/config/admin";
import { loginUrlFor } from "@/config/lost";

export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await getSession();
  if (!session) redirect(loginUrlFor("/admin"));
  if (!isAdmin(session)) {
    return <p>你沒有存取此頁面的權限。</p>; // 替換為你的禁止存取畫面
  }
  return <>{children}</>;
}
```

> [!WARNING]
> layout 無法阻擋直接呼叫 API 的請求。**每個 route handler 與 server action 都必須各自重新檢查權限**，不能僅依賴 layout 或頁面層級的攔截。

route handler 於內部自行檢查，未通過回應 `403`：

```ts
import { NextResponse } from "next/server";
import { getSession } from "@/lib/tpass-auth";
import { isAdmin } from "@/config/admin";

export async function GET() {
  const session = await getSession();
  if (!session || !isAdmin(session)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  // …此處為管理員邏輯
}
```

server action 則以 `requireAdmin` 攔截，非管理員會拋出 `ForbiddenError`：

```ts
"use server";
import { requireAdmin } from "@/lib/guard";

export async function deleteItem(id: string) {
  await requireAdmin();
  // …此處為管理員邏輯
}
```

### 呈現警告：WarningBanner

`restriction === "warning"` 的呈現方式由各模組自訂——沒有固定版型，但 `tpass-portal` 有一份
可直接抄的範本：`tpass-portal/src/components/WarningBanner.tsx`。核心邏輯只有兩行：

```tsx
const perm = permOf(session);
{perm.restriction === "warning" && <WarningBanner reason={perm.reason} until={perm.until} />}
```

### 細粒度授權

`role` 判斷的是角色層級的權限（是否為管理員）。「能否讀取**某一筆**資料」屬於資源層級的授權，仍應於服務本地依資料的擁有者實作。例如「回覆內容僅限建立者本人或管理員讀取」：

```ts
import { isAdmin } from "@/config/admin";
import type { TPassClaims } from "@/lib/tpass-auth";

export function canReadResponses(
  session: TPassClaims,
  form: { ownerSub: string },
): boolean {
  return isAdmin(session) || form.ownerSub === session.sub;
}
```

> [!NOTE]
> 擁有者比對使用 `sub` 而非 `email`。`sub` 是跨服務一致的穩定識別碼，`email` 則可能變動。

### 管理權限：auth 的 `/admin` panel

權限名單**不再寫在任何服務的環境變數裡**。改成登入 auth 的網頁後台管理：

```
https://auth.lvh.me:3000/admin          # 本機
https://auth.tschoolsu.org/admin        # 正式站
```

| 操作 | 位置 |
|---|---|
| 找人 / 新增人員（只需 email，不必等對方登入過） | `/admin/people`、`/admin/people/new` |
| 幫某人在**你的服務**設 role（admin/moderator）或下 restriction（warning/ban + 原因 + 到期） | `/admin/people/[email]` — 每個服務一列 |
| 只看你服務的名單 | `/admin/services/<你的服務id>` |
| 稽核紀錄（誰在什麼時候改了誰） | `/admin/audit` |
| 刪除人員（連同他在**所有**服務的權限紀錄，僅 admin） | `/admin/people/[email]` — 頁面底部「危險操作」 |

panel 本身的存取權：`AUTH_SUPERADMINS`（生態總管，逃生門）或在 auth 這個服務本身被設為
admin/moderator 的人。**moderator 可以下 warning/ban，但不能改 role**；不能 ban 或降級
superadmin；不能調降自己在 auth 的 role。ban 需二次確認且必填原因。

要讓別人也能管權限，就在 `/admin/people/[email]` 把他在 **`auth` 那一列**設成 admin
（可改所有人的角色與管制，含再指派管理員）或 moderator（只能改管制）——panel 的權限就是
這套模型自己，沒有另一份名單。

> [!WARNING]
> **刪除人員是「清空紀錄」，不是「封鎖」。** 刪掉的人下次登入會被重新建立成一筆乾淨紀錄，
> 他身上所有服務的 warning/ban 一併消失；若他當下有尚未過期的 auth 登入態，刪除會讓那顆
> session 立刻復活（ban 寫的 `sessionsValidFrom` 隨 Subject 一起沒了）。要擋人請用 ban。
> 刪除只有 admin 能做，且不能刪自己、不能刪 superadmin；刪除內容會留在 `/admin/audit`
> （`subject.delete`，含被刪掉的完整 grant 清單）。

> [!IMPORTANT]
> 存檔後**不會**立即讓對方的舊票失效（除非是 ban——ban 會讓對方的 auth 登入態立刻作廢）。
> 一般的 role/warning 變更，生效延遲最長＝`JWT_TTL_SECONDS`（建議 45 分鐘），對方下次換票
> 才會拿到新權限。panel 會顯示「最晚 HH:MM 生效」。

### 驗收：授權

- [ ] 在 `/admin` 把某人設為你服務的 admin → 他重新登入（或等舊票過期換票）後進得了 `/admin`（你自己服務的後台）。
- [ ] 名單外的人登入後於你的 `/admin` 被擋下（顯示禁止存取畫面）。
- [ ] 在 `/admin` 對某人下 `ban` + 原因 → 他重新走一次登入被導去 `<auth>/denied?service=<你的id>`，看得到原因與（若有設）解封時間。
- [ ] 解除 ban 後，他能重新登入使用。
- [ ] 對某人下 `warning` → 他登入後在你的服務看得到警告呈現（你自訂的版型，例如照抄 `WarningBanner`）。
- [ ] `permOf(session)` 對缺資料的情況（例如剛登記還沒設定）回傳安全預設值 `{read:true, role:"default"}`，不會誤鎖使用者。

## 本機開發

測試登入需同時執行兩個服務：一份 **auth**（發證端）與**目標服務**（驗證端）。兩者皆須為 **HTTPS**，且皆須運行於 `*.lvh.me` 的子網域上。

> [!NOTE]
> **為何不能串接正式站的 auth 進行測試？** auth 設有 `AUTH_ALLOWED_HOST_SUFFIX` 白名單，正式站僅放行 `*.tschoolsu.org` 的回跳網址，本機的 `lost.lvh.me` 必定被擋下（`400 Invalid redirect_uri`）。這是防止 Open Redirect 的設計，非缺陷。

### 建立本機憑證

Google 登入完成後需以 HTTPS 回跳，後端也須以 HTTPS 抓取 auth 的公鑰，因此本機必須具備憑證。此步驟僅需執行一次：

```bash
brew install mkcert nss node pnpm
mkcert -install                                   # 讓系統與瀏覽器信任自簽憑證（只做一次）
mkdir -p ~/tpass-certs && cd ~/tpass-certs
mkcert -cert-file cert.pem -key-file key.pem \
       auth.lvh.me portal.lvh.me lost.lvh.me      # 一張憑證涵蓋你會用到的子網域
```

> [!NOTE]
> `lvh.me` 是一個公共 DNS 名稱，永遠解析到 `127.0.0.1`，因此不需修改 `/etc/hosts`，同時仍能取得真正的子網域——唯有如此才能正確驗證 cookie 的 host-only 行為（以 `localhost` 測試無法驗證此行為）。

### 啟動本機 auth

此步驟僅需執行一次。**auth 與註冊表必須 clone 在同一層**——auth 會讀 `../tpass-registry/services.json` 決定可以為哪些服務發證：

```bash
git clone git@github.com:YC815/tpass-auth.git
git clone https://github.com/YC815/tpass-registry.git   # ★ 與 tpass-auth 同一層
cd tpass-auth
pnpm install
node scripts/gen-keys.mjs          # 產一組「你自己的」dev EdDSA 金鑰，把印出的兩行貼進下面
cp .env.example .env.local
```

auth 有自己的資料庫（記著誰在哪個服務是什麼角色），本機也要建一份：

```bash
createuser t_auth                                  # 已存在會報錯，可忽略
createdb -O t_auth t_auth
```

> [!NOTE]
> 若 `createuser` / `createdb` 不存在，表示本機沒有 PostgreSQL：`brew install postgresql@17 && brew services start postgresql@17`。

`.env.local` 填入以下內容（`GOOGLE_*` 兩行需向維運成員索取）：

```bash
GOOGLE_CLIENT_ID=<維運給的 dev client>
GOOGLE_CLIENT_SECRET=<維運給的 dev secret>
AUTH_BASE_URL=https://auth.lvh.me:3000
AUTH_ALLOWED_HOST_SUFFIX=lvh.me                  # 本機只放行 *.lvh.me
AUTH_ALLOWED_EMAIL_DOMAIN=tschool.tp.edu.tw
PORTAL_URL=https://portal.lvh.me:3001
JWT_ISSUER=https://auth.lvh.me:3000
JWT_TTL_SECONDS=28800
JWT_PRIVATE_KEY=<gen-keys.mjs 印的>              # 你本機自己的一把
JWT_PUBLIC_KEY=<gen-keys.mjs 印的>
DATABASE_URL=postgresql://t_auth@localhost:5432/t_auth
AUTH_SUPERADMINS=<你的學校信箱>                   # 生態總管，恆為所有服務 admin
```

> [!NOTE]
> **服務白名單不在這裡**。auth 可以為哪些服務發證，完全由 `../tpass-registry/services.json` 決定
> ——你在〈事前準備〉「服務註冊」加的那一筆，把 registry clone 到同一層就會生效，
> 本機不需要另外設定。

套用資料庫 schema（Prisma CLI 只讀 `.env`，所以先把 `.env.local` 匯進環境）：

```bash
set -a; . ./.env.local; set +a
pnpm exec prisma migrate deploy
```

> [!IMPORTANT]
> 這裡產生的 dev 金鑰與正式主機使用的是不同的兩把，此為刻意設計：本機金鑰外流也無法簽發正式站認得的票證。

啟動 auth（於 `tpass-auth/` 目錄下，建議獨佔一個終端機）：

```bash
pnpm dev           # auth 的 package.json 已經設好 HTTPS + auth.lvh.me:3000
```

### 設定 dev 指令

以下三個參數缺一不可，將此段貼入 repo 的 `package.json`：

```json
{
  "packageManager": "pnpm@10.27.0",
  "pnpm": {
    "onlyBuiltDependencies": ["@prisma/client", "@prisma/engines", "prisma", "sharp", "unrs-resolver"]
  },
  "scripts": {
    "dev": "NODE_TLS_REJECT_UNAUTHORIZED=0 next dev --experimental-https --experimental-https-key $HOME/tpass-certs/key.pem --experimental-https-cert $HOME/tpass-certs/cert.pem -H lost.lvh.me -p 3007"
  }
}
```

> [!NOTE]
> `packageManager` 使所有開發者的 pnpm 版本自動對齊；`onlyBuiltDependencies` 是 pnpm 10 的 build-script 白名單機制（pnpm 預設不執行依賴套件的 postinstall，若未放行，sharp / prisma 的原生二進位檔將無法完整安裝——此問題在本機不會顯現，僅於部署至主機後才會出現）。五個服務共用同一份設定，可直接複製使用。

三個參數各自解決的問題：

| 參數 | 缺少時的影響 |
| --- | --- |
| `--experimental-https...` | 缺少 HTTPS，Google 不予回跳，`Secure` cookie 亦無法寫入 |
| `-H lost.lvh.me -p 3007` | 若運行於 `localhost`，cookie 網域、`redirect_uri`、`aud` 全部無法對應，登入必然失敗 |
| `NODE_TLS_REJECT_UNAUTHORIZED=0` | 登入成功後立即被導回登入頁，且無任何錯誤訊息（詳見下方說明） |

第三項參數的原理值得說明。服務後端需 fetch auth 的公鑰（`https://auth.lvh.me:3000/.well-known/jwks.json`），但 Next（Turbopack）server 端所使用的 fetch（undici）不讀取 `NODE_EXTRA_CA_CERTS`，即不信任 mkcert 簽發的憑證。其結果是公鑰擷取失敗，導致驗章失敗，callback 靜默回傳 401，使用者被導回登入頁並反覆循環。關閉本機的 TLS 驗證即是為了繞過此問題。

> [!CAUTION]
> `NODE_TLS_REJECT_UNAUTHORIZED=0` 僅能出現在本機的 `dev` 指令中，不可寫入 `.env`，也不可寫入 `build` / `start`。正式主機使用真憑證，不需要此設定——若將其帶上主機，等同關閉所有 TLS 驗證，屬於資安事故。
>
> 另需注意：**auth 本身不可加入此設定**（〈啟動本機 auth〉的指令中即未包含），因其須驗證 Google 的真實憑證。

### 啟動服務

開啟兩個終端機：

```bash
cd tpass-auth  && pnpm dev      # 終端機 1：發證端 → https://auth.lvh.me:3000
cd tpass-lost  && pnpm dev      # 終端機 2：你的服務 → https://lost.lvh.me:3007
```

接著開啟 `https://lost.lvh.me:3007`。

**Google 登入流程無法自動化**（會被 Google 阻擋，亦違反服務條款），此步驟須由真人手動完成。

### 提交前檢查

```bash
pnpm lint
pnpm exec tsc --noEmit
```

兩項檢查皆通過後才可 push。

### 驗收清單

以下五項需全數通過，皆可在兩個終端機環境下完成測試，不需啟動 portal。

- [ ] **登得進**：開 `https://lost.lvh.me:3007` → 被導去 auth → Google 登入 → 回到你的頁面，看到自己的名字。
- [ ] **cookie 是 host-only**：DevTools → Application → Cookies → `lost.lvh.me`：有一顆 `tpass_token`，
      而且 **Domain 欄是 `lost.lvh.me`——前面沒有那個點**。有點（`.lvh.me`）就是你設了 `Domain`，
      通行證會外洩給其他服務，回去看〈安全規範〉。
- [ ] **登得出**：按登出 → cookie 消失。
- [ ] **SSO 真的有效**：在 DevTools 只刪掉 `lost.lvh.me` 的 `tpass_token`（**留著 `auth.lvh.me` 的
      `tpass_auth_session`**）→ 重新整理 → 你會被導去 auth，然後 **auth 不會叫你再點一次 Google，
      直接把你送回來**。這就是「登入一次、全生態通行」。
- [ ] **隔離測試（最關鍵，可揪出最嚴重的錯誤）**：在瀏覽器直接開這個網址——
      注意 `service` 是**別人**（`portal`），但 `redirect_uri` 指向**你的** callback：

      https://auth.lvh.me:3000/api/auth/authorize?service=portal&redirect_uri=https://lost.lvh.me:3007/api/auth/callback&next=/

      auth 會簽一張 `aud=tpass:portal` 的票 POST 給你。**你的 callback 必須回 401。**
      如果它讓你登入了，代表你沒驗 `audience`——別人服務的票在你家能用，隔離全毀。
      回去看〈整合登入〉「驗章核心」鐵則 3。

## 部署

主機上的部署帳號不具 root 權限。標記 **[root]** 的步驟需交由維運部員執行。

| # | 執行者 | 內容 |
| --- | --- | --- |
| 1 | 你 | Cloudflare DNS：`lost.tschoolsu.org` A record → 主機 IP，**先開灰雲（DNS only）** |
| 2 | **[root]** | nginx server block（反向代理到 `127.0.0.1:3007`）+ `certbot` 簽 TLS 憑證 |
| 3 | 你 | `curl` 直連確認 200 → **切回橘雲** |
| 4 | **[root]** | 有資料庫的話：建 `t_lost` role + database，把 `DATABASE_URL` 給你 |
| 5 | 你 | 主機上 `git clone` 你的 repo 到 `~/tpass/tpass-lost`，寫 `.env.local`（正式網域、**沒有 port**） |
| 6 | 你 | 部署 `lost`（見〈部署指令〉），跑到通為止 |
| 7 | 你 | registry PR：把 `lost` 的 `deployed` 改成 `true` → merge → 重新部署 `auth` 與 `portal` |
| 8 | 你 | 瀏覽器真人走一次登入，跑一遍〈本機開發〉「驗收清單」（把 `lvh.me:3007` 換成正式網域） |

> [!NOTE]
> **灰雲 / 橘雲為何需要來回切換？** Let's Encrypt 簽發憑證時的驗證請求須直接抵達主機，Cloudflare 橘雲代理會攔截該請求，導致憑證簽發失敗。因此流程為：先灰雲 → 簽發完成 → 再切橘雲（橘雲可隱藏源站 IP、抵禦攻擊、提供快取）。

### 部署指令

主機上已備有 `deploy.sh`。針對指定服務，此腳本會依序執行：**拉取最新註冊表**（`tpass-registry`）→ **env 必填檢查**（缺 key 於 build 前即擋下）→ `git pull` → 視需要 `pnpm install --frozen-lockfile` → `prisma generate` → `pnpm build` → 套用 DB schema → `pm2` zero-downtime reload → **健康檢查**（打服務所在 port，30 秒內未收到健康回應即視為失敗）。

```bash
ssh <帳號>@<主機>                     # 位址與帳號跟維運要。★ 絕不寫進任何 repo / commit / PR

cd ~/tpass && git pull --ff-only      # 更新 ops（deploy.sh 本身）；註冊表由 deploy.sh 自己拉

./deploy/deploy.sh lost               # 你的服務首次啟動
```

**你的 registry PR merge 之後，還要重新部署 auth 與 portal** ——它們是在 build 時把註冊表烤進去的，不重新部署就不會知道有你這號人物：

```bash
./deploy/deploy.sh auth               # ① 發證白名單納入 lost（否則使用者會被導去 /service-error）
./deploy/deploy.sh portal             # ② 大廳卡片出現（需要 deployed 已翻 true）
```

查看狀態與 log（皆於主機上執行）：

```bash
pm2 status                 # 所有服務活著沒
pm2 logs lost --lines 100  # 你的服務的錯誤
```

**Rollback**：於 repo 執行 `git revert` 產生新 commit → merge 進 main → 重新執行 `./deploy/deploy.sh lost`，不需特殊機制。build 失敗時舊版程序不受影響、不會停機——`deploy.sh` 採先 build 成功才 reload 的策略。

## 疑難排解

| 症狀 | 原因 / 解法 |
| --- | --- |
| 登入完**馬上被踢回登入頁**（本機） | 多半是 dev 指令缺少 `NODE_TLS_REJECT_UNAUTHORIZED=0`，導致後端抓不到 auth 的 JWKS 公鑰（見〈本機開發〉「設定 dev 指令」）。log 裡找 `UNABLE_TO_VERIFY_LEAF_SIGNATURE` |
| 登入完**馬上被踢回登入頁**（主機） | 與 TLS 無關，**絕不要**在主機加 `NODE_TLS_REJECT_UNAUTHORIZED`。查 `iss` / `aud` 是否對應（見下兩列） |
| 瀏覽器說憑證不安全 | 憑證未涵蓋該子網域。重跑〈本機開發〉「建立本機憑證」的 `mkcert`，把 `lost.lvh.me` 加進去；`mkcert -install` 也需重新執行 |
| 被導去 `/service-error?reason=unknown-service` | 該 id 不在註冊表裡。確認 registry PR 已 merge，且 auth 在那之後**重新部署過**（本機則是 `../tpass-registry` 已 clone 並重啟 auth） |
| 被導去 `/service-error?reason=invalid-redirect` | `redirect_uri` 須為完整網址，且網域須在生態系範圍內（防 Open Redirect） |
| 被導去 `/service-error?reason=invalid-next` | `next` 必須是站內路徑（以 `/` 開頭，且不以 `//` 開頭） |
| 一直跳 `/?error=domain` | 登入使用的 Google 帳號非學校網域信箱 |
| callback 收到 token 但驗不過（401） | `aud` 不相符。確認驗證的是 `tpass:<id>`，且該 id 與 authorize 帶的 `service` 一致 |
| 驗章一直失敗，但 token 看起來很正常 | `iss` 字串差一個 port 或結尾斜線也會導致失敗，須與 auth 的 `JWT_ISSUER` 逐字比對 |
| 前端 JS 讀不到 cookie | 此為正常行為（`HttpOnly`）。身分僅在後端可取得；前端如有需求，應另開一個 `/api/me` |
| 登入一段時間後失效 | 正常現象，per-service token 壽命＝auth 端 `JWT_TTL_SECONDS`（建議 45 分鐘）；重新走一次登入會自動換到新票 |
| 服務一啟動就報「缺少必填環境變數」 | 對照 `src/config/lost.ts` 的 `REQUIRED` 陣列補齊 `.env.local`（該陣列即必填清單的唯一真相） |
| 部署被擋，說 env 缺 key | 同上，但須補齊的是**主機上**的 `.env.local`。`deploy.sh` 於 build 前即擋下，此為刻意設計 |
| 上線了，但 **portal 首頁看不到你的卡片** | 依序確認三件事：① registry 裡你那筆有 `portal` 區塊；② `deployed` 已翻成 `true`；③ portal 在那之後**重新部署過**（卡片是 build 時烤進去的） |
| auth 或 portal 一啟動就報「讀不到服務註冊表」 | `tpass-registry` 沒 clone 在它的上一層。錯誤訊息裡有它試過的完整路徑與 clone 指令 |
| portal 報「portal.icon 不在圖示白名單裡」 | registry 用了 portal 沒登記的 lucide 圖示。錯誤訊息會印出可用清單；要新增就在 `tpass-portal/src/config/icons.ts` 加一行 |

## 安全規範

- 不可在**前端**驗章，不可將 token 存入 `localStorage`。
- 不可移除 `algorithms: ["EdDSA"]`（移除後任何人皆可偽造身分）。
- 不可將 cookie 設為 `Domain=.tschoolsu.org`（通行證將外洩至其他服務，隔離機制全毀）。
- 權限判斷一律讀 JWT 的 `permissions` claim（`perm.role`、`perm.read`）；`groups` 已於 2026-07-27 全面移除，token 裡不會再有這個欄位。名單維護於**中央**（auth 的 `/admin` panel），服務**不應**自行維護 allowlist 或 DB 名單。細粒度授權（可讀取哪筆資料）仍應於服務本地實作。
- 不可 import 或複製 auth 的私鑰、`arctic`、Google OAuth callback。服務**只需要公鑰**。
- 不可將網域 / issuer / audience 寫死於程式碼中，一律透過 env 讀取。
- 不可嘗試自動化 Google 登入流程，測試時須由真人手動操作。
- 每個 server action / route handler 內部都須重新檢查登入狀態，不能僅依賴 layout。
- 對外的 webhook / callback 網址須 pin 官方網域（例如僅允許 `discord.com`），不應讓管理員填入任意 URL。

## 參考：JWT Payload

callback 收到的 token，解開後結構如下：

```json
{
  "sub": "104857600293847561029",
  "email": "b11302042@tschool.tp.edu.tw",
  "name": "林大明",
  "permissions": {
    "lost": { "read": true, "role": "admin" }
  },
  "iss": "https://auth.lvh.me:3000",
  "aud": "tpass:lost",
  "iat": 1750000000,
  "exp": 1750002700
}
```

| 欄位 | 型別 | 意義 |
| --- | --- | --- |
| `sub` | `string` | 使用者唯一識別碼（來自 Google，跨服務一致，可作為 DB 主鍵） |
| `email` | `string` | 學校信箱（已通過驗證與網域白名單） |
| `name` | `string` | 顯示名稱 |
| `permissions` | `Record<string, PermissionEntry>` | **權限本體**。一般服務 token 只含自己一把 key。授權判斷一律讀這個，名單維護於中央 auth 的 `/admin` panel，不再是環境變數 |
| `iss` | `string` | 簽發者，驗章時必須檢查 |
| `aud` | `string` | 受眾，必為 `tpass:<你的服務id>`，驗章時必須檢查 |
| `iat` / `exp` | `number` | 簽發 / 到期時間（Unix 秒）。per-service token 壽命＝auth 端 `JWT_TTL_SECONDS`（建議 45 分鐘） |

其他規格：

- **簽章演算法**：`EdDSA`（Ed25519）。驗章時必須鎖死。
- **公鑰來源（JWKS）**：`GET <auth 網址>/.well-known/jwks.json`，可快取一小時。應使用能依 `kid` 自動選鑰的函式庫（`jose` 的 `createRemoteJWKSet`），不應自行擷取單一把公鑰硬編碼使用，否則金鑰輪替時將導致驗證失效。
- **token 交付方式**：auth 使用自動送出的 `<form method="post">` 將 `token` 與 `next` POST 至指定服務，因此 token 不會出現於網址、瀏覽器歷史紀錄或 Referer 中。

## 參考：services.json 欄位

`YC815/tpass-registry` 的 `services.json` 是服務清單的唯一真相：auth 的發證白名單、portal 的大廳卡片、pm2 設定與部署腳本全部從此派生。不應在其他位置另行硬編碼服務清單、port、目錄名或網域。

```jsonc
{
  "id": "lost",              // 短名。＝pm2 程序名＝TPASS_SERVICE_ID＝aud 後綴。永不改名
  "name": "T-Lost 遺失物",    // ops 用的長名（CLI、部署 log）
  "dir": "tpass-lost",       // repo 目錄名（本機與主機一致）
  "subdomain": "lost",       // 本機＝lost.lvh.me；正式＝lost.tschoolsu.org
  "port": 3007,              // 內部 port（只綁 127.0.0.1）。撞車會被 CI 擋下
  "db": {                    // 沒有資料庫就填 null
    "name": "t_lost",        // 資料庫名（慣例 t_<id>）
    "user": "t_lost",        // 專屬 role（慣例 t_<id>）
    "strategy": "migrate"    // migrate = 有 migrations 歷史（標準做法）；push 僅限原型
  },
  "enabled": true,           // false = 工具與發證白名單全部跳過（封存用）
  "deployed": false,         // true = 納入部署，卡片才會出現。首次上線成功後才翻 true
  "portal": {                // 選填。沒有這塊 = 不進大廳（純後端服務）
    "label": "遺失物",        // 卡片顯示名
    "icon": "Search",        // lucide 圖示的 PascalCase 名（見 lucide.dev/icons）
    "tone": "orange",        // green | blue | orange | violet | rose
    "roles": ["all"]         // all | student | teacher
  }
}
```

**卡片網址不在這裡**：由 `subdomain` + `port` + 頂層 `domains` 推導。大廳只顯示同時滿足 `enabled` + `deployed` + 有 `portal` 區塊的服務。

完整規則與 `node validate.mjs` 的檢查項目見該 repo 的 `README.md`。
