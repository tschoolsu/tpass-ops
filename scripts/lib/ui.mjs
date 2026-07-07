// tpass ui —— 本機管理儀表板。
// 設計：GUI 是 CLI 的薄殼——每個按鈕 = spawn 一個 `tpass <子指令>`（白名單制），
// 輸出經 SSE 串流到瀏覽器。所有邏輯只存在 CLI 一份，這裡零重複。
// 安全：只綁 127.0.0.1 + URL 隨機 token（此面板能觸發部署，不能裸奔）。
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { createConnection } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ROOT, devUrl, prodUrl, services } from "./registry.mjs";
import { envGetJson, setEnv, unsetEnv } from "./env.mjs";

const LIB_DIR = dirname(fileURLToPath(import.meta.url));
const TPASS = join(LIB_DIR, "..", "tpass");

// 允許的子指令（第一個字）→ 防 token 外洩時被當任意執行器
const ALLOWED = new Set(["dev", "check", "build", "start", "deploy", "status", "logs", "db", "list"]);

const jobs = new Map(); // id -> { child, lines: [], listeners: Set<res>, done, argv }
let nextJob = 1;

function startJob(argv) {
  const id = String(nextJob++);
  const child = spawn(process.execPath, [TPASS, ...argv], {
    env: { ...process.env, FORCE_COLOR: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const job = { child, lines: [], listeners: new Set(), done: false, argv };
  jobs.set(id, job);
  const push = (line) => {
    job.lines.push(line);
    if (job.lines.length > 5000) job.lines.shift();
    for (const res of job.listeners) res.write(`data: ${JSON.stringify(line)}\n\n`);
  };
  const wire = (stream) => {
    let buf = "";
    stream.on("data", (d) => {
      buf += d.toString();
      const parts = buf.split("\n");
      buf = parts.pop();
      parts.forEach(push);
    });
    stream.on("end", () => buf && push(buf));
  };
  wire(child.stdout);
  wire(child.stderr);
  child.on("close", (code) => {
    job.done = true;
    push(`◼ 結束（exit ${code}）`);
    for (const res of job.listeners) {
      res.write(`event: done\ndata: ${code}\n\n`);
      res.end();
    }
    job.listeners.clear();
  });
  return id;
}

function json(res, code, obj) {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(obj));
}

const probe = (port) =>
  new Promise((r) => {
    const s = createConnection({ host: "127.0.0.1", port, timeout: 350 });
    s.on("connect", () => (s.destroy(), r(true)));
    s.on("error", () => r(false));
    s.on("timeout", () => (s.destroy(), r(false)));
  });

export async function ui() {
  const token = randomBytes(16).toString("hex");
  const html = readFileSync(join(LIB_DIR, "ui.html"), "utf8");

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (url.searchParams.get("token") !== token) return json(res, 403, { error: "bad token" });

    if (url.pathname === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end(html.replace("__TOKEN__", token));
    }

    if (url.pathname === "/api/registry") {
      const list = await Promise.all(
        services.map(async (s) => ({
          id: s.id,
          name: s.name ?? s.id,
          dir: s.dir,
          port: s.port,
          db: s.db ? `${s.db.name} (${s.db.strategy})` : null,
          enabled: s.enabled,
          deployed: s.deployed,
          devUrl: devUrl(s),
          prodUrl: prodUrl(s),
          devUp: s.enabled ? await probe(s.port) : false,
        }))
      );
      return json(res, 200, { root: ROOT, services: list });
    }

    if (url.pathname === "/api/run" && req.method === "POST") {
      let body = "";
      req.on("data", (d) => (body += d));
      req.on("end", () => {
        let argv;
        try {
          argv = JSON.parse(body).argv;
        } catch {
          return json(res, 400, { error: "bad body" });
        }
        if (!Array.isArray(argv) || !ALLOWED.has(argv[0]) || !argv.every((a) => /^[\w.-]+$/.test(a)))
          return json(res, 400, { error: "指令不在白名單" });
        return json(res, 200, { id: startJob(argv.map(String)) });
      });
      return;
    }

    if (url.pathname.startsWith("/api/stream/")) {
      const job = jobs.get(url.pathname.split("/").pop());
      if (!job) return json(res, 404, { error: "no job" });
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      for (const line of job.lines) res.write(`data: ${JSON.stringify(line)}\n\n`);
      if (job.done) {
        res.write("event: done\ndata: 0\n\n");
        return res.end();
      }
      job.listeners.add(res);
      req.on("close", () => job.listeners.delete(res));
      return;
    }

    if (url.pathname.startsWith("/api/stop/") && req.method === "POST") {
      const job = jobs.get(url.pathname.split("/").pop());
      if (!job) return json(res, 404, { error: "no job" });
      try {
        job.child.kill("SIGTERM");
      } catch {}
      return json(res, 200, { ok: true });
    }

    if (url.pathname === "/api/jobs") {
      return json(
        res, 200,
        [...jobs.entries()].map(([id, j]) => ({ id, argv: j.argv, done: j.done }))
      );
    }

    // 遠端 env（值含 = / 密文，過不了 /api/run 白名單 regex，故走專用端點）。
    // GET：讀（預設遮罩，?reveal=1 顯示密文）。POST {key,value|unset}：寫（值不進 argv、不進 shell）。
    if (url.pathname.startsWith("/api/env/")) {
      const id = decodeURIComponent(url.pathname.slice("/api/env/".length));
      if (!services.some((s) => s.id === id)) return json(res, 404, { error: "未知服務" });

      if (req.method === "GET") {
        try {
          return json(res, 200, envGetJson(id, { reveal: url.searchParams.get("reveal") === "1" }));
        } catch (e) {
          return json(res, 500, { error: e.message });
        }
      }
      if (req.method === "POST") {
        let body = "";
        req.on("data", (d) => (body += d));
        req.on("end", () => {
          let p;
          try {
            p = JSON.parse(body);
          } catch {
            return json(res, 400, { error: "bad body" });
          }
          try {
            if (p.unset) unsetEnv(id, p.key);
            else setEnv(id, p.key, String(p.value ?? ""));
            return json(res, 200, { ok: true });
          } catch (e) {
            return json(res, 400, { error: e.message });
          }
        });
        return;
      }
    }

    json(res, 404, { error: "not found" });
  });

  server.listen(0, "127.0.0.1", () => {
    const addr = `http://127.0.0.1:${server.address().port}/?token=${token}`;
    console.log(`🎛  tpass ui → ${addr}`);
    console.log("   （只綁本機；關掉終端機即關閉。Ctrl-C 結束）");
    if (!process.env.TPASS_UI_NO_OPEN) spawn("open", [addr], { stdio: "ignore" }).on("error", () => {});
  });
}
