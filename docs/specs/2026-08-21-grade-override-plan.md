# 年級屆別覆寫 實作計畫

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 讓休學復學的學生能在 auth 被標記正確的入學屆別，各服務的年級標示自動跟著正確。

**Architecture:** auth 的 `Subject` 新增 `entryYearOverride`（nullable，只存例外），簽 per-service token 時算出 `entryYear` claim 派發；消費端把「從 email 推年級」改成「從 claim 推年級，claim 缺則 fallback 回 email」。管理介面在 auth `/admin/people/[email]`。

**Tech Stack:** Next 16.2 + React 19、Prisma + PostgreSQL、jose（EdDSA JWT）、vitest（本次新引入）

**設計來源：** `docs/specs/2026-08-21-grade-override-design.md`

## Global Constraints

- 套件管理一律 **pnpm**（`pnpm add` / `pnpm add -D`），不得產生 `package-lock.json`
- 每個 repo 的檢查指令：`pnpm lint` + `pnpm exec tsc --noEmit`（新增 `pnpm test`）
- **絕不在前景跑 dev server**；需要時 `run_in_background: true`，用完關掉
- 主機上**絕不執行** `prisma migrate dev` / `db push` / `migrate reset`
- UI 一律 light-only Neobrutalism + OKLCH，`border-2 border-foreground` + hard offset shadow，禁止 soft shadow / dark mode / hex
- 不得把網域、issuer、audience、服務清單寫死——讀 `config/*`（env）
- 測試檔一律**顯式 import** `{ describe, it, expect } from "vitest"`（不開 globals），且**只測零依賴的純函數**——測試檔不得 import 任何帶 `server-only` 或讀 env 的模組
- 民國學年度換算：`民國年 = 西元年 − 1911`，學年度 **8 月**跳新
- 測試裡的日期一律用 `new Date(year, monthIndex, day)`（**本地時間**，monthIndex 從 0 起算），
  不要用帶時區的 ISO 字串——`getMonth()` 讀的是本地時區，UTC 環境下 `"2026-08-01T00:00+08:00"`
  會退回 7 月，學年度邊界的測試就會假性失敗

---

## File Structure

**tpass-auth**
| 檔案 | 責任 |
| --- | --- |
| `src/lib/entry-year.ts` | 建立。屆別純函數：email 解析、現在學年度、有效屆別、範圍驗證。**零 import** |
| `src/lib/entry-year.test.ts` | 建立。上者的測試 |
| `prisma/schema.prisma` | 修改。`Subject` 加 `entryYearOverride Int?` |
| `src/lib/permissions/repo.ts` | 修改。加 `setEntryYearOverride()` |
| `src/lib/session.ts` | 修改。`TPassClaims` 加欄位；`signServiceToken` 算並簽 `entryYear` |
| `src/app/admin/actions.ts` | 修改。加 `saveEntryYear()` server action |
| `src/app/admin/people/[email]/EntryYearCard.tsx` | 建立。client 元件 |
| `src/app/admin/people/[email]/page.tsx` | 修改。掛上卡片 |
| `INTEGRATION.md` | 修改。§3.1 / §3.3 加 `entryYear` |

**tpass-form / tpass-appeals**（兩邊改動幾乎相同）
| 檔案 | 責任 |
| --- | --- |
| `src/lib/grade.ts` | 修改。改吃 `GradeSource`，claim 優先、email fallback |
| `src/lib/grade.test.ts` | 建立。測試 |
| `src/lib/tpass-auth.ts` | 修改。`TPassClaims` 加 `entryYear`，verify 時解析 |
| 呼叫點 | `form/src/app/f/[slug]/actions.ts:56`、`appeals/src/app/actions.ts:52` |
| `form/src/components/builder/SettingsPanel.tsx:83` | 修改。UI 文案（只有 form 有） |

---

## Task 1: auth 的屆別純函數與 vitest

**Files:**
- Create: `tpass-auth/src/lib/entry-year.ts`
- Create: `tpass-auth/src/lib/entry-year.test.ts`
- Modify: `tpass-auth/package.json`（加 `test` script 與 vitest devDep）

**Interfaces:**
- Consumes: 無
- Produces:
  - `parseEntryYearFromEmail(email: string): number | null`
  - `currentAcademicYear(now?: Date): number`
  - `effectiveEntryYear(email: string, override: number | null): number | null`
  - `isValidEntryYear(value: number, now?: Date): boolean`
  - `MIN_ENTRY_YEAR: 100`

- [ ] **Step 1: 裝 vitest**

```bash
cd tpass-auth && pnpm add -D vitest
```

- [ ] **Step 2: 加 test script**

編輯 `tpass-auth/package.json` 的 `scripts`，在 `"lint": "eslint",` 後面加一行：

```json
    "test": "vitest run",
```

- [ ] **Step 3: 寫失敗的測試**

建立 `tpass-auth/src/lib/entry-year.test.ts`：

