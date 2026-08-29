#!/usr/bin/env node
// 一次性：把註冊表裡該監控的東西灌進一個**全新的** Uptime Kuma。
//
// ⚠️ 這支腳本用的是 Kuma 未公開的 socket.io 內部協定，上游明講不對第三方支援、
//    升級可能 breaking。**所以它是一次性的種子工具，不是長期同步機制。**
//    正式的轉交方式是整包 data/ 目錄（Kuma 2.x 已移除 JSON 匯入匯出），
//    這支只是省掉第一次手點九個表單。哪天它壞了就照 HANDOFF.md §6 手動建，不要修它。
//
// 「新服務上線有沒有人開監控」不靠這支，靠 `tpass status` 拿 Kuma 的 monitor 清單
// 對照 tpass-registry ——清單的真相永遠在註冊表，Kuma 只是被檢查有沒有跟上。
//
// 用法（密碼不要放在指令列，會進 shell history）：
//   node monitoring/seed.mjs                    # 互動輸入帳號密碼
//   KUMA_URL=http://localhost:3010 node monitoring/seed.mjs
//   node monitoring/seed.mjs --notify     # 新建的 monitor 直接勾上 Discord 通知
//   node monitoring/seed.mjs --dry-run    # 只印該建哪些，不連線
//
// 冪等：已經存在同名 monitor 就跳過，可以安全重跑。**新服務上線後重跑一次，
// 就會補上它的 monitor 並把它加進狀態頁**——這是「新服務怎麼接監控」的正路。
// 那種時候要帶 --notify，否則新 monitor 不會有告警（見下面 seedNotification 的說明）。

import { stdin, stdout } from "node:process";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { byId, deployedServices, prodUrl, registry } from "../scripts/lib/registry.mjs";

const KUMA_URL = process.env.KUMA_URL ?? "http://localhost:3010";

// 心跳期限 25 小時：主機的備份 cron 是每日 04:15，留一小時寬限。
// 這個 monitor 就是 A2 留下的洞——「備份根本沒跑」時唯一會出聲的東西。
const BACKUP_PUSH_NAME = "backup-heartbeat";
const BACKUP_PUSH_INTERVAL = 25 * 60 * 60;

// 公開狀態頁。slug 要跟 .github/workflows/kuma-watchdog.yml 的 KUMA_SLUG 一致——
// 看門狗打的是 /api/status-page/heartbeat/<slug>，改了這裡就要改那裡。
const PAGE_SLUG = "tpass";
const PAGE_TITLE = "T-Status";
const HERE = dirname(fileURLToPath(import.meta.url));

// T-Status 的導覽列。Kuma 沒有「自訂 HTML」欄位，唯一的注入點是狀態頁的 description
// ——它走 marked() + DOMPurify.sanitize()（StatusPage.vue:845），<div>/<a>/<svg>/class
// 留得住，script 被擋。版型照抄 tpass-form 的 Header.tsx + PortalLink.tsx：
// 左邊「首頁」按鈕，右接服務名，名稱的連字符是 primary 綠。
// 大廳網址從註冊表派生，不寫死（專案鐵律）。
// 圖示是 lucide 的 layout-grid，跟各模組的 PortalLink 同一顆。
const HOME_ICON =
  '<svg class="tp-home-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" ' +
  'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
  '<rect width="7" height="7" x="3" y="3" rx="1"></rect>' +
  '<rect width="7" height="7" x="14" y="3" rx="1"></rect>' +
  '<rect width="7" height="7" x="14" y="14" rx="1"></rect>' +
  '<rect width="7" height="7" x="3" y="14" rx="1"></rect></svg>';

const NAV_HTML =
  '<div class="tp-nav"><div class="tp-nav-inner">' +
  `<a class="tp-home" href="${prodUrl(byId("portal"))}">${HOME_ICON}首頁</a>` +
  '<span class="tp-logo">T<span class="tp-dash">-</span>Status</span>' +
  "</div></div>";

