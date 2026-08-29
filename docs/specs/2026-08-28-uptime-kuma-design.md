# B6 — 自架 Uptime Kuma 取代 UptimeRobot（設計）

日期：2026-08-28
狀態：實作中（本機已調好，待轉交部員部署）
影響 repo：`tpass-ops`、Cloudflare、部員的機器、主機（`backup.env` 一行）
上位計畫：`docs/specs/2026-08-26-platform-hardening-plan.md` 的 **B6**
背景與紅線：`docs/ONBOARDING.md` §6「🚧 規劃中：改用自架的 Uptime Kuma」

---

## 0. 給接手 agent 的 30 秒簡報

**先讀 `docs/ONBOARDING.md` §6，那裡有技術判斷與兩條紅線，這裡不重複。**

這份文件記的是 2026-08-28 部長拍板的決定，其中**有一項推翻了 §6 的紅線二**（見 §2）。
以這份為準。

已經查證過、不要重查的事實：

| 事實 | 影響 |
| --- | --- |
| Kuma 最新穩定版 **2.5.3**（2026-08-22） | compose 檔釘死這個版本 |
| **2.x 移除了 JSON 匯出/匯入** | 官方唯一支援的搬遷方式＝整個 `data/` 目錄複製 |
| **2.x 仍然沒有官方寫入 API**，socket.io 是內部協定、上游明講不對第三方支援 | **不要寫自動建 monitor 的腳本**（見 §4） |
| Python `uptime-kuma-api` 停在 2023-09、只支援 1.x | 同上 |
| Kuma 能改樣式的地方**只有 status page 的 Custom CSS** | 管理後台維持原樣，不 fork、不用反向代理注入 |

---

## 1. 架構

```
部員的機器                                T-Pass 主機
┌──────────────────────┐                 ┌──────────────┐
│ docker: uptime-kuma  │──── HTTP 探測 ──▶│ 7 個服務      │
│  :3001               │                 │ backup.sh ───┼─┐
└──────┬───────────────┘                 └──────────────┘ │
       │ cloudflared tunnel                      push ────┘
       ▼
status.tschoolsu.org  ──公開狀態頁（Neobrutalism CSS）
       │ /dashboard /settings … 被 Cloudflare Access 擋（Google 登入）
       │ /metrics 放行（本身有 API key）
       ▲
       └── GitHub Actions 排程看門狗（tpass-ops）：①Kuma 沒回應 ②有服務沒監控 → 發 Discord
       └── tpass status：讀 /metrics 對照 services.json，抓「沒人開監控」的服務
```

🔴 **紅線一維持不變**：Kuma 跑在**部員的機器**，不是 T-Pass 主機。
主機自己死掉時，只有跑在主機外的東西叫得出來。轉交時要**確認過**那是另一台機器，不要假設。

---

## 2. UptimeRobot 的處置（推翻 ONBOARDING §6 紅線二）

§6 寫的是「不要急著關掉 UptimeRobot，至少並行到 Kuma 連續叫對幾次」。
**2026-08-28 部長決定：Kuma 上線後 UptimeRobot 整個關掉，改用 GitHub Actions 看門狗。**

紅線二真正要防的東西不是「UptimeRobot 這個廠商」，而是**監控自己死掉是靜默的**——
Kuma 跑在部員家裡，他斷網、機器重開沒起來、docker 掛掉，沒有任何東西會來告訴你
監控不見了，而沉默跟一切正常長得一模一樣。

看門狗接手這個職責，並且比 UptimeRobot 更好的地方是**帳號在 `tschoolsu` 組織底下，
不隨個人畢業**（UptimeRobot 是靠「開在 `studentcouncil@` 官方信箱」來達成同一件事）。

**代價要知道**：

- GitHub Actions 排程實際延遲常到 10–15 分鐘。對「監控的監控」夠用，對服務本身不夠——
  所以服務的監控是 Kuma 的 60 秒間隔，看門狗只管 Kuma 活著沒。
