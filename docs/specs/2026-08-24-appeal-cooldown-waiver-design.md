# 申訴冷卻解除（管理員後台解 CD）— 設計

日期：2026-08-24
狀態：已核准，待實作
影響 repo：`tpass-appeals`（單一 repo，不跨服務）

---

## 1. 問題

申訴系統有 30 分鐘冷卻：同一人送出後 30 分鐘內不收第二件（防灌爆 DB 與 Discord 頻道，
安全審查 L2）。目前寫死在 `src/app/actions.ts`：

```ts
const cooldownMs = 30 * 60 * 1000;
const recent = await prisma.appeal.findFirst({
  where: { respondentSub: session.sub, submittedAt: { gt: new Date(Date.now() - cooldownMs) } },
});
if (recent) return { ok: false, message: "剛剛已送出過申訴，請稍後再試（每 30 分鐘限一件）。" };
```

**冷卻沒有自己的資料表**——它完全是從「最後一筆申訴的 `submittedAt`」推導出來的。

實務上會卡到人：學生送出後才發現漏附證據、或申訴內容打錯要重送，就得乾等 30 分鐘。
管理員看得到案件卻沒有任何手段放行。

## 2. 決策

**在 `Appeal` 上標記「這筆不計入冷卻」，冷卻查詢排除已標記的紀錄。**

冷卻既然是從那筆申訴推導出來的，解除就標記在那筆申訴上。不加表、不加查詢，
而且天然是一次性放行——學生補送的新申訴會產生自己的新冷卻。

不開 `CooldownWaiver` 表（sub / grantedBy / expiresAt）：那能做到事前豁免與自訂有效期，
但需求只是「這件已處理完，讓他補送」。多一張表就多一次查詢、多一份過期資料要清。YAGNI。

不刪原申訴：DB 是唯一真相來源／備份（不受 Discord 通知成敗影響），刪掉等於毀證。

不做全域 CD 長度設定：這次只要個案放行。改長度是另一個需求，要做再說。

## 3. 資料模型

`prisma/schema.prisma`，`Appeal` 加兩欄：

```prisma
cooldownWaivedAt DateTime?   // null = 這筆仍計入冷卻
cooldownWaivedBy String?     // 解除者 email，稽核用
```

兩欄都 nullable，既有資料不必補值，向後相容。既有索引
`@@index([respondentSub, submittedAt])` 照用——豁免是額外的過濾條件，不改變查詢形狀。

## 4. 冷卻邏輯抽出

新檔 `src/lib/cooldown.ts`，讓 30 分鐘這個常數只有一個來源（提交檢查與後台顯示都要用）：

| 匯出 | 型別 | 用途 |
| --- | --- | --- |
| `COOLDOWN_MS` | `number` | 30 分鐘 |
| `isCoolingDown(appeal, now)` | 純函式 | `now - submittedAt < COOLDOWN_MS && cooldownWaivedAt === null` |
| `cooldownEndsAt(submittedAt)` | 純函式 | 算冷卻到期時刻，顯示剩餘時間用 |

`cooldown.ts` 只放純函式、不 import prisma，這樣測得到——這個 repo 沒有 DB mock 設施，
現有測試（`grade.test.ts`、`image.test.ts`、`discord.test.ts`）全是純函式測試。

對應的兩個 DB 查詢放在既有的資料存取層 `src/lib/appeals.ts`：

- `findBlockingAppeal(sub)` —— 提交時用，where 加 `cooldownWaivedAt: null`
- `waiveCooldown(id, byEmail)` —— 解除，見下節

## 5. Server action

新檔 `src/app/admin/appeals/actions.ts`：

```
waiveCooldownAction(appealId) →
  requireAdmin("/admin")            // moderator + admin 都能用，跟題目管理／設定一致
  waiveCooldown(appealId, session.email)
  失敗 → 錯誤字串
  revalidatePath("/admin"), revalidatePath(`/admin/appeals/${id}`)
```

`waiveCooldown` 用帶條件的 `updateMany`（`id` + `cooldownWaivedAt: null` + 仍在視窗內）
一次寫入，而不是先讀再寫：兩個管理員同時按也只有一個會寫進去，`count` 就是「這次是否
真的解除了」。解除者 email 一律取自驗章後的 session，不收 client 傳來的身分，稽核紀錄
才可信。

失敗原因（不存在／已過期／已被解除）對操作者的意義相同——現在沒有 CD 可解——所以
不分三種訊息，統一回「這筆申訴已不在冷卻中（可能已過期或已被解除）。」少一組特殊情況。

回 `{ ok: boolean; error?: string }`，不丟例外——UI 直接顯示錯誤字串。

## 6. UI

### 詳情頁 `/admin/appeals/[id]`

頭部卡片下方多一塊狀態區，三種互斥狀態：

| 狀態 | 顯示 |
| --- | --- |
| 已豁免 | `冷卻已解除` + 解除者 email + 解除時間（永久保留，是稽核痕跡） |
| 未豁免且冷卻中 | `這位同學要到 15:42 才能再送一件` + 「解除冷卻」按鈕 |
| 其他 | 不渲染這塊 |

顯示絕對到期時刻而非「剩 X 分」：頁面是 server render 的，剩餘分鐘會隨著頁面停留而
失真，絕對時刻不會。要做即時倒數就得多一個 client 計時器，不值得。

判斷只看這筆申訴本身，不需要「是不是這個人最新一筆」的邏輯——在視窗內且未豁免，
它就是正在擋人的那筆。

### 列表頁 `/admin`

每列在年級 badge 旁多一個「冷卻中」標記，管理員不必點進去就知道誰被卡著。
`listAppeals()` 一併帶回 `cooldownWaivedAt`，不增加查詢次數。

### 樣式

照 `tpass-portal/docs/design.md`：`border-2 border-foreground` + hard offset shadow，
light-only、OKLCH。按鈕用既有的 `components/ui/primitives` 的 `Button`。

## 7. 測試

`src/lib/cooldown.test.ts`（vitest）：

- 視窗內未豁免 → 冷卻中
- 視窗內已豁免 → 不冷卻
- 視窗外 → 不冷卻
- 邊界：剛好等於 `COOLDOWN_MS` → 不冷卻
- `cooldownEndsAt` 回 `submittedAt + COOLDOWN_MS`

## 8. 不在範圍內

- 全域 CD 長度設定（設定頁）
- 事前豁免（學生還沒送就先開）
- 冷卻中名單頁
- 學生端顯示剩餘冷卻時間（目前只在送出時報錯，不改）
