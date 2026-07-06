// 部署 / 主機狀態，全部經 ssh 在本機發動——主機上永遠不裝任何部署工具。
// 主機位址/帳號是機密，只存在 gitignored 的 deploy/host.env。
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createConnection } from "node:net";
import { OPS_ROOT, ROOT, byId, deployedServices, devUrl, services } from "./registry.mjs";

function hostEnv() {
  const candidates = [join(ROOT, "deploy", "host.env"), join(OPS_ROOT, "deploy", "host.env")];
  const file = candidates.find(existsSync);
  if (!file) {
    console.error("✗ 缺 deploy/host.env — 先 cp deploy/host.env.example deploy/host.env 並填值");
    process.exit(1);
  }
  const env = {};
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z_]+)=(.*)$/);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  if (!env.DEPLOY_USER || !env.DEPLOY_HOST) {
    console.error("✗ deploy/host.env 缺 DEPLOY_USER / DEPLOY_HOST");
    process.exit(1);
  }
  return env;
}

export function ssh(remoteCmd, { capture = false } = {}) {
  const { DEPLOY_USER, DEPLOY_HOST } = hostEnv();
  const r = spawnSync("ssh", [`${DEPLOY_USER}@${DEPLOY_HOST}`, remoteCmd], {
    stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit",
    encoding: "utf8",
  });
  return { status: r.status ?? 1, stdout: r.stdout ?? "" };
}

export function deploy(target = "all") {
  if (target !== "all") byId(target); // 驗證存在
  const ids = target === "all" ? deployedServices().map((s) => s.id) : [target];
  console.log(`▶ 部署 ${ids.join(", ")}（主機端：git pull ops → deploy.sh）`);
  // ops repo 先自我更新（deploy.sh / services.json / ecosystem 都吃最新 main），
  // 再執行 deploy.sh——自我更新發生在腳本被 bash 載入之前，避免改到執行中的檔案。
  const r = ssh(`cd ~/tpass && git pull --ff-only && ./deploy/deploy.sh ${target}`);
  if (r.status !== 0) {
    console.error(`\n✗ 部署失敗（exit ${r.status}）。`);
    console.error("  若錯誤是 git 相關：主機可能尚未 git 化 ~/tpass —— 見 docs/MERGE-AND-DEPLOY.md 的一次性 runbook。");
    process.exit(r.status);
  }
  console.log("✅ 部署完成");
}

function probe(port) {
  return new Promise((resolvePromise) => {
    const sock = createConnection({ host: "127.0.0.1", port, timeout: 400 });
    sock.on("connect", () => (sock.destroy(), resolvePromise(true)));
    sock.on("error", () => resolvePromise(false));
    sock.on("timeout", () => (sock.destroy(), resolvePromise(false)));
  });
}

export async function status() {
  console.log("== 本機 dev（port 探測）==");
  for (const s of services) {
    const up = s.enabled ? await probe(s.port) : false;
    const flag = up ? "🟢 執行中" : s.enabled ? "⚪ 未啟動" : "🚫 停用";
    console.log(`  ${flag}  ${s.id.padEnd(9)} :${s.port}  ${devUrl(s)}`);
  }
  console.log("\n== 主機 pm2 ==");
  const r = ssh("pm2 jlist", { capture: true });
  if (r.status !== 0) {
    console.error("✗ 無法取得主機 pm2 狀態");
    process.exit(1);
  }
  let apps;
  try {
    apps = JSON.parse(r.stdout.slice(r.stdout.indexOf("[")));
  } catch {
    console.error("✗ pm2 jlist 輸出解析失敗");
    process.exit(1);
  }
  const byName = new Map(apps.map((a) => [a.name, a]));
  for (const s of services) {
    const a = byName.get(s.id);
    if (!a) {
      console.log(`  ⚪ ${s.id.padEnd(9)} 未部署${s.deployed ? "（registry 標記 deployed，需檢查！）" : ""}`);
      continue;
    }
    const st = a.pm2_env?.status === "online" ? "🟢 online " : `🔴 ${a.pm2_env?.status}`;
    const mem = a.monit ? `${Math.round(a.monit.memory / 1048576)}MB` : "";
    const up = a.pm2_env?.pm_uptime ? `up ${Math.round((Date.now() - a.pm2_env.pm_uptime) / 3600000)}h` : "";
    console.log(`  ${st}  ${s.id.padEnd(9)} ↺${a.pm2_env?.restart_time ?? "?"}  ${mem}  ${up}`);
  }
}

export function logs(id, follow = false) {
  byId(id);
  const cmd = follow ? `pm2 logs ${id}` : `pm2 logs ${id} --lines 100 --nostream`;
  process.exit(ssh(cmd).status);
}
