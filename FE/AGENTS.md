# 股票回測前端專案 Agent 指引

本檔適用於整個 repository。這是一個 greenfield 專案；若實際程式碼、`package.json` 或 lockfile 與本檔的預設不同，先遵循現有專案設定，再以最小範圍更新本檔。所有 Agent 應使用繁體中文撰寫使用者可見文字與交付說明，程式識別字、型別與註解則使用英文。

## 產品目標

建立一個可信、易讀、可重現的股票策略回測前端，讓使用者可以：

- 選擇標的、市場、資料頻率、回測期間與基準指數。
- 選擇策略並調整參數、初始資金、部位限制、手續費、交易稅與滑價。
- 執行、取消及重新執行回測，清楚看到 loading、empty、error 與 partial-data 狀態。
- 查看資產曲線、基準比較、回撤、績效指標、持倉與逐筆交易紀錄。
- 保留或匯出完整參數、資料版本與結果，讓同一組輸入可重現。

此產品只提供研究與模擬，不得暗示保證獲利，也不得把模擬結果描述成真實成交或投資建議。

## 技術基線

除非現有專案已有不同選擇，初始化時採用：

- Vite + React + TypeScript。
- TypeScript `strict` 模式；不以 `any`、不必要的 type assertion 或關閉規則規避錯誤。
- Tailwind CSS，並以 CSS variables 管理顏色、間距與語意化 design tokens。
- Vitest + React Testing Library 進行單元與元件測試；關鍵流程可使用 Playwright。
- ESLint + Prettier（若 Tailwind 版本支援，加入 class sorting）。

套件管理一律使用 npm。安裝依賴只能使用 `npm install`（或安裝指定套件時使用 `npm install <package>`），執行 scripts 使用 `npm run <script>`；不得使用 pnpm、Yarn、Bun 或產生其他套件管理器的 lockfile。`package-lock.json` 必須與 `package.json` 同步提交。新增依賴前先確認是否能用現有能力完成，並說明新增依賴的用途。

專案建立後，`package.json` 至少應提供 `dev`、`build`、`lint`、`typecheck` 與 `test` scripts；Agent 應以實際 scripts 為準，不猜測不存在的命令。

## 建議目錄

```text
src/
  app/                  # app shell、providers、router
  pages/                # route-level pages
  features/backtest/    # 回測表單、結果、hooks、feature-local types
  components/ui/        # 無領域邏輯的共用 UI
  components/charts/    # 圖表呈現與無障礙替代內容
  domain/backtest/      # 純函式、指標公式、驗證與領域模型
  services/             # API clients、DTO mapping、storage adapters
  hooks/                # 真正跨 feature 的 hooks
  lib/                  # 通用且無領域意義的 helpers
  mocks/                # mock handlers 與 fixtures
  test/                 # test setup 與共用 test utilities
```

程式應依 feature 內聚。不要建立只為轉傳 export 的深層抽象，也不要把所有型別或工具集中成無邊界的巨型檔案。

## React 與 TypeScript 規則

- 使用 function components、具名匯出與明確 props types；route framework 有要求時才使用 default export。
- 優先使用 discriminated unions 表示 `idle | loading | success | empty | error`，避免多個 boolean 產生不可能狀態。
- 不把可由 props/state 推導的值重複存進 state；`useEffect` 只用於同步外部系統。
- 商業計算、日期正規化與資料轉換不得寫在 JSX 或圖表元件內，應放在可獨立測試的純函式。
- API response 視為不可信資料：在 service boundary 驗證並由 DTO 明確轉換成 domain model。
- 非同步請求需處理競態、取消、重試邊界與 stale response；元件 unmount 後不得更新狀態。
- 清單使用穩定的 domain ID，不以 array index 當 key（靜態且永不重排的展示清單除外）。
- 不提前濫用 `useMemo`/`useCallback`；先確認昂貴計算或 referential stability 確實有價值。
- 使用 `import type` 匯入型別。共用公開函式要有明確輸入、輸出型別與精簡 JSDoc，尤其是金融公式及其假設。

## 回測正確性（最高優先級）

金融計算的正確性高於視覺效果。任何公式或執行假設改動，都必須同步更新型別、測試與畫面說明。