// ---------------------------------------------------------------------------
// 極簡 socket.io v4 客戶端。用 Node 內建 WebSocket，不引進 socket.io-client——
// ops 層是零依賴的裸 node，不為了一支一次性腳本開一個 node_modules。
// 協定：engine.io 封包前綴 0=open 2=ping 3=pong 4=message，
//       其中 message 再分 40=connect 42=event 43=ack。
// ---------------------------------------------------------------------------
class Kuma {
  #ws;
  #ackId = 0;
  #pending = new Map();
  // 伺服器主動推的事件（不是 ack）。Kuma 的清單類資料都走這條：
  // getMonitorList 的 ack 只回 {ok:true}，真正的內容是另外推一個 "monitorList" 事件。
  #pushed = new Map();
  #waiters = new Map();

  connect() {
    return new Promise((resolve, reject) => {
      const url = KUMA_URL.replace(/^http/, "ws").replace(/\/+$/, "");
      this.#ws = new WebSocket(`${url}/socket.io/?EIO=4&transport=websocket`);
      const fail = () => reject(new Error(`連不上 ${KUMA_URL}（Kuma 有在跑嗎？）`));
      this.#ws.onerror = fail;
      this.#ws.onclose = fail;
      this.#ws.onmessage = (e) => {
        const d = String(e.data);
        if (d.startsWith("0{")) return this.#ws.send("40");
        if (d === "2") return this.#ws.send("3"); // 心跳，不回會被斷線
        if (d.startsWith("40")) {
          this.#ws.onerror = (ev) => console.error("socket 錯誤：", ev.message ?? ev);
          this.#ws.onclose = () => {};
          return resolve();
        }
        const ack = /^43(\d+)(\[.*)$/s.exec(d);
        if (ack) {
          const [, id, payload] = ack;
          const done = this.#pending.get(id);
          if (done) {
            this.#pending.delete(id);
            done(JSON.parse(payload)[0]);
          }
          return;
        }
        const ev = /^42(\[.*)$/s.exec(d);
        if (ev) {
          const [name, payload] = JSON.parse(ev[1]);
          this.#pushed.set(name, payload);
          this.#waiters.get(name)?.(payload);
          this.#waiters.delete(name);
        }
      };
    });
  }

  // 回傳 Kuma 的 ack 物件，通常是 { ok: bool, msg?: string, ... }
  emit(event, ...args) {
    const id = String(++this.#ackId);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`${event} 沒有回應（逾時）`));
      }, 15000);
      this.#pending.set(id, (v) => {
        clearTimeout(timer);
        resolve(v);
      });
      this.#ws.send(`42${id}${JSON.stringify([event, ...args])}`);
    });
  }

  // 等一個伺服器主動推的事件。已經收過就直接給，不然等到逾時。
  waitFor(event, ms = 8000) {
    if (this.#pushed.has(event)) return Promise.resolve(this.#pushed.get(event));
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.#waiters.delete(event);
        resolve(undefined);
      }, ms);
      this.#waiters.set(event, (v) => {
        clearTimeout(timer);
        resolve(v);
      });
    });
  }

  forget(event) {
    this.#pushed.delete(event);
  }

  close() {
    this.#ws?.close();
  }
}

// ---------------------------------------------------------------------------
// 要建什麼——全部從註冊表派生，這裡不寫死任何服務清單。
// ---------------------------------------------------------------------------

// 同 Kuma 前端的 genSecret：[A-Za-z0-9]，push token 用 32 字元。
function genSecret(length) {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, (b) => chars[b % chars.length]).join("");
}
const httpMonitor = (name, url, extra = {}) => ({
  type: "http",
  name,
  url,
  method: "GET",
  interval: 60,
  retryInterval: 60,
  resendInterval: 0,
  maxretries: 1,
  timeout: 30,
  // 🔴 這一格是整份設定最容易錯的地方：T-Pass 的消費端**未登入會回 307**
  // 導向 auth，不是 200。用 Kuma 預設的 200-299 會讓六個服務全天誤報 down，
  // 然後沒人再看告警——假警報比沒有告警更糟。只有 auth 回 200。
  accepted_statuscodes: ["200-399"],
  maxredirects: 0, // 不要跟著 307 跑去 auth，那樣量到的是 auth 不是這個服務
  expiryNotification: false,
  ignoreTls: false,
  upsideDown: false,
  conditions: [],
  notificationIDList: {},
  ...extra,
});

