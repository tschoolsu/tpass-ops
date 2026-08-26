# 部員手冊（HackMD 同步來源）

這個資料夾放**給夥伴看的文件**。每一份對應團隊 HackMD 的一篇筆記，由維運部員手動同步過去。

**要給夥伴看的東西就寫在這裡**，不要另外開檔案散落在各處。

---

## 四篇

| 檔案 | HackMD 標題 | 誰該讀 | 一句話 |
| --- | --- | --- | --- |
| `01-new-service.md` | T-Pass 服務串接指南 | 要做一個新服務的人 | 從開 repo 到上線的完整動手流程，自給自足 |
| `02-sso-contract.md` | T-Pass SSO 串接合約（契約 v2） | 正在寫串接程式碼的人 | 驗章四鐵則、JWT payload、錯誤碼、可直接抄的範本 |
| `03-design-system.md` | T-Pass Design System | 寫 UI 的人 | 顏色、字體、Neobrutalism 鐵則、禁止事項 |
| `04-registry-sop.md` | T-Pass 服務註冊表 SOP | 所有人 | 要改服務註冊表只有一條路：開 PR。含主機紅線 |

每份檔案開頭都有 HackMD 的 YAML frontmatter（`title` / `tags`），**貼過去時整份貼**，
HackMD 會自動吃掉 frontmatter 當標題與標籤。

---

## 哪些是這裡自有、哪些是副本

| 檔案 | 來源 |
| --- | --- |
| `01-new-service.md` | **這裡就是家。**（原 `docs/NEW-SERVICE.md`，2026-08-25 搬進來） |
| `04-registry-sop.md` | **這裡就是家。** |
| `02-sso-contract.md` | 同步副本，來源＝`tpass-auth/INTEGRATION.md` |
| `03-design-system.md` | 同步副本，來源＝`tpass-portal/docs/design.md` |

02 與 03 之所以不搬過來：那兩份是 **public repo 的技術契約**，跟它們描述的程式碼放在一起才有意義——
搬進私有的 ops repo，等於讓 clone `tpass-auth` 的人拿不到串接合約。

**改這兩份要改來源，再把副本刷新：**

```bash
# 在 ops repo 根目錄執行。副本開頭記著同步時的 commit，比它新就該刷新
git -C tpass-auth   log -1 --format='%h %cs' -- INTEGRATION.md
git -C tpass-portal log -1 --format='%h %cs' -- docs/design.md
```

比副本標頭記的 commit 新，就重貼一次內容並更新標頭那行 commit。

---

## 不要放進來

- 機密：主機位址、帳號、任何密鑰。**HackMD 是團隊共用的，不是保險箱。**
- `docs/SECURITY-REVIEW.md`（稽核紀錄，維運自己看）
- `docs/specs/`（實作規格暫存區，寫完就過期）
- `docs/ONBOARDING.md`（開發與維運手冊，含主機維運章節，部員用不到）

送出前掃一次：

```bash
grep -nEi '([0-9]{1,3}\.){3}[0-9]{1,3}|DEPLOY_HOST|DEPLOY_USER|password|PRIVATE KEY' docs/handbook/*.md
```

（`127.0.0.1` 與 `0.0.0.0` 是預期會出現的，其他都要看一眼。）
