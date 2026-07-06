// spawn 助手：前綴串流輸出（重現 dev.sh 的 `sed "s/^/[svc] /"`）、並行執行、清場。
import { spawn, spawnSync, execSync } from "node:child_process";

const COLORS = [36, 32, 33, 35, 34, 31]; // cyan green yellow magenta blue red
let colorIdx = 0;

// 執行到結束，輸出逐行加 [label] 前綴。回傳 { code, child }
export function run(cmd, args, { cwd, env, label, onLine } = {}) {
  const color = COLORS[colorIdx++ % COLORS.length];
  const prefix = label ? `\x1b[${color}m[${label}]\x1b[0m ` : "";
  const child = spawn(cmd, args, {
    cwd,
    env: env ? { ...process.env, ...env } : process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const pipe = (stream, out) => {
    let buf = "";
    stream.on("data", (d) => {
      buf += d.toString();
      const lines = buf.split("\n");
      buf = lines.pop();
      for (const line of lines) {
        out.write(prefix + line + "\n");
        onLine?.(line);
      }
    });
    stream.on("end", () => buf && out.write(prefix + buf + "\n"));
  };
  pipe(child.stdout, process.stdout);
  pipe(child.stderr, process.stderr);
  const done = new Promise((resolvePromise) => child.on("close", (code) => resolvePromise(code ?? 1)));
  return { child, done };
}

// 循序執行一串工作，全部跑完才回報（check 模式：收集所有失敗）
export async function runSeq(jobs) {
  let fail = false;
  for (const job of jobs) {
    const code = await run(job.cmd, job.args, job.opts).done;
    if (code !== 0) {
      fail = true;
      if (job.stopOnFail) return { ok: false };
    }
  }
  return { ok: !fail };
}

// 並行長駐（dev/start 模式）：Ctrl-C 全體收掉
export async function runParallel(jobs) {
  const children = jobs.map((job) => run(job.cmd, job.args, job.opts));
  const cleanup = () => {
    for (const { child } of children) {
      try {
        child.kill("SIGTERM");
      } catch {}
    }
  };
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
  const codes = await Promise.all(children.map((c) => c.done));
  return codes.every((c) => c === 0);
}

// 同步取指令輸出（如 mkcert -CAROOT）
export function capture(cmd, args = []) {
  const r = spawnSync(cmd, args, { encoding: "utf8" });
  if (r.status !== 0) return null;
  return r.stdout.trim();
}

export function commandExists(cmd) {
  return spawnSync("command", ["-v", cmd], { shell: "/bin/sh", encoding: "utf8" }).status === 0;
}
