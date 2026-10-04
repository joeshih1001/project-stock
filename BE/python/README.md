# Python MA 趨勢回測器

此目錄是供 Node.js 子程序呼叫的純 Python 回測入口，不需安裝第三方套件。支援 Python 3.9 以上版本。新增的成本、基準與公司行動用法詳見 [回測會計說明](../BACKTEST_ACCOUNTING.md)。

## 執行

```powershell
python python/backtest.py `
  --data data/0050.csv `
  --symbol 0050 `
  --from 2020-01-01 `
  --to 2025-12-31 `
  --cash 100000 `
  --ma 60 `
  --allocation 0.5 `
  --fee-rate 0.001425 `
  --slippage-rate 0.0005 `
  --max-drawdown-warning-pct 20 `
  --data-source example-vendor `
  --data-version 2025-12-31-v1 `
  --adjustment split-adjusted `
  --volume-unit shares
```

`--data` 是唯一必要參數；其餘參數有預設值，`--symbol` 未給時才使用 CSV 檔名。CSV 必須為 UTF-8（可含 BOM），包含且嚴格驗證 `Date,Open,High,Low,Close,Volume`。日期必須唯一並遞增。

成功時 stdout 只會出現一份 JSON；錯誤只寫 stderr 並以非零狀態結束。`--fee-rate` 與 `--slippage-rate` 都是比率，例如 `0.001` 代表 0.1%。交易稅、最低費、折扣與公司行動須明確設定；未核對資料時結果會標記不完整。

## 策略與成交規則

- SMA 包含當日收盤價。空手且 `Close > SMA` 時發出買進訊號；持倉且 `Close < SMA` 時發出賣出訊號；相等時不改變狀態。
- 訊號在收盤後確認，只能於下一筆 CSV 交易日的開盤價成交。
- 買進滑價為 `Open * (1 + slippageRate)`，賣出滑價為 `Open * (1 - slippageRate)`；手續費依滑價後成交金額計算。
- 僅做多、不加碼，買進整股。包含買進手續費的現金支出不超過成交當時資產的 `allocation` 比例。
- `maxDrawdownWarningPct` 只產生評估告警，不是停損，也不會中止交易。
- 期末固定使用 `MARK_TO_MARKET`：未平倉部位以最後一日 `Close` 計入資產，不虛構賣出成交，也不預扣尚未發生的賣出費用或滑價。該筆交易的 `status` 是 `OPEN`，並產生 warning。

## JSON schemaVersion 1

最上層固定包含：

```text
schemaVersion
symbol
engine
strategy
config
data
metrics
equityCurve
trades
warnings
```

`engine`、`strategy.key`/`strategy.version` 與 `data` 分別記錄引擎版本、策略版本及 CSV SHA-256/來源/版本/調整方式/成交量單位。`config` 完整回寫資金、日期、成本、部位大小與成交時序假設。若 CSV 包含 `--from` 之前的資料，這些 K 棒只用於均線暖身；不會產生委託或權益點，數量記在 `data.warmupRows`。

`equityCurve` 每個交易日提供 `cash`、`marketValue`、`equity`、`positionShares`、`close`、`movingAverage` 與 `drawdownPct`。`trades` 同時容納 `CLOSED` 和 `OPEN` 交易；不適用欄位為 JSON `null`，永不輸出 `NaN` 或 `Infinity`。`warnings` 是字串陣列，每則訊息以穩定的 `[CODE]` 開頭。

## 測試

```powershell
python -m unittest discover -s python/tests -v
```