- **repo 60 天沒有 push 活動，GitHub 會自動停用排程 workflow**。`tpass-ops` 目前有活動，
  但這是一個會靜默失效的機制，要記在 HANDOFF.md 裡。

**切換順序（不可以顛倒）**：Kuma 在部員機器上線 → 看門狗跑起來並確認會叫 →
**才**刪 UptimeRobot 的 monitor。不要在部員按下 `docker compose up` 的同一天關掉。

---

## 3. Monitor 清單

**清單真相是 `tpass-registry/services.json`，不是這份文件。** 下面是 2026-08-28 當下的展開結果，
不要當成寫死的清單抄進任何程式碼——新服務上線時真正的機制是 §4 的抓漏。

`deployed:true` 共 **7 個**：`auth` / `portal` / `form` / `msg` / `appeals` / `notes` / `buddy`

設定：

- 類型 HTTP(s)，URL＝`https://<subdomain>.tschoolsu.org/`
- **Accepted Status Codes `200-399`**——消費端未登入回 **307**，設 200-299 會七個全紅。
  `auth` 回 200。這是 A2 就踩過的坑。
- 檢查間隔 **60 秒**（Kuma 沒有 UptimeRobot 免費版 5 分鐘的硬限制，這是換過來的理由之一）
- monitor 名稱用**註冊表的 `name`**（「T-Form 問卷」）——那個字串會直接顯示在給全校看的
  狀態頁上，id 是維運的講法。§4 的比對靠 URL hostname，不受名稱影響。

額外兩個：

- `tschoolsu.org` 根網域——**先建但設 Paused**。A5（Cloudflare 轉址）還沒做，
  根網域目前沒有 DNS，留著它每天紅只會訓練人忽略告警。A5 做完把它開回來，變綠就是 A5 的驗收。
- **backup heartbeat push monitor**——心跳期限 **25 小時**（cron 是每日 04:15）。
  這是 A2 留下的洞，也是換 Kuma 最主要的理由。**不放上公開 status page**（那是內部訊號）。

不建的：

- `meeting`：線上活著但註冊表 `deployed:false`（A3 的中間態）。等 A3 收掉再說，
  現在建它等於在 Kuma 裡承認一個註冊表不承認的服務。
- **PostgreSQL monitor**：Kuma 支援，但那需要主機對外開放資料庫連線。不做。

---

## 4. 抓漏：註冊表 ↔ Kuma 對照

部長問過「能不能讓 Kuma 主動讀我們的模組清單、動態更新 monitor」。
**做不到，而且不該做**：唯一路徑是刻 Kuma 的 socket.io 內部協定，等於押注一個上游
明講會 breaking 的東西，每次 Kuma 升級都要重驗，而且那支腳本還得跟著 Kuma 跑在部員機器上。

改成做**反向**的事，這才是註冊表鐵律真正要的：
**真相永遠在 `services.json`，Kuma 不是第二份真相，只是被檢查有沒有跟上。**

`scripts/lib/monitor.mjs` 現在對 UptimeRobot 做的就是這件事（拿 monitor 清單對照註冊表，
抓出「`deployed:true` 卻沒有人開監控」的服務）。**比對邏輯照抄，只換資料來源**：

- 來源：Kuma 的 `/metrics`（Prometheus 格式，`monitor_url` label 可比對 hostname）
- 認證：Kuma 的 API key，放 `deploy/host.env` 的 `KUMA_API_KEY`
  （跟現在 `UPTIMEROBOT_API_KEY` 同一個位置，gitignored），另加 `KUMA_BASE_URL`
- 沒設 key 時照現在的行為 `{ skipped: true }`——`status()` 的主職責是 pm2，不能被監控 API 拖垮
- Prometheus 的 status 值語意與 UptimeRobot v2 不同，`STATUS` 對應表要重寫。
  **實作時先打一次看真實回應再寫，不要憑印象**（`monitor.mjs` 檔頭那句話的精神）

