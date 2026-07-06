# TSchool 本地測試 + 部署 SOP

> 一份把「本機 dev-test」與「上線部署」都講清楚的操作手冊。
> 三個服務（`tpass-auth` / `tpass-portal` / `tpass-form`）全 env 驅動，**程式邏輯本機 = 上線，差別只在環境變數與啟動方式**。
> 串接細節以 `tpass-auth/INTEGRATION.md` 為權威，UI 以 `tpass-portal/docs/design.md` 為權威，本檔只談「怎麼跑、怎麼上」。

---

## 0. TL;DR

```bash
# 一次性
scripts/setup.sh                 # mkcert 憑證 + npm install + 產金鑰 + 提示填 .env.local

# 日常開發（內層，有 HMR）
scripts/dev.sh all               # 三服務一起 / 或 dev.sh auth|portal|form

# push 前把關
scripts/check.sh                 # 三 repo lint + tsc --noEmit
scripts/start-all.sh             # production build + start:https（最貼近上線）

# 部署
git push                         # 各 repo 推上去
scripts/ssh.sh 'cd ~/tpass/deploy && ./deploy.sh all'   # 伺服器上 pull+build+reload（主機設定見 deploy/host.env）
```

> **上線實況（權威，覆蓋本檔舊草案）**：正式根網域是 **`tschoolsu.org`**（不是 `tschool.tp.edu.tw`）。
> 對外入口是 **Cloudflare（橘色雲代理）→ 主機 nginx :443 → PM2 app**，**不是 Caddy**。
> nginx vhost（`/etc/nginx/sites-available/tschool-sso`）與 TLS 憑證都由 **root** 管，部署帳號 動不了。
> 伺服器部署根目錄是 **`~/tpass/`**，各服務目錄統一為 `tpass-auth` / `tpass-portal` / `tpass-form` / `tpass-cross_grade_messages`。

| 服務 | 本機網址 | 上線網址 | 內部 port |
| --- | --- | --- | --- |
| `tpass-auth`（SSO 發證） | `https://auth.lvh.me:3000` | `https://auth.tschoolsu.org` | 3000 |
| `tpass-portal`（portal） | `https://portal.lvh.me:3001` | `https://portal.tschoolsu.org` | 3001 |
| `tpass-form`（問卷） | `https://form.lvh.me:3002` | `https://form.tschoolsu.org` | 3002 |
| `tpass-cross_grade_messages`（跨屆傳訊） | `https://msg.lvh.me:3003` | `https://msg.tschoolsu.org` | 3003 |

---

## 1. 一次性環境準備（本機）

前置：裝好 `node`（與 repo 同大版）、`mkcert`（`brew install mkcert nss`）、`postgresql`（tpass-form 用）。

```bash
scripts/setup.sh
```

它會（冪等，可重跑）：
1. `mkcert -install`：把 mkcert 根憑證裝進系統信任區（瀏覽器才不擋本機 HTTPS）。
2. 產一張涵蓋 `auth.lvh.me / portal.lvh.me / form.lvh.me` 的憑證 → `certs/cert.pem`、`certs/key.pem`。
3. 三 repo `npm install`。
4. 跑 `tpass-auth/scripts/gen-keys.mjs` 印出 EdDSA 金鑰兩行。
5. （偵測到 Postgres 時）tpass-form `db:generate` + `db:push`。

**接著手動完成**（setup.sh 結尾也會再提示）：

```bash
cp tpass-auth/.env.example   tpass-auth/.env.local
cp tpass-portal/.env.example tpass-portal/.env.local
cp tpass-form/.env.example tpass-form/.env.local
```

- `tpass-auth/.env.local`：貼上 setup 印出的 `JWT_PRIVATE_KEY` / `JWT_PUBLIC_KEY`。
- 三個 `.env.local` 都設憑證路徑（本機 smoke 的 `server.mjs` 會讀）：
  ```
  TLS_KEY_FILE=<repo 絕對路徑>/../certs/key.pem
  TLS_CERT_FILE=<repo 絕對路徑>/../certs/cert.pem
  ```
- `tpass-form/.env.local`：設 `DATABASE_URL`（本機 Postgres），然後 `cd tpass-form && npm run db:push`。

> `lvh.me` 與其子網域由公共 DNS 直接指向 `127.0.0.1`，**不必改 `/etc/hosts`**。

---

## 2. 本機開發（兩層迴圈）

