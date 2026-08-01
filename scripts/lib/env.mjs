// 遠端 env 管理：改主機各服務的 .env.local（deploy 帳號自己的檔，改它不需 root）。
// 全部經 deploy.mjs 的 ssh()。祕密值只走 stdin / 函式參數，不進 argv（ps 看不到）、不進 git。
// 核心函式（getEntries/setEnv/unsetEnv）拋錯不 exit —— ui 在同一 process 呼叫，不能被 process.exit 殺掉。
import { ssh } from "./deploy.mjs";
import { remoteEnvPath, services } from "./registry.mjs";

const SECRET_RE = /(SECRET|PASSWORD|PRIVATE_KEY|TOKEN|DATABASE_URL|CLIENT_SECRET)/;
const KEY_RE = /^[A-Z][A-Z0-9_]*$/;
const isSecret = (k) => SECRET_RE.test(k);

function svc(id) {
  const s = services.find((x) => x.id === id);
  if (!s) throw new Error(`未知服務「${id}」。可用：${services.map((x) => x.id).join(", ")}`);
  return s;
}

// 讀遠端 .env.local 原文（缺檔回空字串）。~ 由遠端 shell 展開，路徑僅含 [\w.-/]，不加引號。
function readRemote(s) {
  const p = remoteEnvPath(s);
  const r = ssh(`cat ${p} 2>/dev/null || true`, { capture: true });
  if (r.status !== 0) throw new Error(`讀取遠端 ${p} 失敗（ssh exit ${r.status}）`);
  return r.stdout;
}

// 原子寫回整份內容：暫存檔 → chmod 600 → mv。內容經 stdin，不進 argv。
function writeRemote(s, text) {
  const p = remoteEnvPath(s);
  const r = ssh(`set -e; cat > ${p}.tmp && chmod 600 ${p}.tmp && mv ${p}.tmp ${p}`, { input: text });
  if (r.status !== 0) throw new Error(`寫入遠端 ${p} 失敗（ssh exit ${r.status}）`);
}

// upsert：命中就原位換值，其餘行（含註解）byte 不動；沒命中則附加、保留尾端換行慣例。
function upsert(text, key, value) {
  const re = new RegExp(`^\\s*${key}=`);
  const lines = text.split("\n");
  const i = lines.findIndex((l) => re.test(l));
  if (i >= 0) lines[i] = `${key}=${value}`;
  else if (lines.length && lines[lines.length - 1] === "") lines.splice(lines.length - 1, 0, `${key}=${value}`);
  else lines.push(`${key}=${value}`);
  return lines.join("\n");
}

function removeKey(text, key) {
  const re = new RegExp(`^\\s*${key}=`);
  return text.split("\n").filter((l) => !re.test(l)).join("\n");
}

function parse(text) {
  const out = [];
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*([A-Z][A-Z0-9_]*)=(.*)$/);
    if (m) out.push({ key: m[1], value: m[2], isSecret: isSecret(m[1]) });
  }
  return out;
}

// ---- 核心（拋錯，CLI 與 ui 共用）----
export function getEntries(id) {
  return parse(readRemote(svc(id))); // 原始值（未遮罩），呼叫端自行決定遮罩
}
export function setEnv(id, key, value) {
  if (!KEY_RE.test(key)) throw new Error(`不合法的 env key「${key}」（需 ^[A-Z][A-Z0-9_]*$）`);
  const s = svc(id);
  writeRemote(s, upsert(readRemote(s), key, value));
}
export function unsetEnv(id, key) {
  if (!KEY_RE.test(key)) throw new Error(`不合法的 env key「${key}」`);
  const s = svc(id);
  writeRemote(s, removeKey(readRemote(s), key));
}

// 給 ui：預設遮罩密文，reveal 才顯示
export function envGetJson(id, { reveal = false } = {}) {
  const s = svc(id);
  return {
    path: remoteEnvPath(s),
    entries: getEntries(id).map((e) => ({
      key: e.key,
      isSecret: e.isSecret,
      value: e.isSecret && !reveal ? "***" : e.value,
    })),
  };
}

// ---- CLI 包裝（印錯即 exit）----
function die(e) {
  console.error(`✗ ${e.message}`);
  process.exit(1);
}

export function envGet(id, { show = false } = {}) {
  try {
    const s = svc(id);
    const entries = getEntries(id);
    console.log(`== ${id} 遠端 env（${remoteEnvPath(s)}）==`);
    if (!entries.length) return void console.log("   （空或不存在）");
    for (const e of entries) console.log(`   ${e.key}=${e.isSecret && !show ? "***" : e.value}`);
    console.log(`   —— ${entries.length} 個 key${show ? "" : "（密文遮罩，--show 顯示）"}`);
  } catch (e) {
    die(e);
  }
}

export function envSet(id, key, value) {
  try {
    setEnv(id, key, value);
    console.log(`✅ ${id}: 已設定 ${key}${isSecret(key) ? "（密文）" : `=${value}`}（遠端 .env.local）`);
    console.log(`   套用需： tpass deploy ${id}`);
  } catch (e) {
    die(e);
  }
}

export function envUnset(id, key) {
  try {
    unsetEnv(id, key);
    console.log(`✅ ${id}: 已移除 ${key}（遠端 .env.local）。套用需： tpass deploy ${id}`);
  } catch (e) {
    die(e);
  }
}

// 從 stdin 讀值（去掉單一尾端換行）：供 `tpass env set <svc> KEY --stdin`（值不進 argv）
export function readStdin() {
  return new Promise((resolve) => {
    let buf = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (d) => (buf += d));
    process.stdin.on("end", () => resolve(buf.replace(/\n$/, "")));
  });
}
