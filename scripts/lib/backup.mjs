// 備份維運：全部經 ssh 在本機發動（主機上只有 deploy/backup.sh 與 rclone，沒有別的工具）。
// 排程備份本身由主機的 cron 跑；這裡是「人要介入時」的入口：手動觸發、看有哪些備份、
// 還原驗證、裝排程。
//
// 還原驗證為什麼要 Docker：主機是 PostgreSQL 18，本機 psql 是 14 —— pg_restore 14 讀不懂
// 18 的 custom archive。用 postgres:18 容器還原，本機裝什麼版本都不影響。
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { ssh } from "./deploy.mjs";
import { hostOpsRoot, hostServicesRoot, services } from "./registry.mjs";
import { commandExists } from "./sh.mjs";

const SCRATCH = join(homedir(), ".cache", "tpass-backup");
// 主機是 PostgreSQL 18；pg_restore 讀不懂比自己新的 archive，所以驗證一定要 18 以上的工具。
// 本機常見的是舊版（brew 的 postgresql@14/@17），所以自己找一份 18 的 bin。
const PG_MIN = 18;

// crontab 的 command 由 /bin/sh 跑，`~` 展開不保證；$HOME 才是可靠的。
// 路徑仍派生自註冊表的 server.opsRoot，不寫死（帳號名是機密，不能進被追蹤的檔案）。
const opsRootSh = hostOpsRoot.replace(/^~\//, "$HOME/");
const CRON_ENTRY = `15 4 * * * cd ${opsRootSh} && ./deploy/backup.sh >> $HOME/tpass-backup.log 2>&1`;

// quiet：連 stderr 一起吞掉。用在「目錄不存在是正常情況」的探測（weekly/ 要等第一個星期天才有），
// 否則 rclone 每次都噴三行紅字，久了就沒人看紅字了。
function sh(cmd, args, { input, capture = false, quiet = false } = {}) {
  const err = quiet ? "ignore" : "inherit";
  return spawnSync(cmd, args, {
    input,
    stdio: capture ? ["pipe", "pipe", err] : ["inherit", "inherit", err],
    encoding: "utf8",
  });
}

// 主機的 deploy/backup.env 是 remote 名稱的唯一真相 —— 本機不另存一份，免得兩邊漂移。
function remoteName() {
  const r = ssh(`grep -m1 '^BACKUP_REMOTE=' ${hostOpsRoot}/deploy/backup.env 2>/dev/null || true`, { capture: true });
  const v = r.stdout.trim().replace(/^BACKUP_REMOTE=/, "").replace(/^["']|["']$/g, "");
  if (!v) {
    console.error(`✗ 主機的 ${hostOpsRoot}/deploy/backup.env 沒有 BACKUP_REMOTE`);
    console.error(`  先跑： tpass backup setup`);
    process.exit(1);
  }
  return v;
}

function needLocalRclone() {
  if (commandExists("rclone")) return;
  console.error("✗ 本機沒有 rclone： brew install rclone");
  process.exit(1);
}

export function backupRun(dryRun = false) {
  console.log(`▶ 主機備份${dryRun ? "（dry-run）" : ""}`);
  // ops repo 先自我更新，跟 deploy 同一個理由：主機跑的要是 main 上的最新腳本。
  const r = ssh(`cd ${hostOpsRoot} && git pull --ff-only && ./deploy/backup.sh${dryRun ? " --dry-run" : ""}`);
  if (r.status !== 0) process.exit(r.status);
}

export function backupList() {
  needLocalRclone();
  const remote = remoteName();
  for (const kind of ["daily", "weekly"]) {
    console.log(`\n== ${kind} ==`);
    const r = sh("rclone", ["lsf", "--dirs-only", `${remote}/${kind}`], { capture: true, quiet: true });
    const dirs = (r.stdout || "").trim().split("\n").filter(Boolean).sort();
    if (dirs.length === 0) {
      console.log("  （空）");
      continue;
    }
    for (const d of dirs) {
      const s = sh("rclone", ["size", "--json", `${remote}/${kind}/${d}`], { capture: true, quiet: true });
      let info = "";
      try {
        const { count, bytes } = JSON.parse(s.stdout);
        info = `${count} 檔  ${(bytes / 1048576).toFixed(1)} MB`;
      } catch {
        info = "（讀不到大小）";
      }
      console.log(`  ${d.replace(/\/$/, "").padEnd(12)} ${info}`);
    }
  }
}

export function backupStatus() {
  const r = ssh("cat ~/.tpass-backup-status 2>/dev/null || true", { capture: true });
  if (!r.stdout.trim()) return null;
  try {
    return JSON.parse(r.stdout);
  } catch {
    return null;
  }
}

// 每張表的精確列數。query_to_xml 讓「對每張表跑 count(*)」變成一句 SQL，不必先列表再逐張查。
const COUNT_SQL = `select table_name || '=' || (xpath('/row/c/text()', query_to_xml(
  format('select count(*) as c from %I.%I', table_schema, table_name), false, true, '')))[1]::text
from information_schema.tables
where table_schema='public' and table_type='BASE TABLE' order by 1`;

// 主機上同一個庫的實際列數 —— 還原驗證的比對基準。
// 整段腳本走 stdin（bash -s）而不是 argv：SQL 裡有大量單引號，塞進 ssh 的遠端命令列會被
// 三層 shell 引號輾爛。heredoc 用引號括住的分隔符，SQL 一個字元都不會被展開。
function hostCounts(svc) {
  const envfile = `${hostServicesRoot}/${svc.dir}/.env.local`;
  const script = [
    `url=$(grep -m1 -E '^[[:space:]]*(DATABASE_URL|POSTGRES_URL)=' ${envfile} | cut -d= -f2- | xargs)`,
    `[ -n "$url" ] || exit 1`,
    `psql -tAq -d "$url" <<'TPASS_SQL'`,
    COUNT_SQL,
    "TPASS_SQL",
  ].join("\n");
  const r = ssh("bash -s", { input: script, capture: true });
  if (r.status !== 0) return null;
  return new Map(r.stdout.trim().split("\n").filter(Boolean).map((l) => l.split("=")));
}

// 找一份 >= PG_MIN 的 PostgreSQL 工具。順序：明確指定的 env → PATH 上的 → brew 的 keg → Linux 慣例路徑。
function pgBin() {
  const probe = (dir) => {
    const exe = dir ? join(dir, "pg_restore") : "pg_restore";
    const r = spawnSync(exe, ["--version"], { encoding: "utf8" });
    const major = Number(/(\d+)/.exec(r.stdout || "")?.[1]);
    return r.status === 0 && major >= PG_MIN ? dir ?? "" : null;
  };
  const candidates = [process.env.TPASS_PG_BIN, undefined];
  const brew = spawnSync("brew", ["--prefix", `postgresql@${PG_MIN}`], { encoding: "utf8" });
  if (brew.status === 0) candidates.push(join(brew.stdout.trim(), "bin"));
  candidates.push(`/usr/lib/postgresql/${PG_MIN}/bin`);
  for (const c of candidates) {
    if (c === undefined || c) {
      const hit = probe(c);
      if (hit !== null) return hit;
    }
  }
  console.error(`✗ 找不到 PostgreSQL ${PG_MIN}+ 的工具（主機是 PG18，舊版 pg_restore 讀不懂它的 dump）`);
  console.error(`  macOS： brew install postgresql@${PG_MIN}`);
  console.error(`  Linux： apt install postgresql-client-${PG_MIN}`);
  console.error(`  或用 TPASS_PG_BIN 指定 bin 目錄`);
  process.exit(1);
}

export async function backupRestore(date, id) {
  needLocalRclone();
  const bin = pgBin();
  const pg = (name) => (bin ? join(bin, name) : name);
  if (!date || !id) {
    console.error("用法: tpass backup restore <YYYY-MM-DD> <svc>   （日期見 tpass backup list）");
    process.exit(2);
  }
  const svc = services.find((s) => s.id === id);
  if (!svc?.db) {
    console.error(`✗ ${id} 沒有資料庫。有資料庫的服務：${services.filter((s) => s.db).map((s) => s.id).join(", ")}`);
    process.exit(2);
  }
  const remote = remoteName();
  const file = `${svc.id}-${svc.db.name}.dump`;
  mkdirSync(SCRATCH, { recursive: true });
  const local = join(SCRATCH, `${date}-${file}`);

  console.log(`▶ 下載 ${remote}/daily/${date}/${file}`);
  if (sh("rclone", ["copyto", `${remote}/daily/${date}/${file}`, local]).status !== 0 || !existsSync(local)) {
    console.error("✗ 下載失敗（日期或服務對嗎？ tpass backup list）");
    process.exit(1);
  }

  // 用完即丟的叢集：只聽 unix socket（socket 檔就放在這個暫存目錄裡），完全不開 TCP
  // —— 所以不可能跟你本機既有的 Postgres 撞 port，也不可能誤連到正式資料庫。
  const dir = mkdtempSync(join(tmpdir(), "tpass-restore-"));
  const data = join(dir, "data");
  const psqlArgs = ["-h", dir, "-p", "55432", "-U", "postgres"];
  console.log(`▶ 開一個用完即丟的 PostgreSQL 叢集（${dir}）`);
  try {
    // locale 對齊主機的 C.UTF-8：dump 裡的欄位若引用了叢集沒有的 collation，還原會失敗。
    const init = sh(pg("initdb"), ["-D", data, "-U", "postgres", "--auth=trust", "--encoding=UTF8", "--locale=C", "--no-sync"], { capture: true, quiet: true });
    if (init.status !== 0) throw new Error("initdb 失敗");
    const start = sh(pg("pg_ctl"), ["-D", data, "-l", join(dir, "pg.log"), "-w", "-o", `-p 55432 -k ${dir} -h ''`, "start"], { capture: true, quiet: true });
    if (start.status !== 0) throw new Error(`叢集起不來，看 ${join(dir, "pg.log")}`);

    if (sh(pg("createdb"), [...psqlArgs, "verify"], { capture: true }).status !== 0) throw new Error("建驗證用資料庫失敗");
    console.log("▶ pg_restore");
    if (sh(pg("pg_restore"), [...psqlArgs, "-d", "verify", "--no-owner", "--no-privileges", local]).status !== 0) {
      throw new Error("pg_restore 失敗 —— 這份備份還原不出來");
    }

    const out = sh(pg("psql"), [...psqlArgs, "-d", "verify", "-tAq", "-c", COUNT_SQL], { capture: true });
    const restored = new Map((out.stdout || "").trim().split("\n").filter(Boolean).map((l) => l.split("=")));
    if (restored.size === 0) throw new Error("還原出來的資料庫一張表都沒有");

    console.log(`\n▶ 對照主機上的 ${svc.db.name}（備份之後有新資料的話會有落差，那是正常的）\n`);
    const live = hostCounts(svc);
    console.log(`  ${"表".padEnd(28)} ${"還原".padStart(8)} ${"主機".padStart(8)}`);
    let diff = 0;
    for (const [t, n] of [...restored].sort()) {
      const h = live?.get(t);
      const same = h === undefined || h === n;
      if (!same) diff++;
      console.log(`  ${t.padEnd(28)} ${String(n).padStart(8)} ${String(h ?? "?").padStart(8)}  ${same ? "✅" : "⚠️"}`);
    }
    console.log(
      `\n✅ 還原成功：${restored.size} 張表` +
        (live ? (diff === 0 ? "，與主機完全一致" : `，${diff} 張表與主機有落差`) : "（拿不到主機的對照數字）"),
    );
    console.log(`   dump 檔留在 ${local}`);
  } catch (e) {
    console.error(`✗ ${e.message}`);
    process.exitCode = 1;
  } finally {
    sh(pg("pg_ctl"), ["-D", data, "-m", "immediate", "stop"], { capture: true, quiet: true });
    rmSync(dir, { recursive: true, force: true });
  }
}

export function installCron() {
  console.log("▶ 裝主機 cron（每日 04:15）");
  // 先濾掉舊的同名 entry 再寫回 —— 重跑不會長出第二條。
  const cmd =
    `( crontab -l 2>/dev/null | grep -v 'deploy/backup.sh' || true; echo ${JSON.stringify(CRON_ENTRY)} ) | crontab - && crontab -l`;
  const r = ssh(cmd);
  if (r.status !== 0) {
    console.error("✗ 安裝失敗");
    process.exit(r.status);
  }
  console.log("✅ 已安裝。明天早上用 tpass status 確認「最後備份」有更新。");
}

// 一次性主機準備：裝 rclone（無 root）+ 把本機的 rclone remote 設定搬上去。
// Google 授權必須由人在瀏覽器完成，所以流程是「本機 rclone config → 這裡搬設定上主機」。
export function backupSetup() {
  needLocalRclone();
  const conf = join(homedir(), ".config", "rclone", "rclone.conf");
  if (!existsSync(conf)) {
    console.error(`✗ 本機還沒有 ${conf}`);
    console.error(`  先在本機建 remote（會開瀏覽器要你授權 Google）：`);
    console.error(`    rclone config create tpass-backup drive scope=drive.file`);
    process.exit(1);
  }
  // 只搬 [tpass-backup] 那一段 —— rclone.conf 可能還有別的 remote，那些與備份無關，不該上主機。
  const text = readFileSync(conf, "utf8");
  const section = text.split(/^\[/m).find((s) => s.startsWith("tpass-backup]"));
  if (!section) {
    console.error("✗ 本機 rclone.conf 裡沒有 [tpass-backup] 這個 remote");
    console.error("    rclone config create tpass-backup drive scope=drive.file");
    process.exit(1);
  }

  console.log("▶ 主機裝 rclone（無 root；主機沒有 unzip，用 python3 解 zip）");
  const install = [
    "set -e",
    "mkdir -p ~/.local/bin ~/.config/rclone",
    "if ! command -v ~/.local/bin/rclone >/dev/null 2>&1; then",
    "  curl -fsSL https://downloads.rclone.org/rclone-current-linux-amd64.zip -o /tmp/rclone.zip",
    "  rm -rf /tmp/rclone-x && python3 -m zipfile -e /tmp/rclone.zip /tmp/rclone-x",
    "  mv /tmp/rclone-x/*/rclone ~/.local/bin/rclone && chmod +x ~/.local/bin/rclone",
    "  rm -rf /tmp/rclone.zip /tmp/rclone-x",
    "fi",
    "~/.local/bin/rclone version | head -1",
  ].join("\n");
  if (ssh(install).status !== 0) process.exit(1);

  console.log("▶ 搬 remote 設定上主機（含 OAuth token，只走 stdin 不進 argv）");
  const write = "set -e; cat > ~/.config/rclone/rclone.conf.tmp && chmod 600 ~/.config/rclone/rclone.conf.tmp && mv ~/.config/rclone/rclone.conf.tmp ~/.config/rclone/rclone.conf";
  if (ssh(write, { input: `[${section.trimEnd()}\n` }).status !== 0) process.exit(1);

  console.log("▶ 驗證主機連得上 remote");
  const r = ssh("~/.local/bin/rclone mkdir tpass-backup:tpass-backups && ~/.local/bin/rclone lsd tpass-backup: && echo OK", { capture: true });
  if (r.status !== 0 || !r.stdout.includes("OK")) {
    console.error("✗ 主機連不上 remote");
    process.exit(1);
  }
  console.log(r.stdout.trim());
  console.log(`\n✅ rclone 就緒。接著填設定檔（含 Discord webhook）：`);
  console.log(`   scripts/ssh.sh 'cp ${hostOpsRoot}/deploy/backup.env.example ${hostOpsRoot}/deploy/backup.env'`);
}