function plan(notificationIDList = {}) {
  // monitor 名稱用註冊表的 `name`（「T-Form 問卷」）而不是 id（「form」)——
  // 這個名字會直接顯示在給全校看的狀態頁上，id 是維運的講法，學生看不懂。
  // `tpass status` 的對照是用 URL hostname，不靠名稱，所以改名不影響抓漏。
  const items = deployedServices().map((s) => ({
    monitor: httpMonitor(s.name, `${prodUrl(s)}/`, { notificationIDList }),
    note: s.id,
  }));

  // 根網域：A5（Cloudflare 轉址）做完之前沒有 DNS，建了會天天紅。
  // 天天紅的 monitor 只會訓練人忽略告警，所以先建起來、設成暫停。
  // A5 完成後在後台按 Resume，它變綠就是 A5 的驗收。
  items.push({
    // active:false = 建好就是暫停狀態。server.js 的 add handler 是
    // `if (monitor.active !== false) startMonitor(...)`，所以這一個欄位就夠，
    // 不必再多打一個 pauseMonitor 事件。
    monitor: httpMonitor("root-domain", `https://${registry.domains.prod}/`, {
      active: false,
      notificationIDList,
    }),
    note: "根網域轉址（A5 完成前保持暫停）",
    paused: true,
  });

  // 備份的死人開關。不放上公開狀態頁——那是內部訊號，不是給全校看的。
  items.push({
    monitor: {
      type: "push",
      name: BACKUP_PUSH_NAME,
      interval: BACKUP_PUSH_INTERVAL,
      retryInterval: BACKUP_PUSH_INTERVAL,
      resendInterval: 0,
      maxretries: 0,
      upsideDown: false,
      conditions: [],
      notificationIDList,
      // push monitor 用不到接受狀態碼，但 server.js 的 add handler 是**無條件**
      // 跑 `monitor.accepted_statuscodes.every(...)`——少了這格會直接 TypeError。
      accepted_statuscodes: ["200-299"],
      // push URL 的 token 是**前端產的**，後端只做 bean.import。不給就是 null，
      // 那條 /api/push/<token> 永遠對不到這個 monitor。長度 32，同 EditMonitor.vue。
      pushToken: genSecret(32),
    },
    note: "備份死人開關（25 小時沒 ping 就叫）",
  });

  return items;
}

// 密碼一定要遮：這支常常是被 `! node monitoring/seed.mjs` 這樣跑的，
// 回顯出來的字會連同輸出一起被貼進對話或 log 裡。
//
// 為什麼不用 readline 的 _writeToOutput 那個經典 hack：Node 26 的
// readline/promises 介面上沒有那個私有方法，覆蓋不到，密碼會照樣回顯——
// 而「以為遮了其實沒遮」比不遮更危險。這裡自己讀 raw mode，行為是看得見的。
// 讀完一行之後同一個 chunk 裡剩下的字。管線輸入時 "帳號\n密碼\n" 會一次到齊，
// 讀完帳號就把剩下的丟掉的話，問密碼時會永遠等不到東西（會靜靜卡住）。
let leftover = "";

