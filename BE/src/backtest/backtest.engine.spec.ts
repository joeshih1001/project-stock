import { Candle } from '../market-data/types';
import { Signal, Strategy } from '../strategies/strategy.interface';
import { runBacktest } from './backtest.engine';

class FixedStrategy implements Strategy {
  readonly key = 'fixed';
  readonly params = Object.freeze({});
  readonly warmupBars = 0;

  constructor(private readonly signals: Signal[]) {}

  describe(): string {
    return '測試策略';
  }

  generateSignals(): Signal[] {
    return this.signals;
  }
}

const config = {
  symbol: 'TEST',
  from: '2024-01-01',
  to: '2024-01-03',
  initialCapital: 1_000,
  feeRate: 0,
};

function candle(date: string, open: number, close = open): Candle {
  return {
    date,
    open,
    high: Math.max(open, close) + 1,
    low: Math.max(0.000001, Math.min(open, close) - 1),
    close,
    volume: 1_000,
  };
}

describe('runBacktest', () => {
  it('在訊號隔日開盤成交，而不是偷用訊號日收盤價', () => {
    const candles = [
      candle('2024-01-01', 100, 101),
      candle('2024-01-02', 110, 115),
      candle('2024-01-03', 120, 119),
    ];

    const result = runBacktest({
      candles,
      tradingStartIndex: 0,
      strategy: new FixedStrategy(['BUY', 'SELL', 'HOLD']),
      config,
      includeTrades: true,
      includeEquityCurve: true,
    });

    expect(result.trades).toHaveLength(1);
    expect(result.trades![0]).toMatchObject({
      entryDate: '2024-01-02',
      entryPrice: 110,
      exitDate: '2024-01-03',
      exitPrice: 120,
      exitReason: 'SIGNAL',
    });
    expect(result.metrics.finalEquity).toBeCloseTo(1_090.909091, 6);
    expect(result.metrics.exposurePct).toBe(33.33);
    expect(result.warnings).toEqual([]);
  });

  it('買賣兩邊都收費，並把期末強制平倉費用計入權益', () => {
    const result = runBacktest({
      candles: [candle('2024-01-01', 100), candle('2024-01-02', 100, 110)],
      tradingStartIndex: 0,
      strategy: new FixedStrategy(['BUY', 'HOLD']),
      config: { ...config, to: '2024-01-02', feeRate: 0.01 },
      includeTrades: true,
      includeEquityCurve: true,
    });

    expect(result.metrics.finalEquity).toBeCloseTo(1_078.217822, 6);
    expect(result.trades![0].fees).toBeCloseTo(20.792079, 6);
    expect(result.trades![0].exitReason).toBe('END_OF_PERIOD');
    expect(result.equityCurve!.at(-1)!.equity).toBeCloseTo(1_078.217821, 5);
  });

  it('合併最後一日 SELL 未能隔日成交與期末平倉警告', () => {
    const result = runBacktest({
      candles: [
        candle('2024-01-01', 100),
        candle('2024-01-02', 100),
        candle('2024-01-03', 105),
      ],
      tradingStartIndex: 0,
      strategy: new FixedStrategy(['BUY', 'HOLD', 'SELL']),
      config,
      includeTrades: true,
    });

    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('SELL');
    expect(result.trades![0].exitReason).toBe('END_OF_PERIOD');
  });

  it('未要求時不附加大型明細欄位', () => {
    const result = runBacktest({
      candles: [candle('2024-01-01', 100)],
      tradingStartIndex: 0,
      strategy: new FixedStrategy(['HOLD']),
      config: { ...config, to: '2024-01-01' },
    });

    expect(result).not.toHaveProperty('trades');
    expect(result).not.toHaveProperty('equityCurve');
  });

  it('用未捨入損益計算勝率與期末資產', () => {
    const result = runBacktest({
      candles: [candle('2024-01-01', 100), candle('2024-01-02', 100, 100.4)],
      tradingStartIndex: 0,
      strategy: new FixedStrategy(['BUY', 'HOLD']),
      config: { ...config, to: '2024-01-02', initialCapital: 1 },
      includeTrades: true,
    });

    expect(result.trades![0].netPnl).toBe(0.004);
    expect(result.metrics.finalEquity).toBe(1.004);
    expect(result.metrics.winRatePct).toBe(100);
  });

  it('拒絕越界索引、錯誤訊號數、非法訊號與壞 K 棒', () => {
    const candles = [candle('2024-01-01', 100)];

    expect(() =>
      runBacktest({ candles, tradingStartIndex: 1, strategy: new FixedStrategy(['HOLD']), config }),
    ).toThrow(/tradingStartIndex/);
    expect(() =>
      runBacktest({ candles, tradingStartIndex: 0, strategy: new FixedStrategy([]), config }),
    ).toThrow(/回傳 0 個訊號/);
    expect(() =>
      runBacktest({
        candles,
        tradingStartIndex: 0,
        strategy: new FixedStrategy(['INVALID' as Signal]),
        config,
      }),
    ).toThrow(/無效訊號/);
    expect(() =>
      runBacktest({
        candles: [{ ...candles[0], open: 0 }],
        tradingStartIndex: 0,
        strategy: new FixedStrategy(['HOLD']),
        config,
      }),
    ).toThrow(/無效價格/);
  });
});
