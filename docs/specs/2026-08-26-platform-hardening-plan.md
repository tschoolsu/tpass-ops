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
3. 選配：Sentry 免費方案（每月 5,000 事件）接進各服務，收線上例外。

**驗收**：故意停掉一個非關鍵服務的 pm2 程序，三分鐘內收到告警，恢復後收到恢復通知。

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
圖片附件直接以 multipart 上傳；2026-08-24 那筆 commit 讓通知本體寫出申訴人是誰。
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

- [ ] A1 資料庫排程備份 + 還原驗證
- [ ] A2 線上監控與告警
- [ ] A3 `notes` 去留決定
- [ ] A4 Discord 通知去識別化
- [ ] A5 根網域轉址
- [ ] B1 部署搬進 GitHub Actions
- [ ] B2 PR 檢查
- [ ] B3 工具箱發給部員
- [ ] B4 三個服務補錯誤頁
- [ ] B5 回報管道
- [ ] C1 驗章抽成套件
- [ ] C2 runbook
- [ ] C3 上線檢查表
- [ ] C4 知識流動制度
- [ ] C5 交接重疊期