### 內層：日常迭代，有 HMR

```bash
scripts/dev.sh all          # 或 scripts/dev.sh portal
```

底層是 `next dev --experimental-https`（吃 mkcert 憑證）+ `-H <子網域>.lvh.me`，所以**HTTPS、Secure cookie、跨子網域的完整 SSO 流程在 dev 模式照樣測得到**，又保有 Fast Refresh。90% 的時間待在這層。

> **為什麼不是 `npm run dev`？** 全域規則「禁用 `npm run dev`」是約束 **AI agent 不要靠長駐 dev server 判斷對錯**（agent 改用 `lint`+`tsc`）；它不是禁止你人類用 dev 迴圈。`dev.sh` 就是給人用的正確 dev 方式。

### 部署前 smoke：push 前跑一次

```bash
scripts/check.sh            # lint + tsc --noEmit（三 repo）
scripts/start-all.sh        # production build + start:https
```

`start-all.sh` 用 production build（`server.mjs` 跑 HTTPS），是本機最貼近上線 `next start` 的形態，專抓 dev 模式漏掉的 build / 型別 / RSC / React Compiler 行為差異。

### 驗收登入流程

1. 開 `https://portal.lvh.me:3001` → 未登入會導去 auth。
2. **真人手動完成 Google 登入**（不可自動化，違反條款）。
3. 帶 cookie 回 portal，顯示已登入；開 `https://form.lvh.me:3002` 應共享同一 session。

抓 JWKS 驗證 auth 正常：

```bash
curl --cacert "$(mkcert -CAROOT)/rootCA.pem" https://auth.lvh.me:3000/.well-known/jwks.json
# 應含 kid:"tpass-key-1"、alg:"EdDSA"、kty:"OKP"、crv:"Ed25519"
```

---

## 3. 本機 vs 上線：環境變數對照表（本檔的心臟）

**邏輯零改，只換 env 值＋啟動方式。** 啟動指令（`dev` / `start:https` / `next start`）全都已在各 `package.json`，不需動 code。

| 項目 | 本機 (local) | 上線 (Cloudflare + nginx + PM2) |
| --- | --- | --- |
| 服務怎麼跑 | `dev.sh`（dev, HMR）或 `start:https`（smoke） | `pm2 start ecosystem.config.js` → 各跑 `next start -H 127.0.0.1 -p <port>` |
| TLS | mkcert 自簽 + `server.mjs` | **nginx**（root）終結 TLS + Let's Encrypt 憑證；再前置 **Cloudflare 橘色雲**。app 不碰 TLS |
| `NODE_EXTRA_CA_CERTS` | **需要**（Node 信任 mkcert CA 才抓得到 JWKS） | 不需要（auth 走公開 CA） |
| 網域類 env（`AUTH_BASE_URL` / `JWT_ISSUER` / `AUTH_JWKS_URL` / `AUTH_LOGIN_URL` / `AUTH_LOGOUT_URL` / `PORTAL_SELF_URL` / `MSG_SELF_URL` / `PORTAL_URL`） | `*.lvh.me:port` | 正式網域（無 port，如 `https://auth.tschoolsu.org`） |
| `AUTH_COOKIE_DOMAIN` | 空（host-only）或 `.lvh.me` | 正式根網域 `.tschoolsu.org` |
| `JWT_AUDIENCE` | `tschool-sso` | 通常不變 |
| JWT 金鑰對 | setup 本機產 | **另產一組**（`gen-keys.mjs`），存伺服器 `.env.local`，絕不重用 dev 金鑰、絕不進 git |
| Google OAuth | dev client + `*.lvh.me` redirect URI | prod client（或同 client 加 prod redirect URI），須在 Google Cloud 後台登記 |
| `DATABASE_URL`（form / msg） | 本機 Postgres | 伺服器 Postgres，**每服務專屬 user+db**（`t_form` / `t_msg`） |
| Prisma 套 schema | `npm run db:push` | form → `db push`（無 migrations）；msg → `prisma migrate deploy`（`deploy.sh` 內） |
| `TLS_KEY_FILE` / `TLS_CERT_FILE` | 指向 `certs/*.pem` | **不設**（上線不用 server.mjs） |
| `PORT` / `HOSTNAME` | `3000/3001/3002/3003` + `*.lvh.me` | `127.0.0.1:port`（由 `ecosystem.config.js` 設） |

