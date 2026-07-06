// PM2 設定：app 清單完全由 ../services.json（唯一真相）派生，只取 deployed:true。
// 放在伺服器上 ~/tpass/deploy/，各 repo 與本檔同層（~/tpass 即 tpass-ops repo clone）。
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
const path = require("node:path");
const ROOT = path.join(__dirname, ".."); // ~/tpass（deploy/ 的上一層）
const { services } = require(path.join(ROOT, "services.json"));

module.exports = {
  apps: services
    .filter((s) => s.deployed)
    .map((s) => ({
      name: s.id,
      cwd: path.join(ROOT, s.dir),
      script: "./node_modules/.bin/next",
      args: `start -H 127.0.0.1 -p ${s.port}`,
      exec_mode: "fork",
      instances: 1,
      autorestart: true,
      max_memory_restart: "512M",
      env: { NODE_ENV: "production", PORT: String(s.port), HOSTNAME: "127.0.0.1" },
    })),
};
