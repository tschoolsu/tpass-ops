# T-Pass 監控 — 部署與交接手冊

> 你要做的事：把一份**已經調好的** Uptime Kuma 跑在**你自己的機器**上，
> 讓它 24 小時盯著 T-Pass 的七個服務，出事時發 Discord。
>
> 設定不用你重建——部長會私下傳一包 `data/` 給你，那裡面已經有全部的
> monitor、通知管道與狀態頁樣式。你負責的是「讓它活著、而且被看得到」。

設計與理由：`docs/specs/2026-08-28-uptime-kuma-design.md`
上位計畫：`docs/specs/2026-08-26-platform-hardening-plan.md` 的 B6

---

## 0. 開始之前

### 這件事分兩階段，第一階段你一個人就做得完

| 階段 | 做什麼 | 做完就有什麼 | 需要什麼權限 |
| --- | --- | --- | --- |
| **一**（§1、§3） | 把 Kuma 跑起來、把 Discord 通知勾上 | **監控真的在運作了**——服務掛掉會發 Discord | 你的機器 + 主機（驗收要停一次 pm2） |
| **二**（§2、§4、§5） | Cloudflare Tunnel + Access、接上備份心跳 | 公開狀態頁、備份的死人開關、`tpass status` 看得到、GitHub 看門狗盯得到 Kuma | **Cloudflare 帳號**（見下） |

> §4（備份心跳）為什麼在第二階段：push URL 是 `https://status.tschoolsu.org/...` 開頭的，
> tunnel 還沒通的話主機打不到它。

**先把第一階段做完再說。** 它本身就是完整可用的東西，卡在第二階段不會讓前面白做。

⚠️ 但第二階段不是可有可無的：**沒有它，「Kuma 自己掛掉」這件事沒有任何人會知道**
（GitHub 的看門狗要打得到 `status.tschoolsu.org` 才能盯 Kuma）。
第一階段停留太久的話，等於監控存在但無人看管。

### 🔴 第二階段卡的是 Cloudflare 帳號，不是主機權限

`§2` 的 `cloudflared tunnel login` 會叫你授權 **`tschoolsu.org` 這個 zone**，
`§2.2` 要進 **Cloudflare Zero Trust** 設 Access policy。這兩件需要的是**學生會那個
Cloudflare 帳號**——跟你有沒有主機 ssh 權限是兩回事，有主機也進不去 Cloudflare。

手上沒有的話：**約部長一起做 §2**（他登入、你照著設；或請他把你加進那個 Cloudflare 帳號，
之後你自己就能做完）。

⚠️ 不要用你自己的個人 Cloudflare 帳號登入——那樣建出來的 tunnel 沒有
`tschoolsu.org` 這個網域，看起來成功了但 `status.tschoolsu.org` 永遠不會生效。

### 機器要符合兩個條件

**① 不可以是 T-Pass 主機。**

監控的全部價值在於「被監控的東西死掉時它還活著」。跟主機住同一台，
主機一斷電就兩個一起消失，而且**沒有人會知道**。你自己的機器、樹莓派、
另一台 VPS 都可以，就是不能是那台。

🔴 **你有主機的權限，不代表可以裝在那裡。** 主機上跑得動、docker 也在，
裝上去五分鐘就會動——但那樣做出來的東西在主機掛掉時會跟著消失，
而主機掛掉正是最需要它出聲的時候。**這條紅線現在只剩這份文件在守。**

**② 它要一直開著。**

筆電闔上就睡著的機器不適合。要嘛是常開的桌機／小主機，要嘛是 VPS。
會關機的機器會讓 Discord 每天誤報，兩週後所有人都學會忽略那個頻道——
那比沒有監控更糟。

### 部長要給你三樣東西

| 東西 | 用在哪 | 怎麼給 |
| --- | --- | --- |
| `tpass-kuma-data.tar.gz`（約 135 KB） | §1 解開成 `data/` | **密碼管理器的安全檔案分享**或私訊 |
| Kuma 的管理帳號與密碼 | §1 登入後台 | 同上 |
| Discord 維運頻道的存取 | 收告警 | 邀請你進頻道 |

