# tpass 生態系常見漏洞檢查清單

> 2026-09-02 從 `tpass-cross_grade_messages/docs/` 搬到這裡：它是全生態通用的稽核清單，
> 放在單一服務 repo 沒人找得到。逐項稽核發現與處置紀錄在 `SECURITY-REVIEW.md`。

本清單自 T-Msg「冷卻繞過」資安事件（2026-07）萃取而成：攻擊者用同一個校園 email、登入後拿到兩個不同的 Google JWT `sub`，讓冷卻/名額系統誤判成兩個不同的人，因而繞過每日傳訊上限。事後修法：身分閘門改以 email 為鍵、加 DB `UNIQUE` 約束。

其他 agent 若被派去稽核 tpass 生態系的其他 service，可直接拿這份清單逐項核對。每一項都給：風險描述、怎麼查（grep/檢查線索）、正解、以及 T-Msg 這次事件裡是正例還是反例。

---

## 1. 身分閘門要用穩定身分

**風險**：冷卻、名額、封鎖這類「一人一份」的限制，如果用可變、或可被同一人弄出多個值的 ID 當鍵（例如 Google JWT 的 `sub`），攻擊者只要能拿到同一 email 對應的第二個 `sub`，就能繞過限制。

**怎麼查**：
```
grep -rn "where: { sub" src/
grep -rn "@id.*sub\|sub.*@id" prisma/schema.prisma
```
看限制類的資料表（冷卻、封鎖、名額、配額）是不是用 `sub`／任何非 email 的欄位當唯一鍵或查詢鍵。

**正解**：以「網域鎖定、驗證過、且已知穩定」的身分（通常是校園 email）為鍵；並在 DB 層加 `UNIQUE(email)` 約束防止重複身分列——約束要在資料庫裡，不能只靠應用層檢查。

**T-Msg 案例**：反例 → 已修。原本 `UserStatus.sub` 是主鍵且是冷卻/封鎖的查詢鍵；修復後改為 `UserStatus.email @unique` 是身分鍵，`sub` 降級為「最後一次登入」的顯示/稽核欄位。

---

## 2. 大整數 ID 全程當 string 處理

**風險**：Google `sub` 是 21 位數字字串，超過 JS `Number.MAX_SAFE_INTEGER`（9007199254740991）。一旦被 `Number()`／`parseInt()` 之類轉型，精度就會丟失，造成不同 sub 撞出同一個數字。更要注意的是：把 sub 砍尾或加尾一碼，得到的仍是一個「格式合法」的數字字串——單純加格式檢查（正則、長度、範圍）攔不住這種變體。

**怎麼查**：
```
grep -rn "parseInt(.*sub\|Number(.*sub" src/
```
確認任何地方沒有把 `sub` 拿去做數值運算或轉型。

**正解**：`sub` 全程當 opaque string 處理，不做數值轉換。但真正的防線不是「驗 sub 格式合不合法」，而是第 1 項——用 email 當身分鍵 + DB UNIQUE，這樣無論攻擊者能生出幾個「合法」的 sub 變體都沒用，因為系統根本不再拿 sub 當身分鍵。

**T-Msg 案例**：本次事件的核心教訓。修復刻意不加 sub 格式驗證器，因為那治標不治本。

---

## 3. 每個 server action / route handler 要重呼 guard

**風險**：Next.js server action 本質上是一個全域可呼叫的 POST 端點，不是「只有這個頁面的按鈕能觸發」。如果權限檢查只放在 layout 或某個共用元件裡，攻擊者可以直接組 request 打 server action，繞過 layout 完全沒經過的檢查。

**怎麼查**：
```
grep -rln '"use server"' src/
```
對每個檔案，確認每一個 export 出去的 function 內部第一件事就是呼叫對應的 `require*`（`requireAdmin`／`requireSession`／`requireSuperAdmin`），而不是假設呼叫方已經被 layout 擋過。

**正解**：guard 呼叫要放在每個 action/handler 的函式體內部，靠 throw/redirect 擋掉未授權呼叫；不能只信任 UI 層或路由層的保護。

**T-Msg 案例**：正例。`resetCooldownAction`／`banUserAction`／`unbanUserAction`／`sendMessageAction` 等每個 export 開頭都呼叫 `requireAdmin(...)` 或 `requireSession(...)`。

---

## 4. JWT 驗章四鐵則

**風險**：驗證 JWT 時漏掉任一項，都可能被偽造或跨服務重放的 token 騙過。

**怎麼查**：
```
grep -rn "jwtVerify" src/
```
確認呼叫處明確帶了：
- `algorithms: ['EdDSA']`（鎖死演算法，防 `alg: none` / alg confusion 攻擊）
- 驗 `issuer`
- 驗 `audience`（且是 per-service 的，例如 `tpass:<service-id>`，不是共用一個 audience）
- 驗 `exp`（多半函式庫預設會驗，但要確認沒被關掉）

**正解**：四項缺一不可，且演算法要白名單鎖死，不能讓 token 自己宣稱用什麼演算法。

**T-Msg 案例**：正例，見 `src/lib/tpass-auth.ts`。

---

## 5. Open Redirect

**風險**：登入後導回（`redirect`/`next` 參數）如果沒限制目的地，攻擊者可以造一個連結，讓使用者登入後被導去釣魚站。

**怎麼查**：
```
grep -rn "redirect\|loginUrlFor\|next=" src/
```
看 redirect 目標的驗證邏輯。

