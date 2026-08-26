# T-Form 說明欄夾圖片 — 設計

- 日期：2026-08-26
- 影響 repo：`tpass-form`（單一 repo；ops 層只有一項備份待辦，見 §8）
- 狀態：設計已確認，待寫實作計畫

## 1. 問題

T-Form 的說明文字目前只能放純文字。實際使用上，問卷常需要放圖：範例照片、流程圖、
場地示意、規則截圖。現在只能把圖傳到別處再貼連結，填寫者要離開頁面才看得到。

說明文字現有四處：

| # | 位置 | 資料落點 |
| --- | --- | --- |
| 1 | 問卷標題下的說明 | `Form.description`（DB 欄） |
| 2 | 區段說明 | `definition.blocks[].description`（`kind: "section"`） |
| 3 | 說明板塊 | `definition.blocks[]` 的 `heading` / `body`（`kind: "text"`） |
| 4 | 題目說明 | `definition.blocks[].description`（`kind: "question"`） |

四處全部支援夾圖。

## 2. 形式：附在文字下方，不是內嵌

圖片以陣列掛在該說明欄上，渲染在說明文字**下方**，可排序、可加圖說。

不做 markdown 內嵌（`![](id)` 穿插段落之間）。內嵌要多做 markdown 渲染器、編輯器插入 UI
與 XSS 防護，工作量約 2~3 倍，換來的彈性在「問卷說明」這個場景用不上。

## 3. 資料模型：新 `FormAsset`，不重用 `Upload`

既有的 `Upload` 語義相反，不能共用：

| | `Upload`（既有） | `FormAsset`（新） |
| --- | --- | --- |
| 誰上傳 | 填寫者 | 問卷建構者 |
| 綁定 | `formId` + `questionId` | `formId` |
| 內容 | 回覆附件（個資） | 問卷內容 |
| 誰能讀 | 問卷擁有者 / 超管（`/api/files/[id]`） | 任何已登入者 |

混成一張表會讓授權判斷長出一堆 `if`。分開。

```prisma
model FormAsset {
  id         String   @id @default(cuid())
  formId     String
  form       Form     @relation(fields: [formId], references: [id], onDelete: Cascade)
  storageKey String
  mime       String   // 一律 image/webp
  width      Int
  height     Int
  size       Int
  createdBy  String   // JWT sub
  createdAt  DateTime @default(now())

  @@index([formId])
}
```

`Form` 加上 `assets FormAsset[]` 反向關聯。

存 `width` / `height` 是為了渲染時給 `<img>` 固定長寬比，避免圖片載入時 Neobrutalism
卡片跳動。

## 4. Schema（`src/lib/survey-schema.ts`）

```ts
export const imageRefSchema = z.object({
  id: z.string().min(1),        // FormAsset.id
  alt: z.string().default(""),  // 圖說 = 替代文字，一欄兩用
});
export type ImageRef = z.infer<typeof imageRefSchema>;

const imagesField = z.array(imageRefSchema).max(6).default([]);
```

欄位名一律 `images`，掛到四處：

- `questionBlockSchema.images`
- `sectionBlockSchema.images`
- `textBlockSchema.images`
- `formSettingsSchema.images`（問卷層說明的圖存在 settings JSON，不動 DB schema）

**順手清掉兩個死欄位**：`textBlockSchema.imageKey` 與 `formSettingsSchema.coverImageKey`。
全專案 grep 只有宣告、沒有任何讀寫，留著只會讓下一個人以為有功能。zod 預設 strip
未知 key，舊資料含這兩欄仍能 parse。

`createText()` 等工廠函式不必改（`images` 有 `.default([])`）。

## 5. 端點

### `POST /api/form-assets`

授權：`requireAdmin()` + 該問卷的編輯權（沿用 `lib/guard.ts` 既有判斷，與 `saveFormAction` 同一條）。

輸入：`multipart/form-data`，欄位 `file`、`formId`。

處理：

1. mime 必須 `image/*`，原檔 ≤ 10 MB。
2. sharp：`.rotate()`（先吃 EXIF orientation，再整份剝掉 metadata）
   → `.resize({ width: 1600, height: 1600, fit: "inside", withoutEnlargement: true })`
   → `.webp({ quality: 80 })`。
3. 每問卷 asset 數上限 40。
4. `putObject()` 寫入儲存，建 `FormAsset` row。

輸出：`{ id, width, height }`。

錯誤：`401` 未登入 / `403` 無編輯權 / `413` 超過 10 MB / `415` 非圖片或轉檔失敗
/ `429` 超過每問卷 40 張。`415` 要回人話訊息：「這張圖的格式不支援，請改存成 JPG 或 PNG」。

