# 平台體檢後的加固計畫 — 執行手冊

日期：2026-08-26
狀態：待執行
影響 repo：`tpass-ops`、`tpass-registry`、`tpass-appeals`、`tpass-form`、`tpass-cross_grade_messages`、`tpass-portal`、Cloudflare、主機
完整診斷報告：https://claude.ai/code/artifact/d3657b79-7a06-49e9-b92d-d86a87dde055

---

## 0. 給接手 agent 的 30 秒簡報

**不要重新調查。** 這份檔案是一次完整體檢的結論，事實都已驗證過，直接照做。

一句話背景：T-Pass 的**架構是健康的**（per-service token 符合 RFC 9700、金鑰輪替完整、
撤銷延遲有界定並記錄在 `docs/SECURITY-REVIEW.md`）。壞掉的是**交付與延續**——
9 個 repo 的所有 commit 都出自同一個人，沒有 CI、沒有備份、沒有告警，
而開一個新服務的 5 個步驟有 4 步卡在部長身上。

**所以：不要動架構。** 這份計畫裡沒有一項是重寫 SSO、換 Auth0、導入 K8s 或改設計系統。
如果你在執行中產生「順便重構一下」的念頭，那是錯的方向。

**執行方式**：一次做一個任務，做完驗收，再做下一個。**每個任務都可以獨立開一個新對話**，
只要把這份檔案給它看。任務之間沒有依賴，除非下面明講。

---

## 1. 執行前必讀的環境限制

這些限制是硬的，違反會白做工：

| 限制 | 意思 |
| --- | --- |
| **agent 拿不到 root** | 主機上任何 `sudo` 指令都不能代跑。要 root 的步驟一律**印出來交給部長本人在主機貼一次**。 |
| **主機位址是機密** | 在 gitignored 的 `deploy/host.env`。**絕對不要**寫進任何被追蹤的檔案、commit 或 PR。連線一律走 `scripts/ssh.sh`。 |
| **`tpass-registry` 是 public repo** | 任何密鑰、密碼、主機位址都不得出現在那裡。 |
| **頂層 git 不碰子 repo** | 不要 `git add` 各服務目錄、`tpass-registry/`、`deploy/host.env`、`certs/`。 |
| **套件管理一律 pnpm** | 不要產生 `package-lock.json`。 |
| **不要跑不會結束的指令** | dev server 一律 `run_in_background: true`，用完關掉。 |
| **檢查指令** | `pnpm lint` + `pnpm exec tsc --noEmit`（＝`scripts/tpass check`）。 |

---

## 2. 任務清單

排序原則：**先做「弄丟了就永遠回不來」的，再做「降低單點依賴」的，最後做「減少摩擦」的。**
不要跳過 A 直接做 B——A 層一旦出事沒有第二次機會。

---

### A 層：這個週末（資料與可見性）

---

#### A1 — 資料庫排程備份，並實際還原驗證

**為什麼**：全部 repo 搜不到任何排程 `pg_dump`。而 `deploy/deploy.sh:188` 會直接對正式資料庫跑
`prisma migrate deploy`——migration 砍掉欄位，資料就永久沒了。主機上有全校的申訴內容、
問卷回覆、傳訊紀錄。**這是整份計畫投報率最高的一項。**

**現況**：`docs/ONBOARDING.md:233` 的 rollback 是「git revert + 重新部署」——那救程式碼，不救資料。

**要做的**：

1. 在主機寫一支備份腳本，對 `tpass-registry/services.json` 裡 `db != null` 的每個資料庫跑
   `pg_dump`（目前是 `t_auth` / `t_form` / `t_msg` / `t_appeals`）。
   **資料庫清單要從註冊表派生，不要硬編碼**（這是專案鐵律）。
2. 額外備份 `tpass-buddy` 主機上的 `data/pairs.json`——那是 gitignored 的，沒有任何備份路徑。
3. 上傳到**主機以外**的地方（Cloudflare R2 免費額度足夠）。存在同一台機器上不算備份。
4. 用 cron 排程（每日）。保留策略：日備留 7 份、週備留 4 份。
5. **必做**：實際下載一份備份，還原到本機一個新資料庫，確認資料完整。
   沒還原過的備份等於沒有備份。

**驗收**：R2 上有昨天的備份檔；本機成功從那份檔案還原出一個可查詢的資料庫。

**卡住時**：建 R2 bucket 與 API token 需要部長的 Cloudflare 帳號，做不了就印出步驟給他。

---

#### A2 — 接免費的線上監控與告警

**為什麼**：現在的「監控」是部長本人手動跑 `tpass status` 看 pm2
（`docs/ONBOARDING.md:363-386`）。`deploy.sh:60-73` 的健康檢查只在部署當下跑一次。
**主機半夜掛掉，要等有學生在群組抱怨才會知道。** 而且 auth 掛掉＝六個服務同時全掛。

**要做的**：

1. UptimeRobot 免費方案（50 個監控點），對每個 `deployed:true` 的服務加一個 HTTP 監控。
   注意：消費端服務未登入會回 **307**，不是 200——監控條件要設成「HTTP < 500」而非「= 200」。
   `auth.tschoolsu.org` 回 200。
2. 告警管道接部長的手機（Email + 推播）。
3. **備份的 heartbeat 監控（A1 留下的洞，這項必做）**：UptimeRobot 免費方案有
   heartbeat 監控。`deploy/backup.sh` 成功時去 ping 它，超過 25 小時沒收到就告警。
   為什麼需要：A1 的 Discord webhook 只在「腳本跑了但失敗」時響；**cron 根本沒觸發**
   （crontab 被清、cron 服務死了、主機重開後沒起來）時腳本從未執行，也就沒有東西發告警，
   而沉默看起來跟成功一模一樣。現在唯一的訊號是 `tpass status` 的時間戳停住不動——
   那要人主動去看。死人開關等的是「好消息沒來」，不是壞消息。
4. 選配：Sentry 免費方案（每月 5,000 事件）接進各服務，收線上例外。

**A1 已經留下可以直接用的東西，不要重做**：
- 主機已有一個維運告警用的 **Discord webhook**，存在 `~/tpass/deploy/backup.env` 的
  `BACKUP_DISCORD_WEBHOOK`（gitignored）。UptimeRobot 支援 webhook 通知，可以送到同一個頻道。
- `tpass status` 已經會讀 `~/.tpass-backup-status` 並顯示「最後備份 X 小時前」
  （`scripts/lib/deploy.mjs` 的 `status()` 尾巴）。**同一個位置適合再掛上監控摘要**。
- 主機已裝 rclone、有 cron（`crontab -l` 有一條備份排程），要加排程檢查不必再處理環境。

**驗收**：故意停掉一個非關鍵服務的 pm2 程序，三分鐘內收到告警，恢復後收到恢復通知。
另外把主機的備份 crontab 暫時停掉一天（或直接改 heartbeat 的期限），確認「備份沒跑」也會叫。

---

#### A3 — 決定 `notes` 的去留

