# 專案工作約定

## Git 暫存與推送

- 使用者要求 commit 或 push 時，先檢查 `git status`，確認本次要提交的變更。
- 本次變更涉及 `BE/` 時，從 repository 根目錄執行 `git add BE/`。
- 本次變更涉及 `FE/` 時，從 repository 根目錄執行 `git add FE/`。
- 若兩邊都有變更，分別執行上述兩個指令；不要用 `git add .` 或 `git add -A` 取代。
- 根目錄及其他路徑的檔案，只有在本次提交需要時才明確指定路徑暫存。
- commit 前檢查已暫存的 diff，避免夾帶與本次工作無關的變更。

## Commit 訊息

- 以繁體中文為主，簡潔描述本次變更。
- 文件或 `AGENTS.md` 變更以 `[docs]` 開頭，例如 `[docs] 加入專案工作約定`。
- 前端變更以 `[FE]` 開頭，後端變更以 `[BE]` 開頭。
- 同時修改 FE 與 BE 時，若能獨立提交就分成兩個 commit；無法拆分時使用 `[FE][BE]` 開頭。
