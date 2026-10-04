import { crossesAbove, crossesBelow, ema, macd, rsi, sma } from './indicators';

describe('indicators', () => {
  it('計算與原始索引對齊的 SMA 與 EMA', () => {
    expect(sma([1, 2, 3, 4], 2)).toEqual([null, 1.5, 2.5, 3.5]);
    expect(ema([1, 2, 3, 4], 2)).toEqual([null, 1.5, 2.5, 3.5]);
  });

  it('處理 RSI 無漲跌、全上漲與暖身區', () => {
    const flat = rsi(new Array(20).fill(10), 14);
    const rising = rsi(Array.from({ length: 20 }, (_, index) => index + 1), 14);

    expect(flat.slice(0, 14)).toEqual(new Array(14).fill(null));
    expect(flat[14]).toBe(50);
    expect(rising[14]).toBe(100);
  });

  it('讓 MACD 訊號線在原始 K 棒索引成形', () => {
    const result = macd(Array.from({ length: 20 }, (_, index) => index + 1), 3, 5, 2);

    expect(result.macd.slice(0, 4)).toEqual([null, null, null, null]);
    expect(result.macd[4]).not.toBeNull();
    expect(result.signal.slice(0, 5)).toEqual([null, null, null, null, null]);
    expect(result.signal[5]).not.toBeNull();
    expect(result.histogram).toHaveLength(20);
  });

  it('只在兩個相鄰有效值確實穿越時回傳 true', () => {
    expect(crossesAbove([null, 1, 3], [2, 2, 2], 2)).toBe(true);
    expect(crossesBelow([null, 3, 1], [2, 2, 2], 2)).toBe(true);
    expect(crossesAbove([1], [0], 4)).toBe(false);
    expect(crossesBelow([1, 0], [0, 1], 0)).toBe(false);
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    '拒絕無效週期 %s',
    (period) => {
      expect(() => sma([1, 2, 3], period)).toThrow(/period/);
    },
  );

  it('拒絕非有限輸入與不合法的 MACD 週期關係', () => {
    expect(() => ema([1, Number.NaN], 2)).toThrow(/values\[1\]/);
    expect(() => macd([1, 2, 3], 5, 5, 2)).toThrow(/fastPeriod/);
  });
});
