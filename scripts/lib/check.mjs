// push 前把關：next typegen + lint + tsc --noEmit（不靠跑 dev server 驗證）。
// checkEnv：驗 .env.local 是否含所有必填 key。必填清單的真相來源＝各 repo
// src/config/*.ts 的 REQUIRED 陣列（跟 runtime 同一份，不會漂移），不是 .env.example。
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { repoDir, resolveTarget } from "./registry.mjs";
import { run } from "./sh.mjs";

// 解析 repo 的 REQUIRED[] env key（與 deploy/deploy.sh 的 awk 版同語意）
// tpass-auth-js 的 configFromEnv() 一定會要的五顆（第六顆是呼叫時傳進去的 <SVC>_SELF_URL）。
const TPASS_AUTH_KEYS = [
  "AUTH_JWKS_URL",
  "AUTH_AUTHORIZE_URL",
  "AUTH_LOGOUT_URL",
  "TPASS_SERVICE_ID",
  "JWT_ISSUER",
];

export function requiredEnvKeys(svc) {
  // 有 src/ 的服務在 src/config，沒有的（notes、meeting）在根目錄 config——兩處都找，掃不到＝少檢查。
  const cfgDir = ["src/config", "config"].map((p) => join(repoDir(svc), p)).find((p) => existsSync(p));
  const keys = new Set();
  if (!cfgDir) return keys;
  for (const f of readdirSync(cfgDir).filter((f) => f.endsWith(".ts"))) {
    const src = readFileSync(join(cfgDir, f), "utf8");
    for (const m of src.matchAll(/REQUIRED\s*=\s*\[([^\]]*)\]/gs)) {
      for (const k of m[1].matchAll(/"([A-Z][A-Z0-9_]*)"/g)) keys.add(k[1]);
    }
    // C1 之後：SSO 那幾顆 env 的必填檢查搬進套件的 configFromEnv()，服務的 REQUIRED 陣列
    // 只剩自己的 key。掃不到它們，缺 key 就不會在這裡被擋下，而是等到 build 匯入 config
    // 才炸（正是 2026-07-28 那個坑）。所以認得那個呼叫，把套件要的 key 補回來。
    // ⚠️ 這份清單是 tpass-auth-js 的 configFromEnv 的複本——ops 層不能 import 服務的依賴。
    //    套件那邊改必填清單時，這裡要跟著改（那份的真相在 tpass-auth-js/src/index.ts）。
    for (const m of src.matchAll(/configFromEnv\(\s*"([A-Z][A-Z0-9_]*)"/g)) {
      keys.add(m[1]);
      for (const k of TPASS_AUTH_KEYS) keys.add(k);
    }
  }
  return keys;
}

export function checkEnv(svc) {
  // 本機接受 .env.local 或 .env（歷史上部分 repo 為了 Prisma 6 的 CLI 用 .env）；key 在任一檔即算有
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
    // Next 16 把 route 的型別（RouteContext…）生成在 .next/types/ 底下，是 build 的產物。
    // 開發機通常一直有 .next 所以感覺不到，但**全新 clone 上 tsc 會直接噴
    // 「Cannot find name 'RouteContext'」**——新人第一件事跑 check 就撞到，還會以為是自己弄壞的。
    // typegen 只生型別不做 build，一秒，冪等。（CI 的 workflow 也放了同一步，同樣理由。）
    console.log(`== ${s.id} : next typegen ==`);
    if ((await run("pnpm", ["exec", "next", "typegen"], { cwd: dir, label: s.id }).done) !== 0) fail = true;
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