- 明確定義訊號時間與成交時間。預設為第 `t` 根 bar 收盤後產生訊號、最早於第 `t+1` 根可交易 bar 成交，禁止無意的 look-ahead bias。
- 明確記錄價格來源與欄位。使用 adjusted price 或 raw OHLCV 必須一致，並說明股利、拆股、合併與公司行動的處理方式。
- 不得默默 forward-fill 價格或把缺失值當 `0`。缺資料、停牌、上市前區間與不同交易日曆都要採明確政策並產生提示。
- 手續費、交易稅、滑價、最小交易單位、四捨五入方式、現金限制與是否允許放空，都屬於回測輸入，不得藏在 UI 常數中。
- 金額與費率避免直接依賴 IEEE-754 浮點等值比較。API 邊界優先傳 decimal string 或最小貨幣單位；計算層採一致的 decimal/rounding policy。
- 日期使用 ISO `YYYY-MM-DD` 表示交易日，timestamp 使用含 offset 的 ISO 8601。市場時區與使用者顯示時區需分離，禁止用隱含 UTC 轉換造成日期位移。
- 年化報酬、年化波動、Sharpe ratio、Sortino ratio、最大回撤、勝率與 profit factor 必須各自有公式、週期與無風險利率假設。樣本不足時顯示 unavailable，不回傳誤導性的 `0`。
- 最大回撤應由歷史高點至其後低點計算，並保留 peak、trough 與 recovery（若有）日期。
- 基準必須使用相同回測區間、交易日對齊規則與資金流假設。顯示「無基準資料」優於拼接或臆測資料。
- 每次結果至少關聯：策略 ID/版本、完整參數、標的、資料版本或抓取時間、期間、成本模型與 engine 版本。
- 對所有輸出防守 `NaN`、`Infinity`、除以零、空序列與 overflow；不得讓無效數字進入 UI、JSON 或 CSV。
- 要區分 total return、annualized return、time-weighted return 與 money-weighted return；未實作的指標不得用近似值冒充。

若計算由後端完成，前端仍要驗證資料形狀與基本不變量，但不要在前後端各維護一份容易分歧的完整引擎。若目前只有前端 mock engine，將它隔離在 adapter 後方，以便日後替換。

## 領域模型與表單

- 使用具名單位，例如 `feeBps`、`annualRiskFreeRatePct`、`priceMinorUnits`，不要只命名為 `rate` 或 `value`。
- 將 ticker symbol、market、currency 與 exchange timezone 分開建模；ticker 不一定全球唯一。
- 百分比輸入須清楚區分 `1` 代表 1% 還是 100%，在 UI、型別、API mapping 與測試中保持一致。
- 表單至少驗證：初始資金大於零、開始日不晚於結束日、成本不得為負、配置/槓桿合法、策略參數落在有效範圍、所選期間有足夠 warm-up data。
- 驗證訊息靠近欄位、可被螢幕閱讀器關聯，送出失敗後將焦點移至第一個錯誤摘要或欄位。
- URL 或儲存的 preset 只包含非敏感且可驗證的參數；schema 變更時提供版本或 migration/fallback。

## UI、圖表與 Tailwind

- 以桌面分析工作流為主，但至少支援 360px 寬度；表格在窄螢幕可水平捲動或轉為重點卡片，不得截斷關鍵數值。
- 使用語意化 HTML、可見 focus、鍵盤操作、正確 label，以及至少 WCAG AA 對比。互動元素最小點擊範圍約 44×44px。
- 漲跌顏色需集中設定並標示目前慣例（例如台灣市場常見紅漲綠跌）。不可只靠紅/綠傳達結果；同時使用正負號、文字或圖示。
- Tailwind class 保持可讀；重複樣式抽成元件或 variant，動態 class 使用完整可掃描字串，不用 runtime 拼接造成 production CSS 遺失。
- UI 數字使用 tabular numerals；價格、貨幣、百分比與日期使用 `Intl` 並帶明確 locale/currency，不用手工字串拼接。
- 每張圖表要有標題、單位、圖例、tooltip/crosshair、loading/empty/error 狀態，並提供可讀的摘要或資料表作為無障礙替代。
- 報酬曲線與基準使用相同尺度；回撤圖清楚標示負值。Y 軸不得為營造績效而使用誤導性截斷。
- 大型序列可以為「顯示」降採樣，但績效指標必須以完整資料計算。降採樣方法不可刪除區間極值而掩蓋回撤。

