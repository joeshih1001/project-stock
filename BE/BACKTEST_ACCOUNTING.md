# 回測會計、比較與資料限制

## 執行與下載

從專案根目錄分別啟動 `BE` 的 `npm run start:dev` 與 `FE` 的 `npm run dev`。建立回測後，API 沿用 `POST /api/backtests`、`GET /api/backtests/:id`、`GET /api/backtests/:id/result`。成功任務另提供 `GET /api/backtests/:id/export/:kind`，`kind` 為 `trades.csv`、`equity_daily.csv`、`benchmarks_daily.csv`、`summary.json`、`run_manifest.json`。CSV 為 UTF-8 BOM，可在 macOS Numbers 開啟；JSON 保留完整結構供重現。

在 `BE/` 執行可手算的合成範例：

```bash
python3 python/backtest.py \
  --data python/tests/fixtures/corporate-actions-bars.csv \
  --symbol TEST --cash 100 --ma 2 --allocation 0.5 \
  --adjustment raw --actions python/tests/fixtures/corporate-actions.csv \
  --actions-verified --product-type ETF \
  --fee-rate 0 --sell-fee-rate 0 --tax-rate 0
```

該資料的 100% 與 50% 買進持有基準期末均為 100。第二天發生 4:1 分割，第三天每股配 0.5，第四天入帳；除息日資產中的 20 元先列為應收，入帳時由應收轉現金，沒有重複增加權益。可用 `python3 -m unittest discover -s python/tests -v` 重跑手算測試。

## 計算口徑

- 買進扣款為滑價後價格乘股數加買進手續費。賣出入帳為滑價後價格乘股數減賣出手續費及交易稅。折扣立即作用於費額，先取整再套單筆最低費；稅額以賣出金額乘稅率後捨去至整元。事後退費尚未實作。
- 買進股數為指定 `lotSize` 的倍數；演算法包含費用反覆檢查預算，不允許負現金。預設股息留現金，現金利息為零，不重複扣 ETF 已反映在價格內的經理費。
- 策略維持既有 MA 收盤訊號、次一交易日開盤成交規則。100% 與 50% 基準在正式期間第一根開盤買入，之後不再平衡；策略與兩基準共用同一行情、股息、拆股、滑價與費稅。零成本策略只關閉費稅與滑價，用於顯示成本影響。
- 每日資產等於現金加持股市值加股息應收。高水位包含初始資金，回撤是當日收盤資產相對此前高水位的跌幅。期末未平倉按收盤價評價，不預扣未發生的清算成本。年化採起迄日實際日數與 365.25 日年長，零長度或非正期末資產為不可計算。
- `run_manifest.json` 保存任務 ID、時間、版本、資料 SHA-256、完整請求與驗證標記。已看過 2018–2025 結果的區間標記為 `YES`，調參用途預設 `UNKNOWN`；驗證狀態一律 `PENDING_CONFIRMATION`，不自動判定通過。

## 官方規則與仍缺的資料

2026-10-05 查核的[財政部證券交易稅說明](https://www.etax.nat.gov.tw/etwmain/tax-info/understanding/tax-saving-manual/national/securities-transaction-tax/JNxPwlJ)列出股票千分之三、證券投資信託受益憑證千分之一。Node API 對 2018 年起的非當沖 `STOCK`／`ETF` 情境分別帶入 0.003／0.001 賣出稅率；早於 2018 年的這項內建假設會被拒絕，其他商品類型標為未確認。稅額取整與實際券商明細仍須核對。

[臺灣證交所 0050 公告](https://www.twse.com.tw/zh/ETFortune/announcement?company=A00005&date=20250617&fund=0050&seq=1&type=other)指出 2025-06-18 新受益憑證上市，單位數 4:1 分割。現有 Yahoo 日線會把 `adjclose / close` 套回整根 OHLC，沒有可核對的股息權利、付款和拆股事件檔；因此該 API 的 `accountingStatus` 為 `INCOMPLETE`，畫面顯示的是調整價代理模擬，不能當作實際帳戶損益。跨 0050 分割期間另有明確警示。Python CLI 可用原始 OHLC 與已核對的事件檔做會計測試，不能把事件檔與調整價同時套用。

要得到可核對的個人帳戶績效，仍需提供：群益／國泰帳戶實際買賣費率、折扣、最低費及取整規則；原始未還原日線及完整拆股／除息／付款事件；2018–2025 是否用於調參。個人股息稅負、事後退費、系統營運費、漲跌停與缺價下的未成交、零股市場獨立滑價均未實作。若要以這些項目為條件解讀結果，必須先補資料與模型；目前報表不可標示為「實際完整成本」或通過獨立驗證。