🔴 **那包裡有 Discord webhook 明文與管理帳號的密碼 hash。**
不要丟進 Google Drive 公開連結、不要貼在群組、不要寄 email、不要 commit。
拿到之後也不要留在下載資料夾裡到處備份。

### 機器上要先裝的

| 需要 | 給誰用 | 怎麼裝 |
| --- | --- | --- |
| **Docker** | §1 跑 Kuma | macOS：<https://docs.docker.com/desktop/> ；Linux：<https://docs.docker.com/engine/install/> |
| **git** | §1 clone | macOS 裝了 Xcode command line tools 就有；Linux `apt install git` |
| **Node.js** | §6 新服務上線時跑 `seed.mjs` | 用 brew / apt 裝；**第一次部署用不到，之後才需要** |
| **cloudflared** | §2 對外公開 | §2.1 有指令 |

---

## 1. 跑起來

需要 Docker（Docker Desktop 或 Docker Engine 都行）。

```bash
git clone https://github.com/tschoolsu/tpass-ops.git
# 註冊表要並排 clone——monitoring/seed.mjs 靠 ../tpass-registry/services.json
# 知道「該有哪些服務」。沒有它，§6 那支指令跑不起來。
git -C tpass-ops clone https://github.com/tschoolsu/tpass-registry.git
cd tpass-ops/monitoring
```

把部長給你的那包解開，讓它變成 `monitoring/data/`：

```bash
tar -xzf ~/Downloads/tpass-kuma-data.tar.gz -C .   # 解出來要剛好是 ./data/
ls data/kuma.db                                    # 有這個檔才算對
```

```bash
docker compose up -d
docker compose logs -f     # 看到 "Listening on 3001" 就好了，Ctrl-C 離開
```

開 `http://localhost:3001`，用部長給你的帳號密碼登入。
七個 monitor 應該已經在那裡，而且陸續轉綠。

> ⚠️ **`docker-compose.yml` 裡的版本不要動。** 它釘的是 tag + digest，
> 因為轉交是整包 SQLite 複製過來的，而 SQLite schema **不能降級**。
> 要升級就先確認新版本，兩邊一起改（tag 跟 digest 都要換）。

> 💡 **image 不需要別人傳給你，`docker compose up` 會自己拉。**
> 那顆 image 有 2.5GB，而真正要私下傳的設定只有 2.7MB——就是 `data/`。
> 也**不要**用 `docker commit` 打包容器：`/app/data` 是 bind mount，
> 設定根本不在 image 裡，那樣做出來的東西載進去會是一台空白的 Kuma，
> 你卻會以為自己拿到了全套。
>
> 真的拉不到 Docker Hub（被擋、rate limit）時才用這條逃生路徑，
> 讓部長在他機器上 `docker save louislam/uptime-kuma:2.5.3 | gzip > kuma.tgz`，
> 你這邊 `gunzip -c kuma.tgz | docker load`，然後照常 `docker compose up -d`。

> ⚠️ **`data/` 是 gitignored 的，永遠不要 commit。** 裡面有 Discord webhook 明文
> 和管理帳號的密碼 hash，而 `tpass-ops` 是 public repo。

---

## 2. 讓全校看得到：`status.tschoolsu.org`

> 🔴 **這一整節要部長一起做**（見 §0）。`cloudflared tunnel login` 與 Zero Trust
> 都需要學生會那個 Cloudflare 帳號的權限。約個時間、他登入，你照著下面做。

你家的 IP 不該直接曝露到公網，所以走 Cloudflare Tunnel（免費，也不用開 port）。

### 2.1 裝 cloudflared 並建 tunnel

```bash
brew install cloudflared          # macOS；Linux 看 Cloudflare 官方安裝說明
cloudflared tunnel login          # 瀏覽器授權 tschoolsu.org 這個 zone
cloudflared tunnel create tpass-status
cloudflared tunnel route dns tpass-status status.tschoolsu.org
```

設定檔（`~/.cloudflared/config.yml`）：

```yaml
tunnel: tpass-status
credentials-file: /Users/<你>/.cloudflared/<tunnel-id>.json

ingress:
  - hostname: status.tschoolsu.org
    service: http://localhost:3001
  - service: http_status:404
```

跑成常駐服務（開機自動起來，這很重要——不然你重開機監控就沒了）：