> **Cookie 的 `Secure` 怎麼來？** 由 `AUTH_BASE_URL` 是否 `https://` 推導（`tpass-auth/src/config/auth.ts`）。上線即使 app 內部走 HTTP（TLS 在 nginx／Cloudflare），只要 `AUTH_BASE_URL` 是正式 https 網域，cookie 就會正確帶 `Secure`。

各 repo 需要哪些 key，看自己的 `.env.example`（`tpass-auth/`、`tpass-portal/`、`tpass-form/` 各一份）。

---

## 4. 上線拓樸（Cloudflare + nginx + PM2）

```
   使用者
     │  https（橘色雲：Cloudflare 代理 + 邊緣 TLS）
     ▼
  Cloudflare  ──►  主機（IP 見 deploy/host.env）:443
                      │
              nginx（root 管，vhost: tschool-sso，依 hostname 反代）
     ┌────────────────┼────────────────┬────────────────┐
auth.tschoolsu.org  portal.…        form.…            msg.…
     │                │                │                │
127.0.0.1:3000   127.0.0.1:3001   127.0.0.1:3002   127.0.0.1:3003
 (pm2: auth)      (pm2: portal)    (pm2: form)      (pm2: msg)
 next start       next start       next start       next start
                                        │                │
                                   PostgreSQL（t_form / t_msg，各自專屬 user+db）
```

- **對外入口是 nginx，不是 Caddy。** nginx 聲 `:443`、終結 TLS、依 hostname 反代到內部 port。
  vhost 在 `/etc/nginx/sites-available/tschool-sso`，憑證在 `/etc/letsencrypt/`——**兩者都 root 擁有，部署帳號 無 sudo 改不了**。
  新增服務要動 nginx（加 server block + 憑證）時，**停下來請有 root 的人做**。
- 本 repo 的 `deploy/Caddyfile` 在這台主機**沒有使用**（保留作他處部署參考）。
- **PM2** 管四個 `next start` 程序（純 HTTP，綁 127.0.0.1），由 部署帳號 起。設定見 `deploy/ecosystem.config.js`。
- 上線**完全不用 `server.mjs`**（那只是本機跑 HTTPS 用）。

### Cloudflare 橘色雲：新服務上線的灰雲→橘雲儀式

上新子網域（如 `msg`）時的正確順序，以及**為什麼**：

1. **先切灰色雲（DNS only）** — DNS 直接指向主機 IP，Cloudflare 不代理。
2. 讓 nginx / certbot 用 **Let's Encrypt HTTP-01 challenge** 簽到憑證。
   → 這一步**必須灰雲**：challenge 是 ACME server 直接打 `http://msg.tschoolsu.org/.well-known/acme-challenge/…`
   到**你的主機**驗證。若此時是橘雲（代理），請求會被 Cloudflare 邊緣接走、打不到你的 nginx，challenge 失敗、簽不到憑證。
3. 憑證簽好、`curl` 直連主機確認服務正常後，**再切回橘色雲（代理）** — 這樣才享有 Cloudflare 隱藏源站 IP、快取、WAF。

> 一次搞定、免每次來回切的長期解：改用 **Cloudflare Origin Certificate**（15 年、只給 Cloudflare 信任）
> 或 **DNS-01 challenge**，就能一直維持橘雲、不必為了續憑證切灰雲。目前流程可用，這是可選優化。

---

## 5. 部署流程

### 5.1 伺服器一次性準備

1. 裝 `node`（同本機大版）、`pm2`（`npm i -g pm2`）、`nginx`、`postgresql`。（入口用 nginx，非 Caddy。）
2. 本機：各服務先 `git push`（四 repo 見 `GIT-REPOS.md`）。
3. 伺服器：並排 clone 四 repo（統一 `tpass-*` 命名）+ 放 deploy 範本：
   ```
   ~/tpass/tpass-auth
   ~/tpass/tpass-portal
   ~/tpass/tpass-form
   ~/tpass/tpass-cross_grade_messages
   ~/tpass/deploy/{ecosystem.config.js, deploy.sh}   # Caddyfile 本機不使用
   ```