```ts
import { describe, it, expect } from "vitest";
import {
  parseEntryYearFromEmail,
  currentAcademicYear,
  effectiveEntryYear,
  isValidEntryYear,
} from "./entry-year";

describe("parseEntryYearFromEmail", () => {
  it("取信箱開頭三碼當民國入學學年度", () => {
    expect(parseEntryYearFromEmail("1140001@example.edu.tw")).toBe(114);
  });

  it("老師／職務帳號沒有數字前綴 → null", () => {
    expect(parseEntryYearFromEmail("teacher@example.edu.tw")).toBeNull();
  });

  it("前綴不足三碼 → null", () => {
    expect(parseEntryYearFromEmail("11@example.edu.tw")).toBeNull();
  });
});

describe("currentAcademicYear", () => {
  it("8 月 1 日起算新學年度", () => {
    expect(currentAcademicYear(new Date(2025, 7, 1))).toBe(114);
  });

  it("7 月 31 日仍屬前一學年度", () => {
    expect(currentAcademicYear(new Date(2025, 6, 31))).toBe(113);
  });
});

describe("effectiveEntryYear", () => {
  it("沒有覆寫時用信箱推算", () => {
    expect(effectiveEntryYear("1140001@example.edu.tw", null)).toBe(114);
  });

  it("有覆寫時覆寫優先（休學復學：114 屆改算 115 屆）", () => {
    expect(effectiveEntryYear("1140001@example.edu.tw", 115)).toBe(115);
  });

  it("信箱推不出、也沒覆寫 → null", () => {
    expect(effectiveEntryYear("teacher@example.edu.tw", null)).toBeNull();
  });

  it("信箱推不出但有覆寫 → 用覆寫", () => {
    expect(effectiveEntryYear("teacher@example.edu.tw", 114)).toBe(114);
  });
});

describe("isValidEntryYear", () => {
  const now = new Date(2025, 8, 1); // 民國 114 學年度

  it("接受合理的民國學年度", () => {
    expect(isValidEntryYear(114, now)).toBe(true);
  });

  it("接受下一學年度（開學前先建好的新生）", () => {
    expect(isValidEntryYear(115, now)).toBe(true);
  });

  it("拒絕過遠的未來", () => {
    expect(isValidEntryYear(116, now)).toBe(false);
  });

  it("拒絕小於下限的值", () => {
    expect(isValidEntryYear(99, now)).toBe(false);
  });

  it("拒絕非整數", () => {
    expect(isValidEntryYear(114.5, now)).toBe(false);
  });
});
```

- [ ] **Step 4: 跑測試確認失敗**

Run: `cd tpass-auth && pnpm test`
Expected: FAIL — 找不到模組 `./entry-year`

- [ ] **Step 5: 寫實作**

建立 `tpass-auth/src/lib/entry-year.ts`：

```ts
// 入學屆別（民國學年度）的計算。**零依賴純函數**——不 import server-only、不讀 env，
// 才能被 vitest 直接測。屆別是身分屬性，真相在此 repo（Subject.entryYearOverride），
// 經 JWT 的 entryYear claim 派發給各服務。
//
// 為什麼存「屆別」不存「年級」：屆別設定一次就永久正確，年級每年 8 月都要重標一輪。

// 民國學年度下限。比這更早的值一律當作打錯字。
export const MIN_ENTRY_YEAR = 100;

// 學校信箱前三碼＝民國入學學年度（如 1140001@... → 114）。
// 老師／職務帳號沒有數字前綴 → null。
export function parseEntryYearFromEmail(email: string): number | null {
  const m = email.match(/^(\d{3})/);
  return m ? Number(m[1]) : null;
}

// 現在的民國學年度。學年度每年 8 月跳新（8/1 起算新學年）。
export function currentAcademicYear(now: Date = new Date()): number {
  const roc = now.getFullYear() - 1911;
  return now.getMonth() + 1 >= 8 ? roc : roc - 1;
}

// 這個人實際上算哪一屆：人工覆寫優先，沒有就照信箱推。
// 休學復學者 email 沿用、學號前綴不變，就是靠 override 修正。
export function effectiveEntryYear(
  email: string,
  override: number | null,
): number | null {
  return override ?? parseEntryYearFromEmail(email);
}

// 管理介面輸入驗證。+1 是為了容納開學前就先建好的新生。
export function isValidEntryYear(value: number, now: Date = new Date()): boolean {
  return (
    Number.isInteger(value) &&
    value >= MIN_ENTRY_YEAR &&
    value <= currentAcademicYear(now) + 1
  );
}
```

- [ ] **Step 6: 跑測試確認通過**

Run: `cd tpass-auth && pnpm test`
Expected: PASS，14 個測試全綠

- [ ] **Step 7: 檢查**

Run: `cd tpass-auth && pnpm lint && pnpm exec tsc --noEmit`
Expected: 兩者皆無錯誤

- [ ] **Step 8: Commit**

```bash
cd tpass-auth
git add src/lib/entry-year.ts src/lib/entry-year.test.ts package.json pnpm-lock.yaml
git commit -m "feat: 入學屆別純函數與 vitest

年級推導要能被人工覆寫（休學復學），先把計算抽成零依賴純函數並補上
日期邊界測試（8/1 學年跳新、老師帳號、範圍驗證）。"
```

---

## Task 2: Subject 加 entryYearOverride 欄位

**Files:**
- Modify: `tpass-auth/prisma/schema.prisma`
- Create: `tpass-auth/prisma/migrations/<timestamp>_add_entry_year_override/migration.sql`（由 prisma 生成）

**Interfaces:**
- Consumes: 無
- Produces: `Subject.entryYearOverride: number | null`（Prisma client 型別）

- [ ] **Step 1: 改 schema**

在 `tpass-auth/prisma/schema.prisma` 的 `model Subject` 裡，`name` 那行之後加：

```prisma
  entryYearOverride Int?      // 民國入學學年度覆寫（休學復學等例外）；null = 照 email 前三碼推
```

- [ ] **Step 2: 生成 migration**

```bash
cd tpass-auth && pnpm exec prisma migrate dev --name add_entry_year_override
```

本機沒有要保留的資料，若提示 reset 可以接受。

- [ ] **Step 3: 檢查生成的 SQL（把關步驟，不可略過）**

```bash
cat tpass-auth/prisma/migrations/*_add_entry_year_override/migration.sql
```

Expected: **只有一行**
```sql
ALTER TABLE "Subject" ADD COLUMN "entryYearOverride" INTEGER;
```

⚠️ 若出現任何 `DROP`、`ALTER COLUMN`、`CREATE TABLE`，**停下來回報**，不要繼續——
主機有 105 筆真資料，那代表 schema 有非預期的 drift。

- [ ] **Step 4: 確認 client 型別跟上**

Run: `cd tpass-auth && pnpm exec tsc --noEmit`
Expected: 無錯誤（`prisma migrate dev` 會自動跑 generate）

- [ ] **Step 5: Commit**

```bash
cd tpass-auth
git add prisma/schema.prisma prisma/migrations
git commit -m "feat: Subject 加 entryYearOverride（只存例外，nullable）"
```

---

## Task 3: 簽 entryYear claim

