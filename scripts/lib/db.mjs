// 本機 Postgres 自動化：建 role/db（冪等）、補 .env.local 的 DATABASE_URL、跑 prisma。
// 慣例：每服務獨立 role + db，名稱 = services.json 的 db.user / db.name（t_<id>）。
// 注意：Prisma CLI 只讀 .env，不讀 .env.local —— 跑 prisma 前先把 .env.local 匯入環境。
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync, copyFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { byId, dbUrl, hasRepo, repoDir, serverRoot } from "./registry.mjs";
import { ssh } from "./deploy.mjs";
import { setEnv } from "./env.mjs";
import { commandExists, run } from "./sh.mjs";

function psql(sql) {
  return spawnSync("psql", ["-d", "postgres", "-tAc", sql], { encoding: "utf8" });
}

async function ensurePostgresRunning() {
  if (!commandExists("psql")) {
    console.error("✗ 找不到 psql，請先： brew install postgresql@17 && brew services start postgresql@17");
    process.exit(1);
  }
  if (spawnSync("pg_isready", ["-q"]).status === 0) return;
  console.log("   Postgres 未啟動，嘗試 brew services start …");
  const list = spawnSync("brew", ["services", "list"], { encoding: "utf8" }).stdout || "";
  const formula = list.split("\n").map((l) => l.split(/\s+/)[0]).find((n) => n && n.startsWith("postgresql"));
  if (!formula) {
    console.error("✗ 找不到已安裝的 postgresql formula。brew install postgresql@17 後重試。");
    process.exit(1);
  }
  await run("brew", ["services", "start", formula]).done;
  for (let i = 0; i < 15; i++) {
    if (spawnSync("pg_isready", ["-q"]).status === 0) return;
    await new Promise((r) => setTimeout(r, 1000));
  }
  console.error("✗ Postgres 啟動逾時。手動檢查： brew services list && pg_isready");
  process.exit(1);
}