**為什麼**：`notes.tschoolsu.org` 實測回 307 導向登入——nginx 有代理、app 活著、auth 在發證。
但 `tpass-registry/services.json` 寫著 `deployed: false`，所以大廳看不到它。

原因是兩邊的過濾條件不同：
- auth 發證白名單只看 `enabled`（`tpass-auth/src/lib/registry.ts:57`）
- portal 大廳看 `enabled && deployed && portal`（`tpass-portal/src/lib/registry.ts:74`）

**結果：這個服務正在線上收全校學生的資料，但全校從大廳看不到它。** 這是最危險的中間態。

**兩個選項，選一個**：

- **停用**：對 `tpass-registry` 開 PR 把 `notes` 的 `enabled` 翻 `false`，重新部署 auth。
  auth 停止發證後那個站就進不去了。
- **修好上線**：主機上那份是 npm 裝的、沒有 `pnpm-lock.yaml`、目錄屬 root，`deploy.sh` 跑不動
  （見 `services.json` 的 note）。要修就是：把目錄所有權轉給部署帳號（**需 root**）、
  補 `pnpm-lock.yaml`、跑一次 `tpass deploy notes`、成功後開 PR 翻 `deployed:true`、
  重新部署 auth 與 portal。

**這是產品決策，不是技術決策——問部長要哪個，不要自己選。**

---

#### A4 — Discord 通知拿掉申訴人實名

**為什麼**：`tpass-appeals/src/lib/discord.ts` 把每筆申訴開成一個 Discord thread，
通知裡有姓名（thread 標題）、年級（embed author，`76726d4` 加的）、email（footer）、
**申訴全文**（embed description）與**圖片原檔**（multipart 直送 Discord CDN）。
後三項從初版 `1b0a94d` 就在了，不是 8/24 那筆 commit 造成的。
**誰在那個頻道，誰就看得到全校學生的申訴全文與實名**——完全在 T-Pass 的權限模型與
`AuditLog` 之外。申訴內容通常含糾紛細節與他人姓名。

**要做的**：

1. Discord 通知只送**案件編號 + 分類 + 時間**，不送申訴人身分、不送內容全文、不送附件。
2. 通知裡放一個連到後台該案件的連結，真正的內容在有稽核紀錄的地方看。
3. 附件不再送進 Discord。

**順帶（同一個 repo，可一起做）**：`tpass-appeals/src/config/admin.ts:13-16` 的
`isAdmin` 是 `role !== "default"`，任何 moderator 都能讀全部申訴，沒有分案隔離。
這一項比較大，**先不要做**，記錄下來即可——A 層只處理「資料流出到管不到的地方」。

**驗收**：送一筆測試申訴，Discord 收到的訊息裡沒有任何可辨識申訴人的資訊。

---

#### A5 — 根網域加轉址

**為什麼**：`tschoolsu.org` 與 `www.tschoolsu.org` **完全沒有 DNS 記錄**
（實測 A/AAAA/CNAME/MX/TXT 全空 / NXDOMAIN）。學生憑印象打進去就是瀏覽器錯誤頁。
整個平台的正門只存在於口耳相傳的 `portal.tschoolsu.org` 這串字。

**要做的**：Cloudflare 加一條 redirect rule：`tschoolsu.org` 與 `www.tschoolsu.org`
→ `https://portal.tschoolsu.org`（301）。

**驗收**：`curl -I https://tschoolsu.org` 回 301 指向 portal。
A2 已經在 UptimeRobot 建好 `https://tschoolsu.org` 的 monitor 並**設為 Paused**
（根網域現在沒有 DNS，留著它每天紅只會訓練人忽略告警）。**A5 做完把它開回來，它變綠就是驗收。**

**卡住時**：需要部長的 Cloudflare 帳號。

---

### B 層：兩週內（把知識從一個人身上搬出去）

---

#### B1 — 部署搬進 GitHub Actions

**為什麼**：部署現在只能從部長的筆電按下去。鑰匙是 gitignored 的 `deploy/host.env`
加上他機器上被授權的 SSH 金鑰（`scripts/lib/deploy.mjs:18-60`）。
服務 repo **沒有任何 GitHub Actions**（唯一例外是 `tpass-registry/.github/workflows/validate.yml`）。

做完之後，**部署從一項需要授權與知識的特權，變成任何有 repo 權限的人按一個按鈕**。
這一件事同時解決單點依賴、可重現性、稽核軌跡。

**成本為零**：這些 repo 幾乎都是 public，GitHub Actions 對 public repo 的標準 runner 免費。

**要做的**：

1. 在 `tpass-ops` 加一個 `workflow_dispatch`（手動觸發）的 workflow，
   輸入是服務 id（或 `all`），內容是 ssh 進主機跑 `./deploy/deploy.sh <svc>`。
2. 主機的 SSH 私鑰、`DEPLOY_HOST`、`DEPLOY_USER` 放 GitHub Secrets。
   **在主機上為 CI 產一把獨立的金鑰**，不要複製部長本人那把——這樣撤銷 CI 權限時
   不會影響他自己的連線。
3. workflow 要印出部署了哪個 commit，讓 Actions 的執行紀錄本身成為稽核軌跡。
4. `scripts/tpass deploy` 保留不動——本機直連仍然是可用的逃生路徑。

**驗收**：從 GitHub 網頁按下 Run workflow，成功部署一個服務，Actions log 裡看得到
健康檢查通過。第二個人（不是部長）也能按。

**注意**：`deploy.sh` 本身不用改，它已經處理好 registry pull、env 檢查、健康檢查、
pm2 cwd 漂移偵測。這個任務只是換一個發動的地方。

---

#### B2 — `tpass check` 接上 PR 檢查

**為什麼**：現在沒有任何東西擋住壞掉的 code 進 main。所有 repo 都**沒有分支保護**。

**要做的**：

1. 每個服務 repo 加一個 workflow，在 pull request 時跑
   `pnpm install --frozen-lockfile` → `pnpm lint` → `pnpm exec tsc --noEmit` → `pnpm build`。
   （前兩行就是 `scripts/tpass check` 做的事，已經寫好了。）
2. 需要註冊表的服務（auth / portal）要在 CI 裡 clone `tpass-registry` 並設
   `TPASS_REGISTRY_PATH`，否則 build 會失敗。
3. 開啟 main 的分支保護，要求這個檢查通過。

**明確不要做**：不要蓋 staging 主機。業界方向早就是每個 PR 一個預覽環境，
共用 staging 是被淘汰的模式（大家往同一個地方推、互相踩）。

**驗收**：開一個故意有型別錯誤的 PR，CI 紅燈且無法 merge。

---

#### B3 — 把工具箱發給部員

**為什麼**：部長因為「怕大家有自己的部署流程」而沒有把 `scripts/tpass` 公布給部員。
方向對（確實不該統一本機開發），但對象錯——業界統一的是**交界面**與**部署管道**，
不是「你怎麼開發」。