**Files:**
- Modify: `tpass-auth/src/lib/permissions/repo.ts`
- Modify: `tpass-auth/src/lib/session.ts`

**Interfaces:**
- Consumes: Task 1 的 `effectiveEntryYear()`；Task 2 的 `Subject.entryYearOverride`
- Produces:
  - `setEntryYearOverride(subjectId: string, value: number | null): Promise<Subject>`
  - `TPassClaims.entryYear?: number | null`
  - per-service token 的 `entryYear` claim（number，null 時省略該 claim）

- [ ] **Step 1: 加 repo 寫入函式**

在 `tpass-auth/src/lib/permissions/repo.ts` 的 `touchSessionsValidFrom` 之後加：

```ts
// 設定／清除入學屆別覆寫。null＝恢復成照 email 推算。
export function setEntryYearOverride(
  subjectId: string,
  value: number | null,
): Promise<Subject> {
  return prisma.subject.update({
    where: { id: subjectId },
    data: { entryYearOverride: value },
  });
}
```

- [ ] **Step 2: TPassClaims 加欄位**

在 `tpass-auth/src/lib/session.ts` 的 `interface TPassClaims` 裡，`permissions` 那行後面加：

```ts
  // 民國入學學年度。只在 per-service token 出現，且只在算得出來時出現
  // （老師／職務帳號沒有屆別 → 整個 claim 省略）。消費端據此算年級。
  entryYear?: number | null;
```

- [ ] **Step 3: sign() 帶上 claim**

把 `tpass-auth/src/lib/session.ts` 的 `sign()` 內容改成（只改 `new SignJWT(...)` 的參數部分）：

```ts
  const now = Math.floor(Date.now() / 1000);
  const privateKey = await getPrivateKey();
  const payload: Record<string, unknown> = {
    email: claims.email,
    name: claims.name,
    permissions: claims.permissions,
  };
  // 算不出屆別（老師／職務帳號）就整個省略，不要塞 null 進 payload。
  if (typeof claims.entryYear === "number") payload.entryYear = claims.entryYear;
  return new SignJWT(payload)
```

（其後 `.setProtectedHeader(...)` 之後那串完全不動。）

- [ ] **Step 4: signServiceToken 算出屆別**

`tpass-auth/src/lib/session.ts` 的 `signServiceToken()`，在 `const permissions ...` 之後、`return sign(...)` 之前加上查詢，並把結果傳進 `sign`：

```ts
  // 屆別：DB 覆寫優先，沒有就照 email 推。這裡本來就會查 DB 拿 permissions，
  // 多讀一個欄位不增加查詢次數。
  const subject = await findSubjectByEmail(identity.email);
  const entryYear = effectiveEntryYear(
    identity.email,
    subject?.entryYearOverride ?? null,
  );
  return sign(
    { ...identity, permissions, entryYear },
    serviceAudience(serviceId),
    authConfig.jwt.ttlSeconds,
  );
```

檔案頂端補上 import（`findSubjectByEmail` 已存在，只需加 entry-year）：

```ts
import { effectiveEntryYear } from "@/lib/entry-year";
```

- [ ] **Step 5: verify 時解析回來**

`tpass-auth/src/lib/session.ts` 的驗章回傳物件裡，`permissions:` 那行之後加：

```ts
      entryYear: typeof payload.entryYear === "number" ? payload.entryYear : null,
```

- [ ] **Step 6: 確認 signAuthSession 沒被波及**

`signAuthSession` 傳的是 `{ ...identity, permissions: {} }`，沒有 `entryYear` → `typeof undefined !== "number"` → claim 被省略。**這是刻意的**：auth 自己的登入態只存身份，年級對它沒意義。不需要改任何一行。

- [ ] **Step 7: 檢查**

Run: `cd tpass-auth && pnpm lint && pnpm exec tsc --noEmit && pnpm test`
Expected: 全部通過

- [ ] **Step 8: Commit**

```bash
cd tpass-auth
git add src/lib/session.ts src/lib/permissions/repo.ts
git commit -m "feat: per-service token 帶 entryYear claim

屆別覆寫優先於 email 推算；算不出來就省略 claim。auth 自己的
登入態不帶（只存身份）。"
```

---

## Task 4: 儲存屆別的 server action

**Files:**
- Modify: `tpass-auth/src/app/admin/actions.ts`

**Interfaces:**
- Consumes: Task 1 的 `isValidEntryYear()`、`MIN_ENTRY_YEAR`；Task 3 的 `setEntryYearOverride()`
- Produces: `saveEntryYear(input: { email: string; entryYear: number | null }): Promise<ActionResult>`

- [ ] **Step 1: 補 import**

`tpass-auth/src/app/admin/actions.ts` 的 `from "@/lib/permissions/repo"` 那個 import 區塊裡，
在 `touchSessionsValidFrom,` 之後加一行：

```ts
  setEntryYearOverride,
```

檔案 import 區最後補：

```ts
import { isValidEntryYear, MIN_ENTRY_YEAR, currentAcademicYear } from "@/lib/entry-year";
```

- [ ] **Step 2: 加 action**

在 `saveGrant` 之後、`// ── 批次授權` 之前插入：

