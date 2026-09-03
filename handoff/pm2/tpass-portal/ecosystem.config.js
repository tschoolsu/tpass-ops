// pm2 設定（本 repo 專用，只有一個 app：portal）。
//
// 用法（主機上，cwd = 本 repo）：
//   pm2 start ecosystem.config.js     # 首次啟動
//   pm2 save                          # 寫進開機快照
// 部署時由上層 tpass-ops 的 deploy.sh 呼叫：
//   pm2 startOrReload <本檔> --only portal --update-env
//
// ⚠️ pm2 只在「第一次建立 app」時吃下面這些欄位（script / interpreter / env /
//    max_memory_restart …）。改過本檔之後 reload 與 restart 都不會套用新值，要：
//      pm2 delete portal && pm2 start ecosystem.config.js && pm2 save
// 本服務在主機上的 port。真相同時記在 /home/service/service.json 的 port 欄位
// （deploy.sh 的部署後健康檢查讀它），兩邊要一致——改一邊就改兩邊。
// PORT env 可覆蓋，方便臨時錯開或在別的機器上跑。
const PORT = Number(process.env.PORT) || 3001;

module.exports = {
  apps: [
    {
      // 名稱＝服務註冊表的 id。deploy.sh 的 pm2 reload 依賴它，永不改名。
      name: "portal",
      cwd: __dirname,
      // 不直接指 next 的入口：中間隔一層 pm2-start.sh，讓每次 start / restart 都
      // 先 git pull，拉到新 commit 才重新 build。指定 interpreter 才不會被 pm2
      // 當成 JS require（pnpm 的 .bin/* 是 shell shim，直接 require 會炸）。
      script: __dirname + "/pm2-start.sh",
      interpreter: "bash",
      args: String(PORT),
      // 8 GB 的機器跑一整排 Next，cluster 沒有意義。
      exec_mode: "fork",
      instances: 1,

      // ── 資源控管 ──────────────────────────────────────────────────────
      autorestart: true,
      // 2026-09-02 事故結論。512M 太緊（meeting 開會峰值 RSS 562 MB），被 pm2 砍到
      // 第 5 次時撞上 pm2 內部 race，上限被記成 0 → 之後每 30 秒重啟一次。
      // 1G 是頭寸不是預算；峰值再超過就要查漏，不是再往上調。
      max_memory_restart: "1G",
      // 防 crash loop：起來撐不過 min_uptime 就算失敗，連續 max_restarts 次之後
      // pm2 標成 errored 停手，不再無限重啟燒 CPU、灌爆磁碟。
      min_uptime: "30s",
      max_restarts: 10,
      // 失敗重啟間隔指數退避（0.2s → 最多 15s），取代固定 restart_delay。
      exp_backoff_restart_delay: 200,
      // 預設 1600ms 對 Next 太短：cleanup 要等 server.close() 收完所有連線，
      // 有 SSE 的服務每次都會被 SIGKILL（進行中的查詢直接斷）。
      kill_timeout: 5000,
      // log 也是資源。輪替由 pm2-logrotate module 負責（deploy.sh 會自動安裝），
      // 這裡只打上時間戳——事後對照事故時間才查得動。
      time: true,

      env: {
        NODE_ENV: "production",
        // V8 預設 heap limit ~1.5 GB，不到那個數字不積極 GC，RSS 會一路長到撞上面的
        // 1G 線。384 MB 逼它提早回收；非 heap（Buffer、pg 連線）約 100–150 MB，
        // 正常情況下 RSS 碰不到上限。
        // ⚠️ 走 bash interpreter，所以不能用 node_args（那是給 node interpreter 的）。
        //    pm2-start.sh 在 build 時會自行覆蓋這個值（build 要的記憶體遠不止 384 MB）。
        NODE_OPTIONS: "--max-old-space-size=384",
        PORT: String(PORT),
        HOSTNAME: "127.0.0.1",
      },
    },
  ],
};
