# T-Meeting 會議記錄：刪除 + Markdown — 設計

日期：2026-09-02
狀態：已核准，待實作
影響 repo：`tpass-ui`（新增能力、發 v1.1.0）、`tpass-form`（遷移）、`tpass-meeting`（主要需求）

---

## 1. 問題

兩件事，一起做因為都落在同一批「會議記錄」的渲染點上。

**(a) 會議記錄只能新增，不能刪。**
`meeting_notes` 目前只有 `addNote`，沒有刪除路徑。寫錯字、貼錯連結、測試時亂打的紀錄
會永久留在 `/read` 頁與工作台。唯一的補救是刪掉整場會議（`deleteMeetingAction`，已存在）——
把整場會議連同名單、簽到、票數一起炸掉，只為了刪一行字。

**(b) 會議記錄是純文字。**
`app/read/page.tsx:220` 與 `components/manage/notes-panel.tsx:26` 都是
`<p className="whitespace-pre-wrap …">{n.body}</p>`。貼連結不能點，重點不能標粗體。
`tpass-form` 早就解決過同一個問題（`src/lib/rich-text.ts`），但那份邏輯關在 form 裡。

---

## 2. 決策

| 決策點 | 選擇 | 理由 |
| --- | --- | --- |
| 誰能刪單則紀錄 | 創建者／admin 可刪任一則；協作者只能刪自己寫的那則 | 對齊既有 `canWriteNotes` 的權限分層，不新增權限概念 |
| 硬刪 vs 軟刪 | 硬刪 | 會議記錄沒有稽核需求（有稽核需求的是表決）。軟刪要多一個欄位、每個查詢多一個 `WHERE deleted_at IS NULL`，換來沒人會用的復原 |
| Markdown 邏輯放哪 | **抽到 `tpass-ui` v1.1.0**，form 同步遷移 | AGENTS.md 紅線：不要在服務裡養第二份共用邏輯。`tpass-ui` 已有 vitest／`dist` 進 git／CI 守同步，是現成的家 |
| Markdown 語法範圍 | 完全照搬 form 現有的，不擴充 | 行內語法 + 分隔線。多一種區塊語法就多一種攻擊面，而且兩邊行為必須一致 |
| 套用欄位 | 會議記錄 `notes`、會議說明 `meeting.description`、議程與表決案 `description` | 都是「人寫的一段話」，同一類 |
| 編輯既有紀錄 | **不做** | 需求是刪除。刪掉重寫已經夠用 |
| 即時預覽 | **不做** | form 也沒有，只給一行語法提示 |

---

## 3. A 部分：Markdown 抽到 tpass-ui

### 3.1 tpass-ui v1.1.0

原封搬 `tpass-form` 的三個檔（**不改任何邏輯**，這次不是重寫的時機）：

| 來源（tpass-form） | 目的地（tpass-ui） |
| --- | --- |
| `src/lib/rich-text.ts` | `src/rich-text.ts` |
| `src/lib/rich-text.test.ts` | `src/rich-text.test.ts` |
| `src/components/common/RichText.tsx` | `src/rich-text-view.tsx` |

兩邊都是 vitest 4，測試檔可直接搬，只改 import 路徑。

`src/index.ts` 新增匯出：

```ts
export { RichText } from "./rich-text-view.js";
export { parseRichText } from "./rich-text.js";
export type { RichNode } from "./rich-text.js";
```

**`RichText` 不加 `"use client"`** —— 它只做純渲染、沒有 hook，是 server component 也能跑的。
`use-client-directive.test.ts` 只守 `confirm-dialog.js`，不受影響。

`dist/` 照現有模式 build 後進 git，發 tag `v1.1.0`。

### 3.2 tpass-form 遷移

- 刪 `src/lib/rich-text.ts`、`src/lib/rich-text.test.ts`、`src/components/common/RichText.tsx`
- 三個使用處（`fill/QuestionRenderer.tsx`、`fill/FormFiller.tsx`、`quiz/QuizFiller.tsx`）
  的 `import { RichText } from "@/components/common/RichText"` 改成 `from "tpass-ui"`
- `package.json` 的 `tpass-ui` 升 `#v1.1.0`
- 這是純搬家，**行為零變化**；驗證靠 `pnpm exec tsc --noEmit` + `pnpm lint` + 手動開一份問卷確認說明區還會粗體／連結

### 3.3 tpass-meeting 套用

`tpass-ui` 升 `#v1.1.0`，把下列渲染點的純文字換成 `<RichText text={…} />`：

| 檔案 | 位置 | 欄位 |
| --- | --- | --- |
| `app/read/page.tsx` | :90 | `meeting.description` |
| `app/read/page.tsx` | :139 | 議程項目 `a.description` |
| `app/read/page.tsx` | :167 | 表決案 `m.description` |
| `app/read/page.tsx` | :220 | 會議記錄 `n.body` |
| `components/manage/notes-panel.tsx` | :26 | 會議記錄 `n.body` |
| `components/manage/agenda-panel.tsx` | :137 | 議程項目 `item.description` |
| `components/live-display.tsx` | :155 | 投屏當前議程 `current.description` |
| `app/report/page.tsx` | :85, :113 | 列印報告的會議說明與議程說明 |

**外層的 `whitespace-pre-wrap` 一律保留** —— `RichText` 只加行內語法，換行仍由 CSS 處理。

`app/report/page.tsx` 是列印用頁面，走 inline style 與自訂 class，吃不到 tailwind。
語意標籤（`<strong>` / `<a>` / `<hr>`）仍正確渲染，只是連結不會是綠色。不另外處理。

