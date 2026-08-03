// build：全部（或指定）repo pnpm run build。
// start：部署前 production smoke —— start:https（server.mjs，最貼近 prod 的 next start），
//        抓 dev 模式漏掉的 build / 型別 / RSC / React Compiler 行為差異。
// setup：一次性本機環境準備（冪等，重跑安全）。
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  CERT_DIR,
  ROOT,
  byId,
  dbServices,
  devHost,
  enabledServices,
  localServices,
  repoDir,
  resolveTarget,
} from "./registry.mjs";
import { commandExists, run, runParallel } from "./sh.mjs";
import { dbSetup } from "./db.mjs";

export async function build(target) {
  for (const s of resolveTarget(target)) {
    console.log(`== build ${s.id} ==`);
    const code = await run("pnpm", ["run", "build"], { cwd: repoDir(s), label: s.id }).done;
    if (code !== 0) {
      console.error(`❌ ${s.id} build 失敗`);
      process.exit(1);
    }
  }
  console.log("✅ build 完成");
}

export async function start(target) {
  await build(target);
  const jobs = resolveTarget(target).map((s) => {
    console.log(`▶ start:https ${s.id}`);
    return { cmd: "pnpm", args: ["run", "start:https"], opts: { cwd: repoDir(s), label: s.id } };
  });
  const ok = await runParallel(jobs);
  process.exit(ok ? 0 : 1);
}

export async function setup() {
  if (!commandExists("mkcert")) {
    console.error("✗ 找不到 mkcert，請先： brew install mkcert nss");
    process.exit(1);
  }
  console.log("== 1) 信任 mkcert 根憑證（已信任會直接略過）==");
  await run("mkcert", ["-install"]).done;

  const domains = enabledServices().map(devHost);
  console.log(`== 2) 產一張涵蓋 ${domains.length} 網域的憑證 → ${CERT_DIR} ==`);
  await run("mkdir", ["-p", CERT_DIR]).done;
  const code = await run("mkcert", ["-cert-file", "cert.pem", "-key-file", "key.pem", ...domains], {
    cwd: CERT_DIR,
  }).done;
  if (code !== 0) process.exit(1);

  // 各服務 package.json 的 `dev` 一律讀 $HOME/tpass-certs（那是部員版的路徑——他們沒有 ops repo）。
  // 這條 symlink 讓「有 ops repo 的人」打 pnpm dev 也拿得到同一張憑證：全生態只有一個憑證路徑，
  // 文件與 package.json 不必分兩種寫法。
  const link = join(process.env.HOME, "tpass-certs");
  if (!existsSync(link)) {
    console.log(`== 2b) symlink ${link} → ${CERT_DIR}（讓 pnpm dev 找得到憑證）==`);
    await run("ln", ["-s", CERT_DIR, link]).done;
  }

  console.log(`== 3) 安裝相依（${localServices().map((s) => s.dir).join(" / ")}）==`);
  for (const s of localServices()) {
    console.log(`   -> ${s.dir}`);
    if ((await run("pnpm", ["install"], { cwd: repoDir(s), label: s.id }).done) !== 0) process.exit(1);
  }

  console.log("== 4) 產 EdDSA 簽章金鑰（請貼進 auth/.env.local，若已有金鑰請沿用勿換）==");
  const auth = byId("auth");
  if (existsSync(join(repoDir(auth), "scripts", "gen-keys.mjs"))) {
    await run("node", ["scripts/gen-keys.mjs"], { cwd: repoDir(auth) }).done;
  }

  console.log("== 5) 本機資料庫（role / db / prisma；冪等）==");
  for (const s of dbServices()) await dbSetup(s.id);

  console.log(`
────────────────────────────────────────────────────────
接下來手動完成（一次）：
  1. 各 repo 複製 .env.example → .env.local 並填值（tpass db setup 已建好 DATABASE_URL）。
  2. tpass-auth/.env.local：貼上上面印出的 JWT_PRIVATE_KEY / JWT_PUBLIC_KEY 兩行。
  3. 所有 .env.local 都設（本機 HTTPS smoke 用 server.mjs 會讀）：
       TLS_KEY_FILE=${ROOT}/certs/key.pem
       TLS_CERT_FILE=${ROOT}/certs/cert.pem

完成後日常開發：
       tpass dev            # 內層，有 HMR
       tpass check          # push 前把關（lint + tsc）
       tpass start          # push 前 production smoke
────────────────────────────────────────────────────────`);
}
