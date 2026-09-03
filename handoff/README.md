# T-Pass 主機 pm2 交接包

主機重建之後，把 pm2 這一層重新裝起來。

**預計時間 15 分鐘。不需要 root**（只有最後一行開機自啟要 sudo，腳本會印給你貼）。

---

## 這包有什麼

| 檔案 | 用途 |
| --- | --- |
| `install.sh` | 安裝腳本。先 dry-run 看它要做什麼，再 `--apply` 真跑。 |
| `service.json` | 服務註冊表。腳本會放到 `/home/service/service.json`。 |
| `README.md` | 這份。 |

每個服務的 pm2 設定（`ecosystem.config.js` + `pm2-start.sh`）**跟著各自的服務 repo
進 git**，`git pull` 就有，不在這包裡。這樣改設定有 review、有歷史，下次重建 clone 就有。

---

## 開始之前

主機上要先有這些，`install.sh` 會幫你檢查：

- `git` / `node` / `pnpm` / `pm2` 都裝好
- ops repo clone 在 `~/tpass`
- 七個服務 repo clone 在 `/home/service/<目錄>`，**一個服務一層，那層不放別的東西**：

  ```
  /home/service/tpass-auth
  /home/service/tpass-portal
  /home/service/tpass-form
  /home/service/tpass-cross_grade_messages
  /home/service/tpass-appeals
  /home/service/tpass-meeting
  /home/service/tpass-notes
  ```

- 每個服務目錄都跑過一次 `pnpm install` 和 `pnpm build`
- 每個服務目錄的 `.env.local` 都在（金鑰、OAuth、`DATABASE_URL`——這些不在 git 裡，
  要從舊主機或備份拿）

---

## 安裝

```bash
cd <這包解開的位置>

./install.sh            # 先看它要做什麼，不會動到任何東西
./install.sh --apply    # 確認沒問題再跑這行
```

腳本會依序做六件事，每一步都印出來：

1. 檢查 git / node / pnpm / pm2 和七個服務目錄都在
2. 把 `service.json` 放到 `/home/service/service.json`（舊的備份成 `.bak`）
3. 各服務 repo 設好 upstream 並 `git pull`
4. 確認 pm2 設定檔都到位、port 沒衝突、兩邊設定一致
5. `pm2 delete all` 後逐一重建
6. `pm2 list` + 逐一 curl 驗收

跑完它會印出最後一件要你自己做的事（`pm2 startup`，要 sudo）。

**任何一步的 ✗ 都會讓腳本停下來並告訴你原因**，不會裝到一半留爛攤子。

---

## port 分配

跟重建前一樣，nginx 的 upstream 不用改：

| 服務 | port | | 服務 | port |
| --- | --- | --- | --- | --- |
| auth | 3000 | | appeals | 3004 |
| portal | 3001 | | notes | 3007 |
| form | 3002 | | meeting | 3009 |
| msg | 3003 | | law | 不在主機（GitHub Pages） |

要改某個服務的 port，**兩個地方要一起改**，否則 `install.sh` 第 4 步會擋下來：

1. `/home/service/service.json` 的 `port`
2. 該服務 repo 的 `ecosystem.config.js`（要 commit）

---

## 裝完之後，平常會怎麼運作

每個服務目錄底下有兩個檔案（都在 git 裡）：

- `ecosystem.config.js` — 這個服務的 pm2 設定（名稱、port、記憶體上限）
- `pm2-start.sh` — pm2 每次啟動它的時候真正跑的東西

**pm2 每次啟動或重啟某個服務，都會先 `git pull`；只有真的拉到新 commit 才重新 build。**

```
pm2 啟動 xxx
  ├─ git pull
  ├─ 有新 commit？
  │    ├─ 有 → 重新 build → 啟動
  │    └─ 沒有 → 直接啟動（秒起）
  └─ build 失敗 → 用上一版的 build 啟動，服務不會死
```

三件事先講清楚，免得你之後困惑：

- **`git pull` 失敗不會擋住啟動。** 網路斷或工作區有改動，它會印一行警告然後照樣啟動。
- **這不是部署。** 它不會跑資料庫 migration。正式發版還是走原本那條：
  在**本機**下 `tpass deploy <服務名>` 或 `tpass deploy all`。