// 解析 .env / .env.local（KEY=VALUE，去引號；.env.local 優先），供 prisma 子程序用
export function parseEnvLocal(dir) {
  const env = {};
  for (const name of [".env", ".env.local"]) {
    const file = join(dir, name);
    if (!existsSync(file)) continue;
    for (const line of readFileSync(file, "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
      if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
  return env;
}

export async function dbSetup(id) {
  const s = byId(id);
  if (!s.db) {
    console.log(`   （${s.id} 無資料庫，略過）`);
    return;
  }
  if (!hasRepo(s)) {
    console.log(`   （${s.id} 的 repo 不在本機，略過）`);
    return;
  }
  const dir = repoDir(s);
  console.log(`== db setup ${s.id}（role=${s.db.user} db=${s.db.name}）==`);
  await ensurePostgresRunning();

  if (!psql(`SELECT 1 FROM pg_roles WHERE rolname='${s.db.user}'`).stdout.trim()) {
    console.log(`   建 role ${s.db.user}`);
    psql(`CREATE ROLE ${s.db.user} LOGIN`);
  }
  if (!psql(`SELECT 1 FROM pg_database WHERE datname='${s.db.name}'`).stdout.trim()) {
    console.log(`   建 db ${s.db.name}`);
    spawnSync("createdb", ["-O", s.db.user, s.db.name], { stdio: "inherit" });
  }

  // strategy:"none" ＝ 有資料庫但不是 Prisma（例：直接用 pg）。role 與 db 的建立是通用的，
  // 到此為止；schema 與連線字串的 env key 由服務自己管——這裡不該猜它叫什麼名字。
  if (s.db.strategy === "none") {
    console.log(`   ✅ ${s.id} role/db 就緒（非 Prisma：schema 與連線字串 env 由服務自理）`);
    return;
  }

  // env 檔：優先沿用既有的 .env.local / .env；都沒有才從範本建 .env.local。
  // 缺 DATABASE_URL 才 append，絕不覆寫既有值。
  let envFile = [".env.local", ".env"].map((f) => join(dir, f)).find(existsSync);
  if (!envFile) {
    envFile = join(dir, ".env.local");
    if (existsSync(join(dir, ".env.example"))) {
      copyFileSync(join(dir, ".env.example"), envFile);
      console.log("   已從 .env.example 建立 .env.local（其餘值請自行填）");
    }
  }
  const combined = Object.keys(parseEnvLocal(dir));
  if (existsSync(envFile) && !combined.includes("DATABASE_URL")) {
    appendFileSync(envFile, `\nDATABASE_URL=${dbUrl(s)}\n`);
    console.log(`   已寫入 DATABASE_URL=${dbUrl(s)}`);
  }

  const env = parseEnvLocal(dir);
  console.log("   prisma generate");
  if ((await run("pnpm", ["run", "db:generate"], { cwd: dir, env, label: s.id }).done) !== 0) process.exit(1);
  if (s.db.strategy === "migrate") {
    console.log("   prisma migrate dev（套用 migrations）");
    if ((await run("pnpm", ["exec", "prisma", "migrate", "dev"], { cwd: dir, env, label: s.id }).done) !== 0) process.exit(1);
  } else {
    console.log("   prisma db push");
    if ((await run("pnpm", ["run", "db:push"], { cwd: dir, env, label: s.id }).done) !== 0) process.exit(1);
  }
  console.log(`   ✅ ${s.id} 資料庫就緒`);
}

export async function dbReset(id) {
  if (!id || id === "all") {
    console.error("✗ db reset 需指定單一服務（拒絕 all）");
    process.exit(2);
  }
  const s = byId(id);
  if (!s.db) {
    console.error(`✗ ${s.id} 沒有資料庫`);
    process.exit(2);
  }
  console.log(`⚠️  即將 DROP 本機資料庫 ${s.db.name}（${s.id}），資料全數消失。`);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(`確認請輸入服務 id「${s.id}」： `);
  rl.close();
  if (answer.trim() !== s.id) {
    console.log("已取消。");
    return;
  }
  await ensurePostgresRunning();
  spawnSync("dropdb", ["--if-exists", s.db.name], { stdio: "inherit" });
  await dbSetup(id);
}

// 遠端建庫：同一 PG 實例開 role+db（冪等），生成密碼寫進遠端 .env.local 的 DATABASE_URL。
// 免每次 root —— 前提是 deploy 帳號經 peer auth 對到有 CREATEDB/CREATEROLE 的 PG 角色
// （一次性 root 授權見 docs/ONBOARDING.md）。dbSetup 那套 SQL 原封搬過來，只是把本機 spawnSync 換成 ssh。
export function dbCreateRemote(id) {
  const s = byId(id);
  if (!s.db) {
    console.error(`✗ ${s.id} 在 services.json 沒有 db 設定（db:null）`);
    process.exit(2);
  }
  // 目錄需先在主機 clone —— 否則沒地方寫 DATABASE_URL；先擋，避免建出「role/db 已建但 env 沒寫」的半套。
  const dir = `${serverRoot}/${s.dir}`;
  if (ssh(`test -d ${dir} && echo ok`, { capture: true }).stdout.trim() !== "ok") {
    console.error(`✗ 主機目錄 ${dir} 不存在——請先在主機 git clone repo 再建 DB（見 docs/NEW-SERVICE.md〈部署〉）`);
    process.exit(2);
  }
  const { user, name } = s.db;
  const q = (sql) => ssh(`psql -d postgres -tAc ${JSON.stringify(sql)}`, { capture: true });
  const exec = (sql) => ssh(`psql -d postgres -c ${JSON.stringify(sql)}`);

  console.log(`== 遠端 db create ${s.id}（role=${user} db=${name}）==`);
  const roleQ = q(`SELECT 1 FROM pg_roles WHERE rolname='${user}'`);
  if (roleQ.status !== 0) {
    console.error(`✗ 無法查詢主機 postgres（ssh/psql exit ${roleQ.status}）。`);
    console.error(`  請先由 root 授權 deploy 帳號：sudo -u postgres psql -c "CREATE ROLE <deploy_user> LOGIN CREATEDB CREATEROLE;"（見 docs/ONBOARDING.md）`);
    process.exit(1);
  }
  const roleExists = roleQ.stdout.trim();
  const dbExists = q(`SELECT 1 FROM pg_database WHERE datname='${name}'`).stdout.trim();
  if (roleExists && dbExists) {
    console.log(`   （${name} 已存在，略過；不動既有密碼）`);
    return;
  }

  const pw = randomBytes(24).toString("base64url"); // 僅 [A-Za-z0-9_-]，內嵌單引號 SQL 與 URL 皆免跳脫
  if (!roleExists) {
    console.log(`   建 role ${user}`);
    if (exec(`CREATE ROLE ${user} LOGIN PASSWORD '${pw}'`).status !== 0) process.exit(1);
  } else {
    console.log(`   role ${user} 已存在 → 輪替密碼（db 尚缺，需重寫 DATABASE_URL）`);
    if (exec(`ALTER ROLE ${user} PASSWORD '${pw}'`).status !== 0) process.exit(1);
  }
  if (!dbExists) {
    console.log(`   建 db ${name}`);
    if (exec(`CREATE DATABASE ${name} OWNER ${user}`).status !== 0) process.exit(1);
  }

  try {
    setEnv(id, "DATABASE_URL", `postgresql://${user}:${pw}@localhost:5432/${name}`);
  } catch (e) {
    console.error(`✗ 寫入遠端 DATABASE_URL 失敗：${e.message}`);
    process.exit(1);
  }
  console.log(`✅ ${s.id} DB 就緒（DATABASE_URL 已寫入遠端 .env.local）。套用 schema： tpass deploy ${s.id}`);
}