```ts
// ── saveEntryYear ────────────────────────────────────────────────────
// 入學屆別覆寫。休學復學者 email 沿用、學號前綴不變，年級會多算一級（休學兩年直接算不出來），
// 這裡讓管理者把他改算到正確的一屆。存屆別不存年級——設定一次就永久正確，
// 不必每年 8 月把所有例外重標一輪。
// 版主可用：這是身分資料的更正，不是授權變更。
export interface SaveEntryYearInput {
  email: string;
  entryYear: number | null; // null = 恢復成照 email 推算
}

export async function saveEntryYear(input: SaveEntryYearInput): Promise<ActionResult> {
  const g = await gate(requireAuthModerator);
  if ("error" in g) return { ok: false, error: g.error };
  const { session } = g.actor;

  const email = normalizeEmail(input.email);
  if (!isValidEmail(email)) return { ok: false, error: "email 格式不正確" };

  // 與 saveGrant 同一條規則：總管不進 DB，改了也沒有意義。
  if (authConfig.superadmins.includes(email)) {
    return { ok: false, error: "此帳號是生態總管（AUTH_SUPERADMINS），不可調整" };
  }

  if (input.entryYear !== null && !isValidEntryYear(input.entryYear)) {
    return {
      ok: false,
      error: `入學學年度必須是 ${MIN_ENTRY_YEAR}～${currentAcademicYear() + 1} 之間的民國學年度`,
    };
  }

  // 沿用 saveGrant 的做法：沒建過就順手建，不要把「row 存不存在」推給人先處理。
  const subject = (await findSubjectByEmail(email)) ?? (await createSubjectRow(email));
  const before = { entryYearOverride: subject.entryYearOverride };

  if (subject.entryYearOverride === input.entryYear) {
    return { ok: true }; // 沒變動就不寫、不記稽核，避免假紀錄
  }

  await setEntryYearOverride(subject.id, input.entryYear);

  await recordAudit({
    actorEmail: session.email,
    targetEmail: email,
    serviceId: "auth",
    action: input.entryYear === null ? "entryYear.clear" : "entryYear.set",
    before,
    after: { entryYearOverride: input.entryYear },
  });

  revalidatePath(`/admin/people/${encodeURIComponent(email)}`);
  revalidatePath("/admin/audit");
  return { ok: true };
}
```

- [ ] **Step 3: 檢查**

Run: `cd tpass-auth && pnpm lint && pnpm exec tsc --noEmit`
Expected: 無錯誤

- [ ] **Step 4: Commit**

```bash
cd tpass-auth
git add src/app/admin/actions.ts
git commit -m "feat: saveEntryYear server action（版主可用，記稽核）"
```

---

## Task 5: 屆別編輯卡片

**Files:**
- Create: `tpass-auth/src/app/admin/people/[email]/EntryYearCard.tsx`
- Modify: `tpass-auth/src/app/admin/people/[email]/page.tsx`

**Interfaces:**
- Consumes: Task 4 的 `saveEntryYear()`；Task 1 的 `parseEntryYearFromEmail()`、`currentAcademicYear()`
- Produces: `<EntryYearCard email initialOverride derivedFromEmail academicYear ttlSeconds />`

- [ ] **Step 1: 寫元件**

建立 `tpass-auth/src/app/admin/people/[email]/EntryYearCard.tsx`：

```tsx
"use client";
// 入學屆別覆寫。休學復學者 email 沿用、學號前綴不變 → 年級會多算一級，這裡改算到正確的一屆。
// 存的是屆別不是年級：設定一次就永久正確，不必每年開學重標。
// 生效時間與權限變更同理（無狀態本地驗章，要等 token 換發），所以沿用 EffectiveAtNotice。
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { saveEntryYear } from "@/app/admin/actions";
import { Button, Card, Input, Label } from "@/components/admin/primitives";
import { EffectiveAtNotice } from "@/components/admin/EffectiveAtNotice";

// 屆別 → 這學年度的年級標籤。超出高中三年（畢業／未入學／休學中）就不假裝知道。
function gradeLabel(entryYear: number | null, academicYear: number): string {
  if (entryYear === null) return "無屆別（非學生帳號）";
  const grade = academicYear - entryYear + 1;
  const zh = ["一", "二", "三"][grade - 1];
  return zh ? `高${zh}` : "不在高中三年範圍內";
}

export function EntryYearCard({
  email,
  initialOverride,
  derivedFromEmail,
  academicYear,
  ttlSeconds,
}: {
  email: string;
  initialOverride: number | null;
  derivedFromEmail: number | null;
  academicYear: number;
  ttlSeconds: number;
}) {
  const [value, setValue] = useState(
    initialOverride === null ? "" : String(initialOverride),
  );
  const [error, setError] = useState<string | null>(null);
  const [effectiveAt, setEffectiveAt] = useState<number | null>(null);
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  function submit(entryYear: number | null) {
    setError(null);
    setEffectiveAt(null);
    startTransition(async () => {
      const result = await saveEntryYear({ email, entryYear });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setEffectiveAt(Math.floor(Date.now() / 1000) + ttlSeconds);
      router.refresh();
    });
  }

  function onSave() {
    const trimmed = value.trim();
    if (trimmed === "") {
      setError("要恢復自動推算請按「恢復自動」");
      return;
    }
    const parsed = Number(trimmed);
    if (!Number.isInteger(parsed)) {
      setError("請輸入民國學年度數字，例如 115");
      return;
    }
    submit(parsed);
  }

  function onClear() {
    setValue("");
    submit(null);
  }

  // 畫面上顯示的「目前算作」用輸入框的即時值，讓人按下儲存前就看得到後果。
  const previewEntry = value.trim() === "" ? derivedFromEmail : Number(value);
  const previewValid = Number.isInteger(previewEntry);

  return (
    <Card>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="font-mono text-sm font-bold">入學屆別</h2>
        <p className="font-mono text-xs text-muted-foreground">
          依信箱推算：
          {derivedFromEmail === null
            ? "無（非學生帳號）"
            : `${derivedFromEmail} 屆 · ${gradeLabel(derivedFromEmail, academicYear)}`}
        </p>
      </div>

      <p className="mt-2 font-medium text-muted-foreground">
        休學復學等情況下信箱前三碼不再等於實際屆別，可在此改算到正確的一屆。
        設定後每年自動跟著升級，不必重標。
      </p>

      <div className="mt-4 flex flex-wrap items-end gap-3">
        <div>
          <Label htmlFor="entry-year">民國入學學年度</Label>
          <Input
            id="entry-year"
            inputMode="numeric"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={derivedFromEmail === null ? "未設定" : String(derivedFromEmail)}
            className="mt-1 w-32"
            disabled={pending}
          />
        </div>
        <Button variant="primary" onClick={onSave} disabled={pending}>
          {pending ? "儲存中…" : "儲存"}
        </Button>
        <Button onClick={onClear} disabled={pending || initialOverride === null}>
          恢復自動
        </Button>
      </div>

      {previewValid && (
        <p className="mt-3 font-mono text-xs font-bold">
          → 目前算作 {previewEntry} 屆 · {gradeLabel(previewEntry as number, academicYear)}
        </p>
      )}

      {error && (
        <p className="mt-3 rounded-md border-2 border-foreground bg-tone-red-bg px-3 py-1.5 font-mono text-xs font-bold text-tone-red-text">
          {error}
        </p>
      )}
      {effectiveAt !== null && (
        <div className="mt-3">
          <EffectiveAtNotice effectiveAtSeconds={effectiveAt} />
        </div>
      )}
    </Card>
  );
}
```

