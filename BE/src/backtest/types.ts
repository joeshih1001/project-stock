export interface BacktestConfig {
  symbol: string;
  /** 回測起始日（含），YYYY-MM-DD */
  from: string;
  /** 回測結束日（含），YYYY-MM-DD */
  to: string;
  initialCapital: number;
  /** 手續費率，買賣各收一次。0.001 = 0.1% */
  feeRate: number;
}

export type ExitReason = 'SIGNAL' | 'END_OF_PERIOD';

/** 一筆完整的來回交易（進場 → 出場） */
export interface Trade {
  entryDate: string;
  entryPrice: number;
  exitDate: string;
  exitPrice: number;
  shares: number;
  /** 未扣費用的損益 */
  grossPnl: number;
  /** 這筆來回的進場 + 出場手續費合計 */
  fees: number;
  /** 扣掉手續費後的實際損益 */
  netPnl: number;
  /** 相對於本筆投入成本的報酬率（%） */
  returnPct: number;
  /** 持有日曆天數 */
  holdingDays: number;
  exitReason: ExitReason;
}

export interface EquityPoint {
  date: string;
  /** 該日收盤時的總資產（現金 + 持股市值） */
  equity: number;
}

export interface Metrics {
  /** 期末總資產 */
  finalEquity: number;
  /** 總報酬率（%） */
  totalReturnPct: number;
  /** 年化報酬率 CAGR（%）。回測期間不足一天時為 null */
  cagrPct: number | null;
  /** 最大回撤（%），正數表示跌幅 */
  maxDrawdownPct: number;
  /** 最大回撤持續的日曆天數（從高點到創新高） */
  maxDrawdownDurationDays: number;
  /** 年化 Sharpe，無風險利率視為 0。日報酬全無波動時為 null */
  sharpe: number | null;
  /** 完成的來回交易筆數 */
  totalTrades: number;
  /** 勝率（%）。無交易時為 null */
  winRatePct: number | null;
  /** 獲利因子 = 總獲利 / 總虧損。無虧損交易時為 null（無限大） */
  profitFactor: number | null;
  /** 平均獲利金額（只計賺錢的交易） */
  avgWin: number | null;
  /** 平均虧損金額（只計賠錢的交易，負數） */
  avgLoss: number | null;
  /** 平均持有日曆天數 */
  avgHoldingDays: number | null;
  /** 收盤時有持倉的 K 棒數佔全部回測 K 棒的比例（%） */
  exposurePct: number;
}

export interface BacktestResult {
  symbol: string;
  strategy: {
    key: string;
    description: string;
    params: Record<string, number>;
  };
  config: BacktestConfig;
  /** 實際用到的資料範圍與根數（可能因上市日、假日而與請求區間不同） */
  dataRange: {
    from: string;
    to: string;
    bars: number;
    /** 起始日之前額外抓來讓指標成形的 K 棒數 */
    warmupBars: number;
  };
  metrics: Metrics;
  /** 只有在請求帶 includeTrades=true 時才有值 */
  trades?: Trade[];
  /** 只有在請求帶 includeEquityCurve=true 時才有值 */
  equityCurve?: EquityPoint[];
  /** 執行過程中值得使用者知道的提醒（例如資料不足、最後一根訊號無法成交） */
  warnings: string[];
}
