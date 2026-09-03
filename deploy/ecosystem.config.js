// PM2 設定（ops 層 fallback）。
//
// ⚠️ 2026-09-03 起，每個服務 repo 根目錄都有自己的 ecosystem.config.js + pm2-start.sh，
//    deploy.sh 一律優先用那份。這個檔只服務「還沒有自己那份」的 repo（目前只有 notes），
//    是遷移期的退路，不是主要路徑。新服務不要靠它。
//
// app 清單完全由服務註冊表（唯一真相）派生，只取 deployed:true 且跑在本機的服務。
// 放在伺服器上 ~/tpass/deploy/（~/tpass 即 tpass-ops repo clone）。
// 各服務 repo 住 registry 的 server.servicesRoot（＝ /home/service/<dir>，一個服務一層）。
// TLS / 對外入口由 nginx（root 管）+ Cloudflare 橘色雲負責，app 只綁 127.0.0.1。
//
// 用法（伺服器上）：
//   pm2 start ecosystem.config.js     # 首次啟動
//   pm2 save && pm2 startup           # 開機自啟
//   pm2 startOrReload ecosystem.config.js --only <name>   # 部署後（deploy.sh 會自動呼叫）
//
// 重點：
//   - 每個 app 跑 start-service.sh：先 git pull，再 exec 成 next start（純 HTTP，綁 127.0.0.1）。
//   - 密值（金鑰 / OAuth / DATABASE_URL）放各 repo 的 .env.local，Next 自動載入，
//     不寫死在此檔，也不進 git。
//   - app 名稱 = 註冊表的 id，deploy.sh 的 pm2 reload 依賴它，永不改名。
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.join(__dirname, ".."); // ~/tpass（deploy/ 的上一層）

// 註冊表位置。主機上是 /home/service/service.json（單一裸檔，維運組直接維護）；
// 本機開發沒有那個路徑，退回並排 clone 的 tpass-registry repo。
// TPASS_REGISTRY_FILE 是逃生門（測試、非標準佈局）。
const REGISTRY_FILE =
  process.env.TPASS_REGISTRY_FILE ||
  ["/home/service/service.json", path.join(ROOT, "tpass-registry", "services.json")].find((p) => fs.existsSync(p));

if (!REGISTRY_FILE) {
  throw new Error(
    "[ecosystem] 找不到服務註冊表：/home/service/service.json 與 ../tpass-registry/services.json 都不存在。",
  );
}

const { services, server } = JSON.parse(fs.readFileSync(REGISTRY_FILE, "utf8"));

// 服務 repo 的家。註冊表沒宣告就退回舊佈局＝與 ops repo 同層，不會突然把 cwd 指到不存在的路徑。
const expand = (p) => (p && p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : p);
const SERVICES_ROOT = expand(server && server.servicesRoot) || ROOT;
const START = path.join(__dirname, "start-service.sh");

// hosting:"external"（例如 law＝純前端、託管在 GitHub Pages）沒有 Next 行程可跑，
// deployed:true 對它只代表「大廳卡片顯示」——不歸 pm2 管，跳過。
const managed = services.filter((s) => s.deployed && (s.hosting ?? "host") !== "external");

// port 撞車不擋啟動（註冊表可能處於中間狀態），但一定要吵。
// 同一台機器上兩個 app 綁同一個 127.0.0.1:<port>，第二個會 EADDRINUSE 進 crash loop。
const seen = new Map();
for (const s of managed) {
  if (seen.has(s.port)) {
    console.error(`[ecosystem] ⚠️ port ${s.port} 被 ${seen.get(s.port)} 與 ${s.id} 同時使用——第二個起不來。`);
  }
  seen.set(s.port, s.id);
}

module.exports = {
  apps: managed.map((s) => {
    const cwd = path.join(SERVICES_ROOT, s.dir);
    return {
      name: s.id,
      cwd,
      // 不直接指 next 的 JS 入口：中間隔一層 bash wrapper，讓每次 start/restart 都先 git pull。
      // 指定 interpreter 才不會被 pm2 當成 JS require。
      script: START,
      interpreter: "bash",
      args: `${cwd} ${s.port}`,
      exec_mode: "fork",
      instances: 1,

      // ── 資源控管 ───────────────────────────────────────────────────────────
      autorestart: true,
      // 2026-09-02 meeting 開會中 RSS 到 562 MB，原本的 512M 讓 pm2 合法砍了它 5 次，
      // 第 5 次撞上 pm2 內部 race，上限被記成 0 → 之後每 30 秒重啟一次。
      // 1G 是頭寸不是預算；峰值再超過就要查漏，不是再調高。
      max_memory_restart: "1G",
      // V8 預設 heap limit ~1.5 GB，不到那個數字不積極 GC；PM2 在 1G 就殺，
      // 兩者之間的落差讓 V8 不急著回收，RSS 持續成長直到觸發重啟。
      // 384 MB 讓 V8 提早積極 GC；非 heap（Buffer、pg 連線）約 100–150 MB，
      // RSS 正常情況下碰不到 1G 線。
      // ⚠️ 走 bash interpreter，所以不能用 node_args（那是給 node interpreter 的），
      //    要靠 NODE_OPTIONS 傳給 wrapper exec 出來的 node。見下面 env。
      //
      // 防 crash loop：啟動後撐不過 min_uptime 就算失敗，連續 max_restarts 次後
      // pm2 標成 errored 停手，不再無限重啟燒 CPU / 灌爆 log（9/2 的每 30 秒重啟就是這個形狀）。
      min_uptime: "30s",
      max_restarts: 10,
      // 每次失敗重啟的間隔指數退避（100ms → 最多 15s），取代固定 restart_delay。
      exp_backoff_restart_delay: 200,
      // 預設 1600ms 對 Next 太短：它的 cleanup 等 server.close() 收完所有連線，有 SSE 的服務
      // 每次都被 SIGKILL（進行中的查詢直接斷）。服務端要配合處理 SIGINT 主動關長連線。
      kill_timeout: 5000,
      // log 也是資源：pm2 預設不輪替，跑久了單檔可以吃掉整顆磁碟。
      // 靠 pm2-logrotate module 收（安裝方式見 handoff/README.md），這裡只把時間戳打上，
      // 事後對照事故時間才有得查。
      time: true,

      // TPASS_REGISTRY_PATH：服務住 /home/service/<dir>、註冊表住 /home/service/service.json，
      // 服務程式碼裡的「../tpass-registry/services.json」在主機上不成立（本機仍成立）。
      // 由 ops 層在這裡注入絕對路徑，各服務的程式碼與 .env.local 都不用為主機佈局改一個字。
      env: {
        NODE_ENV: "production",
        NODE_OPTIONS: "--max-old-space-size=384",
        PORT: String(s.port),
        HOSTNAME: "127.0.0.1",
        TPASS_REGISTRY_PATH: REGISTRY_FILE,
      },
    };
  }),
};
