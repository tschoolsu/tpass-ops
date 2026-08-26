// 部署 / 主機狀態，全部經 ssh 在本機發動——主機上永遠不裝任何部署工具。
// 主機位址/帳號是機密，只存在 gitignored 的 deploy/host.env。
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createConnection } from "node:net";
import {
  OPS_ROOT,
  ROOT,
  byId,
  deployedServices,
  devUrl,
  hostOpsRoot,
  hostServicesRoot,
  services,
} from "./registry.mjs";

export function hostEnv() {
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

// input 提供時經 stdin 餵給遠端指令（用來把整份 .env.local 寫回主機，值不進 argv）。
export function ssh(remoteCmd, { capture = false, input } = {}) {
  const { DEPLOY_USER, DEPLOY_HOST } = hostEnv();
  const stdio = input
    ? ["pipe", capture ? "pipe" : "inherit", "inherit"]
    : capture
      ? ["ignore", "pipe", "inherit"]
      : "inherit";
  const r = spawnSync("ssh", [`${DEPLOY_USER}@${DEPLOY_HOST}`, remoteCmd], {
    input,
    stdio,
    encoding: "utf8",
  });
  return { status: r.status ?? 1, stdout: r.stdout ?? "" };
}

export function deploy(target = "all") {
  if (target !== "all") byId(target); // 驗證存在
  const ids = target === "all" ? deployedServices().map((s) => s.id) : [target];
  console.log(`▶ 部署 ${ids.join(", ")}（主機端：git pull ops → deploy.sh）`);
  // ops repo 先自我更新（deploy.sh / ecosystem 吃最新 main），再執行 deploy.sh
  // ——自我更新發生在腳本被 bash 載入之前，避免改到執行中的檔案。
  // 註冊表（tpass-registry）由 deploy.sh 自己 pull，不在這裡處理。
  const r = ssh(`cd ${hostOpsRoot} && git pull --ff-only && ./deploy/deploy.sh ${target}`);
  if (r.status !== 0) {
    console.error(`\n✗ 部署失敗（exit ${r.status}）。`);
    console.error(
      `  若錯誤是 git 相關：主機的 ${hostOpsRoot}、${hostOpsRoot}/tpass-registry 或 ${hostServicesRoot}/<dir> 可能還沒 clone —— 見 docs/ONBOARDING.md §5。`,
    );
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

  console.log("\n== 主機程式碼版本（HEAD vs origin/main）==");
  // 一條 ssh 掃完所有 deployed 服務；behind>0 = GitHub 有新 merge 還沒部署。
  const script = deployedServices()
    .map(
      (s) =>
        `cd ${hostServicesRoot}/${s.dir} 2>/dev/null && { git fetch -q origin main 2>/dev/null; ` +
        `echo "${s.id} $(git rev-parse --short HEAD) $(git rev-list --count HEAD..origin/main 2>/dev/null || echo '?')"; }`,
    )
    .join("; ");
  const g = ssh(script, { capture: true });
  if (g.status !== 0 || !g.stdout.trim()) {
    // 這裡曾經是 return —— 拿不到 git 版本就連監控與備份都不印了。
    // 那兩段恰好是最不該沉默的（沒監控、沒備份），所以只跳過這一段。
    console.log("  ⚠️ 無法取得主機 git 版本");
  } else {
    for (const line of g.stdout.trim().split("\n")) {
      const [id, head, behind] = line.trim().split(/\s+/);
      if (!id) continue;
      const flag = behind === "0" ? "🟢 最新" : `🟠 落後 origin/main ${behind ?? "?"} commit → tpass deploy ${id}`;
      console.log(`  ${id.padEnd(10)} ${head ?? "?"}  ${flag}`);
    }
  }

  // 外部監控的狀態。這裡不是要取代 UptimeRobot 的網頁，而是做網頁做不到的事：
  // 跟註冊表對照，抓出「deployed 卻沒有人幫它開監控」的服務。
  const { monitorSummary, printMonitorSummary } = await import("./monitor.mjs");
  printMonitorSummary(await monitorSummary());

  // 備份的靜默失敗防線：Discord webhook 只會在「跑了但失敗」時響，
  // 「cron 根本沒觸發」不會。所以這裡主動報最後一次成功備份的時間。
  console.log("\n== 備份 ==");
  const { backupStatus } = await import("./backup.mjs");
  const b = backupStatus();
  if (!b?.at) {
    console.log("  🔴 沒有任何備份紀錄 → tpass backup setup && tpass backup install-cron");
    return;
  }
  const hours = (Date.now() - Date.parse(b.at)) / 3600000;
  const flag = hours > 30 ? "🔴 超過 30 小時沒備份了！" : "🟢";
  console.log(`  ${flag} 最後備份 ${hours.toFixed(1)} 小時前  ${b.databases} 個資料庫 + ${b.archives} 份 data/  ${(b.bytes / 1048576).toFixed(1)}MB`);
  console.log(`     ${b.remote}`);
}

export function logs(id, follow = false) {
  byId(id);
  const cmd = follow ? `pm2 logs ${id}` : `pm2 logs ${id} --lines 100 --nostream`;
  process.exit(ssh(cmd).status);
}