4. **[需 root]** Postgres 建**每服務專屬** DB + user（如 `t_form` / `t_msg`），組出 `DATABASE_URL`。
5. 各 repo 建 `.env.local`（照 §3 的上線欄）。**JWT 金鑰另跑 `gen-keys.mjs` 產新的一組**（公鑰也要進 `tpass-auth/.env.local`；消費端走 JWKS，不需金鑰）。
6. **[需 root]** nginx：在 `/etc/nginx/sites-available/tschool-sso` 加該子網域的 server block（`reverse_proxy 127.0.0.1:<port>`），
   憑證用 Let's Encrypt（**先切 Cloudflare 灰雲**再簽，見 §4 儀式），`nginx -t && systemctl reload nginx`。
7. 首次啟動（部署帳號，無 root）：
   ```bash
   cd ~/tpass
   for d in tpass-auth tpass-portal tpass-form tpass-cross_grade_messages; do (cd $d && npm ci && npm run build); done
   (cd tpass-form && set -a; . .env.local; set +a; npm run db:push)               # form 無 migrations
   (cd tpass-cross_grade_messages && set -a; . .env.local; set +a; npx prisma migrate deploy)  # msg 有 migrations
   cd deploy && pm2 start ecosystem.config.js && pm2 save && pm2 startup
   ```
8. **[需 root/DNS]** Cloudflare：各子網域一筆記錄指向主機 IP，簽好憑證後切**橘色雲**（見 §4）。
9. Google Cloud 後台：加 prod redirect URI `https://auth.tschoolsu.org/api/auth/callback/google`。

### 5.2 之後每次部署

```bash
# 本機
scripts/check.sh        # 先把關
git push

# 伺服器
scripts/ssh.sh                           # 連主機（設定見 deploy/host.env）
cd ~/tpass/deploy && ./deploy.sh all     # 或 ./deploy.sh msg
```

`deploy.sh` 對每個服務：`git pull` →（`package-lock.json` 變動才）`npm ci` → `npm run build` →
`form` 額外 `prisma db push`、`msg` 額外 `prisma migrate deploy` → `pm2 reload`（zero-downtime）。

---

## 6. 上線前 checklist

- [ ] `scripts/check.sh` 各 repo 全綠。
- [ ] §3 對照表逐 key 核對：伺服器各 `.env.local` 的網域、cookie domain、audience、金鑰、`DATABASE_URL` 都填對。
- [ ] 上線用的 JWT 金鑰是**新產的一組**，不是 dev 的。
- [ ] Google Cloud 已登記 prod redirect URI。
- [ ] nginx vhost 的子網域 → port 對齊 `ecosystem.config.js`（auth=3000 / portal=3001 / form=3002 / msg=3003），`nginx -t` 通過。
- [ ] DNS：各子網域都指向主機；憑證簽好後才切 Cloudflare 橘色雲。

---

## 7. 疑難排解

串接 / TLS / 驗章相關問題，一律看權威來源，不在此重抄：

- 本機 HTTPS、`NODE_EXTRA_CA_CERTS`、JWKS 抓不到 → `tpass-auth/INTEGRATION.md §9`
- 登入後仍未登入、`400 Invalid redirect_uri`、驗章一直失敗 → `tpass-auth/INTEGRATION.md §11`
- 串接四鐵則與各語言範本 → `tpass-auth/INTEGRATION.md §5 / §8 / §12`

本 SOP 專屬：

| 症狀 | 解法 |
| --- | --- |
| `dev.sh` 報找不到憑證 | 先跑 `scripts/setup.sh` 產 `certs/`。 |
| 瀏覽器仍擋本機 HTTPS | `mkcert -install` 沒跑或瀏覽器要重開。 |
| `start-all.sh` build 失敗但 `dev.sh` 正常 | production build 才會炸的錯（型別 / RSC 邊界）；看輸出修掉，這正是 smoke 層的價值。 |
| `deploy.sh` `git pull` 失敗 | 伺服器上有本機改動或 detached；先 `git status` 清乾淨（伺服器不該手改 code）。 |
| 部署後 502 | PM2 程序沒起來（`pm2 logs <name>`）或 nginx vhost 反代 port 與 ecosystem 不一致。 |
| 切橘雲後 5xx / 憑證錯 | 憑證還沒簽好就切了橘雲；先切回灰雲、簽好 Let's Encrypt 憑證、`curl` 直連主機確認 200 再切橘雲（見 §4）。 |
| 新服務切灰雲仍簽不到憑證 | DNS 記錄沒指到主機 IP，或 nginx `:80` 的 `.well-known/acme-challenge` 被擋；`nginx -t` + 確認 A record。 |
