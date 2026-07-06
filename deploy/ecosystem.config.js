// PM2 設定：一檔管四個 app。放在伺服器上 ~/tpass/deploy/，
// 四 repo 與本檔同層（~/tpass/{tpass-auth,tpass-portal,tpass-form,tpass-cross_grade_messages}）。
// TLS / 對外入口由 nginx（root 管）+ Cloudflare 橘色雲負責，app 只綁 127.0.0.1。
//
// 用法（伺服器上）：
//   pm2 start ecosystem.config.js     # 首次啟動
//   pm2 save && pm2 startup           # 開機自啟
//   pm2 reload <name>                 # 部署後（deploy.sh 會自動呼叫）
//
// 重點：
//   - 每個 app 只跑 `next start`（純 HTTP，綁 127.0.0.1），TLS 由 Caddy 終結。
//   - 密值（金鑰 / OAuth / DATABASE_URL）放各 repo 的 .env.local，Next 自動載入，
//     不寫死在此檔，也不進 git。
const path = require("node:path");
const ROOT = path.join(__dirname, ".."); // ~/tpass（deploy/ 的上一層）

const app = (name, dir, port) => ({
  name,
  cwd: path.join(ROOT, dir),
  script: "./node_modules/.bin/next",
  args: `start -H 127.0.0.1 -p ${port}`,
  exec_mode: "fork",
  instances: 1,
  autorestart: true,
  max_memory_restart: "512M",
  env: { NODE_ENV: "production", PORT: String(port), HOSTNAME: "127.0.0.1" },
});

module.exports = {
  apps: [
    app("auth", "tpass-auth", 3000),
    app("portal", "tpass-portal", 3001),
    app("form", "tpass-form", 3002),
    app("msg", "tpass-cross_grade_messages", 3003),
    app("appeals", "tpass-appeals", 3004),
  ],
};
