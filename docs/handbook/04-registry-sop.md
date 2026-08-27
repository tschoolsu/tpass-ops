---
title: T-Pass 服務註冊表 SOP
tags: T-Pass, 手冊
---

# T-Pass 服務註冊表 SOP

> **一句話**：整個生態系「有哪些服務」的唯一真相，是 public repo
> [`tschoolsu/tpass-registry`](https://github.com/tschoolsu/tpass-registry) 的 `services.json`。
> 要改它，**只有一條路：開 PR**。

這份講的是「怎麼改註冊表」。至於怎麼開一個新服務、怎麼串登入，見《T-Pass 服務串接指南》。

---

## 為什麼一個 JSON 檔說了算

| 誰讀它 | 讀來做什麼 | 沒登記的後果 |
| --- | --- | --- |
| `tpass-auth` | 發證白名單 | 登入直接被拒（`service-error` 頁） |
| `tpass-portal` | 大廳卡片（顯示名、圖示、配色、網址） | 卡片不會出現 |
| `deploy.sh` / `ecosystem.config.js` | 部署哪些服務、目錄在哪、跑哪個 port、DB 怎麼套 | 部署腳本找不到你的服務 |

**這裡改一次，三邊自動跟上。** 反過來說：這裡沒改，其他地方改再多也沒用——
所以不要試圖在 portal 或 auth 裡「先寫死一份清單頂著用」，那條路 2026-07-31 已經拆掉了。

---

## 🚫 三條紅線

### 1. 不要在主機上手改 `services.json`

主機上 `~/tpass/tpass-registry` 那份是**唯讀鏡像**，不是工作區。

`deploy.sh` 部署**任何一個服務**的第一步都是：

```bash
git -C ~/tpass/tpass-registry pull --ff-only   # 主機只認 tpass-registry main 的最新版
node ~/tpass/tpass-registry/validate.mjs       # 驗證失敗 → 整個部署中止
```

所以主機上一筆沒 commit 的手改，會造成兩件事：

- **驗證不過 → 所有人、所有服務都部署不了**，而且錯誤訊息指著註冊表，
  跟你正要部署的那個服務看起來毫無關係，下一個人得先花時間查「我明明只改了 appeals」。
- **那筆改動遲早消失**——沒 commit 的東西，下次 `pull --ff-only` 不是衝突就是被輾過去，
  你花的力氣沒有任何人看得到。

> 真實案例（2026-08-25）：有人在主機直接加了一筆新服務、`icon` 寫成 `"class"`（不是 PascalCase），
> 結果一個純粹只改申訴系統的部署被擋在第一步。

**要改就在自己電腦上改，走 PR。**

### 2. 不要把服務清單、網域、port 寫死在別的 repo

卡片網址是由 `subdomain` + 頂層 `domains` + `port` **推導**出來的。寫死的話，
本機門戶會把人送去正式站，本機根本測不了 SSO 互通。

### 3. 這個 repo 是公開的——不得出現任何密鑰

沒有密碼、沒有主機位址、沒有 token。DB 名稱與 role 名可以寫（密碼在主機的 `.env.local`，不進 git），
port 也可以寫（只綁 `127.0.0.1`，對外靠 nginx 反代）。

---

## 唯一流程

**新增服務、改既有欄位、上線翻牌——全都是同一條路。**

```bash
# 1. Fork（第一次才要）
gh repo fork tschoolsu/tpass-registry --clone
cd tpass-registry

# 2. 開分支
git switch -c registry-lost

# 3. 改 services.json

# 4. 本機先驗（不用裝任何依賴，一秒）
node validate.mjs

# 5. 送出
git commit -am "registry: 登記 lost（遺失物）"
git push -u origin registry-lost
gh pr create --fill
```

CI 每個 PR 都會跑一次 `validate.mjs`，所以第 4 步只是讓你不用等 CI 就知道結果。

> 你不需要先被加成 collaborator。這個 repo 刻意公開，任何部員 fork + PR 就能提註冊。

---

## 三個情境劇本

### A. 登記一個還沒上線的新服務

佔住 `id` 與 `port`，但先不要出現在大廳：

```jsonc
{
  "id": "lost",
  "name": "T-Lost 遺失物",
  "dir": "tpass-lost",
  "subdomain": "lost",
  "port": 3007,
  "db": { "name": "t_lost", "user": "t_lost", "strategy": "migrate" },
  "enabled": true,
  "deployed": false,        // ← 佔位階段就是這個 false
  "portal": { "label": "遺失物", "icon": "Search", "tone": "orange", "roles": ["all"] }
}
```

merge 之後**重新部署 auth**，你本機就可以開始測登入了（卡片還不會出現）。

### B. 改既有服務的欄位

改卡片文案、換圖示、換配色、調 port——**跟新增走完全一樣的流程**，沒有「小改動可以直接動主機」這種例外。

```bash
git switch -c registry-tweak-notes
# 改 services.json
node validate.mjs
gh pr create --fill
```

### C. 讓服務真正上線

把 `deployed` 翻成 `true`。**時機很重要**：

`deployed: true` 同時決定 pm2 的程序清單，所以它必須在**主機第一次部署你的服務之前**就翻好，
但翻完之後、你的 repo 還沒 clone 到主機之前，這中間 `deploy.sh all` 會找不到目錄而失敗。

→ **翻牌的 PR merge 後，要接著把 repo clone 到主機、寫好 `.env.local`，一氣呵成做完。**
順序細節見《T-Pass 服務串接指南》〈部署〉。

卡片要出現在大廳，三個條件必須同時成立：`enabled: true` **且** `deployed: true` **且**有 `portal` 區塊。

---

## merge 之後怎麼生效

**merge 本身不會讓任何事情發生。** auth 與 portal 都是在**程序啟動時**把註冊表整份讀進記憶體
（`export const registry = load()`，模組層級只執行一次），之後不再看那個檔案。
所以要讓改動生效，那兩個服務必須**重新啟動**——實務上就是重新部署。

| 你改了什麼 | 要重新部署 |
| --- | --- |
| 發證白名單相關（新服務、`enabled`） | `auth` |
| 大廳卡片相關（`portal` 區塊、`deployed`、`subdomain`） | `portal` |
| 拿不準 | 兩個都部署，不會有壞處 |

**部署你自己來，不必找維運**（2026-08-27 起）：
**[tpass-ops → Actions → deploy → Run workflow](https://github.com/tschoolsu/tpass-ops/actions/workflows/deploy.yml)**，
輸入 `auth`，再按一次輸入 `portal`。只需要 `tpass-ops` 的寫入權，不需要主機憑證。
（有主機帳號的人也可以照舊 `tpass deploy auth`，跑的是同一支腳本。）

在主機上單獨 `git pull` 註冊表**不會**生效——程序還跑著舊的那份記憶體。

---

## validate 擋下來的常見錯誤

| 訊息 | 意思 |
| --- | --- |
| `portal.icon 必須是 PascalCase，收到「class」` | 到 https://lucide.dev/icons 找圖示，用 PascalCase 名（`clipboard-list` → `ClipboardList`） |
| `port 重複` | 有人先佔了。往後找一個沒人用的 |
| `id / dir / subdomain 重複` | 同上。封存服務允許保留歷史值，所以別回收舊 id |
| `deployed:true 但 enabled:false` | 矛盾。要嘛都關，要嘛都開 |
| `db.strategy 不合法` | 只能是 `migrate`（標準）/ `push`（僅限原型）/ `none`（有 DB 但不用 Prisma） |
| `issuer 不得有 portal 區塊` | auth 不是使用者的目的地，不該有卡片 |

圖示還有第二道關卡：portal 為了讓卡片能在伺服器端就渲染出來，維護一份圖示白名單。
**用了白名單以外的名字，portal 一啟動就直接報錯並印出可用清單**——不會靜默換成別的圖示。
若你要的圖示不在清單裡，在 PR 說明裡提一句，維運會順手在 `tpass-portal` 的 `src/config/icons.ts` 加一行。

---

## 欄位速查

```jsonc
{
  "id": "lost",              // 短名。＝pm2 程序名＝TPASS_SERVICE_ID＝JWT 的 aud 後綴。★ 永不改名
  "name": "T-Lost 遺失物",    // 長名（CLI、部署 log 顯示）
  "dir": "tpass-lost",       // repo 目錄名（只寫目錄名，不寫路徑）。主機上＝/home/service/tpass-lost
  "subdomain": "lost",       // 本機＝lost.lvh.me；正式＝lost.tschoolsu.org
  "port": 3007,              // 內部 port，只綁 127.0.0.1
  "db": null,                // 沒有資料庫就 null；有的話 { name, user, strategy }
  "enabled": true,           // false = 本機工具與 auth 白名單全部跳過（封存用）
  "deployed": false,         // 產生 pm2 清單、決定卡片出不出現
  "portal": {                // 選填。沒有這塊 = 不進大廳（例如純後端服務）
    "label": "遺失物",
    "icon": "Search",        // lucide-react PascalCase
    "tone": "orange",        // green | blue | orange | violet | rose
    "roles": ["all"]         // all | student | teacher
  }
}
```

完整欄位說明（含主機路徑約定、卡片網址推導規則）以 repo 的 `README.md` 為準。

---

## 如果主機那份已經被手改了

維運部員的排除步驟：

```bash
git -C ~/tpass/tpass-registry status --short     # 看有沒有 M services.json
git -C ~/tpass/tpass-registry diff               # 看改了什麼

# 有價值 → 先留著，回自己電腦整理成 PR
git -C ~/tpass/tpass-registry stash push -m "手改暫存"
# 沒價值 → 丟掉
git -C ~/tpass/tpass-registry checkout services.json
```

**在主機恢復乾淨之前，所有服務都部署不了。**