而且收起整箱的理由是「不是所有人用 Mac」。**驗證結果：只有本機開發那半是 macOS 綁死的**
（`scripts/lib/db.mjs:25` 直接呼叫 `brew services`、`build.mjs:45` 要 `brew install mkcert`）。
`tpass deploy` 完全不吃 macOS——它做的事只有 `ssh 進主機 && ./deploy/deploy.sh`，
重活全在主機的 Linux 上跑，Windows（WSL / 內建 OpenSSH）與 Linux 都能用。

**要做的**：

1. 在 `docs/ONBOARDING.md` 頂端加一個「哪些指令跨平台、哪些只支援 macOS」的表。
2. 明講：`deploy` / `status` / `logs` / `env` / `check` 跨平台；
   `setup` / `db setup` 目前只支援 macOS，歡迎 PR。
3. 把 `tpass-ops` repo 的存取權開給部員（它已經是 public，主要是告訴他們它存在）。
4. **不要**把 `deploy/host.env` 或憑證交出去——B1 做完之後，他們該用的是 GitHub Actions 那顆按鈕。

**驗收**：一位部員在自己的機器上成功跑起 `tpass status`。

---

#### B4 — 三個服務補錯誤頁

**為什麼**：`tpass-form`、`tpass-appeals`、`tpass-cross_grade_messages` 底下**都沒有**
`error.tsx` / `not-found.tsx` / `global-error.tsx`。資料庫連不上、server action 炸掉、
打錯網址時，學生看到的是 **Next.js 預設的英文白畫面**——沒有中文、沒有品牌、
沒有回大廳的出口、沒有回報管道。

**要做的**：

1. 三個服務各補 `error.tsx` 與 `not-found.tsx`。抄 `tpass-auth/src/components/ErrorPage.tsx`
   的寫法（auth 的錯誤文案品質已經很好，例如「此帳號不在授權範圍，請改用學校帳號登入」）。
2. 一併改 `tpass-auth/src/app/service-error/page.tsx:14-36`——它現在顯示
   「串接者：把服務登記進 tpass-registry 的 services.json（開 PR）…」，
   **那是給工程師的指示，卻直接秀給撞到的學生看**。改成給學生的話，工程師的指示移到 log。
3. 錯誤頁要有：回大廳的連結、B5 的回報管道連結。

**驗收**：暫時把某個服務的 `DATABASE_URL` 改壞，確認看到的是中文錯誤頁不是英文白畫面。

---

#### B5 — 加一個回報管道

**為什麼**：使用者端**沒有任何「回報問題」入口**。portal 頁尾只有版權宣告。
`tpass-cross_grade_messages/src/content/terms.md:77` 寫「請透過門戶公告聯絡」——
**公告這個功能不存在**（註冊表裡沒有公告服務）。學生撞到 bug 的唯一辦法是
在走廊上抓到數位部的人。

**要做的**：

1. 決定管道（一份 T-Form 問卷最省事，或學生會 LINE）。
2. portal 頁尾加連結。
3. 各服務錯誤頁帶上它（跟 B4 一起做）。
4. 修 `terms.md` 那句指向不存在功能的話。

**驗收**：從大廳頁尾點得到回報入口。

---

#### B6 — Uptime Kuma 調好後轉交部員自架

> 接手 A2 留下的洞。**技術判斷、兩條紅線、交接風險、工程成本全都已經寫在
> `docs/ONBOARDING.md` §6 的「🚧 規劃中：改用自架的 Uptime Kuma」**——動手前讀那一節，
> 這裡只記待辦與分工，不重複內容。

**為什麼在 B 層而不是 A 層**：監控已經有了（A2 的 UptimeRobot），這不是從零到一。
它補的是 A2 的①（**死人開關**——免費版 UptimeRobot 沒有 heartbeat，Kuma 內建 push monitor，
`backup.sh` 一行都不用改，`BACKUP_HEARTBEAT_URL` 填 Kuma 的 push URL 即可）。
而且它的本質是**把一塊基礎設施交到第二個人手上**，正好是 B 層的主題。

**分工（部長 2026-08-27 指定）**：
1. **部長先把 Kuma 調到滿意**——monitor 清單、告警管道、push monitor、面板長相。
2. **再轉交部員，由他部署到自己的機器**上監控 T-Pass。

**先確認再開始調，否則會做兩次**：Kuma 的設定存在它自己的資料目錄（SQLite），
**本機調好的東西不會自己跟著走**。要嘛搬整個資料目錄，要嘛把 monitor 清單寫成一份文件
請部員照著重建。先決定是哪一種，再決定「調到滿意」要調到多細。

**驗收**：
- Kuma 跑在**部員的機器**上（不是 T-Pass 主機——ONBOARDING §6 紅線一），
  七個服務的 monitor 都綠；
- `backup.sh` 的一次成功執行有 ping 到 Kuma 的 push monitor；
  把 cron 停一天（或改短 push monitor 的期限）確認「備份沒跑」會叫；
- **UptimeRobot 仍然開著並行**（紅線二：監控自己死掉是靜默的），
  `scripts/lib/monitor.mjs` 打的還是 UptimeRobot v2 API，這階段先不要動它。

**這一項不能單獨算完成**：那台機器屬於一個部員。他畢業、退部或機器停掉，監控就整個消失。
交接條件（機器是誰的、帳單誰付、他離開時交給誰）要在轉交當下講定，這題 C5 躲不掉。

---

### C 層：這學期（讓第二個人真的進得來）

C 層每一項都比 A/B 大，**做之前先跟部長確認優先順序**，不要一口氣全做。

---

#### C1 — 驗章抽成一個共用套件

**為什麼**：`src/lib/tpass-auth.ts` 在六個服務各有一份手抄副本，行數已經在漂移
（78 / 81 / 85 / 85 / 86 / 91），而且**沒有任何共用套件**。

**重要**：我逐一檢查過六份，驗章四鐵則（`algorithms` / `issuer` / `audience` / `exp`）
**目前全部都在，沒有一份漏掉**。漂移發生在註解與型別定義，不在安全路徑上。
所以這**不是**在救火，是在防止下一次漂移。

為什麼非做不可：如果某個服務漏了 audience 檢查，**不會有任何測試失敗，登入照樣成功**，
只有在別人拿其他服務的通行證來打的時候才會發現。這種安靜的錯誤不能靠人類抄寫來防守。

**要做的**：

1. 把 `tpass-portal/src/lib/tpass-auth.ts`（參考實作）抽成一個獨立套件。
2. **不需要私有 registry**——repo 都是 public，直接
   `pnpm add github:tschoolsu/tpass-auth-js#v1.0.0` 即可。
3. 一個服務一個服務換過去，每換一個跑一次完整登入流程驗證。
4. 換完之後，`docs/handbook/01-new-service.md`（33,747 字）裡「驗章核心」「接收 token」
   「登出」那三大節可以砍掉大半，改成一行 import 加設定說明。
   **這是這個任務真正的價值**：把 300 行手抄變成一行 import，等於把手冊砍掉一大塊。

**同一招適用於 design system**：`tpass-portal/docs/design.md` 只有文件沒有元件庫。
把 Neobrutalism 的 Button / Card / Badge 做成套件，比八份設計文件的人肉遵從度高一個數量級。
**但這是獨立任務，不要跟 C1 綁在一起做。**

