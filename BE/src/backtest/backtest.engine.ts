import { Candle } from '../market-data/types';
import { Signal, Strategy } from '../strategies/strategy.interface';
import { computeMetrics } from './metrics';
import {
  BacktestConfig,
  BacktestResult,
  EquityPoint,
  ExitReason,
  Trade,
} from './types';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

interface OpenPosition {
  entryDate: string;
  entryPrice: number;
  shares: number;
  /** 進場時付掉的手續費，出場時併入該筆交易的總費用 */
  entryFee: number;
}

export interface EngineInput {
  /** 含暖身段的完整 K 棒序列 */
  candles: Candle[];
  /** candles 中第一根「真正開始交易」的索引；在此之前的只用來讓指標成形 */
  tradingStartIndex: number;
  strategy: Strategy;
  config: BacktestConfig;
  /** 是否在結果中附上逐筆交易；預設只回傳摘要，避免回應過大 */
  includeTrades?: boolean;
  /** 是否在結果中附上每日權益曲線 */
  includeEquityCurve?: boolean;
}

/**
 * 單標的、日 K、全額進出的回測引擎。
 *
 * 成交模型 —— 這是整份程式最該被質疑的地方，所以講清楚：
 * 第 i 根 K 棒「收盤後」才算得出訊號，因此最快只能在第 i+1 根的「開盤價」成交。
 * 迴圈刻意寫成「先成交上一根排入的委託 → 再結算當日權益 → 最後才產生新訊號」，
 * 讓「今天的訊號用今天的收盤價成交」這種前瞻偏誤在結構上就不可能發生。
 */
export function runBacktest(input: EngineInput): BacktestResult {
  const {
    candles,
    tradingStartIndex,
    strategy,
    config,
    includeTrades = false,
    includeEquityCurve = false,
  } = input;
  const warnings: string[] = [];

  if (
    !Number.isInteger(tradingStartIndex) ||
    tradingStartIndex < 0 ||
    tradingStartIndex >= candles.length
  ) {
    throw new RangeError(
      `tradingStartIndex 必須是 candles 範圍內的整數，收到 ${tradingStartIndex}`,
    );
  }
  if (!Number.isFinite(config.initialCapital) || config.initialCapital <= 0) {
    throw new RangeError(`initialCapital 必須大於 0，收到 ${config.initialCapital}`);
  }
  if (
    !Number.isFinite(config.feeRate) ||
    config.feeRate < 0 ||
    config.feeRate >= 1
  ) {
    throw new RangeError(
      `feeRate 必須介於 0（含）與 1（不含）之間，收到 ${config.feeRate}`,
    );
  }
  validateCandles(candles);

  // 訊號在完整序列上計算，指標才有暖身資料；但只有 tradingStartIndex 之後才會下單
  const signals = strategy.generateSignals(candles);
  if (signals.length !== candles.length) {
    throw new Error(
      `策略 '${strategy.key}' 回傳 ${signals.length} 個訊號，但行情共有 ${candles.length} 根 K 棒`,
    );
  }
  const invalidSignalIndex = signals.findIndex(
    (signal) => signal !== 'BUY' && signal !== 'SELL' && signal !== 'HOLD',
  );
  if (invalidSignalIndex !== -1) {
    throw new Error(
      `策略 '${strategy.key}' 在索引 ${invalidSignalIndex} 回傳無效訊號：${String(
        signals[invalidSignalIndex],
      )}`,
    );
  }

  const trades: Trade[] = [];
  const equityCurve: EquityPoint[] = [];

  let cash = config.initialCapital;
  let position: OpenPosition | null = null;
  let pendingOrder: Signal | null = null;
  let barsInMarket = 0;

  for (let i = tradingStartIndex; i < candles.length; i++) {
    const bar = candles[i];

    // 1) 先執行昨天收盤排入的委託，成交價是今天的開盤價
    if (pendingOrder === 'BUY' && position === null) {
      position = openPosition(bar, cash, config.feeRate);
      cash = 0;
    } else if (pendingOrder === 'SELL' && position !== null) {
      const { trade, proceeds } = closePosition(
        position,
        bar.date,
        bar.open,
        config.feeRate,
        'SIGNAL',
      );
      trades.push(trade);
      cash += proceeds;
      position = null;
    }
    pendingOrder = null;

    // 2) 用今天的收盤價結算權益
    if (position !== null) barsInMarket++;
    equityCurve.push({
      date: bar.date,
      equity: cash + (position ? position.shares * bar.close : 0),
    });

    // 3) 最後才看今天的訊號，排入明天開盤的委託。
    //    重複訊號（已有部位又收到 BUY）直接忽略：全額進出的模型沒有加碼概念。
    const signal = signals[i];
    if (signal === 'BUY' && position === null) pendingOrder = 'BUY';
    else if (signal === 'SELL' && position !== null) pendingOrder = 'SELL';
  }

  // 回測結束仍持有部位就強制平倉，否則未實現損益不會進到交易統計，
  // 勝率、獲利因子這些數字會少算最後一筆。
  if (position !== null && candles.length > 0) {
    const lastBar = candles[candles.length - 1];
    const finalSellCouldNotExecute = pendingOrder === 'SELL';
    const { trade, proceeds } = closePosition(
      position,
      lastBar.date,
      lastBar.close,
      config.feeRate,
      'END_OF_PERIOD',
    );
    trades.push(trade);
    cash += proceeds;
    position = null;

    // 平倉的手續費要反映在最後一個權益點上，否則期末資產會偏高
    equityCurve[equityCurve.length - 1] = { date: lastBar.date, equity: cash };
    warnings.push(
      finalSellCouldNotExecute
        ? `最後一個交易日出現 SELL 訊號，因無隔日開盤價可成交，已依期末規則於 ` +
            `${lastBar.date} 以收盤價強制平倉。`
        : `回測結束時仍持有部位，已於最後一個交易日 ${lastBar.date} ` +
            `以收盤價強制平倉計入績效。`,
    );
    if (finalSellCouldNotExecute) pendingOrder = null;
  }

  // 最後一根 K 棒的訊號沒有「隔日」可以成交，據實告知而不是偷偷用收盤價補成交
  if (pendingOrder !== null) {
    warnings.push(
      `最後一個交易日出現 ${pendingOrder} 訊號，但已無隔日開盤價可成交，該訊號未列入回測。`,
    );
  }

  const result: BacktestResult = {
    symbol: config.symbol,
    strategy: {
      key: strategy.key,
      description: strategy.describe(),
      params: { ...strategy.params },
    },
    config,
    dataRange: {
      from: candles[tradingStartIndex]?.date ?? config.from,
      to: candles[candles.length - 1]?.date ?? config.to,
      bars: candles.length - tradingStartIndex,
      warmupBars: tradingStartIndex,
    },
    metrics: computeMetrics(equityCurve, trades, config.initialCapital, barsInMarket),
    warnings,
  };

  if (includeTrades) result.trades = trades.map(formatTrade);
  if (includeEquityCurve) result.equityCurve = equityCurve;
  return result;
}