新服務上線流程因此變成：registry PR 合併 → `tpass status` 開始喊「vote 沒有 monitor」→ 有人去補。
漏不掉，也不用押注私有協定。

**2026-08-29 追加：看門狗也做同一個比對。**

`tpass status` 的抓漏要有人主動去跑。所以 `kuma-watchdog.yml` 加了第二個檢查：
拿 `services.json` 的 `deployed:true` 對照**狀態頁的公開 API**，缺了就發 Discord
並開 `monitor-missing` 的 issue（跟 `kuma-down` 分開，兩個問題的處置不同）。

為什麼這條做得成而「自動建 monitor」做不成：**它只讀不寫**。
狀態頁 API 免驗證、`tpass-registry` 是 public repo，所以它**不需要任何 secret，
也拿不到 Kuma 的管理權**——不必把一台私人機器的管理憑證放進 public repo 的 Secrets，
也不必開一條從 CI 寫入他家機器的路。

代價與已知限制：
- 它是**用名稱比對**的（狀態頁公開 API 不吐 URL），所以 monitor 名稱必須等於註冊表的
  `name`。改名字會誤報「沒有監控」——誤報的內容是「去看一下」，成本低；
  漏報的內容是「沒人知道服務掛了」，成本高。這個方向選對邊。
- Kuma 自己掛掉時這項**整個跳過**（`checked=false`），不然會在一個真警報上疊七個假的。
- 它比的是**狀態頁上有沒有**，不是「Kuma 裡有沒有」。monitor 建了卻沒放上公開頁一樣會叫
  ——那也是問題（全校看不到），所以是對的。

**這不會省掉那道指令，它消滅的是「要有人記得」。** 想真正自動化建 monitor 的評估
（爆改 Kuma / GitHub Action 寫入同步）見 §4.1。

**實作後補上的兩個事實（2026-08-29 實測）**：

- `/metrics` **只輸出已經產生過心跳的 monitor**。暫停中的、以及從未被 ping 過的 push
  monitor 都不在裡面。所以「暫停一個 monitor」跟「根本沒開 monitor」在 `tpass status`
  看起來一樣——那是對的，暫停的監控本來就等於沒有監控。但也代表 `backup-heartbeat`
  在收到第一次備份 ping 之前不會出現在那份清單上。
- Kuma 只有在設定 **`apiKeysEnabled`** 為真時才用 API key 驗 `/metrics`，否則退回
  管理帳密的 basic auth（回 401，log 寫 `BASIC-AUTH`）。在後台建過一把 key 會自動打開它。

### 4.1 兩條被評估後否決的自動化（2026-08-29）

部長問過「爆改 Kuma 讓它直接讀註冊表」與「用 GitHub Action 自動更新 Kuma」。
兩條都否決了，理由記在這裡，不要再走一次：

**先看規模**：`deployed:true` 在 2026-07-31 → 08-28 只翻過兩次（+buddy、+notes）。
要自動化掉的大約是一個月一道指令。

**爆改 Kuma（fork）**：Kuma 光是 2026 年 8 月就出了 4 個版本（2.5.0～2.5.3），
每次上游更新都要重新 merge、rebuild、重測。更關鍵的是**它毀掉 B6 的目的**——
交出去的東西如果是 `docker compose up`，部員接得住；如果是「維護一份 fork」，
等於把單點依賴從部長搬到部員身上，還加了一層。

**GitHub Action 自動寫入 Kuma**：
① 它得穿過 Cloudflare Access 打到部員家裡那台機器 → 要 Access service token ＋
Kuma 管理密碼進 GitHub Secrets，而 `tpass-ops` 是 **public repo**。
為了一個月一次的方便，把一台私人機器的管理憑證放進組織 secrets、並開一條從 CI
寫入他家機器的路，不划算。
② 它走 socket.io 那條未公開協定。Kuma 升級把它弄壞時，失敗的後果是
**「新服務靜靜地沒有監控」——正是整個 B6 要防的事**。會靜默倒向「沒有監控」的自動化，
比一個人可能忘記的手動步驟更糟，因為手動忘記至少有東西抓得到。

