// 本機 Postgres 自動化：建 role/db（冪等）、補 .env.local 的 DATABASE_URL、跑 prisma。
// 慣例：每服務獨立 role + db，名稱 = services.json 的 db.user / db.name（t_<id>）。
// 注意：Prisma CLI 只讀 .env，不讀 .env.local —— 跑 prisma 前先把 .env.local 匯入環境。
import { spawnSync } from "node:child_process";
import { appendFileSync, copyFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { byId, dbUrl, repoDir } from "./registry.mjs";
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
  if ((await run("npm", ["run", "db:generate"], { cwd: dir, env, label: s.id }).done) !== 0) process.exit(1);
  if (s.db.strategy === "migrate") {
    console.log("   prisma migrate dev（套用 migrations）");
    if ((await run("npx", ["prisma", "migrate", "dev"], { cwd: dir, env, label: s.id }).done) !== 0) process.exit(1);
  } else {
    console.log("   prisma db push");
    if ((await run("npm", ["run", "db:push"], { cwd: dir, env, label: s.id }).done) !== 0) process.exit(1);
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
