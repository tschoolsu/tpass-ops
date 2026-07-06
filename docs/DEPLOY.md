# 部署與主機拓樸（權威）

> 主機上**永遠不裝任何部署工具**（效能預算給產品本身）：只有 ssh + git + node + pm2 +
> nginx（root 管）+ PostgreSQL。所有部署動作從本機 `tpass deploy` 經 ssh 觸發。
> 主機位址/帳號是機密，只存在 gitignored 的 `deploy/host.env`。

---

## 1. 拓樸

```
   使用者
     │  https（橘色雲：Cloudflare 代理 + 邊緣 TLS）
     ▼
  Cloudflare  ──►  主機（IP 見 deploy/host.env）:443
                      │
              nginx（root 管，vhost: tschool-sso，依 hostname 反代）
     ┌────────────────┼────────────────┬────────────────┐
auth.tschoolsu.org  portal.…        form.…            msg.…   （appeals 上線後同型）
     │                │                │                │
127.0.0.1:3000   127.0.0.1:3001   127.0.0.1:3002   127.0.0.1:3003
 (pm2: auth)      (pm2: portal)    (pm2: form)      (pm2: msg)
 next start       next start       next start       next start
                                        │                │
                                   PostgreSQL（每服務專屬 user+db：t_form / t_msg / t_appeals…）
```

- **對外入口是 nginx，不是 Caddy**。vhost 在 `/etc/nginx/sites-available/tschool-sso`、
  憑證在 `/etc/letsencrypt/`——都 root 擁有，部署帳號無 sudo。要動 nginx 時
  **停下來把 server block 交給有 root 的維運部員**（`tpass new` 會自動印出來）。
- **PM2** 由部署帳號管 `next start` 程序（純 HTTP 綁 127.0.0.1）。app 清單由
  `deploy/ecosystem.config.js` 從 `../services.json` 派生（`deployed:true` 者）。
- app 的 `Secure` cookie 由 `AUTH_BASE_URL` 等 env 是否 https 推導；TLS 全在 nginx/Cloudflare 終結。

## 2. 主機目錄佈局（= tpass-ops repo clone）

```
~/tpass/                    ← tpass-ops 的 git clone（deny-all 白名單 .gitignore）
├── services.json           ← 服務註冊表（唯一真相）
├── deploy/{deploy.sh, ecosystem.config.js}
├── scripts/…               ← 主機上用不到，但跟著版控走
├── tpass-auth/             ← 各服務 repo 並排 clone（被頂層 .gitignore 排除）
├── tpass-portal/  tpass-form/  tpass-cross_grade_messages/  …
```

每次 `tpass deploy` 都先 `git pull` ops repo 自我更新（deploy.sh / services.json /
ecosystem 吃最新 main），再執行 `deploy/deploy.sh <svc>`。主機尚未 git 化？
一次性 runbook 見 `docs/MERGE-AND-DEPLOY.md`。

## 3. 每次部署發生什麼（deploy/deploy.sh）

對每個服務：`git pull --ff-only` → **env 必填檢查**（awk 解析該 repo
`src/config/*.ts` 的 REQUIRED 陣列，缺 key 先擋，不讓 next build 埋雷）→
鎖檔變動才 `npm ci` → `prisma generate`（有 DB 者）→ `npm run build` →
依 `services.json` 的 `db.strategy` 跑 `prisma migrate deploy` 或 `db push` →
`pm2 startOrReload`（既有 app zero-downtime；registry 新服務自動首啟）。

## 4. 本機 vs 上線 env 對照（邏輯零改，只換值）

| 項目 | 本機 | 上線 |
| --- | --- | --- |
| 服務怎麼跑 | `tpass dev`（HMR）/ `tpass start`（smoke） | pm2 → `next start -H 127.0.0.1` |
| TLS | mkcert + server.mjs | nginx（Let's Encrypt）+ Cloudflare 橘雲 |
| `NODE_EXTRA_CA_CERTS` | 需要（tpass dev 自動處理） | 不需要 |
| 網域類 env | `*.lvh.me:port` | 正式網域（無 port，`*.tschoolsu.org`） |
| `AUTH_SERVICE_IDS`（auth） | `portal,form,msg,appeals` | 同（新服務時加 id） |
| `TPASS_SERVICE_ID`（消費端） | 各自 id | 同 |
| `AUTH_COOKIE_DOMAIN`（v1 遷移期） | `.lvh.me` | `.tschoolsu.org`；v2 全面上線後停用 |
| JWT 金鑰對 | setup 產 | **另產一組**，絕不重用 dev 金鑰、絕不進 git |
| `DATABASE_URL` | `t_<id>@localhost`（tpass db setup 建） | 主機 per-service user+db（root 建） |
| `TLS_KEY_FILE` / `PORT` / `HOSTNAME` | 設 | 不設（pm2/ecosystem 管） |

## 5. Cloudflare 灰雲→橘雲儀式（新子網域上線）

1. **先切灰色雲（DNS only）**——Let's Encrypt HTTP-01 challenge 必須直接打到主機；
   橘雲代理會把 challenge 接走、簽不到憑證。
2. root 部員：nginx server block + `certbot certonly`。
3. `curl` 直連主機確認 200 → **切回橘色雲**（隱藏源站 IP、WAF、快取）。

> 長期可選優化：Cloudflare Origin Certificate（15 年）或 DNS-01 challenge，
> 可一直維持橘雲、不必為續憑證來回切。

## 6. 疑難排解

| 症狀 | 解法 |
| --- | --- |
| `tpass deploy` git 錯誤 | 主機 `git -C ~/tpass status` 不乾淨（主機不該手改檔案）或尚未 git 化（見 MERGE-AND-DEPLOY.md） |
| 部署後 502 | `tpass logs <svc>` 看 pm2；或 nginx 反代 port 與 services.json 不一致 |
| 切橘雲後 5xx / 憑證錯 | 憑證沒簽好就切橘雲——回灰雲簽好再切（§5） |
| env 缺 key 部署被擋 | deploy.sh 會列出缺哪些；對照該 repo `.env.example` 補真值 |
| pm2 app 不存在 | `pm2 startOrReload deploy/ecosystem.config.js --only <id>` 後 `pm2 save` |

## 附：Caddy 參考設定（本主機不使用）

若未來換到可用 Caddy 的主機，等價設定（自動 Let's Encrypt）：

```caddyfile
# export TSCHOOL_DOMAIN=tschoolsu.org
auth.{$TSCHOOL_DOMAIN}    { reverse_proxy 127.0.0.1:3000 }
portal.{$TSCHOOL_DOMAIN}  { reverse_proxy 127.0.0.1:3001 }
form.{$TSCHOOL_DOMAIN}    { reverse_proxy 127.0.0.1:3002 }
msg.{$TSCHOOL_DOMAIN}     { reverse_proxy 127.0.0.1:3003 }
appeals.{$TSCHOOL_DOMAIN} { reverse_proxy 127.0.0.1:3004 }
```
