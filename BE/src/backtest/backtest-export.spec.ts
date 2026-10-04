import { renderBacktestExport } from './backtest-export';
import { PythonBacktestResult } from './job.types';

const fixture: PythonBacktestResult = {
  schemaVersion: 1,
  symbol: 'TEST',
  engine: {}, strategy: {}, config: {}, data: {},
  metrics: { finalEquity: 95 },
  equityCurve: [{ date: '2024-01-01', equity: 95, cash: 50, holdings: { TEST: 5 }, drawdownPct: 5 }],
  trades: [{ tradeId: 1, status: 'OPEN', entrySignalDate: '=HYPERLINK("x")', shares: 5 }],
  warnings: ['incomplete'],
  benchmarks: {
    buyHold100: { metrics: { finalEquity: 90 }, equityCurve: [{ date: '2024-01-01', equity: 90, drawdownPct: 10 }] },
    buyHold50: { metrics: { finalEquity: 95 }, equityCurve: [{ date: '2024-01-01', equity: 95, drawdownPct: 5 }] },
  },
  manifest: { runId: 'abc' },
};

describe('backtest exports', () => {
  it('escapes spreadsheet formulas and keeps numeric rows', () => {
    const trades = renderBacktestExport(fixture, 'trades.csv');
    expect(trades).toContain('"\'=HYPERLINK');
    expect(trades).toContain('"5"');
  });

  it('exports aligned benchmark rows and manifest', () => {
    expect(renderBacktestExport(fixture, 'benchmarks_daily.csv')).toContain('"90","10","95","5"');
    expect(JSON.parse(renderBacktestExport(fixture, 'run_manifest.json'))).toEqual({ runId: 'abc' });
  });
});
