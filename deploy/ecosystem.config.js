// PM2 設定：app 清單完全由 ../tpass-registry/services.json（唯一真相）派生，只取 deployed:true。
// 放在伺服器上 ~/tpass/deploy/（~/tpass 即 tpass-ops repo clone，註冊表與本檔同層）。
// 各服務 repo 則住 registry 的 server.servicesRoot（＝ /home/service/<dir>，一個服務一層）。
// TLS / 對外入口由 nginx（root 管）+ Cloudflare 橘色雲負責，app 只綁 127.0.0.1。
//
// 用法（伺服器上）：
//   pm2 start ecosystem.config.js     # 首次啟動
//   pm2 save && pm2 startup           # 開機自啟
//   pm2 startOrReload ecosystem.config.js --only <name>   # 部署後（deploy.sh 會自動呼叫）
//
// 重點：
//   - 每個 app 只跑 `next start`（純 HTTP，綁 127.0.0.1），TLS 由 nginx 終結。
//   - 密值（金鑰 / OAuth / DATABASE_URL）放各 repo 的 .env.local，Next 自動載入，
//     不寫死在此檔，也不進 git。
//   - app 名稱 = services.json 的 id，deploy.sh 的 pm2 reload 依賴它，永不改名。
const os = require("node:os");
const path = require("node:path");
const ROOT = path.join(__dirname, ".."); // ~/tpass（deploy/ 的上一層）
const REGISTRY_FILE = path.join(ROOT, "tpass-registry", "services.json");
const { services, server } = require(REGISTRY_FILE);

// 服務 repo 的家。註冊表沒宣告（舊版）就退回舊佈局＝與 ops repo 同層，不會突然把 cwd 指到不存在的路徑。
const expand = (p) => (p && p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : p);
const SERVICES_ROOT = expand(server && server.servicesRoot) || ROOT;

module.exports = {
  apps: services
    // hosting:"external"（例如純前端、託管在 GitHub Pages 的服務）沒有 Next 行程可跑，
    // deployed:true 對它只代表「大廳卡片顯示」——不歸 pm2 管，跳過。
    .filter((s) => s.deployed && (s.hosting ?? "host") !== "external")
    .map((s) => ({
      name: s.id,
      cwd: path.join(SERVICES_ROOT, s.dir),
      // 指向 next 真正的 JS 入口，不走 node_modules/.bin：pm2 是把 script 當 JS require 的，
      // 而 pnpm 的 .bin/* 是 shell shim（npm 時代是 JS symlink 才僥倖能跑）。
      script: "./node_modules/next/dist/bin/next",
      args: `start -H 127.0.0.1 -p ${s.port}`,
      exec_mode: "fork",
      instances: 1,
      autorestart: true,
      // 1G：2026-09-02 meeting 開會中 RSS 到 562 MB，原本的 512M 讓 pm2 合法砍了它 5 次，
      // 第 5 次撞上 pm2 內部 race，上限被記成 0 → 之後每 30 秒重啟一次。主機 8 GB、八個 app
      // 閒置各 ~250 MB，1G 是頭寸不是預算；開會峰值再超過就要查漏，不是再調高。
      max_memory_restart: "1G",
      // 預設 1600ms 對 Next 太短：它的 cleanup 等 server.close() 收完所有連線，有 SSE 的服務
      // 每次都被 SIGKILL（進行中的查詢直接斷）。服務端要配合處理 SIGINT 主動關長連線。
      kill_timeout: 5000,
      // ⚠️ 這些選項只在 pm2 第一次建立 app 時生效。有人用 `pm2 restart <svc> --max-memory-restart …`
      // 之類的 CLI 旗標手改過之後，startOrReload 救不回來——要 `pm2 delete <svc>` 再
      // `pm2 start ecosystem.config.js --only <svc>` 重建。主機上不要手打 pm2 選項。
      // TPASS_REGISTRY_PATH：服務住 /home/service/<dir>、註冊表住 ~/tpass/tpass-registry，
      // 主機上「../tpass-registry」不再成立（本機仍成立）。由 ops 層在這裡注入絕對路徑，
      // 各服務的程式碼與 .env.local 都不用為主機佈局改一個字。
      env: {
        NODE_ENV: "production",
        PORT: String(s.port),
        HOSTNAME: "127.0.0.1",
        TPASS_REGISTRY_PATH: REGISTRY_FILE,
      },
    })),
};
