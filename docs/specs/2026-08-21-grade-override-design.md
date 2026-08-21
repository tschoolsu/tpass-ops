# 年級屆別覆寫（休學復學例外機制）— 設計

日期：2026-08-21
狀態：已核准，待實作
影響 repo：`tpass-auth`、`tpass-form`、`tpass-appeals`

---

## 1. 問題

年級目前純由 email 前三碼推算（`deriveGrade`，`tpass-form` 與 `tpass-appeals` 各有一份完全相同的複製）：

```
年級 = 現在學年度 − email 前三碼 + 1        // 學年度每年 8 月跳新
```

休學後復學的人 email 沿用，學號前綴不變，於是：

- 休學一年 → 系統多算一級（該顯示高一卻顯示高二）
- 休學兩年 → 算出 4，超出 1..3 範圍 → 回 `null` → 年級整欄空白

而且推算結果會**寫死進各服務的 DB**（`Response.respondentGrade`、`Appeal.respondentGrade`），
錯誤會固化在歷史資料裡。

## 2. 決策

**在 auth 存「入學屆別覆寫」，經 JWT claim 派發給各服務。**

存屆別而非年級：設定一次，往後每年自動跟著升。存年級的話每年 8 月開學都要手動把所有例外 +1，
忘了就錯——那是一個保證會壞掉的維護負擔。

放 auth 而非各服務：年級是身分屬性，不是單一服務的事。放服務端的話同一個人要在每個服務各標一次，
而 `grade.ts` 已經是兩份複製，再加 override 就是 2N 份要同步。這也是既有鐵律
（各服務不自維護名單，名單在 auth 的 `/admin` panel 管）。

不走「各服務呼叫 auth API 查」：違反契約 v2（各服務不回呼 auth），且會讓 auth 掛掉時全部服務跟著壞。

## 3. 資料模型

`tpass-auth/prisma/schema.prisma`，`Subject` 加一欄：

```prisma
entryYearOverride Int?   // 民國入學學年度覆寫；null = 照 email 前三碼推
```

只存例外。絕大多數人的 email 就是真相，不需要 row。

### 資料安全性（本次最重要的約束）

**真資料只在主機**，本機是可拋棄的開發資料庫。所以所有保護措施都對準主機。

主機現況（2026-08-21 實查）：

```
_prisma_migrations : 20260727095455_init | 2026-07-28 08:25 | 未 rollback
資料量             : Subject 105 / Grant 11 / AuditLog 15
```

`_prisma_migrations` 表存在且 init 正常套用 → `migrate deploy` 會乾淨地只跑新 migration，
**不需要 baseline，不會撞「表已存在」**。這是加欄位最容易出事的情境，已排除。

| 保證 | 依據 |
| --- | --- |
| 現有 row 不被改動 | 新欄位 nullable、無 default，migration 只有 `ALTER TABLE "Subject" ADD COLUMN "entryYearOverride" INTEGER;`。Postgres 對這種加欄位是 metadata-only，不重寫資料頁、不長時間鎖表 |
| 部署不會 reset DB | `services.json` 的 `auth.db.strategy = "migrate"`，`deploy.sh:187` 走 `prisma migrate deploy`——只前進、不 reset、偵測到 drift 是**報錯**而不是重建 |
| 出事有得救 | 部署前先 `pg_dump`（見下），105 筆 Subject 的 dump 是秒級的，沒有不做的理由 |
| `form` / `appeals` 零 schema 風險 | 這兩個 repo 本次**完全不動 Prisma schema**，只改 TypeScript |
| 歷史年級資料不被回溯竄改 | 已存的 `respondentGrade` 一律不 touch（見 §8） |

### 部署前必做：備份

```bash
scripts/ssh.sh 'set -a; . /home/service/tpass-auth/.env.local; set +a; \
  pg_dump "$DATABASE_URL" > ~/t_auth-backup-$(date +%Y%m%d-%H%M).sql; \
  ls -lh ~/t_auth-backup-*.sql | tail -1'
```

確認 dump 檔案大小合理（非 0）後才執行部署。

**主機上絕不執行**：`prisma migrate dev`、`prisma db push`、`prisma migrate reset`。
部署一律走 `deploy.sh`，它已經依 `strategy` 選對 `migrate deploy`。

⚠️ 本機：`pnpm db:migrate` 偵測到 drift 會提議 reset 整個資料庫——本機沒有要保留的資料，
按下去無妨。這條警告只是說明兩邊行為不同，不是主機的風險。

## 4. auth 端

新增 `tpass-auth/src/lib/entry-year.ts`：從 email 前三碼解析民國入學學年度，非數字前綴（老師 / 職務帳號）回 `null`。

`signServiceToken()`（`src/lib/session.ts`）多簽一個 claim：

```
entryYear = subject.entryYearOverride ?? parseEntryYearFromEmail(email)    // number | null
```