**正解**：只允許兩種目的地：
- 站內相對路徑：`path.startsWith('/') && !path.startsWith('//')`（防止 `//evil.com` 這種 protocol-relative URL 繞過）
- 白名單網域，且比對邏輯要是 `host === base || host.endsWith('.' + base)`——切忌寫成裸的 `host.endsWith(base)`，那樣 `evil-tschool.tp.edu.tw` 會被誤判為合法子網域。

**T-Msg 案例**：正例。

---

## 6. SSRF / 外送目標鎖網域

**風險**：如果外送請求（webhook、callback URL 等）的目標網域可以由使用者/管理員自由填寫，可能被用來打內網位址或任意外部主機（SSRF）。

**怎麼查**：
```
grep -rn "fetch(\|axios\|http.request" src/lib/chat.ts src/
```
看送出 webhook 前有沒有驗證 URL 的 host 與 protocol。

**正解**：外送 URL 只收固定、已知的網域（例如 `chat.googleapis.com`），且只允許 `https`。不要只驗字串裡「有沒有包含某網域」，要驗實際 parse 出來的 host。

**T-Msg 案例**：正例。

---

## 7. Secret 不進 git / log / 錯誤訊息 / URL；UI 顯示要截斷

**風險**：Webhook URL、token、API key 這類 secret 一旦印進 log、丟進錯誤訊息、或整包顯示在 UI/URL 上，就等於外洩——log 平台、瀏覽器歷史紀錄、錯誤追蹤服務都可能是外洩管道。

**怎麼查**：
```
grep -rn "console.log\|console.error" src/ | grep -i "url\|secret\|token\|key"
```
檢查是否有整串 secret 值被印出或塞進 error message／URL query string。

**正解**：secret 只落地在 DB；程式碼、git history、log、錯誤訊息一律不出現完整值；UI 需要顯示時做截斷（例如只顯示前後幾碼）。

**T-Msg 案例**：正例，webhook URL 含 secret，UI 顯示會截斷。

---

## 8. 並發防護：條件式原子 update，不要 read-then-write

**風險**：名額/冷卻類邏輯如果是「先讀狀態、判斷可不可以、再寫入」，在並發請求（連點兩下、或攻擊者刻意併發送出）下會出現 race condition，讀到的狀態在寫入前就過期了，導致同一名額被搶兩次。

**怎麼查**：
```
grep -rn "updateMany\|findUnique.*update" src/app/actions.ts
```
確認寫入名額/冷卻的地方，是不是把「條件」直接放進 `update`／`updateMany` 的 `where` 裡（DB 層原子操作），而不是應用層 `if (可以) { update() }`。

**正解**：用條件式原子 `updateMany`（`where` 帶判斷條件，例如 `nextAllowedAt: null OR <= now`），然後看回傳的 `count` 決定是否搶到名額；不要 read-then-write。

**T-Msg 案例**：正例，見 `sendMessageAction` 裡的 `updateMany` + `claimed.count`。

---

## 9. TOCTOU：批次/預覽動作要用原始輸入重新 parse

**風險**：如果一個「預覽」步驟把解析結果（例如批次匯入要新增的 email 清單）整包回傳給前端，再由前端把「預覽結果」原封不動送回後端執行，等於信任了 client 端可竄改的資料——這是 Time-Of-Check-To-Time-Of-Use 問題。

**怎麼查**：
```
grep -rn "preview\|批次" src/
```
看執行動作的 server action，是重新 parse 使用者原始輸入（例如貼上的整段文字），還是直接吃 client 回傳的「預覽結果」陣列。

**正解**：執行步驟一定要以「原始輸入」重新 parse/驗證一次，不能信任 client 回傳的預覽/確認資料本身。

**T-Msg 案例**：正例，批次匯入管理員 email 的流程有重新 parse。

---

## 10. 內容過濾（禁詞）的已知限制

**風險**：如果禁詞比對是單純 substring match，使用者可以插入空白、全形字元、或做其他正規化手法繞過（例如 `笨 蛋` 或全形符號插入）。

**怎麼查**：
```
grep -rn "findBannedWord\|bannedWords" src/lib/settings.ts
```
確認比對邏輯的正規化程度。

**正解**：這是設計取捨，不一定要做到滴水不漏（自然語言過濾本來就打不贏所有繞法），但要明確記錄「這是已知限制」，不要誤以為是完整防護。

**T-Msg 案例**：已知限制，非 bug，記錄在案即可。

---

## 11. 登入 CSRF / Session Fixation（低風險項，知悉即可）

**風險**：如果登入 callback 接受用 POST 帶 token 來設 cookie，理論上存在 CSRF/session fixation 的攻擊面，但只要 cookie 屬性設對，實務風險很低。

**怎麼查**：
```
grep -rn "sameSite\|httpOnly\|set-cookie" src/
```
確認 session cookie 有沒有設 `sameSite=lax`（或更嚴）加 `HttpOnly`。

**正解**：`sameSite=lax` + `HttpOnly` 已經能緩解大部分風險；除非有特殊需求，不需要額外加 CSRF token。

**T-Msg 案例**：已知悉，屬低風險項，現況已用 `sameSite=lax` + `HttpOnly` 緩解。

---

## 用法提示

拿到一個新 service 的 repo 時，建議順序：
1. 先跑第 1、2 項的 grep，找出「身分閘門用什麼鍵」——這類問題最容易被忽略，也最致命。
2. 跑第 3、4 項，確認權限與驗章基本盤沒漏洞。
3. 其餘依 repo 實際功能（有沒有 redirect、有沒有外送 webhook、有沒有批次匯入）挑相關項目核對。
4. 每項都要落地到「T-Msg 案例」欄位對應的具體程式碼位置去理解正解長什麼樣子，不要只背抽象原則。
