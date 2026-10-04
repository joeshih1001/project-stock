import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { PreparedMarketData } from '../market-data/types';
import { BacktestRequestSnapshot } from './job.types';
import { PythonBacktestRunner } from './python-backtest.runner';

describe('PythonBacktestRunner integration', () => {
  let directory: string;
  let csvPath: string;
  let csv: string;
  let request: BacktestRequestSnapshot;
  let marketData: PreparedMarketData;
  let runner: PythonBacktestRunner;

  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(tmpdir(), 'python-runner-'));
    csvPath = path.join(directory, '0050.csv');
    csv =
      'Date,Open,High,Low,Close,Volume\n' +
      '2024-01-01,10,11,9,10,1000\n' +
      '2024-01-02,11,13,10,12,1100\n' +
      '2024-01-03,12,14,11,13,1200\n' +
      '2024-01-04,9,10,8,9,1300\n';
    await fs.writeFile(csvPath, csv, 'utf8');
    const digest = createHash('sha256').update(csv, 'utf8').digest('hex');

    request = {
      symbol: '0050',
      from: '2024-01-01',
      to: '2024-01-04',
      strategy: 'ma-trend',
      maPeriod: 2,
      initialCapital: 100_000,
      allocation: 0.5,
      feeRate: 0.001,
      slippageRate: 0.0005,
      maxDrawdownWarningPct: 20,
    };
    marketData = {
      symbol: '0050',
      sourceSymbol: '0050.TW',
      csvPath,
      dataVersion: digest,
      source: 'yahoo-finance2',
      adjustmentMode: 'adjclose-ratio',
      volumeUnit: 'shares',
      from: '2024-01-01',
      to: '2024-01-04',
      rows: 4,
      fetchedAt: '2024-01-05T00:00:00.000Z',
    };
    runner = new PythonBacktestRunner();
  });

  afterEach(async () => {
    runner.onApplicationShutdown();
    await fs.rm(directory, { recursive: true, force: true });
  });

  it('spawns Python, validates its JSON contract, and returns a versioned report', async () => {
    request.productType = 'ETF';
    request.sellFeeRate = 0.002;
    request.feeDiscount = 0.5;
    request.minFee = 1;
    request.feeRounding = 'FLOOR';
    request.lotSize = 2;
    const result = await runner.run(request, marketData, new AbortController().signal);

    expect(result).toMatchObject({
      schemaVersion: 1,
      symbol: '0050',
      strategy: { key: 'ma-trend', version: '1.0.0', params: { maPeriod: 2 } },
      config: {
        from: '2024-01-01',
        to: '2024-01-04',
        initialCash: 100_000,
        allocation: 0.5,
        productType: 'ETF',
        taxRate: 0.001,
        sellFeeRate: 0.002,
      },
      data: {
        source: 'yahoo-finance2',
        version: marketData.dataVersion,
        sha256: marketData.dataVersion,
        adjustment: 'adjclose-ratio',
        volumeUnit: 'shares',
      },
    });
    expect(result.equityCurve).toHaveLength(4);
    expect(result.trades.length).toBeGreaterThan(0);
    expect((result.benchmarks as Record<string, { equityCurve: unknown[] }>).buyHold100.equityCurve).toHaveLength(4);
    expect(result.accountingStatus).toBe('INCOMPLETE');

    const validate = (
      runner as unknown as {
        validateResult: (
          value: unknown,
          expectedRequest: BacktestRequestSnapshot,
          expectedData: PreparedMarketData,
        ) => unknown;
      }
    ).validateResult.bind(runner);
    const wrongCurveLength = structuredClone(result);
    wrongCurveLength.equityCurve.pop();
    expect(() => validate(wrongCurveLength, request, marketData)).toThrow(
      /資產曲線長度/,
    );

    const invalidTrade = structuredClone(result);
    (invalidTrade.trades[0] as Record<string, unknown>).entryPrice = Number.NaN;
    expect(() => validate(invalidTrade, request, marketData)).toThrow(/進場交易明細/);

    const invalidBenchmark = structuredClone(result);
    ((invalidBenchmark.benchmarks as Record<string, { equityCurve: Record<string, unknown>[] }>).buyHold50.equityCurve[1]).date = '2024-01-05';
    expect(() => validate(invalidBenchmark, request, marketData)).toThrow(/資產曲線|交易日不一致/);
  });

  it('rejects a report when the prepared data version does not match the CSV bytes', async () => {
    marketData.dataVersion = '0'.repeat(64);

    await expect(
      runner.run(request, marketData, new AbortController().signal),
    ).rejects.toMatchObject({ code: 'INVALID_RESULT' });
  });
});
