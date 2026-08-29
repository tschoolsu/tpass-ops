// 自架 Uptime Kuma 的唯讀查詢。監控本身住在部員的機器上（這是重點——主機自己死掉時，
// 只有跑在主機外的東西叫得出來），這裡不取代它的網頁，只做一件網頁做不到的事：
// 把 monitor 清單跟註冊表對照，抓出「deployed:true 卻沒有人幫它開監控」的服務。
//
// 為什麼是 /metrics 而不是 Kuma 的 socket.io：Kuma 沒有官方寫入 API，socket.io 是內部協定、
// 上游明講不對第三方支援。/metrics 是 Prometheus 格式、有 API key、格式穩定，而且我們只需要讀。
//
// 2026-08-28：從 UptimeRobot v2 API 換過來。換的理由與紅線見
// docs/specs/2026-08-28-uptime-kuma-design.md。
//
// ⚠️ /metrics 只輸出**已經產生過心跳**的 monitor（2026-08-29 實測）：
//    暫停中的、以及從未被 ping 過的 push monitor 都不在裡面。
//    所以「暫停一個服務的 monitor」跟「根本沒開 monitor」在這裡看起來一樣——
//    那是刻意的，暫停的監控本來就等於沒有監控。
//    但也代表 backup-heartbeat 在收到第一次備份 ping 之前不會出現在這份清單上。
//
// apiAuth 的坑：Kuma 只有在設定 `apiKeysEnabled` 為真時才用 API key 驗證 /metrics，
// 否則會退回管理帳密的 basic auth（回 401 且 log 寫 BASIC-AUTH）。
// 在後台建過一把 key 就會自動打開那個設定。
import { deployedServices, prodUrl } from "./registry.mjs";
import { hostEnv } from "./deploy.mjs";

// Kuma 的 monitor 狀態值（server/prometheus.js）。
// PENDING 跟 DOWN 分開顯示——半夜看到 🟠 跟 🔴 的處置不同
// （前者再等一輪，後者現在就去看 log）。
const STATUS = {
  0: ["🔴", "down"],
  1: ["🟢", "up"],
  2: ["🟠", "疑似 down"],
  3: ["🔧", "維護中"],
};

const hostOf = (u) => {
  try {
    return new URL(u).hostname;
  } catch {
    return "";
  }
};

// Prometheus 文字格式：
//   monitor_status{monitor_name="auth",monitor_type="http",monitor_url="https://auth…/",…} 1
// 只認 monitor_status 這一個 metric，其餘（response_time / cert_days）不關我們的事。
function parseMetrics(text) {
  const out = [];
  for (const line of text.split("\n")) {
    if (!line.startsWith("monitor_status{")) continue;
    const m = /^monitor_status\{(.*)\}\s+(-?\d+(?:\.\d+)?)\s*$/.exec(line.trim());
    if (!m) continue;
    const [, labelBlob, value] = m;
    const label = (k) => {
      const hit = new RegExp(`${k}="((?:[^"\\\\]|\\\\.)*)"`).exec(labelBlob);
      return hit ? hit[1].replace(/\\"/g, '"').replace(/\\\\/g, "\\") : "";
    };
    out.push({
      name: label("monitor_name"),
      url: label("monitor_url"),
      status: Number(value),
    });
  }
  return out;
}

// 回傳 { skipped } | { error } | { rows, missing }
// 一律不 throw：status() 的主職責是 pm2，不能被監控 API 拖垮。
export async function monitorSummary() {
  const env = hostEnv();
  const base = (env.KUMA_BASE_URL ?? "").replace(/\/+$/, "");
  const key = env.KUMA_API_KEY;
  if (!base || !key) return { skipped: true };

  let monitors;
  try {
    const r = await fetch(`${base}/metrics`, {
      // Kuma 的 /metrics 走 HTTP Basic，帳號留空、密碼放 API key。
      headers: { Authorization: `Basic ${Buffer.from(`:${key}`).toString("base64")}` },
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) return { error: `/metrics 回 HTTP ${r.status}` };
    monitors = parseMetrics(await r.text());
  } catch (e) {
    return { error: e.message };
  }
  if (monitors.length === 0) {
    return { error: "/metrics 有回應但沒有任何 monitor_status（API key 對嗎？）" };
  }

  // Kuma 的 monitor URL 帶不帶結尾斜線都可能，所以一律用 hostname 比對。
  // 名稱只是備援：push monitor 沒有 URL，靠名稱才顯示得出來。
  const byHost = new Map();
  for (const m of monitors) {
    const h = hostOf(m.url);
    if (h && !byHost.has(h)) byHost.set(h, m);
  }

  // 先把 deployed 服務排前面（看的人要先看到自己的服務），
  // 沒對應到服務的 monitor（根網域、備份心跳…）排後面。
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
    used.add(m);
    rows.push({ label: s.id, host, status: m.status });
  }
  for (const m of monitors) {
    if (used.has(m)) continue;
    rows.push({ label: null, host: hostOf(m.url) || m.name, status: m.status });
  }
  return { rows, missing };
}

export function printMonitorSummary(res) {
  console.log("\n== 監控（Uptime Kuma）==");
  if (res.skipped) {
    console.log("  （未設定 deploy/host.env 的 KUMA_BASE_URL / KUMA_API_KEY，跳過）");
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
    console.log(`  ⚠️ ${s.id.padEnd(9)} 沒有監控 → 去 Kuma 加 ${prodUrl(s)}/`);
    console.log(`  ${"".padEnd(12)}名稱填「${s.name}」，接受狀態碼 200-399`);
  }
}
