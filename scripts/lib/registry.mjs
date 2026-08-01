// 服務註冊表載入器。註冊表住在並排的 tpass-registry/ repo（public），是唯一真相來源；
// portal 的大廳卡片與 auth 的發證白名單也各自讀同一份檔案。這裡負責：
// 1. 載入 + 驗證（id/dir/port/subdomain 唯一性——撞車直接 fail，杜絕 3004 級 bug）
// 2. 派生欄位（dev/prod URL、DATABASE_URL 慣例、憑證路徑）
//
// TPASS_ROOT：服務 repo 所在根目錄的覆寫（預設 = ops repo 根）。
// 用途：ops repo 的 git worktree 裡沒有服務子 repo，測試時可指回真正的 checkout。
// 註冊表也跟著 ROOT 走——worktree 裡本來就沒有 tpass-registry/。
import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const OPS_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const ROOT = process.env.TPASS_ROOT ? resolve(process.env.TPASS_ROOT) : OPS_ROOT;
export const CERT_DIR = join(ROOT, "certs");
export const CERT = join(CERT_DIR, "cert.pem");
export const KEY = join(CERT_DIR, "key.pem");

function fail(msg) {
  console.error(`✗ services.json 無效：${msg}`);
  process.exit(1);
}

export const REGISTRY_DIR = join(ROOT, "tpass-registry");
export const REGISTRY_FILE = join(REGISTRY_DIR, "services.json");

function load() {
  const file = REGISTRY_FILE;
  if (!existsSync(file)) {
    console.error(`✗ 找不到服務註冊表 ${file}`);
    console.error(`  註冊表住在並排的 public repo，先 clone 一次：`);
    console.error(`    git -C ${ROOT} clone https://github.com/tschoolsu/tpass-registry.git`);
    process.exit(1);
  }
  let data;
  try {
    data = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    fail(`JSON 解析失敗：${e.message}`);
  }
  if (!Array.isArray(data.services) || data.services.length === 0) fail("services 必須是非空陣列");
  for (const key of ["id", "dir", "subdomain", "port"]) {
    const seen = new Map();
    for (const s of data.services) {
      if (s[key] === undefined || s[key] === null || s[key] === "") fail(`服務缺 ${key} 欄位：${JSON.stringify(s)}`);
      // 撞車檢查只看可能同時運行的服務（enabled）；封存服務允許保留歷史值
      if (!s.enabled) continue;
      if (seen.has(s[key])) fail(`${key} 重複：「${s[key]}」同時出現在 ${seen.get(s[key])} 與 ${s.id}`);
      seen.set(s[key], s.id);
    }
  }
  for (const s of data.services) {
    if (s.db && !["push", "migrate"].includes(s.db.strategy)) fail(`${s.id} 的 db.strategy 必須是 push 或 migrate`);
  }
  if (!data.services.some((s) => s.id === data.issuer)) fail(`issuer「${data.issuer}」不在服務清單中`);
  return data;
}

export const registry = load();
export const services = registry.services;
export const issuerId = registry.issuer;

export function byId(id) {
  const s = services.find((x) => x.id === id);
  if (!s) {
    console.error(`✗ 未知服務「${id}」。可用：${services.map((x) => x.id).join(", ")}`);
    process.exit(2);
  }
  return s;
}

export const enabledServices = () => services.filter((s) => s.enabled);
export const deployedServices = () => services.filter((s) => s.deployed);
export const dbServices = () => enabledServices().filter((s) => s.db);

export const devHost = (s) => `${s.subdomain}.${registry.domains.dev}`;
export const devUrl = (s) => `https://${devHost(s)}:${s.port}`;
export const prodUrl = (s) => `https://${s.subdomain}.${registry.domains.prod}`;
export const repoDir = (s) => join(ROOT, s.dir);
export const dbUrl = (s) => `postgresql://${s.db.user}@localhost:5432/${s.db.name}`;

// 主機端服務根目錄（services.json 的 server.root，例：~/tpass）。遠端指令用，~ 由遠端 shell 展開。
export const serverRoot = registry.server?.root ?? "~/tpass";
export const remoteEnvPath = (s) => `${serverRoot}/${s.dir}/.env.local`;

// 解析 [svc|all] 參數 → 服務陣列（all = enabled）
export function resolveTarget(arg, { fallback = "all" } = {}) {
  const t = arg || fallback;
  if (t === "all") return enabledServices();
  return [byId(t)];
}