## 預期頁面組成

- Header：產品名稱、資料狀態與研究用途聲明。
- Backtest configuration：標的/市場、日期、策略與參數、資金、成本、基準。
- Run controls：執行、取消、重設；避免重複送出，顯示進度或目前階段。
- Result summary：total/annualized return、benchmark return、volatility、Sharpe、max drawdown、trade count 等 KPI，並附單位與 tooltip。
- Analysis charts：equity vs benchmark、drawdown，以及策略需要時的價格/進出場點。
- Trades/positions：可排序與篩選的紀錄、分頁或虛擬化、空狀態與匯出。
- Assumptions/data quality：資料來源、時間、成本模型、公司行動、缺值與警告。

## 效能與可靠性

- 先量測再最佳化。對長序列避免在每次 render 重做排序、聚合或格式化。
- 大量計算不得長時間阻塞主執行緒；需要時使用 Web Worker，並提供取消與進度狀態。
- 保留 immutable input/result 邊界，避免圖表函式庫意外改寫 domain data。
- 錯誤畫面提供可行的恢復方式，例如重試、修改日期或回到上次有效結果；不要只顯示「發生錯誤」。
- 若顯示舊結果，必須清楚標記 stale，且不可讓舊結果看似屬於新參數。

## 安全與隱私

- 不把 API key、券商憑證或私密資料放入前端 bundle、localStorage、mock、log 或 Git。僅提交 `.env.example` 的變數名稱與安全範例。
- 不直接渲染不可信 HTML。錯誤訊息與 log 不洩漏 token、完整 request、帳戶或個資。
- CSV 匯出需防止 spreadsheet formula injection；下載檔名需正規化。
- 此前端不得在未新增明確產品需求、安全審查與二次確認流程前接入真實下單功能。

## 測試要求

每次行為變更都應新增或更新測試。最低覆蓋重點：

- 純函式：報酬、複利、回撤、年化、成本、滑價、部位與交易配對。
- Edge cases：空資料、單點、全零報酬、虧損、跨年、閏日、不同時區、缺 bar、停牌、極小/極大金額、除以零。
- Bias regression：訊號不得在同一根不可得價格成交；warm-up data 不得進入績效區間。
- 元件：輸入驗證、鍵盤操作、loading/empty/error/success、重跑時舊狀態處理。
- 整合：固定 fixture 的完整回測結果與已知 golden values。
- E2E（若已配置）：設定策略 → 執行 → 閱讀圖表摘要/交易 → 變更參數再執行。

測試 fixture 應小、固定、可人工核對，不依賴即時行情或網路。浮點結果使用有依據的 tolerance，不用過大的近似範圍讓錯誤通過。快照只用於穩定且有審查價值的輸出，不取代行為斷言。

## Agent 工作流程

1. 修改前先閱讀本檔、`package.json`、lockfile、相關 feature 與測試；確認 dirty worktree，保留使用者既有變更。
2. 對需求中的資料來源、成交時點、費用、時區或公式若有歧義，先列出採用的假設；會實質影響結果時向使用者確認。
3. 以最小、可審查的變更完成需求，不順手重構無關區域，不改 public contract 而未同步 consumers。
4. 先完成 domain types 與純計算，再接 state/UI，最後補足狀態、無障礙與測試。
5. 完成後依專案實際 scripts 執行 lint、typecheck、相關 tests 與 production build。不可宣稱未執行的檢查已通過。
6. 交付時用繁體中文摘要：改了什麼、關鍵假設、驗證結果、仍存在的限制；引用實際檔案路徑。

## 完成定義

一項工作只有在下列條件滿足時才算完成：

- 主要成功流程可用，loading、empty、error 與 invalid-input 狀態完整。
- 金融假設可見、單位一致、結果可重現，且沒有已知 look-ahead bias。
- TypeScript 無錯、無新增 lint error，相關測試與 production build 通過。
- 新 UI 可用鍵盤操作、在手機與桌面合理呈現，且不只靠顏色傳意。
- 沒有 secrets、敏感 log、意外的真實交易行為或無關檔案變更。
- 文件、fixtures 與使用者可見文字已隨行為更新。

若因專案尚未建立、依賴缺失或環境限制而無法執行某項驗證，應明確列出「未執行」、原因與建議的後續命令。