---

#### C2 — 寫一份「凌晨兩點版」runbook

**為什麼**：`docs/ONBOARDING.md` 是「怎麼開發與部署」，不是「網站掛了怎麼辦」。
Google SRE 的實測數字是：事先寫好的操作手冊相較臨場硬幹，**縮短約三倍的故障恢復時間**，
而且對「資淺、需要快速上手複雜系統的人」效果最大。

**要做的**：一份**很短、很醜、很具體**的文件（`docs/RUNBOOK.md`），只回答這些：

- 網站打不開 → 先分辨是 Cloudflare 還是主機 → `tpass status` → `tpass logs <svc>`
- 某個服務 502 → 重啟指令是什麼
- 登入全站壞掉 → 先看 auth 還是 JWKS，怎麼確認
- 資料庫要還原 → 一步步的指令（依賴 A1 完成）
- 主機進不去 / 憑證過期 / 網域到期 → 誰有帳號、去哪找
- 主機重開機後服務沒起來 → `pm2 resurrect`

**寫作要求**：這份文件的讀者是**慌張的人**，不是 AI。
每一節開頭直接給指令，解釋放後面。不要超過兩頁。
`ONBOARDING.md:388-407` 的疑難排解表已經有很多素材，搬過來重新排序即可。

---

#### C3 — 把上線閘門變成一張檢查表

**為什麼**：`deployed: false → true` 這個閘門已經存在（見 `docs/handbook/04-registry-sop.md`），
但它**只檢查註冊表欄位，不檢查服務健康**。業界把這叫「上線就緒審查」。

**要做的**：在 `04-registry-sop.md` 加一張翻 `deployed:true` 前的檢查表：

- [ ] 有健康檢查端點嗎？
- [ ] 錯誤有上報嗎（Sentry）？
- [ ] 監控加上去了嗎（A2）？
- [ ] 備份含這個資料庫嗎（A1）？
- [ ] 有 `error.tsx` 與 `not-found.tsx` 嗎？
- [ ] **通知 / webhook 送到哪？那個頻道有誰看得到？**（A4：appeals 曾把申訴實名與全文
      貼進全體學生會頻道。這一題沒有程式碼守得住，只能靠上線時問一次。）
- [ ] **有第二個人知道它怎麼運作嗎？**
- [ ] 資料保留多久、由誰決定刪除？

零技術成本。

---

#### C4 — 強迫知識流動

**為什麼**：9 個 repo 的所有 commit 出自同一人。有研究分析 133 個熱門 GitHub 專案，
46% 只要 1 個人離開就會停擺。這個專案是 1——而且**部長本人不靠 AI 也部署不出來**，
代表交接的時候他交不出「怎麼用」。

**降低這個風險的方法不是寫更多文件（文件已經 12.9 萬字了），是讓知識被迫移動。**

**要做的**（這是制度，不是程式）：

1. B1 完成後，**規定每次部署由不同的人按**。
2. 每個服務至少要有兩個人有 commit 紀錄。
3. handbook 的每一頁，至少被一個「沒寫它的人」照著做過一次並回報卡在哪。
   **最後這一條會立刻告訴你 12.9 萬字裡哪些是廢話。**

---

#### C5 — 交接要有重疊期

新部長不該在畢業前一週才拿到主機密碼。至少一學期的重疊：
新任在舊任還在的時候，**實際跑過一次部署、一次事故、一次新服務上線**。
不是「跟著看一陣子」，是自己動手、舊任在旁邊。

---

#### C6 — 數位部專用的 agent skill

> ⚠️ **這一項不是體檢發現的**，是部長 2026-08-27 提出的方向，補記於此免得只散在對話記憶裡。
> 還沒開始，只是方向。

**為什麼**：數位部**全員都用 AI coding**。所以約束的正確載體不是文件而是工具——
文件要人（或模型）自己想起來讀，skill 是每次對話自動生效。
這跟「12.9 萬字文件的實際讀者是模型不是人」是同一個問題的正面解：
既然讀者是模型，就不要再寫更多字給人，改成餵給模型的 skill。

**候選內容**：
- Neobrutalism + OKLCH 的 light-only design system（來源 `tpass-portal/docs/design.md`）
- SSO 驗章四鐵則（`algorithms` / `issuer` / `audience` / `exp`）
- 註冊表是唯一真相：服務清單／網域／issuer 一律不得硬編碼
- pnpm-only

**挑選標準**：只收「**模型推不出來、而且錯了很貴**」的規則。
已經被工具擋住的**不要再寫進去**——`pnpm lint` + `pnpm exec tsc --noEmit` 這類慣例，
**B2 做完後 CI 已經在擋**（2026-08-27），寫進 skill 只是重複；被 hook 強制的同理。

**跟 C1 的關係**：同一類手段（把「靠人肉遵從度」換成「工具強制」），但**不重疊**——
C1 管執行期正確性（驗章邏輯本身），skill 管生成期正確性（模型寫出來的東西長什麼樣）。
兩件事互補，可以各自獨立做。

---

## 3. 明確不要做的事

這些是體檢時評估過並否決的方向。如果你（agent 或人）在執行中提出這些，那是走錯路：

| 不要做 | 為什麼 |
| --- | --- |
| 蓋 Backstage | 它本身需要一個團隊維護。`services.json` + `tpass` CLI 已經達成它的兩個核心功能（服務目錄 + scaffold），維護成本接近零。 |
| 導入 Kubernetes / Docker 化 | 八個服務、一台機器、學生團隊。複雜度會吃掉全部時間，下一任看不懂就等於系統死亡。優先序遠低於備份與 CI。 |
| 換成 Auth0 / Clerk / Firebase Auth | 危險的部分（密碼、雙因素、帳號回復）已經外包給 Google；自建的只有發證層，品質已驗證。換掉會引入廠商鎖定與「畢業後帳單誰付」的問題。 |
| 蓋 staging 主機 | 共用 staging 是被淘汰的模式。該做的是 B2 的 PR 檢查。 |
| 追求測試覆蓋率數字 | 只測三種：驗章四鐵則各一個「故意做錯應該被拒絕」的測試、註冊表格式驗證、每個服務 build 能過。其他是奢侈品。 |
| 把所有 repo 併成 monorepo | Google 的巨型 repo 需要自建版控與建置系統才成立。分散式 repo + 註冊表已經拿到大部分好處。 |
| 重寫 SSO / 改契約 v2 | 架構是這個專案最健康的部分。不要碰。 |

---

## 4. 已記錄但這次不處理

體檢發現、但不在本計畫範圍內的項目。**不要順手做，記著就好**：

- **Sentry（線上例外收集）沒做**——A2 第 4 點列為選配，2026-08-26 決定不併進 A2
  （要動 6 個服務 repo、6 個 DSN、6 次部署，是獨立一件事）。
  現況：**「站活著但功能壞掉」沒有任何訊號**——UptimeRobot 只知道首頁有回應。
  相關的待討論題目：大公司在「各團隊獨立開發模組」的架構下，是怎麼要求開發者把 Sentry
  併進自己的專案的（強制？模板？共用套件？）——這跟 C1 抽共用套件是同一類問題。