- [ ] **Step 2: 確認顏色 token 存在**

Run: `grep -rn "tone-red-bg\|tone-red-text" tpass-auth/src/app/globals.css tpass-auth/src/components/admin/*.tsx | head`
Expected: 有結果。**若沒有**，改用 `GrantRow.tsx` 裡實際使用的錯誤訊息 class（照抄那一份），不要自創顏色。

- [ ] **Step 3: 掛到頁面上**

`tpass-auth/src/app/admin/people/[email]/page.tsx`：

import 區加：

```ts
import { EntryYearCard } from "./EntryYearCard";
import { parseEntryYearFromEmail, currentAcademicYear } from "@/lib/entry-year";
```

在 `{isSuperadmin ? (` 那整段 Card 的**上方**（也就是 `</div>` 標題區之後）插入：

```tsx
      {!isSuperadmin && (
        <EntryYearCard
          email={email}
          initialOverride={subject?.entryYearOverride ?? null}
          derivedFromEmail={parseEntryYearFromEmail(email)}
          academicYear={currentAcademicYear()}
          ttlSeconds={authConfig.jwt.ttlSeconds}
        />
      )}
```

- [ ] **Step 4: 檢查**

Run: `cd tpass-auth && pnpm lint && pnpm exec tsc --noEmit && pnpm test`
Expected: 全部通過

- [ ] **Step 5: 人工驗證**

背景啟動 auth（`run_in_background: true`）：`cd tpass-auth && pnpm dev`，登入後開
`https://auth.lvh.me:3000/admin/people/<某個學生 email>`，確認：
- 卡片出現在權限列上方
- 「依信箱推算」顯示正確的屆別與年級
- 輸入 `115` → 下方即時顯示「目前算作 115 屆」
- 按儲存 → 出現「最晚於 HH:MM 生效」
- 重新整理後輸入框仍是 115
- 按「恢復自動」→ 輸入框清空、按鈕變灰
- `/admin/audit` 看得到 `entryYear.set` 與 `entryYear.clear`

驗證完**關掉背景 dev server**。

- [ ] **Step 6: Commit**

```bash
cd tpass-auth
git add "src/app/admin/people/[email]/EntryYearCard.tsx" "src/app/admin/people/[email]/page.tsx"
git commit -m "feat: /admin/people 屆別編輯卡片"
```

---

## Task 6: INTEGRATION.md 契約文件

**Files:**
- Modify: `tpass-auth/INTEGRATION.md`

**Interfaces:**
- Consumes: Task 3 的 claim 形狀
- Produces: 部員唯一該讀的契約說明

- [ ] **Step 1: §3.1 範例加欄位**

在 §3.1 的 JSON 範例裡，`"name": "林大明",` 之後加一行：

```json
  "entryYear": 114,
```

- [ ] **Step 2: §3.2 範例加欄位**

在 §3.2 的 JSON 範例裡，同樣位置加同一行。

- [ ] **Step 3: §3.3 欄位表加一列**

在 `| \`name\` | \`string\` | ✓ | 顯示名稱 |` 之後加：

```markdown
| `entryYear` | `number` | ✗ | 民國入學學年度（如 `114`）。**可能不存在**：老師／職務帳號沒有屆別，舊 token 也還沒有這個欄位。缺少時請 fallback 回信箱前三碼，見下方說明 |
```

- [ ] **Step 4: §3.3 末尾加說明段**

在 §3.3 的「解析安全預設值」引言區塊之後、`### 3.4` 之前插入：

```markdown
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
```

- [ ] **Step 5: 人工檢查**

Run: `grep -n "entryYear" tpass-auth/INTEGRATION.md`
Expected: 至少 5 處（兩個 JSON 範例、欄位表、說明段的 ts 區塊與內文）

- [ ] **Step 6: Commit**

```bash
cd tpass-auth
git add INTEGRATION.md
git commit -m "docs: 契約加 entryYear claim 與 fallback 義務"
```

---

## Task 7: tpass-form 改吃 claim

**Files:**
- Modify: `tpass-form/package.json`（vitest devDep + test script）
- Modify: `tpass-form/src/lib/grade.ts`
- Create: `tpass-form/src/lib/grade.test.ts`
- Modify: `tpass-form/src/lib/tpass-auth.ts`
- Modify: `tpass-form/src/app/f/[slug]/actions.ts:56`
- Modify: `tpass-form/src/components/builder/SettingsPanel.tsx:83`

**Interfaces:**
- Consumes: Task 3 簽出的 `entryYear` claim
- Produces:
  - `GradeSource { email: string; entryYear?: number | null }`
  - `deriveGrade(source: GradeSource, now?: Date): number | null`
  - `gradeLabel(grade: number | null): string | null`（不變）

- [ ] **Step 1: 裝 vitest 並加 script**

```bash
cd tpass-form && pnpm add -D vitest
```

`tpass-form/package.json` 的 `scripts` 裡，`"lint"` 那行之後加：

```json
    "test": "vitest run",
```

- [ ] **Step 2: 寫失敗的測試**

建立 `tpass-form/src/lib/grade.test.ts`：