```bash
sudo cloudflared service install    # 需要 root，這是你自己的機器所以你有
```

### 2.2 🔴 保護管理後台

**Kuma 的管理後台跟狀態頁是同一個 port。** Tunnel 一開，`status.tschoolsu.org/dashboard`
就跟狀態頁一樣在公網上了——雖然有密碼擋著，但那是不必要的攻擊面。

在 Cloudflare Zero Trust → Access → Applications 建一個 self-hosted application，
網域 `status.tschoolsu.org`，然後：

| 路徑 | 政策 | 為什麼 |
| --- | --- | --- |
| `/status/*`、`/api/status-page/*`、`/assets/*`、`/icon.svg` 等靜態資源 | **Bypass**（不需登入） | 這是要給全校看的 |
| `/metrics` | **Bypass** | 它自己有 API key 擋著，而 `tpass status` 要打它 |
| 其他全部（`/dashboard*`、`/settings*`、`/add`、`/edit*`、`/manage-status-page*`） | 限定 Google 帳號（你 + 部長） | 管理介面不該在公網裸奔 |

根路徑**不用**在 Cloudflare 加 redirect rule——Kuma 原生的 Entry Page 設定已經
指向這個狀態頁了（Settings → General → Entry Page），而且那個設定跟著 `data/` 一起過來。

### 2.3 驗收

- 用**沒登入**的瀏覽器（無痕視窗）開 `https://status.tschoolsu.org` → 看得到狀態頁
- 同一個無痕視窗開 `https://status.tschoolsu.org/dashboard` → 被 Cloudflare 擋下來要求登入

---

## 3. 接上告警

`data/` 裡已經有 Discord 通知設定，但**部長刻意沒有把它勾到任何 monitor 上**
（他本機在調的時候，電腦一關七個 monitor 會全紅、把頻道洗爆）。

登入後台 → 每個 monitor → Edit → 勾選那個 Discord 通知 → Save。

### 驗收①：服務掛掉會叫

在主機上停掉一個非關鍵服務的 pm2 程序，**三分鐘內**維運頻道應該收到告警：

```bash
pm2 stop buddy      # 挑非關鍵的，不要拿 auth 練習——它掛了六個服務一起掛
# 等告警進來
pm2 start buddy     # 應該收到恢復通知
```

⚠️ `buddy` 是活動限定的臨時服務，拿它試最安全。**絕對不要停 `auth`**：
它是發證端，停掉等於全校六個服務同時登不進去。

---

## 4. 接上備份的死人開關

這是整個「換掉 UptimeRobot」最主要的理由。

主機每天 04:15 跑 `deploy/backup.sh`。它失敗時會自己發 Discord——但**cron 根本沒觸發**時
（crontab 被清、cron 服務死了、主機重開後沒起來）腳本從未執行，也就沒有東西發告警，
**而沉默看起來跟成功一模一樣**。死人開關等的是「好消息沒來」，不是壞消息。

`data/` 裡已經有一個叫 `backup-heartbeat` 的 push monitor（心跳期限 25 小時）。
你要做的是把它的 URL 填進主機：

1. 後台 → `backup-heartbeat` → 複製 Push URL
   （長得像 `https://status.tschoolsu.org/api/push/<token>`）
2. 進主機，把它接在 `backup.env` 後面：

   ```bash
   printf 'BACKUP_HEARTBEAT_URL=%s\n' 'https://status.tschoolsu.org/api/push/<token>' \
     >> ~/tpass/deploy/backup.env
   ```

   **`backup.sh` 一行都不用改**，它本來就會 ping 這個變數。

3. 手動跑一次備份確認心跳有進來——Kuma 上那個 monitor 應該立刻變綠：

   ```bash
   cd ~/tpass/deploy && ./backup.sh
   ```

> ⚠️ 這一步要 §2 做完才有意義：push URL 是 `status.tschoolsu.org` 開頭的，
> tunnel 還沒通的話主機打不到它。先做 §2 再回來。
>
> ⚠️ `backup.env` 是 gitignored 的機密檔（裡面還有 Discord webhook）。
> 用 `>>` 接在後面，不要整個覆寫掉。

### 驗收②：備份沒跑會叫

