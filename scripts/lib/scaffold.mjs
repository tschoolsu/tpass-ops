// tpass new <id>：把新服務登記進 services.json、重生本機憑證，
// 並印出「自動化不了的人工步驟」完整清單（root/nginx/DNS/OAuth 都是人的工作）。
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { OPS_ROOT, registry, services } from "./registry.mjs";
import { setup } from "./build.mjs";

export async function newService(idArg) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = async (q, dflt) => ((await rl.question(`${q}${dflt !== undefined ? ` [${dflt}]` : ""}： `)).trim() || String(dflt ?? ""));

  const id = idArg || (await ask("服務 id（短名，如 vote）"));
  if (services.some((s) => s.id === id)) {
    console.error(`✗ id「${id}」已存在`);
    process.exit(2);
  }
  const name = await ask("顯示名稱", `T-${id[0].toUpperCase()}${id.slice(1)}`);
  const dir = await ask("repo 目錄名", `tpass-${id}`);
  const subdomain = await ask("子網域", id);
  const maxPort = Math.max(...services.map((s) => s.port));
  const port = Number(await ask("port", maxPort + 1));
  const hasDb = (await ask("需要 PostgreSQL？(y/N)", "N")).toLowerCase() === "y";
  rl.close();

  const svc = {
    id, name, dir, subdomain, port,
    db: hasDb ? { name: `t_${id}`, user: `t_${id}`, strategy: "migrate" } : null,
    enabled: true,
    deployed: false,
  };
  const file = join(OPS_ROOT, "services.json");
  const data = JSON.parse(readFileSync(file, "utf8"));
  data.services.push(svc);
  writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
  console.log(`✅ 已登記進 services.json：${JSON.stringify(svc)}`);

  console.log("\n== 重生本機 mkcert 憑證（納入新子網域）==");
  console.log("（跑 tpass setup 會一併處理 pnpm install / 金鑰 / DB；只想重生憑證可手動 mkcert）");
  await setup();

  const prod = `${subdomain}.${registry.domains.prod}`;
  const devU = `https://${subdomain}.${registry.domains.dev}:${port}`;
  console.log(`
────────────────────────────────────────────────────────
🧾 人工步驟清單（自動化不了的部分，照順序做）：

1. 建 repo：照 tpass-portal/src/lib/tpass-auth.ts 做後端驗章（四鐵則），
   文檔骨架見 tpass-ops docs/SERVICE-TEMPLATE.md。本機測試： tpass dev ${id}

2. tpass-auth 的服務白名單加入新 audience（契約 v2）：
   auth/.env.local 的 AUTH_SERVICE_IDS 加上「${id}」→ 重啟 auth。

3. tpass-portal/src/config/services.ts 加發射台卡片：
   { id: "${id}", name: "${name}", url: "https://${prod}", icon: <LucideIcon>, tone: "...", roles: ["all"], enabled: true },

4. Google OAuth（僅當服務要自己跑 OAuth 才需要；一般消費端不用）——通常跳過。

5. 上線（依 docs/MERGE-AND-DEPLOY.md 的新服務段落）：
   a. Cloudflare DNS：新增 A 記錄 ${prod} → 主機 IP（先灰雲）
   b. [需 root] nginx vhost —— 把下面這塊交給主機維運部員：
      server {
          listen 443 ssl http2;
          server_name ${prod};
          ssl_certificate     /etc/letsencrypt/live/${prod}/fullchain.pem;
          ssl_certificate_key /etc/letsencrypt/live/${prod}/privkey.pem;
          location / {
              proxy_pass http://127.0.0.1:${port};
              proxy_set_header Host $host;
              proxy_set_header X-Forwarded-Proto https;
              proxy_set_header X-Real-IP $remote_addr;
          }
      }
      （先 certbot certonly --nginx -d ${prod}，成功後 Cloudflare 轉橘雲）
${hasDb ? `   c. [需 root] 主機建 DB（交給維運部員）：
      sudo -u postgres psql -c "CREATE ROLE t_${id} LOGIN PASSWORD '<隨機強密碼>';"
      sudo -u postgres psql -c "CREATE DATABASE t_${id} OWNER t_${id};"
` : ""}   d. 主機 clone repo 到 ~/tpass/${dir}、填 .env.local（對照 src/config REQUIRED）
   e. services.json 把 ${id} 的 deployed 改 true → commit → merge
   f. tpass deploy ${id}（deploy.sh 會自動 pm2 startOrReload）→ pm2 save
────────────────────────────────────────────────────────`);
}
