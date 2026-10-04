import { Candle } from '../market-data/types';
import { crossesAbove, crossesBelow, macd } from '../indicators/indicators';
import {
  Signal,
  Strategy,
  StrategyDefinition,
  positiveInt,
} from './strategy.interface';

/**
 * MACD 快慢線交叉。
 * DIF（快 EMA - 慢 EMA）上穿訊號線 → BUY，下穿 → SELL。
 * 本質仍是順勢，但因為用了兩層 EMA，比單純均線交叉略為平滑、訊號較少。
 */
export class MacdCrossStrategy implements Strategy {
  readonly key = 'macd-cross';
  readonly params: Readonly<Record<string, number>>;
  readonly warmupBars: number;

  private readonly fastPeriod: number;
  private readonly slowPeriod: number;
  private readonly signalPeriod: number;

  constructor(params: Record<string, number> = {}) {
    this.fastPeriod = positiveInt(params, 'fastPeriod', 12);
    this.slowPeriod = positiveInt(params, 'slowPeriod', 26);
    this.signalPeriod = positiveInt(params, 'signalPeriod', 9);

    if (this.fastPeriod >= this.slowPeriod) {
      throw new Error(
        `fastPeriod (${this.fastPeriod}) 必須小於 slowPeriod (${this.slowPeriod})`,
      );
    }
    this.params = Object.freeze({
      fastPeriod: this.fastPeriod,
      slowPeriod: this.slowPeriod,
      signalPeriod: this.signalPeriod,
    });
    // EMA 是遞迴指標，剛成形時仍高度依賴 SMA 種子；以 5 倍慢週期暖身，
    // 再加訊號線週期與交叉所需的一根，降低回測起點偏誤。
    this.warmupBars = this.slowPeriod * 5 + this.signalPeriod + 1;
  }

  describe(): string {
    return `MACD(${this.fastPeriod}, ${this.slowPeriod}, ${this.signalPeriod}) 交叉`;
  }

  generateSignals(candles: Candle[]): Signal[] {
    const result = macd(
      candles.map((c) => c.close),
      this.fastPeriod,
      this.slowPeriod,
      this.signalPeriod,
    );

    return candles.map((_, i) => {
      if (crossesAbove(result.macd, result.signal, i)) return 'BUY';
      if (crossesBelow(result.macd, result.signal, i)) return 'SELL';
      return 'HOLD';
    });
  }
}

export const macdCrossDefinition: StrategyDefinition = {
  key: 'macd-cross',
  name: 'MACD 交叉',
  description:
    'MACD 線上穿訊號線買進，下穿賣出。經過兩層 EMA 平滑，訊號比均線交叉少但也較鈍。',
  defaultParams: { fastPeriod: 12, slowPeriod: 26, signalPeriod: 9 },
  create: (params) => new MacdCrossStrategy(params),
};