把那個 push monitor 的心跳期限暫時改成 5 分鐘，等它翻紅並發出告警，再改回 25 小時。
（比停一天 cron 快得多，驗的是同一件事。）

---

## 5. 讓 `tpass status` 看得到 Kuma

**API key 不用你重發**（而且這一步要 §2 做完才會生效——`tpass status` 是從別人的
筆電打 `status.tschoolsu.org`，沒有 tunnel 就打不到）。

`data/` 裡已經有一把叫 `tpass-status-readonly` 的唯讀 API key
（後台 → Settings → API Keys 看得到），部長本機也已經有它的值。
你上線之後他只要把自己的 `deploy/host.env` 從

```
KUMA_BASE_URL=http://localhost:3010          ← 調設定階段
```

改成

```
KUMA_BASE_URL=https://status.tschoolsu.org   ← 你上線之後
```

就好，key 不用重發。（要重發也可以，在後台建新的、把舊的停用，再把值給他。）

之後 `tpass status` 的「== 監控 ==」就會顯示各服務狀態，
並且**拿 Kuma 的 monitor 清單對照 `tpass-registry/services.json`，
抓出「已上線卻沒有人開監控」的服務**。

這是新服務上線時不會漏掉監控的機制：註冊表的 PR 一合併，`tpass status` 就開始喊。
**清單的真相永遠在註冊表，Kuma 只是被檢查有沒有跟上。**

你自己也想用 `tpass status` 的話（你有主機權限就跑得動）：`cp deploy/host.env.example
deploy/host.env`，填主機位址與帳號、再填上面那兩個 `KUMA_*`。那個檔是 gitignored 的機密，
主機位址不得出現在任何被追蹤的檔案裡。

---

## 6. 新服務上線時要做什麼

新服務的流程是：有人對 `tpass-registry` 開 PR 把 `deployed` 翻成 `true` → 部署 →
**然後才輪到監控**。監控這一步沒有自動化（理由見 §6.1），要有人動手。

### 正路：重跑 seed（推薦）

在**你的機器上**（Kuma 在本機，不必穿過 Cloudflare Access）：

```bash
cd tpass-ops
git -C tpass-registry pull                              # 先把註冊表更新到最新
node monitoring/seed.mjs --dry-run                      # 看一眼該有哪些，不動任何東西
KUMA_URL=http://localhost:3001 node monitoring/seed.mjs --notify
```

它是冪等的：已經存在的 monitor 全部跳過，只補上新的那個，順便把它加進狀態頁。

> 🔴 **`--notify` 不要漏。** 少了它，新 monitor 不會有任何告警管道——
> 那個服務掛掉時沒有人會收到通知，而它在狀態頁上還是綠的，看起來一切正常。
> 沒有告警的監控比沒有監控更糟，因為它讓人放心。

跑完檢查兩件事：後台那個新 monitor 的 Notifications 有勾起來；狀態頁上看得到它。

### 備路：後台手動加

`seed.mjs` 用的是 Kuma 未公開的內部協定，哪天 Kuma 升級把它弄壞了就走這條，不要修它。

後台 → Add New Monitor：

| 欄位 | 填什麼 |
| --- | --- |
| Monitor Type | HTTP(s) |
| Friendly Name | **註冊表 `services.json` 的 `name`**（例如 `T-Vote 選舉`），不是服務 id——這個名字會直接顯示在給全校看的狀態頁上 |
| URL | `https://<subdomain>.tschoolsu.org/` |
| Heartbeat Interval | 60 |
| **Accepted Status Codes** | **`200-399`** ← 這格一定要改 |
| Notifications | 勾維運頻道的 Discord |

再到 Status Page → Edit 把它拖進群組。

> 為什麼是 `200-399`：T-Pass 的消費端服務**未登入會回 307 導向登入頁**，
> 不是 200。用預設的 `200-299` 會讓服務全部顯示紅色。只有 `auth` 回 200。

### 6.1 漏掉了會怎樣

部長那邊的 `tpass status` 會印：

```
⚠️ vote      沒有監控 → 去 Kuma 加 https://vote.tschoolsu.org/
             名稱填「T-Vote 選舉」，接受狀態碼 200-399
```