**還有一點讓前提本身鬆動**：Kuma 只有一組管理帳號，部長與部員共用。上線後部長
用自己的 Google 帳號穿過 Cloudflare Access 就能進後台加 monitor——
**管機器的人不是這件事的關卡**，他只負責那台機器活著。

---

## 5. 樣式（status page custom CSS）

只做 **status page**。管理後台沒有 custom CSS 欄位，要改就得 fork Vue 原始碼或用
反向代理 `sub_filter` 注入，升級一次就壞——不做。

CSS 照 `tpass-portal/docs/design.md`：白底、OKLCH（禁 hex/rgb）、`border-2 border-foreground`
＋ hard offset shadow（禁 soft shadow）、Plus Jakarta Sans（標題/內文）＋ Geist Mono（標籤）、
**強制 light-only**（覆蓋 Kuma 的 dark 主題變數）。

CSS 存成 `monitoring/status-page.css` 進 git（純文字、無機密），
轉交後部員要改樣式時貼這份，不用去 `data/` 裡挖。

### 這一節的實作結論（2026-08-29 實測）

- **這個頁面對外叫 `T-Status`**（部長 2026-08-29 命名），不是 T-Pass。
  導覽列與瀏覽器標題都用這個名字。
- **心跳條是 canvas 畫的，但顏色可以換**：JS 從 `document.documentElement` 讀
  `--bs-primary`（up）/ `--bs-danger`（down）/ `--bs-warning`（pending）/
  `--maintenance`。那四個變數**必須定在 `:root`**，搬到別的選擇器底下就失效。
- **Google Fonts 的 `@import` 可用**：Kuma 把 custom CSS 注入成**獨立的一個
  `<style>` 元素**（`StatusPage.vue:598`），所以 `@import` 位在該 stylesheet 最前面，合法。
- **導覽列做得出來**：Kuma 沒有自訂 HTML 欄位，但 status page 的 `description` 走
  `marked()` + `DOMPurify.sanitize()`（`StatusPage.vue:845`），`<div>` / `<a>` / `<svg>` /
  `class` 都留得住（實測 lucide 圖示的四個 `<rect>` 完整渲染）。markup 放在
  `monitoring/seed.mjs` 的 `NAV_HTML`，樣式在 `status-page.css` 的 `.tp-nav` 段，
  版型照抄 `tpass-form` 的 `Header.tsx` + `PortalLink.tsx`（左邊「首頁」按鈕、右接服務名）。
- **根路徑不需要 Cloudflare redirect rule**：Kuma 原生的 Entry Page 設定
  （`setSettings` 的 `entryPage: "statusPage-<slug>"`）就能把 `/` 導到狀態頁，
  而且跟著 `data/` 一起轉交。
- **服務名稱用註冊表的 `name`**（「T-Form 問卷」）而不是 id（「form」)——這個字串會
  直接顯示給全校看。`tpass status` 的對照是用 URL hostname，不受影響。

---

## 6. 公開到 status.tschoolsu.org

部員機器跑 `cloudflared`，Cloudflare Tunnel → `http://localhost:3001`。

**坑**：Kuma 的管理後台跟 status page 是**同一個 port**，開 tunnel 等於把登入頁一起丟到公網。

對策——Cloudflare Access policy：

- 放行（不需登入）：status page 路徑與它的靜態資源、`/api/status-page/*`
- 放行：`/metrics`（本身有 API key 保護，`tpass status` 要打它）
- 擋住（要 Google 帳號）：`/dashboard*`、`/settings*`、`/add`、`/edit*`、`/manage-status-page*`

順便解決「部員機器上的 Kuma 後台怎麼給部長看」——部長用自己的 Google 帳號進 Access 就進得去。