- **build 失敗不會讓服務消失。** 它會退回上一版的 build 繼續跑，但那代表
  「跑的是舊版」——看到 log 裡有 `build 失敗` 就要處理。

### 資源控管

每個服務都設了這些，主要是防 2026-09-02 那次「記憶體上限被記成 0，每 30 秒重啟一次」再發生：

- 記憶體超過 **1 GB** 自動重啟
- Node 的 heap 上限壓在 **384 MB**，逼它提早回收記憶體（build 的時候會自動放寬）
- 啟動後**撐不過 30 秒**算失敗，**連續失敗 10 次**就停手不再重試（不會無限重啟燒 CPU）
- 關閉時給 **5 秒**收尾（會議系統的即時連線需要，不然每次都被硬砍）
- log 輪替不用管，部署腳本會自動裝好

### 要臨時調參數救火時

**不要手改 `ecosystem.config.js`**——下次 `tpass deploy` 會把它沖掉。用 env：

```bash
cd /home/service/tpass-meeting
pm2 delete meeting
PM2_MAX_MEMORY=2G pm2 start ecosystem.config.js     # 記憶體門檻臨時放寬
pm2 save
```

| env | 改什麼 | 預設 |
| --- | --- | --- |
| `PORT` | 監聽的 port | 各服務不同，見上表 |
| `PM2_MAX_MEMORY` | pm2 的記憶體重啟門檻 | `1G` |
| `NODE_HEAP_MB` | V8 的 heap 上限（MB） | `384` |

臨時措施有效之後，記得回頭把值改進 `ecosystem.config.js` 並 commit，
不然下次重建又回到原點。

> ⚠️ 改過 `ecosystem.config.js` 之後，`pm2 restart` 和 `pm2 reload` **不會套用新設定**。
> 一定要 `pm2 delete <服務名>` 再 `pm2 start ecosystem.config.js`，最後 `pm2 save`。
> 重跑 `install.sh --apply` 會幫你做掉這一整套。

---

## 出事怎麼查

```bash
pm2 list                      # 誰活著、重啟了幾次
pm2 logs <服務名> --lines 100  # 看某個服務的 log
pm2 logs | grep pm2-start     # 看啟動時 pull / build 的紀錄
pm2 describe <服務名>          # 看它實際跑的 script、cwd、記憶體上限
```

常見狀況：

| 症狀 | 多半是 |
| --- | --- |
| 某個服務 `errored`，重啟次數卡在 10 | 連續啟動失敗被 pm2 停手。看 log 找原因，修好後 `pm2 restart <服務名>` |
| log 裡一直出現 `git pull 失敗` | 那個目錄的 upstream 沒設好，或工作區被手改過 |
| log 裡出現 `build 失敗` | 跑的是舊版。手動進那個目錄 `pnpm build` 看完整錯誤 |
| `EADDRINUSE` | port 撞到別的東西。`ss -tlnp \| grep <port>` 看誰佔著 |
| 網頁 502 | 服務沒起來，或 nginx 的 upstream port 跟上面的表對不上 |

---

## 這些事我沒做完，要你決定

1. **`notes`（共編筆記）沒有自己的設定檔**，走的是 ops 層的共用設定。它也是唯一還在用
   舊寫法接資料庫的服務，去留還沒定案。決定下架的話：把 `service.json` 裡 notes 的
   `deployed` 改成 `false`，然後 `pm2 delete notes && pm2 save`。

2. **`/home/service/service.json` 現在沒有任何把關。** 以前這份清單放在 GitHub 上，
   改一行要開 PR、有人看、有自動檢查。現在它是主機上一個純檔案——
   **手改它就等於直接改線上的登入白名單，沒有紀錄也沒人審**。改之前先想清楚，
   改完要重新部署 auth 和 portal 才會生效。

3. **全部沒有在真主機上跑過。** 主機的 SSH 指紋變了，我這邊連不進去。
   `pm2-start.sh` 的三種情況（不用 build / build 成功 / build 失敗回滾）
   和 `install.sh` 的每條路徑我都在本機用假環境測過，但 pm2 本身沒有實機驗證。
   所以請先跑 dry-run，有任何一行看起來不對就先別 `--apply`。