- **註冊表被繞過 PR 直接在主機上改**（2026-08-26 發現）。主機的 `~/tpass/tpass-registry`
  是**部署用的 clone**，卻被當成作者的工作區：有一個沒推上去的本機 commit（註冊 meeting 與
  一個尚不存在的服務 `csm`）加上未 commit 的修改，導致 `deploy.sh` 的 `git pull --ff-only`
  直接失敗、部署停擺。那份 meeting 條目的 `icon: "CalendarDays"` **不在 portal 的圖示白名單裡**
  （`tpass-portal/src/config/icons.ts`），下次部署 portal 會啟動即炸——PR CI 會擋下這種錯，
  直接在主機改不會。當時的處置：把那個 commit 存成 `hailey-registry-20260826` 分支 + stash，
  再把 clone 對回 `origin/main`。**該做而沒做的是讓這件事不可能發生**（主機那份設成唯讀 /
  在 `04-registry-sop.md` 點名 / B2 的分支保護）。
- **`csm`（課表拉取器）還沒進註冊表**。上面那個本機 commit 裡有它，但服務本身在主機上
  還不存在（沒目錄、port 30088 沒在聽），且 port 不在其他服務的 3000–3009 區段。
  要納管就開一個正式 PR，順便決定 port 是否改成 3010。
- `tpass-appeals/src/config/admin.ts:13-16` 的 `isAdmin` 扁平化——任何 moderator
  都能讀全部申訴，沒有分案隔離。（比 A4 大，需要權限模型討論。）
- 沒有任何資料保留政策。學生三年前的問卷與申訴永遠躺在主機上，畢業生資料無處理流程。
- 隱私政策只有 msg 有一份（`src/content/terms.md`），而且要登入才看得到。
  收申訴內容的 appeals 一份都沒有。
- 沒有任何使用量統計（無 GA / Plausible / PostHog）。部長不知道有多少人在用。
  `Subject.lastSeenAt` 有資料但沒有任何報表呈現。
- `tpass-portal/src/components/HeroSection.tsx:66` 寫死「有效至 2026-07」（已過期）；
  同檔 `:158` 硬編碼 `tschool.edu.tw`，違反「網域一律 env 驅動」鐵則。
- `tpass-portal/src/components/ServiceCard.tsx:44,60` 對未登入與被停權的卡片整張加
  `aria-hidden="true"`，螢幕閱讀器使用者讀不到「你被禁止使用申訴系統」。
- `design.md` 全文沒有任何一行提到無障礙 / 對比 / focus 樣式。
- 各服務 `public/` 還躺著 Next.js 樣板的 `next.svg` / `vercel.svg`；
  `tpass-portal/README.md` 還是 `create-next-app` 的原始樣板。

---

## 5. 進度追蹤

做完一項就在這裡打勾並註記日期，讓下一個接手的人知道進度。

- [x] A1 資料庫排程備份 + 還原驗證（2026-08-26 完成）
      主機 cron 每日 04:15 → Google Drive（rclone）；日備留 7、週備留 4。
      備份範圍從註冊表派生，涵蓋 5 個資料庫 + 任何服務非空的 `data/`。
      auth/form/msg/appeals 四個正式庫已各還原驗證一次，列數與主機一致。
      失敗兩層可見：Discord webhook（跑了但失敗）+ `tpass status` 的
      「最後備份 X 小時前」（cron 沒觸發）。用法見 `docs/ONBOARDING.md` §6.1。
      **未加密**；已搬到 `studentcouncil@` 官方帳號的「我的雲端硬碟」（不隨個人畢業消失），
      改用共用雲端硬碟會更穩，尚未做（見 `ONBOARDING.md` §6.1 已知限制）。
- [x] A2 線上監控與告警（2026-08-26 完成，**heartbeat 未接**）
      UptimeRobot 免費方案，6 個 `deployed:true` 服務各一個 HTTP monitor，5 分鐘間隔。
      **接受碼放寬到 2xx+3xx**——消費端未登入回 307，只收 200 會全天誤報。
      告警管道兩個：email（`studentcouncil@` 官方信箱）+ Discord webhook（維運頻道，
      與備份失敗告警同一條）。七個 monitor 都掛上、`threshold:0` 不延遲。
      **手機推播還沒接**——這兩個管道都要有人去看才成立，半夜叫不醒人。
      🔑 唯讀 API key **讀得出 Discord webhook 全文**，要當機密保管（放 gitignored 的
      `deploy/host.env`）。
      **端到端實測過**（2026-08-26）：`pm2 stop buddy` → **6.6 分鐘**後判定 down 並告警
      → 復原後 4.5 分鐘判定 up 並發恢復通知。
      ⚠️ 計畫原本寫的「三分鐘內」**免費方案做不到**——最短就是 5 分鐘間隔，
      加上判定要連續失敗，實際落在 5～7 分鐘。這是方案的硬限制，不是設定錯了。
      `tpass status` 多一段「== 監控 ==」：讀 UptimeRobot v2 API（唯讀 key 放本機
      gitignored 的 `deploy/host.env`，**不放主機**），並**跟註冊表對照抓出
      「`deployed:true` 卻沒有人開監控」的服務**——那是網頁看不出來的，也是唯一寫 code 的理由。
      沒填 key 整段安靜跳過。用法見 `docs/ONBOARDING.md` §6。
      順手修掉 `status()` 的一個 early return：拿不到主機 git 版本時，會把後面的監控與備份
      兩段一起吞掉——那恰好是最不該沉默的兩段。
      **留給下一個人的三件事**：
      ① **死人開關沒接**（A1 的洞還開著；→ 已獨立成 **B6**）。`backup.sh` 的 ping 已經寫好，`backup.env` 填一個
      `BACKUP_HEARTBEAT_URL` 就生效；UptimeRobot 免費方案**沒有** heartbeat（行銷頁寫有，
      產品裡是 Solo 以上），要接就用 healthchecks.io，步驟寫在 `ONBOARDING.md` §6。
      在那之前「cron 根本沒觸發」仍然只有主動跑 `tpass status` 才看得到。
      ② **新服務上線要手動加 monitor**，沒有自動化；`tpass status` 的 ⚠️ 是補救不是預防（見 C3）。
      ③ UptimeRobot 帳號同樣**不隨個人畢業**才安全（見 C5）。
      📌 **2026-08-27 後續**：部員提議改用自架的 **Uptime Kuma**（跑在他自己的主機，
      他負責部署）。值得做——它內建 push monitor，①那個死人開關的洞直接補掉，
      `backup.sh` 連改都不用改（`BACKUP_HEARTBEAT_URL` 填 Kuma 的 push URL 即可）。
      三個但書寫在 `docs/ONBOARDING.md` §6：**不能跟被監控的主機同一台**、
      **先跟 UptimeRobot 並行不要直接切**（監控自己死掉是靜默的）、
      **機器屬於個人的交接風險比 UptimeRobot 帳號更重**（C5）。
      `scripts/lib/monitor.mjs` 打的是 UptimeRobot v2 API，並行期間先不要動它。