輸入端提示（照抄 form 的文案，`FormBuilder.tsx:257`）：
- `components/note-bar.tsx`：紀錄輸入框下方那行說明追加語法提示
- `components/meeting-form.tsx:78`：「會議說明」的 `hint` 追加語法提示

---

## 4. B 部分：刪除單則會議記錄

### 4.1 資料層（`lib/meetings.ts`）

```ts
export interface MeetingNoteOwner {
  id: number;
  meeting_id: number;
  author_sub: string | null;
  author_email: string;
}

export async function getNote(noteId: number): Promise<MeetingNoteOwner | null>;
export async function deleteNote(noteId: number): Promise<boolean>;  // rowCount > 0
```

DB schema **不動**：`meeting_notes` 已有 `id` 主鍵與 `author_sub`。

### 4.2 權限判定（`lib/note-permissions.ts`，純函式）

抽成獨立的純函式，因為它要被測試，而 `lib/actions.ts` 是 `"server-only"` + `next/cache`，
在 `node --test` 底下 import 不進來。

```ts
export function canDeleteNote(
  note: { author_sub: string | null; author_email: string },
  meeting: { owner_sub: string },
  session: { sub: string; email: string },
  isAdminUser: boolean,
): boolean {
  if (isAdminUser) return true;
  if (meeting.owner_sub === session.sub) return true;
  // author_sub 是後補欄位，舊紀錄是 NULL，這時退回 email 比對認作者。
  if (note.author_sub) return note.author_sub === session.sub;
  return note.author_email === session.email;
}
```

email 比對前雙方都已 lowercase（`getSession` 壓過，`addNote` 寫入時來自同一個 session）。

### 4.3 Server action（`lib/actions.ts`）

```ts
export async function deleteNoteAction(meetingId: number, noteId: number): Promise<FormState>
```

流程：`requireAccess()` → `getNote(noteId)`（找不到 → 「找不到這則紀錄」）→
**驗 `note.meeting_id === meetingId`**（防止用別場會議的 id 借權限）→ `getMeeting(meetingId)` →
`canDeleteNote(...)`（false → 「你沒有權限刪除這則紀錄」）→ `deleteNote` →
`revalidatePath('/read?id=…')`。

只 revalidate `/read`，照 `noteAction` 的既有慣例：`/manage` 是 `dynamic = "force-dynamic"`，
不吃快取，不需要 revalidate。

注意用 `requireAccess` 而非 `requireManager`：協作者可能是一般學生（`default` 角色），
`requireManager` 會把他們踢到 `/forbidden`。權限由 `canDeleteNote` 判，不由角色判。

### 4.4 UI（`components/delete-note.tsx`）

照 `components/delete-meeting.tsx` 的形狀——`ConfirmActionButton` 的薄包裝：

```tsx
<ConfirmActionButton
  size="sm" variant="ghost" label="刪除"
  action={() => deleteNoteAction(meetingId, noteId)}
  confirm={{ title: "確定要刪除這則紀錄嗎？", description: "刪除後無法復原。", confirmLabel: "刪除" }}
/>
```

放在紀錄卡片標頭右側（作者名／時間那一列）。**權限在 server component 算好、以 boolean 傳進來**，
不在 client 判斷；action 本身仍會再驗一次（client 只管顯不顯示）。

出現在兩處，權限算法不同：

- **`components/manage/notes-panel.tsx`（工作台）**：無條件顯示。
  `app/manage/page.tsx:30-34` 已經擋掉所有非 admin／非創建者的人，
  能看到這個面板的人本來就有權刪任一則，不必再算。
- **`app/read/page.tsx`（會議頁）**：逐則算。這裡才會出現協作者（可能是一般學生）。
  page 是 server component，且已有 `session`、`isAdminUser`、`canEdit`，
  直接在 `notes.map` 裡呼叫 `canDeleteNote(n, meeting, session, isAdminUser)`。

`MeetingNote` 型別因此**不需要**新增欄位；`canDeleteNote` 需要的
`author_sub` 要補進 `getMeetingDetail` 的 `notes` 子查詢（目前只選了
`id / author_email / author_name / body / created_at`）。

### 4.5 測試

`lib/note-permissions.test.ts`，用 `node:test`（meeting 的測試指令是
`node --experimental-strip-types --test lib/*.test.ts`，**不是 vitest**），照 `lib/threshold.test.ts` 的形狀。

案例：admin 可刪他人紀錄／創建者可刪他人紀錄／作者可刪自己（`author_sub` 有值）／
作者可刪自己（`author_sub` 為 NULL，退回 email）／路人不能刪／
`author_sub` 為 NULL 且 email 不同的人不能刪。

---

## 5. 出貨順序

1. `tpass-ui`：加 rich-text、build、測試、發 `v1.1.0`
2. `tpass-form`：升版、刪本地三檔、改 import、`check`、推 main → Actions 部署
3. `tpass-meeting`：升版、套 `RichText`、做刪除功能、`check` + `test`、推 main → `tpass deploy meeting`

form 與 meeting 彼此獨立，(2) 與 (3) 順序可換，但都必須排在 (1) 之後。

---

## 6. 不做（YAGNI）

- 編輯既有紀錄（需求是刪除）
- 軟刪／刪除稽核紀錄
- Markdown 即時預覽
- 擴充 Markdown 語法（標題、清單、表格、圖片）
- 撤銷協作者授權（既有缺口，與本次無關）
