import { computeMetrics } from './metrics';
import { EquityPoint } from './types';

function point(date: string, equity: number): EquityPoint {
  return { date, equity };
}

describe('computeMetrics', () => {
  it('單調上漲時回撤與回撤期間都是 0', () => {
    const metrics = computeMetrics(
      [point('2024-01-01', 100), point('2024-01-02', 110), point('2024-01-03', 120)],
      [],
      100,
      0,
    );

    expect(metrics.maxDrawdownPct).toBe(0);
    expect(metrics.maxDrawdownDurationDays).toBe(0);
  });

  it('回到高點時把復原日納入回撤期間', () => {
    const metrics = computeMetrics(
      [point('2024-01-01', 100), point('2024-01-02', 90), point('2024-01-10', 100)],
      [],
      100,
      1,
    );

    expect(metrics.maxDrawdownPct).toBe(10);
    expect(metrics.maxDrawdownDurationDays).toBe(9);
  });

  it('回測結束仍未復原時算到最後一個權益點', () => {
    const metrics = computeMetrics(
      [point('2024-01-01', 100), point('2024-01-05', 80), point('2024-01-10', 90)],
      [],
      100,
      2,
    );

    expect(metrics.maxDrawdownPct).toBe(20);
    expect(metrics.maxDrawdownDurationDays).toBe(9);
  });

  it('空曲線回傳穩定的零交易摘要', () => {
    const metrics = computeMetrics([], [], 100, 0);

    expect(metrics).toMatchObject({
      finalEquity: 100,
      totalReturnPct: 0,
      cagrPct: null,
      sharpe: null,
      totalTrades: 0,
      winRatePct: null,
      exposurePct: 0,
    });
  });

  it('拒絕不可能的曝險與非有限權益', () => {
    expect(() => computeMetrics([], [], 100, 1)).toThrow(/barsInMarket/);
    expect(() =>
      computeMetrics([point('2024-01-01', Number.NaN)], [], 100, 0),
    ).toThrow(/權益曲線/);
  });
});