- [x] A3 `notes` 去留決定（2026-08-26 完成）→ **選「修好上線」**
      決定的依據：repo 已從 `Ray1020-a` 轉進 `tschoolsu` 組織，原本最貴的障礙
      （要 commit 進別人的 repo）消失了。資料量很小（2 篇筆記、0 協作者、1 個測試 PDF），
      但站本來就活著、驗章四鐵則齊全，關掉不會比修好便宜。
      **做了什麼**：`tschoolsu/tpass-notes#1`（補 `pnpm-lock.yaml`、刪 `package-lock.json`、
      刪自帶的 `ecosystem.config.js`、補 `pnpm.onlyBuiltDependencies`）、
      `tschoolsu/tpass-notes#2`（tsconfig exclude `node_modules.npm-bak`）、
      `tpass-registry#4`（notes 翻 `deployed:true` + **meeting 納管**）、
      主機一次 root 操作（`chown` + 從 root 的 pm2 刪掉 `tpass-notes` 釋出 3007）、
      `tpass deploy notes` + `tpass deploy portal`。
      現在：pm2 app 名是 `notes`（不是 `tpass-notes`）、屬部署帳號、綁 `127.0.0.1:3007`
      （之前綁 `*`）、`tpass status` 全綠、大廳有「共編筆記」卡片。
      ⚠️ **計畫原文有兩處是錯的，已在執行中修正**：
      ① 順序反了——`deploy/ecosystem.config.js:28` 只收 `deployed:true`，
      **必須先 merge registry PR 翻 true 才 deploy 得動**，不是「deploy 成功後再翻」。
      ② **auth 不用重新部署**——發證白名單只看 `enabled`，notes 本來就是 true。只有 portal 要。
      🕳 **踩到的坑（下一個服務照樣會踩）**：`deploy.sh` 從 npm 切 pnpm 時會把舊
      `node_modules` 備份成 `node_modules.npm-bak` 留在專案根目錄。notes 的 tsconfig
      只 exclude 了 `node_modules`，於是 **7 月那份 npm 的 `next` 型別宣告被一起拉進
      型別檢查**，把 `useSearchParams()` 蓋成可為 null，build 在主機上掛掉而本機完全正常。
      另外五個服務的 tsconfig 早就有 `node_modules.npm-bak` 這一行，notes 是唯一漏的。
      **meeting 上線時會再踩一次。**
      **留給下一個人的三件事**：
      ① **notes 的 UptimeRobot monitor 要手動加**（`https://notes.tschoolsu.org/`，
      **接受碼 2xx+3xx**，未登入回 307）。加之前 `tpass status` 的「== 監控 ==」會一直
      ⚠️ 標它——那正是 A2 寫那段的理由。
      ② **meeting 只做了「納管」，沒上線**（`enabled:true` / `deployed:false`）。
      `enabled:true` 的實質效果是**修好它的登入**——在此之前它不在註冊表，
      auth 的 authorize 一律回 `unknown-service`，那個服務從 8/26 上線起登入就是壞的。
      剩下的上線步驟與 notes 完全相同：轉移目錄所有權（root）、從 root 的 pm2 交給部署帳號、
      補 `pnpm-lock.yaml`、刪自帶 `ecosystem.config.js`、tsconfig exclude `node_modules.npm-bak`、
      翻 `deployed:true`、加 monitor。**它還在開發中，別急著翻。**
      ③ 主機上服務 repo 的 `origin` 多半還指著**轉移前的舊擁有者**（`YC815/…`），靠 GitHub
      轉址在動。notes 這次已改成正式網址；其他的沒動——哪天 GitHub 停掉轉址就會一起壞。
      🔧 **順手修的**：`deploy/backup.sh` 的檔案備份規則從只收 `<dir>/data/` 擴成
      `data/` 與 `uploads/`（`STATE_DIRS`）。notes 與 meeting 都把使用者上傳檔寫在
      `uploads/`，原本**一份都沒有備份**。同時把 meeting 主機上的 `.env` 改名成 `.env.local`
      ——`backup.sh` 與 `deploy.sh` 都只認後者，不改名它的資料庫永遠不會進備份。
      **已實跑驗證**（2026-08-26，沒等 cron）：6 個資料庫（`t_meeting` 首次入列）
      + 4 份檔案目錄，備份庫上確認有 `notes-uploads.tar.gz`（1.3M）與
      `meeting-uploads.tar.gz`（2.8M）。⚠️ **cron 那行不會 `git pull`**
      （`15 4 * * * cd $HOME/tpass && ./deploy/backup.sh`），所以改完 `backup.sh`
      必須讓主機的 `~/tpass` 拉一次，否則今晚跑的還是舊規則。
- [x] A4 Discord 通知去識別化（2026-08-26 程式碼、2026-08-27 頻道，兩半都完成）
      🔴 **執行時才問出來的關鍵事實：那個 webhook 接的是「全體學生會」頻道。**
      所以這不是隱私潔癖——**申訴的對象很可能就是學生會或其幹部，潛在被申訴人本人
      就坐在收件頻道裡**，即時看到申訴人姓名、全文與照片。而 `src/app/actions.ts:3`
      寫著「一律具名，不做匿名分支」：既然強制學生具名，就必須保證他具名的對象是承辦人。
      這一項的嚴重度比計畫原本估的高，**下次排序時 A4 應該排在 A5 前面**。
      **程式碼改了什麼**（`tpass-appeals`）：Discord 通知只剩
      thread 標題（姓名+時間）+ embed author（姓名·年級）+ 後台深連結 + 附件「數量」。
      拿掉 email（footer）、申訴全文（description）、圖片附件（整條 multipart 路徑
      連同 `collectImageAttachments` 一起刪）。`postAppealToDiscord` 的簽名縮成
      `(webhookUrl, appealUrl, respondent, attachmentCount)`——**不讀 env，維持純格式化**，
      深連結由 `actions.ts` 用既有的 `authConfig.selfUrl` 組（沒有新增 env）。
      `prisma.appeal.create()` 的回傳值原本沒接，改成接住拿 id。
      `lib/storage.ts` 與 `lib/image.ts` 沒動——後台取檔與縮圖還在用。
      測試從 8 個改成 10 個，其中一個**直接對整包 request body 斷言**找不到 email 與內容字串
      （繞過欄位結構，之後誰加了什麼欄位都擋得住）。`lint` / `tsc` / `test` 全過。
      **頻道那半**（2026-08-27，部長處理）：Discord 側已收斂成只有申訴承辦人看得到，
      **webhook URL 沿用**，所以 `/admin/settings` 不必動、不必再部署。
      舊 thread 的全文與照片跟著頻道權限一起收進去了。
      🔒 **這一半沒有任何程式碼在守它**——下一任只要把那個頻道的權限放寬，或把 webhook
      改貼到大頻道，外流就回來了，而且不會有任何測試或 CI 會紅。**要接手申訴系統的人
      必須知道這件事**；C3 的上線檢查表值得補一條「通知送到哪、誰看得到」。
      **留給下一個人的一件事**：**端到端沒實測**——要真人 Google 登入，agent 做不了。
      下次有真實申訴進來時順手確認一眼：訊息裡應該只有姓名·年級、時間、後台連結、
      附件數量，**沒有** email、沒有任何一題的答案、沒有圖。