**這是把校方網域指向一台個人機器。** 他畢業、退部、機器停掉，`status.tschoolsu.org` 就變成
一個 5xx 的對外頁面。這是 §8 交接條件必須講定的理由，不是可以之後再說的事。

---

## 7. 轉交方式：搬 `data/` 目錄

Kuma 2.x 官方唯一支援的方式。設定 100% 一致、零重建成本。

```
monitoring/
  docker-compose.yml     # 進 git，pin louislam/uptime-kuma:2.5.3
  status-page.css        # 進 git
  HANDOFF.md             # 進 git
  data/                  # gitignored ← 私下傳的那包
```

**紀律**：

- `data/` 裡有 **Discord webhook 明文**與 **admin 密碼 hash**。🚫 **絕不進 git**
  （`tpass-ops` 是 public repo）。用密碼管理器或私訊傳。
- **版本要釘死**：部員的 Kuma 不能比部長本機的舊，SQLite schema 不能降級。
  compose 檔寫 `2.5.3`，不要用 `:1`、`:2` 或 `:latest`。
- Kuma 管理帳號只有一組（2.x 是否支援多使用者實作時確認）→ 部長與部員共用，密碼一起傳。

### 本機調的階段：notification 建好但不要勾

Notification（Discord，送主機 `backup.env` 那條同一個維運頻道）在本機建好，
**但不要勾到任何 monitor 上**——部長電腦一關，七個 monitor 全紅會洗爆頻道。
等部員機器上線後才勾。

**因此 B6 的兩項驗收必然發生在轉交之後**，這次做不完，列進 HANDOFF.md：

- 故意停掉一個非關鍵服務的 pm2 程序，三分鐘內收到 Discord 告警，恢復後收到恢復通知
- `backup.sh` 的一次成功執行有 ping 到 push monitor；把 cron 停一天（或改短 push monitor
  的期限）確認「備份沒跑」會叫
- 主機 `~/tpass/deploy/backup.env` 的 `BACKUP_HEARTBEAT_URL` 填 Kuma 的 push URL。
  **`backup.sh` 一行都不用改。**

---

## 8. 交接條件（C5，不能省）

B6 明講**這一項不能單獨算完成**：那台機器屬於一個部員。他畢業、退部或機器停掉，
監控就整個消失，而且 `status.tschoolsu.org` 會變成對全校壞掉的頁面。

HANDOFF.md 最後一段要寫死、並在轉交當下講定：

- 那台機器是誰的
- 電費 / 網路 / 網域誰付
- 他離開時交給誰

---

## 9. 交付物

`tpass-ops`：

- `monitoring/docker-compose.yml`
- `monitoring/status-page.css`
- `monitoring/seed.mjs`（一次性種子：從註冊表建 monitor + 狀態頁；`--dry-run` 印清單）
- `monitoring/HANDOFF.md`
- `monitoring/data/` 加進 `.gitignore`
- `.github/workflows/kuma-watchdog.yml`
- `scripts/lib/monitor.mjs` 改寫（UptimeRobot v2 → Kuma `/metrics`）
- `deploy/host.env.example` 加 `KUMA_BASE_URL` / `KUMA_API_KEY`，移除 `UPTIMEROBOT_API_KEY`
- `docs/ONBOARDING.md` §6 改寫：把「🚧 規劃中」換成現況，記下紅線二的變更與理由

本機產出（不進 git）：調好的 `monitoring/data/`，打包私下傳給部員。

## 10. 這次做不完的（列進 HANDOFF.md 與 plan 的 B6）

- 部員實際部署、Cloudflare Tunnel 與 Access、`status.tschoolsu.org` DNS
- 兩項告警驗收（§7）
- 主機 `backup.env` 填 `BACKUP_HEARTBEAT_URL`
- 刪 UptimeRobot 的 monitor（要在看門狗確認會叫之後）
