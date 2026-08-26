// UptimeRobot 唯讀查詢。監控本身住在外部服務（這是重點——主機自己死掉時，
// 只有跑在主機外的東西叫得出來），這裡不取代它的網頁，只做一件網頁做不到的事：
// 把 monitor 清單跟註冊表對照，抓出「deployed:true 卻沒有人幫它開監控」的服務。
//
// API：v2（legacy 但仍支援，2026-08-26 實測 200）。v3 的欄位命名查不到權威文件，
// 不寫猜出來的東西；哪天 v2 停掉，先打一次看回應再改，不要憑印象。
import { deployedServices, prodUrl } from "./registry.mjs";
import { hostEnv } from "./deploy.mjs";

const API = "https://api.uptimerobot.com/v2/getMonitors";

// v2 的 status 值。8 是「連續幾次沒回應、還沒判定」，跟 9 分開顯示——
// 半夜看到 🟠 跟 🔴 的處置不同（前者再等一輪，後者現在就去看 log）。
const STATUS = {
  0: ["⏸", "paused"],
  1: ["⚪", "尚未檢查"],
  2: ["🟢", "up"],
  8: ["🟠", "疑似 down"],
  9: ["🔴", "down"],
};

const hostOf = (u) => {
  try {
    return new URL(u).hostname;
  } catch {
    return "";
  }
};

// 回傳 { skipped } | { error } | { rows, missing }
// 一律不 throw：status() 的主職責是 pm2，不能被監控 API 拖垮。
export async function monitorSummary() {
  const key = hostEnv().UPTIMEROBOT_API_KEY;
  if (!key) return { skipped: true };

  let data;
  try {
    const r = await fetch(API, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ api_key: key, format: "json" }),
      signal: AbortSignal.timeout(8000),
    });
    data = await r.json();
  } catch (e) {
    return { error: e.message };
  }
  if (data.stat !== "ok") return { error: data.error?.message ?? "API 回了 stat != ok" };

  const monitors = data.monitors ?? [];
  const byHost = new Map(monitors.map((m) => [hostOf(m.url), m]));

  // 先把 deployed 服務排前面（看的人要先看到自己的服務），沒對應到服務的 monitor 排後面。
  const rows = [];
  const used = new Set();
  const missing = [];
  for (const s of deployedServices()) {
    const host = hostOf(prodUrl(s));
    const m = byHost.get(host);
    if (!m) {
      missing.push(s);
      continue;
    }
    used.add(m.id);
    rows.push({ label: s.id, host, status: m.status });
  }
  for (const m of monitors) {
    if (used.has(m.id)) continue;
    rows.push({ label: null, host: hostOf(m.url) || m.friendly_name, status: m.status });
  }
  return { rows, missing };
}

export function printMonitorSummary(res) {
  console.log("\n== 監控（UptimeRobot）==");
  if (res.skipped) {
    console.log("  （未設定 deploy/host.env 的 UPTIMEROBOT_API_KEY，跳過）");
    return;
  }
  if (res.error) {
    console.log(`  ⚠️ 查不到監控狀態：${res.error}`);
    return;
  }
  for (const { label, host, status } of res.rows) {
    const [icon, text] = STATUS[status] ?? ["❔", `status=${status}`];
    if (label) console.log(`  ${icon} ${label.padEnd(9)} ${host.padEnd(26)} ${text}`);
    else console.log(`  ${icon} ${"".padEnd(9)} ${host.padEnd(26)} ${text}（不對應任何服務）`);
  }
  for (const s of res.missing) {
    console.log(`  ⚠️ ${s.id.padEnd(9)} 沒有監控 → 去 UptimeRobot 加 ${prodUrl(s)}/`);
  }
}