/**
 * 全額進場。手續費從可用現金裡先扣，再決定買得起幾股：
 *   shares * price * (1 + feeRate) = cash
 * 允許小數股 —— 使用者選的是「全額投入」而非「取整數股」。
 */
function openPosition(bar: Candle, cash: number, feeRate: number): OpenPosition {
  const shares = cash / (bar.open * (1 + feeRate));
  const cost = shares * bar.open;

  return {
    entryDate: bar.date,
    entryPrice: bar.open,
    shares,
    entryFee: cost * feeRate,
  };
}

function closePosition(
  position: OpenPosition,
  exitDate: string,
  exitPrice: number,
  feeRate: number,
  exitReason: ExitReason,
): { trade: Trade; proceeds: number } {
  const gross = position.shares * exitPrice;
  const exitFee = gross * feeRate;
  const cost = position.shares * position.entryPrice;

  const grossPnl = gross - cost;
  const fees = position.entryFee + exitFee;
  const netPnl = grossPnl - fees;

  return {
    proceeds: gross - exitFee,
    trade: {
      entryDate: position.entryDate,
      entryPrice: position.entryPrice,
      exitDate,
      exitPrice,
      shares: position.shares,
      grossPnl,
      fees,
      netPnl,
      // 分母用「進場成本 + 進場手續費」，代表這筆交易真正佔用的資金
      returnPct: (netPnl / (cost + position.entryFee)) * 100,
      holdingDays: daysBetween(position.entryDate, exitDate),
      exitReason,
    },
  };
}

/** API 明細維持易讀精度；績效計算則使用上方未捨入的原始交易值。 */
function formatTrade(trade: Trade): Trade {
  return {
    ...trade,
    entryPrice: round(trade.entryPrice, 6),
    exitPrice: round(trade.exitPrice, 6),
    shares: round(trade.shares, 8),
    grossPnl: round(trade.grossPnl, 6),
    fees: round(trade.fees, 6),
    netPnl: round(trade.netPnl, 6),
    returnPct: round(trade.returnPct, 4),
  };
}

function daysBetween(from: string, to: string): number {
  return Math.round(
    (new Date(`${to}T00:00:00Z`).getTime() - new Date(`${from}T00:00:00Z`).getTime()) /
      MS_PER_DAY,
  );
}

function round(value: number, digits: number): number {
  const factor = Math.pow(10, digits);
  return Math.round(value * factor) / factor;
}

function validateCandles(candles: Candle[]): void {
  let previousDate: string | null = null;

  candles.forEach((bar, index) => {
    if (!isCalendarDate(bar.date) || (previousDate !== null && bar.date <= previousDate)) {
      throw new Error(
        `第 ${index} 根 K 棒日期無效或未嚴格遞增：${bar.date}`,
      );
    }
    previousDate = bar.date;

    const prices = [bar.open, bar.high, bar.low, bar.close];
    if (prices.some((price) => !Number.isFinite(price) || price <= 0)) {
      throw new Error(`第 ${index} 根 K 棒含無效價格：${bar.date}`);
    }
    if (
      bar.high < Math.max(bar.open, bar.close, bar.low) ||
      bar.low > Math.min(bar.open, bar.close, bar.high)
    ) {
      throw new Error(`第 ${index} 根 K 棒的 high/low 關係不合法：${bar.date}`);
    }
    if (!Number.isFinite(bar.volume) || bar.volume < 0) {
      throw new Error(`第 ${index} 根 K 棒含無效成交量：${bar.date}`);
    }
  });
}

function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}
