# TSchool git repos

## 服務子 repo（各自獨立 .git；註冊表見 `services.json`）

1. https://github.com/YC815/tpass-auth — SSO 發證
2. https://github.com/YC815/tpass-portal — 門戶（消費端參考實作）
3. https://github.com/YC815/tpass-form — 問卷
4. https://github.com/YC815/tpass-cross_grade_messages — 跨屆代傳
5. https://github.com/YC815/tpass-appeals — 申訴（尚未上線主機）
6. https://github.com/YC815/tpass-directory — **已封存（2026-07-05），不部署**

## ops repo（頂層本身，只追蹤 services.json / scripts / deploy / docs / SOP）

- https://github.com/YC815/tpass-ops （private）
- 主機 `~/tpass` 是本 repo 的 clone（git 化步驟見 `docs/MERGE-AND-DEPLOY.md §2`）

## 連部署主機

`scripts/ssh.sh`（主機位址/帳號是機密，見 gitignored 的 `deploy/host.env`）；
日常操作用 `scripts/tpass deploy / status / logs`。
