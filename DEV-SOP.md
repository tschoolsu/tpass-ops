# DEV-SOP（已搬家）

> 本檔內容已重整到 `docs/`，這裡只留指標（別的文件還連到這個檔名）。

| 你要找… | 去這裡 |
| --- | --- |
| 開發 → 測試 → 部署 完整流程 | **`docs/ONBOARDING.md`** |
| 主機拓樸、nginx/Cloudflare、root 分工、env 對照表 | **`docs/DEPLOY.md`** |
| 這一輪大改版的 merge / 上線 runbook | **`docs/MERGE-AND-DEPLOY.md`** |
| 新服務標準與登記 | **`docs/SERVICE-TEMPLATE.md`** |
| 安全審查發現 | **`docs/SECURITY-REVIEW.md`** |

TL;DR：一切從 `scripts/tpass` 開始（不帶參數＝互動選單）：

```bash
scripts/tpass setup   # 一次性環境準備
scripts/tpass dev     # 日常開發（HTTPS + HMR）
scripts/tpass check   # push 前把關
scripts/tpass deploy  # 部署
```
