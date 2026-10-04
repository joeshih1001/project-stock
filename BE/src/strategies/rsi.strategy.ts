import { Candle } from '../market-data/types';
import { rsi } from '../indicators/indicators';
import {
  Signal,
  Strategy,
  StrategyDefinition,
  numberInRange,
  positiveInt,
} from './strategy.interface';

/**
 * RSI 超賣買進 / 超買賣出（逆勢策略）。
 *
 * 用「上穿 / 下穿門檻」而非「低於 / 高於門檻」：後者在 RSI 長期趴在 30 以下時
 * 會每天都送出 BUY，雖然引擎會忽略重複訊號，但語意上會讓「進場時機」變得模糊，
 * 也不利於之後擴充成加碼邏輯。
 */
export class RsiStrategy implements Strategy {
  readonly key = 'rsi';
  readonly params: Readonly<Record<string, number>>;
  readonly warmupBars: number;

  private readonly period: number;
  private readonly oversold: number;
  private readonly overbought: number;

  constructor(params: Record<string, number> = {}) {
    this.period = positiveInt(params, 'period', 14);
    this.oversold = numberInRange(params, 'oversold', 30, 0, 100);
    this.overbought = numberInRange(params, 'overbought', 70, 0, 100);

    if (this.oversold >= this.overbought) {
      throw new Error(
        `oversold (${this.oversold}) 必須小於 overbought (${this.overbought})`,
      );
    }
    this.params = Object.freeze({
      period: this.period,
      oversold: this.oversold,
      overbought: this.overbought,
    });
    // Wilder 平滑是遞迴指標，只抓到「剛成形」會讓結果過度受種子值影響。
    // 10 倍週期後種子權重約只剩 e^-10，可大幅降低回測起點偏誤。
    this.warmupBars = this.period * 10 + 1;
  }

  describe(): string {
    return `RSI(${this.period}) 上穿 ${this.oversold} 買進 / 下穿 ${this.overbought} 賣出`;
  }

  generateSignals(candles: Candle[]): Signal[] {
    const values = rsi(
      candles.map((c) => c.close),
      this.period,
    );

    return candles.map((_, i) => {
      if (i < 1) return 'HOLD';
      const prev = values[i - 1];
      const now = values[i];
      if (prev === null || now === null) return 'HOLD';

      // 由超賣區向上脫離 → 進場（等它開始回升，而不是接下墜的刀）
      if (prev <= this.oversold && now > this.oversold) return 'BUY';
      // 由超買區向下跌落 → 出場
      if (prev >= this.overbought && now < this.overbought) return 'SELL';
      return 'HOLD';
    });
  }
}

export const rsiDefinition: StrategyDefinition = {
  key: 'rsi',
  name: 'RSI 超買超賣',
  description:
    'RSI 由超賣區向上脫離時買進，由超買區向下跌落時賣出。逆勢策略，強勢趨勢中容易太早出場。',
  defaultParams: { period: 14, oversold: 30, overbought: 70 },
  create: (params) => new RsiStrategy(params),
};
