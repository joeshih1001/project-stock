import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AddressInfo } from 'node:net';
import { AppModule } from './app.module';
import { configureApp } from './app.setup';
import { BacktestJobService } from './backtest/backtest-job.service';
import { RunBacktestDto } from './backtest/dto/run-backtest.dto';
import {
  BacktestRequestSnapshot,
  BacktestTaskView,
  PythonBacktestResult,
} from './backtest/job.types';
import { MarketDataService } from './market-data/market-data.service';

const TASK_ID = '11111111-1111-4111-8111-111111111111';

const defaultRequest: BacktestRequestSnapshot = {
  symbol: 'AAPL',
  from: '2024-01-02',
  to: '2024-01-03',
  strategy: 'ma-trend',
  maPeriod: 60,
  initialCapital: 100_000,
  allocation: 0.5,
  feeRate: 0,
  slippageRate: 0,
  maxDrawdownWarningPct: 20,
};

const backtestResult: PythonBacktestResult = {
  schemaVersion: 1,
  symbol: 'AAPL',
  engine: { name: 'python' },
  strategy: { key: 'ma-trend' },
  data: { rows: 2 },
  config: {},
  metrics: { finalEquity: 100_000 },
  equityCurve: [],
  trades: [],
  warnings: [],
};

function taskView(
  status: BacktestTaskView['status'] = 'queued',
  request: BacktestRequestSnapshot = defaultRequest,
): BacktestTaskView {
  return {
    schemaVersion: 1,
    id: TASK_ID,
    status,
    phase: status === 'queued' ? 'queued' : 'complete',
    request,
    createdAt: '2024-01-04T00:00:00.000Z',
    updatedAt: '2024-01-04T00:00:00.000Z',
    resultAvailable: status === 'succeeded',
    links: {
      self: `/api/backtests/${TASK_ID}`,
      result: `/api/backtests/${TASK_ID}/result`,
    },
  };
}

describe('HTTP API (e2e)', () => {
  let app: INestApplication;
  let baseUrl: string;

  const jobs = {
    create: jest.fn(),
    list: jest.fn(),
    get: jest.fn(),
    result: jest.fn(),
    cancel: jest.fn(),
  };
  const marketData = {
    listPrepared: jest.fn(),
    updateCsv: jest.fn(),
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(BacktestJobService)
      .useValue(jobs)
      .overrideProvider(MarketDataService)
      .useValue(marketData)
      .compile();

    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.listen(0, '127.0.0.1');
    const address = app.getHttpServer().address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    jobs.create.mockImplementation(async (request: RunBacktestDto) =>
      taskView('queued', {
        symbol: request.symbol,
        from: request.from,
        to: request.to,
        strategy: 'ma-trend',
        maPeriod: request.maPeriod,
        initialCapital: request.initialCapital,
        allocation: request.allocation,
        feeRate: request.feeRate,
        slippageRate: request.slippageRate,
        maxDrawdownWarningPct: request.maxDrawdownWarningPct,
      }),
    );
    jobs.list.mockResolvedValue([taskView('succeeded')]);
    jobs.get.mockResolvedValue(taskView('succeeded'));
    jobs.result.mockResolvedValue(backtestResult);
    jobs.cancel.mockResolvedValue(taskView('cancelled'));
    marketData.listPrepared.mockResolvedValue([]);
    marketData.updateCsv.mockResolvedValue({ symbol: '0050', sourceSymbol: '0050.TW' });
  });

  afterAll(async () => {
    await app.close();
  });

  it('serves health, Swagger, and only the ma-trend strategy', async () => {
    const [health, docs, strategies] = await Promise.all([
      fetch(`${baseUrl}/api/health`),
      fetch(`${baseUrl}/docs`),
      fetch(`${baseUrl}/api/strategies`),
    ]);

    expect(health.status).toBe(200);
    await expect(health.json()).resolves.toEqual({ status: 'ok' });
    expect(docs.status).toBe(200);
    expect(strategies.status).toBe(200);
    expect(await strategies.json()).toEqual([
      expect.objectContaining({
        key: 'ma-trend',
        version: '1.0.0',
        defaultParams: { maPeriod: 60, allocation: 0.5 },
      }),
    ]);
  });

  it('accepts a backtest as a queued job and applies every DTO default', async () => {
    const response = await fetch(`${baseUrl}/api/backtests`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        symbol: ' aapl ',
        from: '2024-01-02',
        to: '2024-01-03',
      }),
    });
    const body = (await response.json()) as BacktestTaskView;

    expect(response.status).toBe(202);
    expect(body).toMatchObject({
      id: TASK_ID,
      status: 'queued',
      phase: 'queued',
      resultAvailable: false,
      request: defaultRequest,
    });
    expect(jobs.create).toHaveBeenCalledWith(expect.objectContaining(defaultRequest));
  });

  it('rejects unknown fields, obsolete strategies, and malformed dates', async () => {
    const request = {
      symbol: '0050',
      from: '2024-01-02',
      to: '2024-01-03',
    };
    const responses = await Promise.all([
      fetch(`${baseUrl}/api/backtests`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...request, typo: true }),
      }),
      fetch(`${baseUrl}/api/backtests`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...request, strategy: 'ma-cross' }),
      }),
      fetch(`${baseUrl}/api/backtests`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...request, from: '2024/01/02' }),
      }),
    ]);

    expect(responses.map((response) => response.status)).toEqual([400, 400, 400]);
    expect(jobs.create).not.toHaveBeenCalled();
  });

  it('exposes list, detail, result, and cancellation job routes', async () => {
    const [listResponse, detailResponse, resultResponse, cancelResponse] = await Promise.all([
      fetch(`${baseUrl}/api/backtests`),
      fetch(`${baseUrl}/api/backtests/${TASK_ID}`),
      fetch(`${baseUrl}/api/backtests/${TASK_ID}/result`),
      fetch(`${baseUrl}/api/backtests/${TASK_ID}`, { method: 'DELETE' }),
    ]);

    expect(listResponse.status).toBe(200);
    expect((await listResponse.json()) as BacktestTaskView[]).toHaveLength(1);
    expect(detailResponse.status).toBe(200);
    expect(await detailResponse.json()).toMatchObject({ id: TASK_ID, status: 'succeeded' });
    expect(resultResponse.status).toBe(200);
    expect(await resultResponse.json()).toEqual(backtestResult);
    expect(cancelResponse.status).toBe(200);
    expect(await cancelResponse.json()).toMatchObject({ id: TASK_ID, status: 'cancelled' });
    expect(jobs.get).toHaveBeenCalledWith(TASK_ID);
    expect(jobs.result).toHaveBeenCalledWith(TASK_ID);
    expect(jobs.cancel).toHaveBeenCalledWith(TASK_ID);
  });
});