function ask(prompt, { hidden = false } = {}) {
  return new Promise((resolve, reject) => {
    stdout.write(prompt);
    const tty = Boolean(stdin.isTTY);
    const wasRaw = tty ? stdin.isRaw : false;

    let buf = "";
    let settled = false;

    // 回傳 true 代表這一行讀完了
    const consume = (chunk) => {
      for (let i = 0; i < chunk.length; i++) {
        const c = chunk[i];
        if (c === "\n" || c === "\r" || c === "\u0004") {
          leftover = chunk.slice(i + 1);
          return "done";
        }
        if (c === "\u0003") {
          leftover = "";
          return "cancel";
        }
        if (c === "\u007f" || c === "\b") {
          buf = buf.slice(0, -1);
          continue;
        }
        buf += c;
        // 非 TTY（被 pipe）時終端機不會自己回顯，所以要不要寫由我們決定。
        if (!hidden) stdout.write(c);
      }
      return "more";
    };

    const finish = (verdict) => {
      if (settled) return;
      settled = true;
      stdin.off("data", onData);
      if (tty) stdin.setRawMode(wasRaw);
      stdin.pause();
      stdout.write("\n");
      if (verdict === "cancel") reject(new Error("已取消"));
      else resolve(buf.trim());
    };

    const onData = (chunk) => {
      const verdict = consume(String(chunk));
      if (verdict !== "more") finish(verdict);
    };

    // 先吃掉上一次讀剩的，不夠再等新的輸入
    if (leftover) {
      const pending = leftover;
      leftover = "";
      const verdict = consume(pending);
      if (verdict !== "more") {
        settled = true;
        stdout.write("\n");
        return verdict === "cancel" ? reject(new Error("已取消")) : resolve(buf.trim());
      }
    }

    if (tty) stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    stdin.on("data", onData);
  });
}

