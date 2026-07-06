#!/usr/bin/env bash
# 連部署主機。主機位址/帳號是機密，只存在 gitignored 的 deploy/host.env。
# 用法：
#   scripts/ssh.sh                              # 開互動 shell
#   scripts/ssh.sh 'cd ~/tpass/deploy && ./deploy.sh all'   # 帶命令執行
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
if [[ ! -f "$root/deploy/host.env" ]]; then
  echo "缺 deploy/host.env — 先 cp deploy/host.env.example deploy/host.env 並填值" >&2
  exit 1
fi
set -a; . "$root/deploy/host.env"; set +a
exec ssh "$DEPLOY_USER@$DEPLOY_HOST" "$@"
