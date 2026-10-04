# 台股 Python 回測任務 API

第一版後端依照「Node.js 管理資料與任務、Python 執行歷史模擬」的分工實作：NestJS 取得並整理 Yahoo Finance 日線、保存可追溯的 CSV、管理任務與結果，再以受控子程序啟動 Python。前端與券商實盤下單不在本版範圍內。

## 架構與資料流

1. `POST /api/backtests` 驗證設定、建立任務並立即回傳 `202 Accepted`。
2. 背景工作把純數字台股代號（例如 `0050`）轉成 Yahoo 的 `0050.TW`，下載並整理 `Date,Open,High,Low,Close,Volume` CSV。
3. CSV 旁保存來源、調整方式、涵蓋範圍、更新時間及 SHA-256；同一份完整資料可重複使用。
4. Node.js 以參數及受控 CSV 路徑啟動 `python/backtest.py`。Python 的 stdout 只輸出一份 JSON，診斷訊息走 stderr。
5. Node.js 驗證 JSON 後，把任務與完整報告分別保存到 `results/`，供狀態及結果 API 查詢。

任務有 `queued`、`running`、`succeeded`、`failed`、`cancelled` 五種狀態。服務會限制同時執行數、Python 執行時間、stdout/stderr 大小，也支援取消；服務重啟後，先前尚未完成的任務會標記為失敗，避免留下永久執行中的假狀態。

## 環境需求與啟動

- Node.js 20 以上
- Python 3.10 以上（回測核心只用標準函式庫）

```bash
npm install
npm run start:dev
```

預設服務位址為 `http://localhost:5500`：

- Swagger：`http://localhost:5500/docs`
- 健康檢查：`GET /api/health`
- 策略清單：`GET /api/strategies`
- 行情清單：`GET /api/market-data`
- 任務清單：`GET /api/backtests`

## 建立與查詢回測

PowerShell 範例：

```powershell
$body = @{
  symbol = '0050'
  from = '2018-01-01'
  to = '2025-12-31'
  strategy = 'ma-trend'
  maPeriod = 60
  initialCapital = 100000
  allocation = 0.5
  feeRate = 0
  slippageRate = 0
  maxDrawdownWarningPct = 20
} | ConvertTo-Json

$task = Invoke-RestMethod -Method Post `
  -Uri 'http://localhost:5500/api/backtests' `
  -ContentType 'application/json' `
  -Body $body

Invoke-RestMethod "http://localhost:5500$($task.links.self)"
Invoke-RestMethod "http://localhost:5500$($task.links.result)"
```

建立任務只代表已排隊，不代表回測已完成。狀態成為 `succeeded` 後才能讀取結果；其餘狀態讀取結果會回 `409 Conflict`。取消排隊中或執行中的任務：

```text
DELETE /api/backtests/{id}
```

如需在回測前明確強制更新行情：

```http
POST /api/market-data/update
Content-Type: application/json

{"symbol":"0050","from":"2018-01-01","to":"2025-12-31"}
```

## 第一版模型

- 策略為 `ma-trend`，預設使用 60 個交易日簡單移動平均線。
- 訊號只使用當日收盤以前的資料，最快在下一交易日開盤成交，避免前視偏誤。
- 每次進場最多使用當時總資產的 50%，使用整數股，不放空、不加碼。
- 回測結束若仍持倉，以最後收盤價評價為未實現損益，不虛構一筆期末成交。
- `maxDrawdownWarningPct` 只用來評估結果及產生警告，不是停損，也不會中止交易。
- 手續費與滑價預設皆為 0，因架構文件尚未指定實際假設；研究時應明確傳入並保存。
- Yahoo 的 `adjclose / close` 比率會套到整根 OHLC，成交量固定標示為股。資料仍不是 point-in-time 官方資料，配息、分割與資料回溯修訂都必須在解讀績效時納入考量。

完整結果包含引擎/策略版本、資料 SHA-256、參數、資料範圍、績效、每日資產、交易明細與警告，可用來重現及比較實驗。

## 設定

可複製 `.env.example` 後調整：

```text
PORT=5500
MARKET_DATA_DIR=./data/market-data
RESULTS_DIR=./results
PYTHON_EXECUTABLE=python
BACKTEST_SCRIPT=./python/backtest.py
BACKTEST_MAX_CONCURRENCY=1
BACKTEST_TIMEOUT_MS=120000
BACKTEST_MAX_OUTPUT_BYTES=20971520
BACKTEST_MAX_STDERR_BYTES=1048576
```

程式檔由後端設定，API 不接受任意 Python 或 CSV 路徑。若部署到多人可存取的環境，仍應在反向代理或應用層補上認證、限流及允許來源明確的 CORS 設定。

## 驗證

```bash
npm test -- --runInBand
npm run test:python
npm run build
```

目錄分工：

```text
src/                 NestJS API、行情、任務、持久化與 Python runner
python/backtest.py   Python CLI 與 JSON 輸出入口
python/strategies/   回測策略與模擬邏輯
data/market-data/    產生的 CSV 與來源中繼資料（不提交版本控制）
results/             任務與回測報告（不提交版本控制）
```
