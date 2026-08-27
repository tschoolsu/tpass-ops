#!/usr/bin/env bash
# CI 專用 SSH 金鑰的強制命令（authorized_keys 的 command="…" 指向這裡）。
#
# 那把金鑰不管送什麼指令過來，sshd 都只會執行這支——對方原本想跑的字串被丟進
# $SSH_ORIGINAL_COMMAND，這裡只把它當「服務 id」看待。所以「有 tpass-ops 寫入權」
# 等於「能按部署」，而不是「等於主機上那個帳號的 shell」。
#
# ⚠️ 整段包在 main() 裡是刻意的：底下會 git pull 覆蓋這個檔案本身，而 bash 是
# 邊讀邊執行的。先把整個函式定義解析完再呼叫，才不會執行到一半讀進新版檔案。
#
# ⚠️ tpass-ops 是 public repo，Actions 的 log 也是公開的——這裡不要印主機位址。
set -euo pipefail

main() {
  svc="${SSH_ORIGINAL_COMMAND:-all}"

  # 只允許小寫英數與 - _。順手擋掉分號、空白、反引號、$( 等注入。
  if [[ ! "$svc" =~ ^[a-z0-9_-]+$ ]]; then
    echo "✗ 非法服務 id：${svc}" >&2
    exit 2
  fi

  # 保留字：只回答「CI 這把金鑰還連得上主機嗎」，不部署任何東西。
  # 以後懷疑金鑰被撤銷、主機換位址、authorized_keys 被清掉，按一次就知道。
  if [ "$svc" = "ping" ]; then
    echo "✓ CI 金鑰可用（$(date -Is)，ops @ $(git -C "$HOME/tpass" rev-parse --short HEAD)）"
    exit 0
  fi

  # 跟本機 `tpass deploy` 完全相同的兩行：ops 自我更新，再跑部署。
  cd "$HOME/tpass"
  git pull --ff-only
  exec ./deploy/deploy.sh "$svc"
}

main