```ts
import { describe, it, expect } from "vitest";
import { deriveGrade, gradeLabel } from "./grade";

const AUTUMN_114 = new Date(2025, 8, 1); // 民國 114 學年度

describe("deriveGrade", () => {
  it("有 entryYear claim 時以它為準（信箱說 114 屆，claim 說 113 屆）", () => {
    expect(
      deriveGrade({ email: "1140001@example.edu.tw", entryYear: 113 }, AUTUMN_114),
    ).toBe(2); // 只看信箱會得到 1，證明 claim 優先
  });

  it("claim 缺（舊 token）時 fallback 回信箱前三碼", () => {
    expect(deriveGrade({ email: "1140001@example.edu.tw" }, AUTUMN_114)).toBe(1);
  });

  it("claim 為 null 時同樣 fallback 回信箱", () => {
    expect(
      deriveGrade({ email: "1130001@example.edu.tw", entryYear: null }, AUTUMN_114),
    ).toBe(2);
  });

  it("休學一年復學：覆寫屆別後從誤判的高二變回高一", () => {
    const autumn115 = new Date(2026, 8, 1); // 民國 115 學年度
    const email = "1140001@example.edu.tw";
    expect(deriveGrade({ email }, autumn115)).toBe(2); // 不修正 → 誤判高二
    expect(deriveGrade({ email, entryYear: 115 }, autumn115)).toBe(1); // 修正後 → 高一
  });

  it("老師／職務帳號 → null", () => {
    expect(deriveGrade({ email: "teacher@example.edu.tw" }, AUTUMN_114)).toBeNull();
  });

  it("已畢業（超出高中三年）→ null", () => {
    expect(deriveGrade({ email: "1100001@example.edu.tw" }, AUTUMN_114)).toBeNull();
  });

  it("尚未入學（未來屆）→ null", () => {
    expect(deriveGrade({ email: "1160001@example.edu.tw" }, AUTUMN_114)).toBeNull();
  });

  it("8 月 1 日跳新學年度：前一天還是高一，當天變高二", () => {
    const email = "1140001@example.edu.tw";
    expect(deriveGrade({ email }, new Date(2026, 6, 31))).toBe(1);
    expect(deriveGrade({ email }, new Date(2026, 7, 1))).toBe(2);
  });
});

describe("gradeLabel", () => {
  it("1/2/3 轉成中文", () => {
    expect(gradeLabel(1)).toBe("高一");
    expect(gradeLabel(2)).toBe("高二");
    expect(gradeLabel(3)).toBe("高三");
  });

  it("null 回 null", () => {
    expect(gradeLabel(null)).toBeNull();
  });
});
```

- [ ] **Step 3: 跑測試確認失敗**

Run: `cd tpass-form && pnpm test`
Expected: FAIL — `deriveGrade` 目前收的是 `string`，型別不合／行為不符

- [ ] **Step 4: 改寫 grade.ts**

把 `tpass-form/src/lib/grade.ts` 整個換成：

```ts
// 年級推導。屆別的真相在 auth：token 的 entryYear claim（民國入學學年度，
// 含休學復學等人工覆寫）。契約見 tpass-auth/INTEGRATION.md §3.3。
//
// claim 缺席時 fallback 回信箱前三碼——這條是必要的，不是可選的：token TTL 45 分鐘，
// auth 升級後的轉場期使用者手上還是舊 token，少了 fallback 那段時間年級會整批變空白。
//
// 年級 = 現在學年度 − 入學學年度 + 1；學年度每年 8 月跳新。高中三年制，超出範圍回 null
// （老師/職務帳號、已畢業、尚未入學）。

export interface GradeSource {
  email: string;
  entryYear?: number | null;
}

// 信箱前三碼＝民國入學學年度（如 1140001@... → 114）。無數字前綴 → null。
function parseEntryYearFromEmail(email: string): number | null {
  const m = email.match(/^(\d{3})/);
  return m ? Number(m[1]) : null;
}

export function deriveGrade(
  source: GradeSource,
  now: Date = new Date(),
): number | null {
  const entry = source.entryYear ?? parseEntryYearFromEmail(source.email);
  if (entry === null) return null;
  const roc = now.getFullYear() - 1911;
  const academicYear = now.getMonth() + 1 >= 8 ? roc : roc - 1;
  const grade = academicYear - entry + 1;
  return grade >= 1 && grade <= 3 ? grade : null;
}

// 給人看的標籤：1 → 高一、2 → 高二、3 → 高三；其餘原樣回數字字串。
export function gradeLabel(grade: number | null): string | null {
  if (grade === null) return null;
  const zh = ["一", "二", "三"][grade - 1];
  return zh ? `高${zh}` : String(grade);
}
```

- [ ] **Step 5: 跑測試確認通過**

Run: `cd tpass-form && pnpm test`
Expected: PASS

- [ ] **Step 6: claims 型別加 entryYear**

`tpass-form/src/lib/tpass-auth.ts` 的 `interface TPassClaims`，`permissions` 那行之後加：

```ts
  // 民國入學學年度（契約 v2）。老師／職務帳號與舊 token 沒有這個欄位 → null，
  // 由 deriveGrade 自行 fallback 回信箱推算。
  entryYear: number | null;
```

`verifySession` 的回傳物件裡，`permissions:` 那段之後加：

```ts
      entryYear: typeof payload.entryYear === "number" ? payload.entryYear : null,
```

- [ ] **Step 7: 改呼叫點**

`tpass-form/src/app/f/[slug]/actions.ts:56`，把

```ts
    if (identityFields.includes("grade")) stamp.respondentGrade = deriveGrade(session.email);
```

改成

```ts
    if (identityFields.includes("grade")) stamp.respondentGrade = deriveGrade(session);
```

- [ ] **Step 8: 改 UI 文案**

`tpass-form/src/components/builder/SettingsPanel.tsx:83`，把

```
送出時由伺服器從登入身分填入（使用者無法竄改）。年級由信箱前三碼推算。
```

改成

```
送出時由伺服器從登入身分填入（使用者無法竄改）。年級依 T-Pass 的入學屆別計算。
```

- [ ] **Step 9: 檢查**

Run: `cd tpass-form && pnpm lint && pnpm exec tsc --noEmit && pnpm test`
Expected: 全部通過

- [ ] **Step 10: Commit**

