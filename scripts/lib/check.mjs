// push 前把關：lint + tsc --noEmit（不靠跑 dev server 驗證）。
// checkEnv：驗 .env.local 是否含所有必填 key。必填清單的真相來源＝各 repo
// src/config/*.ts 的 REQUIRED 陣列（跟 runtime 同一份，不會漂移），不是 .env.example。
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { repoDir, resolveTarget } from "./registry.mjs";
import { run } from "./sh.mjs";

// 解析 repo 的 REQUIRED[] env key（與 deploy/deploy.sh 的 awk 版同語意）
export function requiredEnvKeys(svc) {
  const cfgDir = join(repoDir(svc), "src", "config");
  const keys = new Set();
  if (!existsSync(cfgDir)) return keys;
  for (const f of readdirSync(cfgDir).filter((f) => f.endsWith(".ts"))) {
    const src = readFileSync(join(cfgDir, f), "utf8");
    for (const m of src.matchAll(/REQUIRED\s*=\s*\[([^\]]*)\]/gs)) {
      for (const k of m[1].matchAll(/"([A-Z][A-Z0-9_]*)"/g)) keys.add(k[1]);
    }
  }
  return keys;
}

export function checkEnv(svc) {
  // 本機接受 .env.local 或 .env（Prisma CLI 只讀 .env，部分 repo 用它）；key 在任一檔即算有
  const files = [".env.local", ".env"].map((f) => join(repoDir(svc), f)).filter(existsSync);
  if (files.length === 0) return { ok: false, missing: [...requiredEnvKeys(svc)], noFile: true };
  const content = files.map((f) => readFileSync(f, "utf8")).join("\n");
  const missing = [...requiredEnvKeys(svc)].filter(
    (k) => !new RegExp(`^\\s*${k}=`, "m").test(content)
  );
  return { ok: missing.length === 0, missing, noFile: false };
}

export async function check(target) {
  let fail = false;
  for (const s of resolveTarget(target)) {
    const dir = repoDir(s);
    console.log(`== ${s.id} : lint ==`);
    if ((await run("pnpm", ["run", "lint"], { cwd: dir, label: s.id }).done) !== 0) fail = true;
    console.log(`== ${s.id} : tsc --noEmit ==`);
    if ((await run("pnpm", ["exec", "tsc", "--noEmit"], { cwd: dir, label: s.id }).done) !== 0) fail = true;
  }
  console.log(fail ? "❌ 有錯誤，見上方輸出" : "✅ all green");
  process.exit(fail ? 1 : 0);
}

export function checkEnvCmd(target) {
  let fail = false;
  for (const s of resolveTarget(target)) {
    const r = checkEnv(s);
    if (r.noFile) {
      console.log(`❌ ${s.id}: 缺 ${s.dir}/.env.local（範本見 .env.example）`);
      fail = true;
    } else if (!r.ok) {
      console.log(`❌ ${s.id}: .env.local 缺必填 key： ${r.missing.join(" ")}`);
      fail = true;
    } else {
      console.log(`✅ ${s.id}: env 完整`);
    }
  }
  process.exit(fail ? 1 : 0);
}
