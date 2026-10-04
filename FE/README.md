# 台股策略回測前端

使用 React、TypeScript、Vite 與 Tailwind CSS 建立的台股回測介面。前端依照後端非同步任務 API 建立回測、輪詢執行狀態、取消任務，並呈現 Python 引擎回傳的績效、每日權益與交易明細。

## 啟動方式

```bash
npm install
npm run dev
```

預設後端位址是 `http://localhost:5500`。如需修改，請將 `.env.example` 複製為 `.env.local`，再設定 `VITE_API_BASE_URL`。

## API 流程

1. `GET /api/strategies`：取得策略、版本與預設參數。
2. `GET /api/market-data`：取得已準備的行情 CSV 與資料版本。
3. `POST /api/backtests`：建立回測任務，取得 task ID。
4. `GET /api/backtests/:id`：輪詢任務狀態與執行階段。
5. `GET /api/backtests/:id/result`：任務成功後取得完整結果。
6. `DELETE /api/backtests/:id`：取消排隊中或執行中的任務。

目前介面對應 `ma-trend` 策略，支援均線週期、初始資金、投入比例、買賣手續費、折扣、最低費、取整、交易單位、商品種類、滑價率與最大回撤提醒門檻。純數字台股代號由後端以 Yahoo 上市市場 `.TW` 準備行情；實際資料來源與版本會顯示在結果中。

回測完成後可下載完整交易、每日資產、兩種買進持有基準 CSV，以及摘要與執行參數 JSON；有交易明細時還可按「下載表格摘要 CSV」取得畫面欄位。CSV 可在 Mac 的 Numbers 開啟。資料限制與精確口徑詳見 [後端會計說明](../BE/BACKTEST_ACCOUNTING.md)。

## 回測假設

- 收盤產生訊號，下一交易日開盤成交。
- 只使用整股，期末未平倉部位按最後收盤價評價。
- 起始日前資料只供均線暖身，不會用於交易。
- 買賣手續費、滑價、最低手續費與交易單位可分別設定；賣出交易稅按商品種類套用研究用假設。
- Yahoo 調整價缺少可核對公司行動明細時，畫面標示會計不完整；三者比較是同一價格序列下的模擬。
- 最大回撤門檻只產生提醒，不會自動停損。

## 品質檢查

```bash
npm run format:check
npm run lint
npm run typecheck
npm test
npm run build
```

本工具僅供研究與模擬使用，不代表真實成交、未來績效或投資建議。