- [x] A5 根網域轉址（2026-08-27 完成）
      `tschoolsu.org` 與 `www.tschoolsu.org` → **301 → `https://portal.tschoolsu.org/`**，
      http 與 https、有無路徑一律成立，查詢字串保留（`/?a=1` → `/?a=1`）。
      🕳 **第一版設錯了，值得記**：規則的目標主機名跟來源一樣——
      `(http.host eq "tschoolsu.org")` → 動態 `concat("https://tschoolsu.org", …)`，
      **少了 `portal.`**，apex 轉給自己變成 `ERR_TOO_MANY_REDIRECTS`。
      ⚠️ **而且瀏覽器測不出來。** 301 會被永久快取：部長自己的 Chrome 存著更早那版
      正確的轉址，連進去一切正常，只有沒被快取過的路徑（`/foo`）才現形。
      **這種東西只認 curl 或無痕視窗**，「我點進去是好的」不算驗收。
      ✅ **最後的做法是併成一條**：`http.host in {"tschoolsu.org" "www.tschoolsu.org"}`
      → **靜態** `https://portal.tschoolsu.org`，301。原本 apex 一條、www 一條，
      還要手動排「冪次」讓它們不打架——那是多出來的特殊情況，一條規則就沒有順序問題。
      用靜態、不保留路徑是刻意的：apex 底下沒有內容，`tschoolsu.org/foo` 保留路徑
      只會變成 portal 的 404，丟掉路徑直接落到大廳才對。
      UptimeRobot 的 `tschoolsu.org` monitor 已從 Paused 開回來，等它下一輪翻綠即可。