```bash
cd tpass-form
git add src/lib/grade.ts src/lib/grade.test.ts src/lib/tpass-auth.ts \
  "src/app/f/[slug]/actions.ts" src/components/builder/SettingsPanel.tsx \
  package.json pnpm-lock.yaml
git commit -m "feat: 年級改吃 entryYear claim（缺則 fallback 回信箱）

休學復學者信箱前綴不變，直接推算會多算一級。屆別真相改由 auth 派發。"
```

---

## Task 8: tpass-appeals 改吃 claim

**Files:**
- Modify: `tpass-appeals/package.json`（vitest devDep + test script）
- Modify: `tpass-appeals/src/lib/grade.ts`
- Create: `tpass-appeals/src/lib/grade.test.ts`
- Modify: `tpass-appeals/src/lib/tpass-auth.ts`
- Modify: `tpass-appeals/src/app/actions.ts:52`

**Interfaces:**
- Consumes: Task 3 簽出的 `entryYear` claim
- Produces: 與 Task 7 相同的 `GradeSource` / `deriveGrade` / `gradeLabel`（兩個 repo 各一份複製，行為必須一致）

- [ ] **Step 1: 裝 vitest 並加 script**

```bash
cd tpass-appeals && pnpm add -D vitest
```

`tpass-appeals/package.json` 的 `scripts` 裡，`"lint"` 那行之後加：

```json
    "test": "vitest run",
```

- [ ] **Step 2: 寫失敗的測試**

建立 `tpass-appeals/src/lib/grade.test.ts`：

```ts
import { describe, it, expect } from "vitest";
import { deriveGrade, gradeLabel } from "./grade";

const AUTUMN_114 = new Date(2025, 8, 1); // 民國 114 學年度

describe("deriveGrade", () => {
  it("有 entryYear claim 時以它為準（信箱說 114 屆，claim 說 113 屆）", () => {
    expect(
      deriveGrade({ email: "1140001@example.edu.tw", entryYear: 113 }, AUTUMN_114),
    ).toBe(2); // 只看信箱會得到 1，證明 claim 優先
  });

  it("claim 缺（舊 token）時 fallback 回信箱前三碼", () => {
    expect(deriveGrade({ email: "1140001@example.edu.tw" }, AUTUMN_114)).toBe(1);
  });

  it("claim 為 null 時同樣 fallback 回信箱", () => {
    expect(
      deriveGrade({ email: "1130001@example.edu.tw", entryYear: null }, AUTUMN_114),
    ).toBe(2);
  });

  it("老師／職務帳號 → null", () => {
    expect(deriveGrade({ email: "teacher@example.edu.tw" }, AUTUMN_114)).toBeNull();
  });

  it("已畢業（超出高中三年）→ null", () => {
    expect(deriveGrade({ email: "1100001@example.edu.tw" }, AUTUMN_114)).toBeNull();
  });

  it("尚未入學（未來屆）→ null", () => {
    expect(deriveGrade({ email: "1160001@example.edu.tw" }, AUTUMN_114)).toBeNull();
  });

  it("8 月 1 日跳新學年度：前一天還是高一，當天變高二", () => {
    const email = "1140001@example.edu.tw";
    expect(deriveGrade({ email }, new Date(2026, 6, 31))).toBe(1);
    expect(deriveGrade({ email }, new Date(2026, 7, 1))).toBe(2);
  });
});

describe("gradeLabel", () => {
  it("1/2/3 轉成中文", () => {
    expect(gradeLabel(1)).toBe("高一");
    expect(gradeLabel(2)).toBe("高二");
    expect(gradeLabel(3)).toBe("高三");
  });

  it("null 回 null", () => {
    expect(gradeLabel(null)).toBeNull();
  });
});
```

- [ ] **Step 3: 跑測試確認失敗**

Run: `cd tpass-appeals && pnpm test`
Expected: FAIL

- [ ] **Step 4: 改寫 grade.ts**

把 `tpass-appeals/src/lib/grade.ts` 整個換成（與 tpass-form 同一份，兩邊必須一致）：

```ts
// 年級推導。屆別的真相在 auth：token 的 entryYear claim（民國入學學年度，
// 含休學復學等人工覆寫）。契約見 tpass-auth/INTEGRATION.md §3.3。
//
// claim 缺席時 fallback 回信箱前三碼——這條是必要的，不是可選的：token TTL 45 分鐘，
// auth 升級後的轉場期使用者手上還是舊 token，少了 fallback 那段時間年級會整批變空白。
//
// 年級 = 現在學年度 − 入學學年度 + 1；學年度每年 8 月跳新。高中三年制，超出範圍回 null
// （老師/職務帳號、已畢業、尚未入學）。

export interface GradeSource {
  email: string;
  entryYear?: number | null;
}

// 信箱前三碼＝民國入學學年度（如 1140001@... → 114）。無數字前綴 → null。
function parseEntryYearFromEmail(email: string): number | null {
  const m = email.match(/^(\d{3})/);
  return m ? Number(m[1]) : null;
}

export function deriveGrade(
  source: GradeSource,
  now: Date = new Date(),
): number | null {
  const entry = source.entryYear ?? parseEntryYearFromEmail(source.email);
  if (entry === null) return null;
  const roc = now.getFullYear() - 1911;
  const academicYear = now.getMonth() + 1 >= 8 ? roc : roc - 1;
  const grade = academicYear - entry + 1;
  return grade >= 1 && grade <= 3 ? grade : null;
}

// 給人看的標籤：1 → 高一、2 → 高二、3 → 高三；其餘原樣回數字字串。
export function gradeLabel(grade: number | null): string | null {
  if (grade === null) return null;
  const zh = ["一", "二", "三"][grade - 1];
  return zh ? `高${zh}` : String(grade);
}
```

- [ ] **Step 5: 跑測試確認通過**

Run: `cd tpass-appeals && pnpm test`
Expected: PASS

- [ ] **Step 6: claims 型別加 entryYear**

`tpass-appeals/src/lib/tpass-auth.ts` 的 `interface TPassClaims`，`permissions` 那行之後加：

```ts
  // 民國入學學年度（契約 v2）。老師／職務帳號與舊 token 沒有這個欄位 → null，
  // 由 deriveGrade 自行 fallback 回信箱推算。
  entryYear: number | null;
```

