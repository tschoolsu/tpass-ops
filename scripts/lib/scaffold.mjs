// tpass new <id>：把新服務寫進 tpass-registry 的 services.json、重生本機憑證，
// 並印出「自動化不了的人工步驟」（DNS / nginx / certbot / 建 DB 都是人的工作）。
//
// ⚠️ 這支只改**本機**的 registry 檔。註冊要生效，得在 tpass-registry 開 PR 並 merge——
// auth 的發證白名單與 portal 的大廳卡片都是從那個 repo 的 main 派生的。
import { readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { REGISTRY_DIR, REGISTRY_FILE, registry, services } from "./registry.mjs";
import { run } from "./sh.mjs";
import { setup } from "./build.mjs";

const TONES = ["green", "blue", "orange", "violet", "rose"];

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

  // portal 區塊選填：沒有這塊就不進大廳（純後端服務、或還沒想好長相）。
  const wantsCard = (await ask("要在門戶大廳出現一張卡片嗎？(Y/n)", "Y")).toLowerCase() !== "n";
  let portal = null;
  if (wantsCard) {
    const label = await ask("  卡片顯示名", name);
    const icon = await ask("  圖示（lucide 的 PascalCase 名，見 lucide.dev/icons）", "PackageSearch");
    const tone = await ask(`  配色（${TONES.join(" | ")}）`, "green");
    portal = { label, icon, tone, roles: ["all"] };
  }
  rl.close();

  const svc = {
    id, name, dir, subdomain, port,
    db: hasDb ? { name: `t_${id}`, user: `t_${id}`, strategy: "migrate" } : null,
    enabled: true,
    deployed: false,
    ...(portal ? { portal } : {}),
  };
  const data = JSON.parse(readFileSync(REGISTRY_FILE, "utf8"));
  data.services.push(svc);
  writeFileSync(REGISTRY_FILE, JSON.stringify(data, null, 2) + "\n");
  console.log(`✅ 已寫入 ${REGISTRY_FILE}`);

  console.log("\n== 驗證註冊表 ==");
  if ((await run("node", ["validate.mjs"], { cwd: REGISTRY_DIR }).done) !== 0) {
    console.error("✗ 註冊表驗證失敗，先修好再繼續（改動還在檔案裡，沒有自動還原）");
    process.exit(1);
  }

  console.log("\n== 重生本機 mkcert 憑證（納入新子網域）==");
  console.log("（tpass setup 會一併處理 pnpm install / 金鑰 / DB；只想重生憑證可手動 mkcert）");
  await setup();

  const prod = `${subdomain}.${registry.domains.prod}`;
  const devUrl = `https://${subdomain}.${registry.domains.dev}:${port}`;
  console.log(`
────────────────────────────────────────────────────────
🧾 接下來（照順序做）：

1. 讓註冊生效 —— 這一步沒做，前面等於什麼都沒發生：
     cd ${REGISTRY_DIR}
     git checkout -b add-${id} && git commit -am "registry: 登記 ${id}（${name}）"
     git push -u origin add-${id} && gh pr create --fill
   merge 之後，auth 的發證白名單與 portal 的大廳卡片會自動包含 ${id}。
   （portal 卡片還要等 deployed 翻 true，見第 5 步）

2. 建服務 repo，照 docs/NEW-SERVICE.md 串登入（驗章四鐵則）。
   參考實作：tpass-portal/src/lib/tpass-auth.ts + src/config/portal.ts。
   本機測試： cd ${dir} && pnpm dev   →  ${devUrl}

3. Cloudflare DNS：新增 A 記錄 ${prod} → 主機 IP（**先灰雲**，certbot 簽完再轉橘雲）

4. [需 root] 交給有 sudo 的維運在主機上執行：

   certbot certonly --nginx -d ${prod}

   nginx server block：
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
${hasDb ? `
   建資料庫：
       sudo -u postgres psql -c "CREATE ROLE t_${id} LOGIN PASSWORD '<隨機強密碼>';"
       sudo -u postgres psql -c "CREATE DATABASE t_${id} OWNER t_${id};"
` : ""}
5. 上線：主機 clone repo 到 ~/tpass/${dir}、填 .env.local（對照 src/config 的 REQUIRED），
   部署 ${id} 成功後，再開一個 registry PR 把 ${id} 的 deployed 翻成 true，
   然後重新部署 auth 與 portal（卡片才會出現在大廳）。
────────────────────────────────────────────────────────`);
}
