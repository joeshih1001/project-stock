import { EquityPoint, Metrics, Trade } from './types';

/** 一年幾個交易日，用於 Sharpe 年化 */
const TRADING_DAYS_PER_YEAR = 252;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

export function computeMetrics(
  equityCurve: EquityPoint[],
  trades: Trade[],
  initialCapital: number,
  barsInMarket: number,
): Metrics {
  validateMetricInputs(equityCurve, trades, initialCapital, barsInMarket);
  const finalEquity =
    equityCurve.length > 0 ? equityCurve[equityCurve.length - 1].equity : initialCapital;

  const totalReturnPct = (finalEquity / initialCapital - 1) * 100;
  const drawdown = computeDrawdown(equityCurve);

  const wins = trades.filter((t) => t.netPnl > 0);
  const losses = trades.filter((t) => t.netPnl < 0);
  const grossProfit = sum(wins.map((t) => t.netPnl));
  const grossLoss = Math.abs(sum(losses.map((t) => t.netPnl)));

  return {
    finalEquity: roundMoney(finalEquity),
    totalReturnPct: round2(totalReturnPct),
    cagrPct: computeCagr(equityCurve, initialCapital),
    maxDrawdownPct: round2(drawdown.maxDrawdownPct),
    maxDrawdownDurationDays: drawdown.maxDrawdownDurationDays,
    sharpe: computeSharpe(equityCurve),
    totalTrades: trades.length,
    winRatePct: trades.length > 0 ? round2((wins.length / trades.length) * 100) : null,
    // 沒有任何虧損交易時獲利因子是無限大。回 null 而不是 Infinity —— 後者
    // 序列化成 JSON 會變成 null 或報錯，不如明確表達「不適用」。
    profitFactor: grossLoss > 0 ? round4(grossProfit / grossLoss) : null,
    avgWin: wins.length > 0 ? roundMoney(grossProfit / wins.length) : null,
    avgLoss: losses.length > 0 ? roundMoney(-grossLoss / losses.length) : null,
    avgHoldingDays:
      trades.length > 0
        ? round2(sum(trades.map((t) => t.holdingDays)) / trades.length)
        : null,
    exposurePct:
      equityCurve.length > 0 ? round2((barsInMarket / equityCurve.length) * 100) : 0,
  };
}

/**
 * 最大回撤：資產從歷史高點跌到谷底的最大幅度。
 * 同時算出回撤持續天數 —— 只看跌幅會低估痛苦程度，
 * 一個跌 20% 但三個月回本的策略，跟跌 20% 卡三年的策略完全是兩回事。
 */
function computeDrawdown(equityCurve: EquityPoint[]): {
  maxDrawdownPct: number;
  maxDrawdownDurationDays: number;
} {
  if (equityCurve.length === 0) {
    return { maxDrawdownPct: 0, maxDrawdownDurationDays: 0 };
  }

  let peak = equityCurve[0].equity;
  let peakDate = equityCurve[0].date;
  let maxDrawdownPct = 0;
  let maxDurationDays = 0;
  let inDrawdown = false;

  for (const point of equityCurve) {
    if (point.equity >= peak) {
      // 只有真的曾經落到高點下方，才把「高點到回復日」算成水下期間。
      // 單調上漲或持平的曲線不應憑空得到一天回撤期。
      if (inDrawdown) {
        maxDurationDays = Math.max(maxDurationDays, daysBetween(peakDate, point.date));
      }
      peak = point.equity;
      peakDate = point.date;
      inDrawdown = false;
      continue;
    }
    inDrawdown = true;
    if (peak > 0) {
      maxDrawdownPct = Math.max(maxDrawdownPct, ((peak - point.equity) / peak) * 100);
    }
    maxDurationDays = Math.max(maxDurationDays, daysBetween(peakDate, point.date));
  }

  return { maxDrawdownPct, maxDrawdownDurationDays: maxDurationDays };
}

/** 年化報酬率。以日曆天數換算年數，跨越閏年時比用 365 準確。 */
function computeCagr(equityCurve: EquityPoint[], initialCapital: number): number | null {
  if (equityCurve.length < 2 || initialCapital <= 0) return null;

  const years =
    daysBetween(equityCurve[0].date, equityCurve[equityCurve.length - 1].date) / 365.25;
  if (years <= 0) return null;

  const finalEquity = equityCurve[equityCurve.length - 1].equity;
  // 資產歸零時取幾次方根會是 0 或 NaN，直接回報 -100%
  if (finalEquity <= 0) return -100;

  return round2((Math.pow(finalEquity / initialCapital, 1 / years) - 1) * 100);
}

/**
 * 年化 Sharpe（無風險利率視為 0）。
 * 用母體標準差而非樣本標準差，與多數回測工具一致。
 */
function computeSharpe(equityCurve: EquityPoint[]): number | null {
  if (equityCurve.length < 3) return null;

  const returns: number[] = [];
  for (let i = 1; i < equityCurve.length; i++) {
    const prev = equityCurve[i - 1].equity;
    if (prev <= 0) continue;
    returns.push(equityCurve[i].equity / prev - 1);
  }
  if (returns.length < 2) return null;

  const mean = sum(returns) / returns.length;
  const variance = sum(returns.map((r) => (r - mean) ** 2)) / returns.length;
  const stdDev = Math.sqrt(variance);

  // 全期間空手（日報酬恆為 0）時標準差是 0，Sharpe 無定義
  if (stdDev === 0) return null;

  return round2((mean / stdDev) * Math.sqrt(TRADING_DAYS_PER_YEAR));
}

function daysBetween(from: string, to: string): number {
  return Math.round(
    (new Date(`${to}T00:00:00Z`).getTime() - new Date(`${from}T00:00:00Z`).getTime()) /
      MS_PER_DAY,
  );
}

function sum(values: number[]): number {
  return values.reduce((acc, v) => acc + v, 0);
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function roundMoney(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function validateMetricInputs(
  equityCurve: EquityPoint[],
  trades: Trade[],
  initialCapital: number,
  barsInMarket: number,
): void {
  if (!Number.isFinite(initialCapital) || initialCapital <= 0) {
    throw new RangeError(`initialCapital 必須是大於 0 的有限數字`);
  }
  if (
    !Number.isInteger(barsInMarket) ||
    barsInMarket < 0 ||
    barsInMarket > equityCurve.length
  ) {
    throw new RangeError(`barsInMarket 必須介於 0 與權益曲線長度之間`);
  }

  let previousDate: string | null = null;
  for (const point of equityCurve) {
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(point.date) ||
      (previousDate !== null && point.date <= previousDate) ||
      !Number.isFinite(point.equity) ||
      point.equity <= 0
    ) {
      throw new Error(`權益曲線含無效或未排序的資料：${point.date}`);
    }
    previousDate = point.date;
  }

  if (
    trades.some(
      (trade) =>
        !Number.isFinite(trade.netPnl) ||
        !Number.isFinite(trade.holdingDays) ||
        trade.holdingDays < 0,
    )
  ) {
    throw new Error('交易紀錄含無效數值');
  }
}