`verifySession` 的回傳物件裡，`permissions:` 那段之後加：

```ts
      entryYear: typeof payload.entryYear === "number" ? payload.entryYear : null,
```

- [ ] **Step 7: 改呼叫點**

`tpass-appeals/src/app/actions.ts:52`，把

```ts
  const respondentGrade = deriveGrade(session.email);
```

改成

```ts
  const respondentGrade = deriveGrade(session);
```

- [ ] **Step 8: 檢查**

Run: `cd tpass-appeals && pnpm lint && pnpm exec tsc --noEmit && pnpm test`
Expected: 全部通過

- [ ] **Step 9: Commit**

```bash
cd tpass-appeals
git add src/lib/grade.ts src/lib/grade.test.ts src/lib/tpass-auth.ts \
  src/app/actions.ts package.json pnpm-lock.yaml
git commit -m "feat: 年級改吃 entryYear claim（缺則 fallback 回信箱）"
```

---

## Task 9: 部署

**Files:** 無程式碼改動

**Interfaces:**
- Consumes: Task 1–8 的全部 commit（三個 repo 都已 push）

⚠️ 本任務會動到主機的正式資料庫（Subject 105 筆）。**每一步都要看輸出再往下走。**

- [ ] **Step 1: 確認三個 repo 都乾淨且已 push**

```bash
for r in tpass-auth tpass-form tpass-appeals; do
  echo "--- $r"; git -C "$r" status --short; git -C "$r" log --oneline -1
done
```
Expected: 無未 commit 檔案

- [ ] **Step 2: 備份主機 auth 資料庫（不可略過）**

```bash
scripts/ssh.sh 'set -a; . /home/service/tpass-auth/.env.local; set +a; \
  pg_dump "$DATABASE_URL" > ~/t_auth-backup-$(date +%Y%m%d-%H%M).sql; \
  ls -lh ~/t_auth-backup-*.sql | tail -1'
```
Expected: 印出一個大小非 0 的 `.sql` 檔。**若失敗或檔案是 0，停在這裡回報。**

- [ ] **Step 3: 記錄部署前的資料量**

```bash
scripts/ssh.sh 'set -a; . /home/service/tpass-auth/.env.local; set +a; \
  psql "$DATABASE_URL" -tAc "SELECT (SELECT count(*) FROM \"Subject\"), (SELECT count(*) FROM \"Grant\"), (SELECT count(*) FROM \"AuditLog\");"'
```
記下三個數字（基準值約為 `105|11|15`，實際以當下輸出為準）。

- [ ] **Step 4: 部署 auth**

```bash
scripts/tpass deploy auth
```
Expected: 輸出裡看得到 `auth → prisma migrate deploy`，且該步驟成功。
**若出現 drift 警告或 migration 失敗，停下來回報，不要重試、不要改用 db push。**

- [ ] **Step 5: 驗證資料完好**

```bash
scripts/ssh.sh 'set -a; . /home/service/tpass-auth/.env.local; set +a; \
  psql "$DATABASE_URL" -tAc "SELECT (SELECT count(*) FROM \"Subject\"), (SELECT count(*) FROM \"Grant\"), (SELECT count(*) FROM \"AuditLog\");"; \
  psql "$DATABASE_URL" -tAc "SELECT migration_name, rolled_back_at IS NOT NULL FROM _prisma_migrations ORDER BY started_at;"; \
  psql "$DATABASE_URL" -tAc "SELECT count(*) FROM \"Subject\" WHERE \"entryYearOverride\" IS NOT NULL;"'
```
Expected:
- 三個數字與 Step 3 相同（AuditLog 可能因為期間有人操作而增加，Subject / Grant 不該減少）
- `_prisma_migrations` 多一筆 `add_entry_year_override`，`rolled_back_at` 為 f
- 覆寫筆數為 0（還沒有人設定）

- [ ] **Step 6: 部署兩個消費端**

```bash
scripts/tpass deploy form
scripts/tpass deploy appeals
```

- [ ] **Step 7: 確認服務都活著**

```bash
scripts/tpass status
```
Expected: auth / form / appeals 皆為 online

- [ ] **Step 8: 端到端驗證**

請**使用者本人**操作（agent 不得自動化 Google 登入）：
1. 到 auth 的 `/admin/people/<某個休學復學學生的 email>`，設定正確的屆別並儲存
2. 等該服務 token 換發（最多 45 分鐘，或請該學生重新登入 form）
3. 在 form 填一份有勾選「年級」的問卷，確認匯出的年級欄位正確
4. 到 `/admin/audit` 確認有 `entryYear.set` 紀錄

- [ ] **Step 9: 記錄結果**

在 `docs/specs/2026-08-21-grade-override-design.md` 的 §10 驗收清單勾選完成項目，commit 到 ops repo。

---

## Self-Review 紀錄

**Spec 覆蓋檢查**（對照 `2026-08-21-grade-override-design.md`）：

| Spec 章節 | 對應任務 |
| --- | --- |
| §3 資料模型 + migration 安全 | Task 2（含 SQL 把關步驟） |
| §4 auth 端 claim | Task 1、Task 3 |
| §5 消費端 fallback | Task 7、Task 8 |
| §6 UI | Task 4、Task 5 |
| §7 文件 | Task 6（INTEGRATION.md）、Task 7 Step 8（SettingsPanel 文案） |
| §8 明確不做 | 無對應任務——本計畫不含任何回填腳本，符合設計 |
| §9 部署順序 | Task 9（auth → form → appeals） |
| §10 驗收 | Task 9 Step 5、Step 8 |

**型別一致性**：`deriveGrade(source: GradeSource, now?: Date)` 在 Task 7、Task 8 兩份實作與測試中簽名相同；
`entryYear` 在 auth（`TPassClaims.entryYear?: number | null`）與消費端（`TPassClaims.entryYear: number | null`）
的差異是刻意的——auth 端 optional 是為了讓 `signAuthSession` 不必傳，消費端 required 是因為 verify 一定會填 null。