這會多一次 `Subject` 查詢（`permissionsFor` 查的是 `Grant` 表，沒碰 `Subject`），email 有 unique index，成本可接受。

`signAuthSession()` **不帶**這個 claim——那顆 token 只存身份、permissions 一律空，年級對它沒有意義。

## 5. 消費端（`tpass-form`、`tpass-appeals`）

`src/lib/tpass-auth.ts` 的 claims 型別加 `entryYear?: number | null`，解析時型別檢查
（`typeof payload.entryYear === "number"`），非數字一律當缺。

`src/lib/grade.ts` 從「吃 email」改成「吃 session」：

```
entryYear claim 存在 → 用它
claim 不存在        → fallback 回 email 前三碼（＝現行行為）
→ 兩者都得不到數字 → null
```

**fallback 這條是強制的，不是可選的。** token TTL 45 分鐘，auth 部署後那段時間使用者手上的舊 token
還沒有這個 claim；若寫成「claim 缺就回 null」，部署完會有整整 45 分鐘全校年級變空白。

呼叫點各一行：`tpass-form/src/app/f/[slug]/actions.ts:56`、`tpass-appeals/src/app/actions.ts:52`。

## 6. UI

`/admin/people/[email]`，在權限卡**上方**新增「屆別」卡（身分屬性，不是權限，不放進 Grant 列）：

```
屆別
依信箱推算：114 屆 · 高二
[ 115 ] 屆    [儲存] [恢復自動]
→ 目前算作 115 屆 · 高一
```

- 守門：`requireAuthModerator()`（auth 服務上的 admin 或 moderator），走既有 `gate()`
  把 `ForbiddenError` 轉成畫面訊息——server action 直接 throw 會讓畫面卡在「處理中…」
- 稽核：`recordAudit` 記 `entryYear.set` / `entryYear.clear`，`serviceId: "auth"`
- superadmin：沿用既有規則擋掉（不進 DB、不可調整）
- Subject row 不存在時順手建，比照 `saveGrant` 的既有做法
- 不加 reason 欄位：`AuditLog` 已有 actor / before / after，足夠追責

輸入驗證：三位數民國學年度，接受範圍 `100 ≤ 值 ≤ 現在學年度 + 1`（+1 容納開學前先建好的新生），
超出或非整數一律拒絕並回可讀訊息。

## 7. 文件

| 檔案 | 改什麼 |
| --- | --- |
| `tpass-auth/INTEGRATION.md` §3.1 / §3.2 / §3.3 | claim 契約的權威文件：payload 範例與欄位定義加 `entryYear`，寫明「可能為 null」與 fallback 義務 |
| `tpass-form` / `tpass-appeals` 的 `grade.ts` 註解 | 現在寫死「email 前三碼」，改成「優先吃 claim」 |
| `tpass-form/src/components/builder/SettingsPanel.tsx:83` | UI 文案「年級由信箱前三碼推算」會變成假的 |

`docs/NEW-SERVICE.md` 不動——年級是選用資料，寫在 INTEGRATION.md §3.3 就夠，塞進流程文件只會讓它變長。

## 8. 明確不做

- **不回填**已存的 `respondentGrade`：那是送出當下的快照，回溯修改會讓舊問卷統計無聲變動
- **不做「休學中」狀態**：目前沒這需求
- **不改 email**：學號是 `Subject.email` 這個 unique 查找鍵，換 email 等於換人，Grant 全斷

## 9. 部署順序

1. `tpass-auth`（schema + migration + claim + panel）
2. `tpass-form`、`tpass-appeals`

auth 先上時舊服務完全無感——JWT 多一個未知 claim 會被消費端忽略（解析是手動挑欄位的）。
順序反了也不會壞，只是例外的人繼續錯到 auth 上線為止。

## 10. 驗收

- [ ] `prisma migrate dev` 生成的 SQL 只有一行 `ADD COLUMN`，沒有任何 `DROP` / `ALTER COLUMN`
- [ ] 沒設覆寫的人，年級與改動前完全一致（含老師帳號仍為 null）
- [ ] 設了覆寫的人，token 換發後（≤45 分鐘）各服務年級跟著變
- [ ] 拿一顆沒有 `entryYear` claim 的舊 token，form / appeals 仍算得出年級（fallback 生效）
- [ ] moderator 改得動屆別，一般使用者打 server action 被擋
- [ ] `/admin/audit` 看得到 `entryYear.set` 紀錄
- [ ] 三個 repo 各自 `pnpm lint` + `pnpm exec tsc --noEmit` 通過
- [ ] 部署前已產出 `pg_dump` 備份且檔案非空
- [ ] 部署後主機資料量不變：Subject 105 / Grant 11 / AuditLog 15（新增的人不算）
- [ ] 部署後 `_prisma_migrations` 多一筆、且 `rolled_back_at` 為 null