新增直接相依：`pnpm add sharp`（0.34.5 已在 node_modules，是 Next 的相依，只是提為直接相依）。

### `GET /api/form-assets/[id]`

授權：只驗「有 session」。填寫頁本來就要求登入，說明圖就是要給填寫者看的；
asset id 是 cuid，不可猜。刻意**不**做 per-form 授權——那會讓「一張圖被多份問卷引用」
之類的未來需求卡死，而說明圖本身不是個資。

回應：`Content-Type: image/webp`，
`Cache-Control: private, max-age=31536000, immutable`（內容不可變，換圖＝換 id）。

`/api/files/[id]`（回覆附件，admin-only）**一行都不動**。

## 6. UI

### 建構端 `src/components/builder/ImageAttachments.tsx`

四處編輯器共用同一個元件。介面：

```tsx
<ImageAttachments formId={formId} images={block.images} onChange={(next) => set({ images: next })} />
```

- 縮圖橫列 + 「加圖片」按鈕（`<input type="file" accept="image/*" multiple>`）。
- 每張縮圖下：圖說輸入框、刪除鈕、左移／右移鈕。
- **不引 dnd**。6 張上限下箭頭排序最笨也最清楚，四處都塞 dnd 太重。
- 上傳中顯示 pending 狀態；失敗顯示端點回的人話訊息。

掛載點：`TextEditor`、`SectionEditor`、`QuestionEditor`、`SettingsPanel`（問卷層說明）。

### 渲染端 `src/components/common/DescriptionImages.tsx`

填寫端（`FormFiller`、`QuestionRenderer`）與 builder 預覽共用。

- 1 張 → 單張滿寬；2 張以上 → `grid-cols-2`，手機收成 1 欄。
- 每張 `border-2 border-foreground rounded-xl shadow-[3px_3px_0_0_var(--color-foreground)]`，
  照 design system，不用 soft shadow。
- `alt` 有值 → 圖片下方 mono 小字圖說；同時作為 `<img alt>`。
- 整張包 `<a href={src} target="_blank" rel="noopener">` 讓人看原圖。不做 lightbox。
- `<img>` 帶 `width` / `height`（來自 `FormAsset`）避免 layout shift。

`QuizFiller`（客製特效皮）本次不接，維持現狀。

## 7. 孤兒清理

存檔時 GC。`saveDraft` 成功之後：

1. 掃 `definition.blocks[].images` 與 `settings.images`，收集所有被引用的 asset id。
2. 刪掉「屬於此問卷、不在引用集、且 `createdAt` 早於 1 小時前」的 row 與 storage object。

1 小時緩衝同時擋掉兩種誤刪：剛上傳但還沒存檔的圖、編輯中暫時移除稍後又放回的圖。

刪問卷：Prisma `onDelete: Cascade` 清 row，另外一次刪光該問卷的 storage object。

## 8. 儲存後端與已知取捨

沿用 `src/lib/storage.ts` 的 `local` driver（`./.uploads`）。主機的 `deploy.sh` 是
`git pull --ff-only`，不會清掉這個目錄。

三項已知取捨，都是刻意接受的：

1. **綁單機**。圖片存在主機檔案系統，將來要多機或搬家得先把 `storage.ts` 的 `s3`
   driver 補完（目前會直接丟錯）。現在是單機，不是問題。
2. **`.uploads` 沒被備份**。`deploy/backup.sh` 只備 DB，主機重灌圖片全丟。
   這是 ops repo 的待辦，**不在本次實作範圍**，另案處理。
3. **HEIC 可能失敗**。sharp 預設沒編 libheif，iPhone 直傳 HEIC 會轉檔失敗。實務上
   iPhone 走瀏覽器 file input 多半自動轉 JPEG，但不保證。失敗回 `415` 配人話訊息，
   不為了它去編 libheif。

## 9. 測試

- `src/lib/asset-gc.test.ts`（純函式，vitest 已在用）
  - 引用集收集涵蓋四處來源（question / section / text / settings）。
  - GC 判定：1 小時緩衝內不刪、跨問卷不誤刪、引用中不刪。
- schema round-trip
  - 舊 definition（沒有 `images` 欄）parse 後 `images` 為 `[]`。
  - 舊資料含 `imageKey` / `coverImageKey` 能 parse 且欄位被 strip。

## 10. 不做的事

- markdown / 富文字內嵌。
- 圖片 lightbox、縮放、輪播。
- 影片、GIF 動畫以外的媒體。
- 外部圖片網址（會壞連結、有第三方追蹤問題）。
- `QuizFiller` 特效皮的說明圖。
- s3 driver 實作。