// Discord 通知。**刻意不勾到任何 monitor 上**（applyExisting:false、isDefault:false）——
// 部長本機在調設定時電腦一關，七個 monitor 會全紅、把維運頻道洗爆。
// 等 Kuma 部署到部員的機器之後，才由他在後台逐一勾上（HANDOFF.md §3）。
//
// webhook 用的是主機那條既有的維運頻道（backup.sh 失敗告警同一條），不另開。
// 取得順序：環境變數 → scripts/ssh.sh 去主機讀 → 都沒有就跳過（不是錯誤）。
function readWebhook() {
  if (process.env.KUMA_DISCORD_WEBHOOK) return process.env.KUMA_DISCORD_WEBHOOK.trim();
  try {
    return execFileSync(join(HERE, "..", "scripts", "ssh.sh"), [
      "grep -m1 '^BACKUP_DISCORD_WEBHOOK=' ~/tpass/deploy/backup.env | cut -d= -f2-",
    ], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
}

const NOTIFICATION_NAME = "維運頻道（Discord）";

async function seedNotification(kuma) {
  console.log("\nDiscord 通知 …");
  const url = readWebhook();
  if (!url.startsWith("https://discord.com/")) {
    console.log("  ⏭ 拿不到 webhook（設 KUMA_DISCORD_WEBHOOK 或確認 scripts/ssh.sh 通得到主機），跳過");
    return;
  }

  // 冪等：addNotification 的第二個參數是「要更新哪一個」，傳 null 一定是新增——
  // 重跑就會多一個同名的通知管道（實際踩過）。先找既有的，有就把 id 帶進去更新，
  // 順便讓「webhook 換了」這件事重跑一次就生效。
  const existing = (await kuma.waitFor("notificationList")) ?? [];
  const hit = existing.find((n) => n?.name === NOTIFICATION_NAME);

  const res = await kuma.emit(
    "addNotification",
    {
      name: NOTIFICATION_NAME,
      type: "discord",
      isDefault: false,
      applyExisting: false, // 🔴 true 會套用到所有現有 monitor，正是這裡不要的
      discordWebhookUrl: url,
      discordUsername: "T-Status",
      discordPrefixMessage: "",
    },
    hit?.id ?? null,
  );
  if (!res?.ok) {
    console.log(`  ✗ 失敗：${res?.msg ?? ""}`);
    return;
  }
  console.log(hit ? "  ⏭ 已存在，更新設定" : "  ✓ 已建立（刻意沒有勾到任何 monitor 上）");
}

// 公開狀態頁。樣式的主本是 monitoring/status-page.css（進 git）——這裡只是把它灌進去，
// 之後要改樣式是「改檔案 → 開 PR → 把內容貼進後台 Custom CSS」，見 HANDOFF.md §7。
// （Kuma 沒辦法從檔案讀 CSS，所以 git 那份是主本、後台那份是部署結果。）
async function seedStatusPage(kuma) {
  console.log(`\n狀態頁 /status/${PAGE_SLUG} …`);

  const add = await kuma.emit("addStatusPage", PAGE_TITLE, PAGE_SLUG);
  if (add?.ok) console.log("  ✓ 已建立");
  else if (/UNIQUE constraint/i.test(add?.msg ?? "")) console.log("  ⏭ 已存在，沿用並更新設定");
  else console.log(`  ⚠️ 建不起來，改成更新既有的：${add?.msg ?? ""}`);

  // 拿 monitor 的 id：只有服務上狀態頁，backup-heartbeat 是內部訊號、
  // root-domain 還暫停著，兩個都不放給全校看。
  kuma.forget("monitorList");
  await kuma.emit("getMonitorList");
  const list = Object.values((await kuma.waitFor("monitorList")) ?? {});
  const wanted = new Set(deployedServices().map((svc) => svc.name));
  const monitorList = list
    .filter((m) => wanted.has(m.name))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((m) => ({ id: m.id }));

  const config = {
    slug: PAGE_SLUG,
    title: PAGE_TITLE,
    // marked 要靠空行才會把上面那塊當成獨立的 HTML block，不要把它們接在一起
    description: `${NAV_HTML}\n\nTSchool 數位服務平台的即時狀態。異常時這裡會先知道。`,
    theme: "light", // design.md 是嚴格 light-only，不給 auto/dark
    autoRefreshInterval: 60,
    showTags: false,
    showPoweredBy: false,
    showOnlyLastHeartbeat: false,
    showCertificateExpiry: false,
    footerText: "TSchool 學生會數位服務團隊維運",
    customCSS: readFileSync(join(HERE, "status-page.css"), "utf8"),
    rssTitle: PAGE_TITLE,
    analyticsType: null,
    analyticsId: null,
    analyticsScriptUrl: null,
    domainNameList: [],
  };

  const save = await kuma.emit(
    "saveStatusPage",
    PAGE_SLUG,
    config,
    "/icon.svg", // 第三個參數是 logo：data URL 會存成檔案，一般字串就當網址用
    [{ name: "服務", monitorList }],
  );
  if (!save?.ok) {
    console.log(`  ✗ 存檔失敗：${save?.msg ?? "(沒有訊息)"}`);
    return;
  }
  console.log(`  ✓ ${monitorList.length} 個服務、樣式已套用（theme=light）`);

  // 讓根路徑直接進狀態頁。Kuma 原生就有這個設定，所以 Cloudflare 那邊
  // 不必再多一條 redirect rule。setSettings 是逐鍵覆寫，但先讀回來再合併——
  // 只送一個 entryPage 會讓 server.js 誤判 chromeExecutable 改變而重置瀏覽器。
  const current = await kuma.emit("getSettings");
  if (current?.ok) {
    const res = await kuma.emit("setSettings", { ...current.data, entryPage: `statusPage-${PAGE_SLUG}` }, "");
    console.log(res?.ok ? "  ✓ 根路徑已指向狀態頁" : `  ⚠️ 根路徑設定失敗：${res?.msg ?? ""}`);
  }
}

// ---------------------------------------------------------------------------
async function main() {
  // --dry-run：只印「該有哪些 monitor」，不連線、不改任何東西。
  // 手動在後台補建時照著這份打，就不會漏掉 accepted_statuscodes 那格。
  if (process.argv.includes("--dry-run")) {
    console.log("該建的 monitor（從 tpass-registry/services.json 派生）：\n");
    for (const { monitor, note, paused } of plan()) {
      const target = monitor.url ?? "(push monitor，URL 建好後在後台複製)";
      console.log(`  ${monitor.name.padEnd(16)} ${monitor.type.padEnd(5)} ${target}`);
      console.log(
        `  ${"".padEnd(16)} 間隔 ${monitor.interval}s` +
          // push monitor 的接受狀態碼只是為了餵飽後端的檢查，不是設定的一部分，別印出來誤導人
          (monitor.type === "http" ? `　接受狀態碼 ${monitor.accepted_statuscodes.join(",")}` : "") +
          (paused ? "　【建好後設為暫停】" : "") +
          `　— ${note}`,
      );
      console.log("");
    }
    return;
  }

  const kuma = new Kuma();

  console.log(`連線 ${KUMA_URL} …`);
  await kuma.connect();

  const username = process.env.KUMA_USER ?? (await ask("Kuma 帳號: "));
  const password = process.env.KUMA_PASSWORD ?? (await ask("Kuma 密碼: ", { hidden: true }));

  const login = await kuma.emit("login", { username, password, token: "" });
  if (!login?.ok) throw new Error(`登入失敗：${login?.msg ?? "(沒有訊息)"}`);
  console.log("✓ 登入成功\n");

  // 冪等：先看現在有什麼。
  // ⚠️ getMonitorList 的 ack 只有 {ok:true}——清單是伺服器另外推的 "monitorList" 事件。
  //    直接讀 ack 會拿到空的，然後把已經存在的 monitor 再建一次。
  kuma.forget("monitorList");
  await kuma.emit("getMonitorList");
  const list = (await kuma.waitFor("monitorList")) ?? {};
  const have = new Set(
    Object.values(list)
      .map((m) => m?.name)
      .filter(Boolean),
  );
  console.log(`目前有 ${have.size} 個 monitor${have.size ? "：" + [...have].join(", ") : ""}\n`);

  // --notify：把既有的通知管道勾到**這次新建**的 monitor 上。
  // 預設不勾，因為部長本機在調設定時電腦一關，七個 monitor 會全紅洗爆頻道。
  // 但 Kuma 已經跑在部員機器上之後，新服務上線那次一定要帶 --notify——
  // 一個沒有告警的 monitor 等於沒有監控，而且它還會在畫面上顯示綠色讓人放心。
  let notificationIDList = {};
  if (process.argv.includes("--notify")) {
    const notifications = (await kuma.waitFor("notificationList")) ?? [];
    for (const n of notifications) if (n?.id && n.active !== false) notificationIDList[n.id] = true;
    const names = notifications.map((n) => n?.name).filter(Boolean);
    console.log(
      names.length ? `新建的 monitor 會勾上：${names.join("、")}\n` : "⚠️ --notify 但一個通知管道都沒有\n",
    );
  }

  let added = 0;
  let skipped = 0;
  for (const { monitor, note, paused } of plan(notificationIDList)) {
    if (have.has(monitor.name)) {
      console.log(`  ⏭  ${monitor.name.padEnd(16)} 已存在，跳過`);
      skipped++;
      continue;
    }
    const res = await kuma.emit("add", monitor);
    if (!res?.ok) {
      console.log(`  ✗  ${monitor.name.padEnd(16)} 失敗：${res?.msg ?? "(沒有訊息)"}`);
      continue;
    }
    console.log(`  ✓  ${monitor.name.padEnd(16)} ${paused ? "已建立（暫停）" : "已建立"}  ${note}`);
    added++;
  }

  console.log(`\n完成：新增 ${added}，跳過 ${skipped}。`);

  await seedStatusPage(kuma);
  await seedNotification(kuma);

  console.log("\n接下來（HANDOFF.md 有完整版）：");
  console.log("  1. 打包 monitoring/data/ 私下傳給部員（裡面有 webhook 明文，絕不進 git）");
  console.log(`  2. ${BACKUP_PUSH_NAME} 的 Push URL 等部員部署完才會定案，那時再填進主機 backup.env`);
  console.log("  3. Discord 通知要等部員機器上線後，才由他在後台逐一勾到 monitor 上");
  console.log("     （之後新服務上線時重跑這支並帶 --notify，就會自動勾好）");

  kuma.close();
}

main().catch((e) => {
  console.error(`\n✗ ${e.message}`);
  process.exit(1);
});
