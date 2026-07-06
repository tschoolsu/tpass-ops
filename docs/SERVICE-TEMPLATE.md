# 新服務標準（登記 + 文檔骨架）

> 用 `scripts/tpass new <id>` 登記新服務——它會寫 `services.json`、重生本機憑證、
> 印出所有自動化不了的人工步驟。本檔定義「一個合格的 tpass 服務長什麼樣」。

---

## 1. services.json 欄位定義（唯一真相）

```jsonc
{
  "id": "form",              // 短名。＝pm2 app 名＝tpass CLI 參數＝TPASS_SERVICE_ID＝aud 後綴。永不改名。
  "name": "T-Form 問卷",      // 顯示名稱（tpass ui / list 用）
  "dir": "tpass-form",       // repo 目錄名（本機與主機一致）
  "subdomain": "form",       // dev = form.lvh.me；prod = form.tschoolsu.org
  "port": 3002,              // 內部 port。registry 驗證唯一性，撞車直接 fail
  "db": {                    // 沒有資料庫填 null
    "name": "t_form",        // 資料庫名（慣例 t_<id>）
    "user": "t_form",        // 專屬 role（慣例 t_<id>）
    "strategy": "migrate"    // migrate = 有 migrations 歷史（標準）；push 僅限原型
  },
  "enabled": true,           // false = 本機工具全部跳過（封存用）
  "deployed": false          // true = 進 ecosystem/deploy all。首次上線成功後才翻 true
}
```

## 2. 服務 repo 必備骨架

```
tpass-<id>/
├── README.md            ← 一頁：是什麼、dev/prod URL、DB 有無+strategy、怎麼跑（見 §3）
├── AGENTS.md            ← Next 16 警告 block + 指回上層 tpass-ops 的指標段 + 本 repo 鐵律
├── .env.example         ← 全部 env key + 註解（本機預設值）；真值在 .env.local（不進 git）
├── src/config/*.ts      ← REQUIRED 陣列（env 必填清單的唯一真相；deploy.sh 靠它擋部署）
├── src/lib/tpass-auth.ts ← 照抄 tpass-portal 參考實作（安全四鐵則）
├── src/app/api/auth/{callback,logout}/route.ts ← 照抄 portal（契約 v2 兩個 route）
└── prisma/migrations/   ← 有 DB 就要有（strategy=migrate）
```

## 3. README.md 標準內容（一頁）

1. 一句話說明 + 服務 id。
2. 表格：本機/正式網址、DB、SSO 角色。
3. 開發指令：`tpass dev <id>` / `tpass check <id>` / `tpass db setup <id>`，
   註明**禁止裸 `npm run dev`**、env 真相在 `src/config/*.ts` REQUIRED。
4. 結構速記（主要目錄/檔案 5–8 行）。

## 4. 跨服務鐵律（違反就是 bug）

- SSO：四鐵則驗章（EdDSA 鎖定 / issuer / `aud=tpass:<id>` / exp）；只碰公鑰；
  token 只放 host-only HttpOnly cookie；權限用服務內 allowlist，不信 JWT `role`。
- UI：light-only Neobrutalism + OKLCH，照 `tpass-portal/docs/design.md`。
- env：網域 / issuer / audience / DB 一律 env 驅動，不寫死；新必填 key 進 REQUIRED。
- 每個 server action / route handler 內部重呼 guard，不能只靠 layout。
- 對外 webhook / callback URL 要 pin 官方網域（參考 msg / appeals 的作法）。
- 命名：super-admin 種子一律叫 `SUPER_ADMIN_EMAILS`（歷史教訓：directory 用了
  `DIRECTORY_SUPER_ADMIN_EMAILS`，工具鏈對不上）。

## 5. 上線清單（tpass new 也會印）

1. auth `.env.local` 的 `AUTH_SERVICE_IDS` 加 id → 重啟 auth。
2. `tpass-portal/src/config/services.ts` 加發射台卡片。
3. Cloudflare DNS（灰雲）→ [root] nginx vhost + certbot → 切橘雲（`docs/DEPLOY.md §5`）。
4. [root] 主機建 `t_<id>` role + db（有 DB 者）。
5. 主機 clone repo 到 `~/tpass/<dir>`、填 `.env.local`。
6. `services.json` 翻 `deployed: true` → merge → `tpass deploy <id>` → 主機 `pm2 save`。
