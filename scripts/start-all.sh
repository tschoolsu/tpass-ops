#!/usr/bin/env bash
# 相容 wrapper：實作已移到 scripts/tpass（讀 services.json）。直接用 tpass start 即可。
exec "$(cd "$(dirname "$0")" && pwd)/tpass" start "$@"
