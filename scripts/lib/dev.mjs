// 內層 dev 迴圈：next dev 跑 HTTPS(mkcert) + *.lvh.me 子網域 + HMR。
// SSO 流程（HTTPS / Secure cookie / 跨子網域）在此模式照樣測得到。
import { existsSync } from "node:fs";
import { join } from "node:path";
import { CERT, KEY, devHost, devUrl, issuerId, repoDir, resolveTarget } from "./registry.mjs";
import { capture, runParallel } from "./sh.mjs";

export async function dev(target) {
  if (!existsSync(CERT) || !existsSync(KEY)) {
    console.error(`✗ 找不到憑證 ${CERT} / ${KEY}，請先跑： tpass setup`);
    process.exit(1);
  }
  const caroot = capture("mkcert", ["-CAROOT"]);
  const jobs = resolveTarget(target).map((s) => {
    // 讓本機 node 工具信任 mkcert 根憑證。但 Next(Turbopack) server 端 fetch(undici)
    // 不吃 NODE_EXTRA_CA_CERTS / --use-system-ca，消費端抓本機 mkcert 簽的 auth JWKS
    // 會 UNABLE_TO_VERIFY_LEAF_SIGNATURE → 驗章默默失敗、登入後一直掉回登入頁。
    // dev-only 對消費端關閉 TLS 驗證；發證端（auth）不關——它要驗 Google 真憑證。
    // 正式環境走真憑證，完全不經過這段。
    const env = { NODE_EXTRA_CA_CERTS: `${caroot}/rootCA.pem` };
    if (s.id !== issuerId) env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
    console.log(`▶ ${s.id} → ${devUrl(s)}`);
    return {
      cmd: join(repoDir(s), "node_modules", ".bin", "next"),
      args: [
        "dev",
        "--experimental-https",
        "--experimental-https-key", KEY,
        "--experimental-https-cert", CERT,
        "-H", devHost(s),
        "-p", String(s.port),
      ],
      opts: { cwd: repoDir(s), env, label: s.id },
    };
  });
  const ok = await runParallel(jobs);
  process.exit(ok ? 0 : 1);
}
