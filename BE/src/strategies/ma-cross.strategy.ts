import { Candle } from '../market-data/types';
import { crossesAbove, crossesBelow, sma } from '../indicators/indicators';
import {
  Signal,
  Strategy,
  StrategyDefinition,
  positiveInt,
} from './strategy.interface';

/**
 * 均線黃金 / 死亡交叉。
 * 短均線上穿長均線 → BUY；下穿 → SELL。典型的順勢策略：
 * 盤整期會被雙巴，但單邊大行情時能吃到整段。
 */
export class MaCrossStrategy implements Strategy {
  readonly key = 'ma-cross';
  readonly params: Readonly<Record<string, number>>;
  readonly warmupBars: number;

  private readonly fastPeriod: number;
  private readonly slowPeriod: number;

  constructor(params: Record<string, number> = {}) {
    this.fastPeriod = positiveInt(params, 'fastPeriod', 20);
    this.slowPeriod = positiveInt(params, 'slowPeriod', 60);

    if (this.fastPeriod >= this.slowPeriod) {
      throw new Error(
        `fastPeriod (${this.fastPeriod}) 必須小於 slowPeriod (${this.slowPeriod})`,
      );
    }
    this.params = Object.freeze({
      fastPeriod: this.fastPeriod,
      slowPeriod: this.slowPeriod,
    });
    // 慢均線最晚成形，且交叉判斷要比較前一根，故 +1
    this.warmupBars = this.slowPeriod + 1;
  }

  describe(): string {
    return `MA(${this.fastPeriod}) / MA(${this.slowPeriod}) 交叉`;
  }

  generateSignals(candles: Candle[]): Signal[] {
    const closes = candles.map((c) => c.close);
    const fast = sma(closes, this.fastPeriod);
    const slow = sma(closes, this.slowPeriod);

    return candles.map((_, i) => {
      if (crossesAbove(fast, slow, i)) return 'BUY';
      if (crossesBelow(fast, slow, i)) return 'SELL';
      return 'HOLD';
    });
  }
}

export const maCrossDefinition: StrategyDefinition = {
  key: 'ma-cross',
  name: '均線交叉',
  description:
    '短均線上穿長均線買進（黃金交叉），下穿賣出（死亡交叉）。順勢策略，盤整期易被雙巴。',
  defaultParams: { fastPeriod: 20, slowPeriod: 60 },
  create: (params) => new MaCrossStrategy(params),
};