那是**拿 Kuma 的 monitor 清單對照註冊表**算出來的，不是寫死的檢查清單，
所以新服務永遠涵蓋得到。但它要有人主動去跑 `tpass status` 才看得到。

**還有第二層，這層不需要有人記得**：`.github/workflows/kuma-watchdog.yml` 每 10 分鐘
也做同一個比對（用公開的狀態頁 API，不需要任何權限），發現有服務上線卻沒監控就
發 Discord 並開一顆 `monitor-missing` 的 issue。所以忘了補的話，十分鐘內你就會被叫。

⚠️ 那層是**用名稱比對**的（狀態頁的公開 API 不吐 URL）。monitor 名稱一定要等於註冊表的
`name`，取別的名字它會一直說「沒有監控」。

**為什麼不自動建**：Kuma 沒有官方寫入 API，唯一的路是它未公開的 socket.io 內部協定
（上游明講會 breaking）。所以方向是反過來的——**真相永遠在註冊表，
Kuma 只是被檢查有沒有跟上**。`seed.mjs` 也是走那條協定，所以它是「省事的工具」，
不是「可以依賴的機制」；真正兜底的是上面那個對照。

---

## 7. 改狀態頁樣式

樣式的真相是 `monitoring/status-page.css`（在 git 裡），
設計系統的真相是 `tpass-portal/docs/design.md`。

改法：編輯 `status-page.css` → 開 PR → 合併後，把整份內容貼進
後台 Status Page → Edit → **Custom CSS** → Save。

（Kuma 沒辦法從檔案讀 CSS，一定要貼。所以 git 那份是「主本」，
後台那份是「部署結果」——改了 git 沒貼上去，等於沒改。）

---

## 8. 🔴 交接條件（這一項沒講定，整件事就不算做完）

這台機器是**你的**。你畢業、退部，或哪天不想跑了，會同時發生三件事：

- T-Pass 的監控整個消失，而且**沒有人會收到通知**
- `status.tschoolsu.org` 變成一個對全校壞掉的頁面
- 備份的死人開關跟著沒了——備份哪天靜靜停掉，不會有人發現

所以在你按下 `docker compose up` 的那天就要把下面三格填掉，**不要留到以後**：

| 問題 | 答案 |
| --- | --- |
| 這台機器是誰的？（型號 / 放在哪 / 誰有實體存取） | |
| 電費、網路、網域的費用誰付？ | |
| 你離開時交給誰？交接要做哪些事？ | |

填完把這份 PR 出來，讓它進 git。這是 C5（交接重疊期）的一部分，躲不掉。

---

## 9. 排錯

| 症狀 | 先看哪裡 |
| --- | --- |
| 七個 monitor 全紅，但服務其實正常 | Accepted Status Codes 是不是還停在 `200-299`（見 §6） |
| 狀態頁打不開，後台正常 | cloudflared 有沒有在跑：`cloudflared tunnel info tpass-status` |
| 後台打不開，容器在跑 | `docker compose logs --tail=50` |
| 容器起不來，抱怨 database | `data/` 解錯層了（要剛好是 `monitoring/data/kuma.db`），或版本被改低了 |
| Discord 沒收到告警 | monitor 的 Notifications 有沒有勾（`data/` 裡預設是沒勾的，見 §3） |
| GitHub 上跳出「Uptime Kuma 沒有回應」的 issue | 那是看門狗（`.github/workflows/kuma-watchdog.yml`）發現 Kuma 整台沒回應。恢復後它會自己關掉，不要手動關 |
| GitHub 上跳出「有已上線的服務沒有監控」的 issue | 同一支看門狗發現註冊表有、狀態頁沒有。照 §6 補上去；或是 monitor 名稱跟註冊表的 `name` 不一致（它是用名稱比對的） |
| `tpass status` 說某個服務「沒有監控」，但後台明明有 | 那個 monitor 被暫停了。`/metrics` 不輸出暫停中的 monitor——暫停的監控等於沒有監控，這是刻意的 |
| `backup-heartbeat` 沒出現在 `tpass status` | 正常。push monitor 要收到第一次 ping 才會有心跳，才會出現在 `/metrics` |
| `/metrics` 回 401 | Kuma 的 `apiKeysEnabled` 設定沒開。在後台建過一把 API key 就會自動打開 |