- [x] B1 部署搬進 GitHub Actions（2026-08-27 完成）
      **[Actions → deploy → Run workflow](https://github.com/tschoolsu/tpass-ops/actions/workflows/deploy.yml)**，
      輸入框打服務 id（`all` / `ping` / 單一 id）。合法清單**現場抓 `tpass-registry/services.json`**，
      不寫死在 workflow 裡——新服務上線這個檔案一行都不用改。
      三個檔案就是全部：`.github/workflows/deploy.yml`、`deploy/ci-deploy.sh`、
      `deploy/deploy.sh` 多一行 `📌 部署版本：<sha> <標題>`（＝計畫第 3 點的稽核軌跡）。
      `scripts/tpass deploy` 一行沒動（計畫第 4 點）。
      🔐 **比計畫原文多做了一層：強制命令。** 計畫只說「金鑰放 Secrets」，
      但 `tpass-ops` 是 **public**，若不綁，「有 repo 寫入權」就等於「主機上部署帳號的 shell」
      ——任何人改一行 workflow 就能跑任意指令。做法是 `authorized_keys` 裡 CI 那把金鑰前面掛
      `command="/home/<user>/tpass/deploy/ci-deploy.sh",restrict`：sshd 收到什麼指令都丟掉，
      一律改跑包裝層，原字串塞進 `$SSH_ORIGINAL_COMMAND` 當服務 id 白名單過濾（`^[a-z0-9_-]+$`）。
      **本機實測四種情況**：`ping` 通、`pm2 list` 擋成 exit 2、`buddy; rm -rf ~` 擋成 exit 2、
      `ssh -tt` 要不到 pty。所以「有 repo 寫入權」＝「能按部署」，僅此而已。
      保留字 `ping` 不部署，只回答「CI 金鑰還連得上主機嗎」——以後排查金鑰被撤銷 / 主機換位址用得到。
      🕳 **踩到的四個坑**：
      ① **`.gitignore` 靜默吃掉 `.github/`**。頂層是 deny-all 白名單（`/*` 全忽略再逐項放行），
      不加 `!/.github/` 的話 `git add .github` **不報錯、也什麼都沒加**。這是第一步就該做的。
      ② **bash 變數後面接中文字元會被當成變數名的一部分**：`echo "「$SERVICE」"` 在 runner 上
      噴 `SERVICE」: unbound variable`。推之前在本機把那段 shell 跑過才抓到。一律寫 `${SERVICE}`。
      ③ **計畫與 `AGENTS.md` 都寫「private 只有 tpass-ops」，實際上它是 public**（已修）。
      這不只是文件錯字——**Actions 的執行紀錄跟著是公開的**，所以 `ping` 刻意不印 hostname，
      往 `deploy.sh` 加任何 `echo` 前都要想一次。已實際 grep 過一次完整部署 log：
      主機位址 0 次、私鑰字樣 0 次、12 行被遮成 `***`。
      ④ **先有蛋才有雞**：`ci-deploy.sh` 自己會 `git pull`，但第一次它得先存在於主機——
      要先 commit + push + 手動讓 `~/tpass` pull 一次，才能寫 `authorized_keys`。
      之後就自我更新了（那也是為什麼它整段包在 `main()` 裡：bash 邊讀邊執行，
      而它正在覆蓋自己執行中的檔案）。
      **驗收證據**（2026-08-27）：`buddy` 從網頁按下去，log 有
      `📌 部署版本：94ef51c`、`✅ 健康檢查通過（:3008 → HTTP 307）`、`✅ buddy 部署完成`。
      動 `authorized_keys` 前備份成 `~/.ssh/authorized_keys.bak-preci`，只用 `>>` 追加，
      原有金鑰未動。CI 私鑰已從本機刪除，**只存在 GitHub Secrets、讀不回來**；
      要換就重產一把、重設 secret、重寫那一行。
      **留給下一個人的兩件事**：
      ① **「第二個人也能按」還沒驗**——計畫的完整驗收包含這條，需要給另一位部員
      `tpass-ops` 的 write 權限再讓他按一次。這是 B3（工具箱發給部員）與 C4（強迫知識流動：
      規定每次部署由不同的人按）的前置，做 B3 時順手一起收掉。
      ② **撤銷 CI 權限的方法要有人知道**：刪掉主機 `~/.ssh/authorized_keys` 裡
      `github-actions-deploy` 那一行即可，不影響任何人的個人連線。已寫進 `ONBOARDING.md` §4。
- [x] B2 PR 檢查（2026-08-27 完成，**分支保護刻意不做**）
      七個服務 repo 各一份 `.github/workflows/ci.yml`：`pnpm install --frozen-lockfile`
      →（有 Prisma 才）`prisma generate` → `next typegen` → `lint` → `tsc --noEmit`
      →（有測試才）`test` → `build`。一次跑 **44～52 秒**，public repo 免費。
      觸發掛 `pull_request` **與 `push: main` 兩個**——沒開分支保護，直推 main 是常態，
      所以後者不是保險絲而是主力：推壞的人幾十秒後收到 GitHub 的失敗信。
      auth / portal 多一步 `git clone` 註冊表到 `$RUNNER_TEMP` 並用 `$GITHUB_ENV`
      傳絕對路徑 `TPASS_REGISTRY_PATH`（**不 checkout 進專案目錄**，免得 eslint / tsc /
      Turbopack 把它當專案的一部分；`runner.temp` 在 job 層 `env:` 讀不到，只能在步驟裡）。
      🚫 **計畫第 3 點「開啟 main 的分支保護」刻意沒做**，這是執行時查出事實後改的決定，
      不是漏掉。查到的事實：**八個 repo 的 push 權限清單完全一樣**（`YC815`、`Ray1020-a`、
      `Super1115`、`tschoolsu-manager`——是組織層級不是只有 ops），但**歷史上推過 code 的只有
      `YC815`，`notes` 多一個 `Ray1020-a`**。也就是保護要擋的兩個帳號從沒推過任何東西，
      而部長選的「管理員可繞道」又讓他自己免疫——規則管的是還沒發生的事，代價卻是現在就要教。
      另一個支撐：**壞 code 進 main 不會弄壞線上站**（已實測：把 registry 的 icon 改壞去 build
      portal，`Failed to collect page data for /`；`deploy.sh` 是先 build 再 restart，
      build 掛掉部署中止，線上維持舊版）。所以 CI 的價值是「把發現時間從下次部署提前到推上去 40 秒後」，
      **那個價值不需要靠強制 PR 拿到**。
      ⏰ **什麼時候該回來開**：等第二個人開始固定推 code（＝C4 的目標達成那天）。
      那時已經有七顆亮著的燈，開保護只剩點四個勾。設定內容（部長已選定）：
      ruleset → Active、bypass 加 Repository admin、target = default branch、
      勾 Restrict deletions / Require PR（**approvals 設 0**，人力還是 1.2 個人）/
      Require status checks → 選 `check`（**不要**勾 up-to-date，PR 量小、只是白等）/ Block force pushes。
      🚫 **也刻意不建任何制度**：不寫進部員手冊、不列進交付要求、不教任何人、不做 `tpass ci` 產生器。
      理由是部長講的工作流：**部員只交 v1，之後的驗收、修補、維護都是部長與 Ray**，
      而且**部員自己開 project，不會經過 `tpass new`**——所以「教每個新人做 CI」的成本大於必要性。
      CI 在這裡是**給接手的兩個人用的工具**：不必 clone 別人交來的 code、不必配 env、不必起資料庫，
      40 秒就知道那包東西 lint / 型別 / build 過不過。以後要幫某個 repo 裝，複製任一份現有的
      `ci.yml` 過去改 `env:` 區塊即可（填錯 CI 會直接印 `[config/xxx] 缺少必填環境變數：KEY`，一次收斂）。
      **代價要誠實記著：沒有任何提醒機制，新 repo 實際上大概率永遠不會裝 CI。**
      🕳 **踩到的五個坑（下一個人照計畫原文寫 workflow 一定再踩）**：
      ① **`tsc --noEmit` 在全新 clone 上會失敗**（appeals / form：`Cannot find name 'RouteContext'`）。
      那些型別是 Next 生成在 `.next/types/` 的，本機有 `.next` 所以 `tpass check` 一直是綠的。
      解法 `pnpm exec next typegen`（Next 16 的指令，不用整包 build，一秒）。
      ⚠️ 這代表**部員在全新 clone 上跑 `tpass check` 也會無故噴紅**——`tpass check` 值得補這一步。
      ② **`prisma generate` 要自己跑**，`pnpm install` 不會帶到（`deploy.sh:175` 早就寫過同樣的理由）。
      ③ **build 期就會 import `src/config/*.ts`**，缺 REQUIRED 直接 throw，所以 CI 需要一份假 env。
      網域一律用 `.invalid`（RFC 2606 保證解析不出來）：萬一有人寫出 build 期就 fetch 的 code，
      它會當場爆炸而不是安靜打到正式站。**auth 不需要在 CI 產金鑰**——`session.ts` 的 `??=` 是 lazy，
      `JWT_PRIVATE_KEY=ci-not-a-real-key` 照樣 build 過，public repo 裡連假 PEM 都不必出現。
      ④ **action 版本會過期**：`@v4` 一跑就噴 `Node.js 20 is deprecated`。現行大版本是
      `checkout@v7` / `setup-node@v7` / `pnpm/action-setup@v6`。這是整件事**唯一不能在本機先跑過**的部分
      （action 只存在於 runner 上）；其餘每一行都在全新 clone 上實跑過才推。
      ⑤ **裝煞車前要先看車子是不是好的**：`tpass-notes` 的 `pnpm lint` 當時就是紅的
      （`components/access-gate.tsx:11`，React Compiler 規則擋 effect 內同步 setState）。
      **CI 只能加在現在就是綠的 repo 上**——加在紅的上面，三天後大家就學會忽略它，比沒有更糟。
      已修（那行 `setCanClose(false)` 本來就沒作用，初始值就是 false），順手補上 notes 漏掉的
      `packageManager: pnpm@10.27.0`（其餘六個都有；少了它 `pnpm/action-setup` 不知道裝哪版）。
      📌 **順帶更正 §4 的一句話**：註冊表 icon 事故的實際後果是「**部署中止、線上維持舊版**」，
      不是「啟動即炸」；而且**這次的 CI 擋不下它**——portal 的 CI 抓的是註冊表的 `main`，
      註冊表的 PR 不會去 build portal。要擋得靠註冊表那邊的 CI 反過來 build 一次 portal，本次沒做。
      **留給下一個人的三件事**：
      ① **`tpass-appeals` 的 CI 走 PR（[#2](https://github.com/tschoolsu/tpass-appeals/pull/2)）**，
      是第一段的教學樣本，淨改動只有那一個檔案；其餘六個直推 main。若那個 PR 還開著就是還沒 merge。
      ② **`tpass-meeting` / `tpass-vote` / `tpass-registry` 沒有這份 CI**：meeting 本機沒 clone
      且還在開發、vote 還沒有 GitHub repo、registry 已經有自己的 `validate.yml`。
      ③ 驗收證據（2026-08-27）：故意在 appeals 推一個型別錯誤，CI 在 `tsc` 那步紅、
      後面的 test / build 自動跳過，GitHub 把錯誤標註在 `src/lib/ci-red-test.ts#1`；移除後回綠。
      六個直推 main 的 repo 首跑全綠（44～52 秒）。
- [ ] B3 工具箱發給部員
- [ ] B4 三個服務補錯誤頁
- [ ] B5 回報管道
- [ ] B6 Uptime Kuma 調好後轉交部員自架（接手 A2 的死人開關洞）
- [ ] C1 驗章抽成套件
- [ ] C2 runbook
- [ ] C3 上線檢查表
- [ ] C4 知識流動制度
- [ ] C5 交接重疊期
- [ ] C6 數位部專用 agent skill（**非體檢發現**，部長 2026-08-27 提出）
