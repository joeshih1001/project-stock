import { BadRequestException, ConflictException } from '@nestjs/common';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { MarketDataService } from '../market-data/market-data.service';
import { PreparedMarketData } from '../market-data/types';
import { BacktestJobService } from './backtest-job.service';
import { BacktestTaskRepository } from './backtest-task.repository';
import { RunBacktestDto } from './dto/run-backtest.dto';
import { BacktestTaskView, PythonBacktestResult } from './job.types';
import { PythonBacktestRunner, PythonRunnerError } from './python-backtest.runner';

function request(overrides: Partial<RunBacktestDto> = {}): RunBacktestDto {
  return Object.assign(new RunBacktestDto(), {
    symbol: '0050',
    from: '2024-01-02',
    to: '2024-01-03',
    ...overrides,
  });
}

describe('BacktestJobService', () => {
  let resultsDir: string;
  let originalResultsDir: string | undefined;
  let originalMaxConcurrency: string | undefined;
  let repository: BacktestTaskRepository;
  let service: BacktestJobService;
  let prepareCsv: jest.MockedFunction<MarketDataService['prepareCsv']>;
  let runPython: jest.MockedFunction<PythonBacktestRunner['run']>;
  let prepared: PreparedMarketData;
  let result: PythonBacktestResult;

  beforeEach(async () => {
    originalResultsDir = process.env.RESULTS_DIR;
    originalMaxConcurrency = process.env.BACKTEST_MAX_CONCURRENCY;
    resultsDir = await fs.mkdtemp(path.join(tmpdir(), 'stock-backtest-jobs-'));
    process.env.RESULTS_DIR = resultsDir;
    process.env.BACKTEST_MAX_CONCURRENCY = '1';

    prepared = {
      symbol: '0050',
      sourceSymbol: '0050.TW',
      csvPath: path.join(resultsDir, '0050.csv'),
      dataVersion: 'a'.repeat(64),
      source: 'yahoo-finance2',
      adjustmentMode: 'adjclose-ratio',
      volumeUnit: 'shares',
      from: '2023-09-01',
      to: '2024-01-03',
      rows: 85,
      fetchedAt: '2024-01-04T00:00:00.000Z',
    };
    result = {
      schemaVersion: 1,
      symbol: '0050',
      engine: { name: 'python' },
      strategy: { key: 'ma-trend' },
      data: { version: prepared.dataVersion },
      config: {},
      metrics: { finalEquity: 101_000 },
      equityCurve: [],
      trades: [],
      warnings: [],
    };

    prepareCsv = jest.fn().mockResolvedValue(prepared);
    runPython = jest.fn().mockResolvedValue(result);
    repository = new BacktestTaskRepository();
    service = new BacktestJobService(
      { prepareCsv } as unknown as MarketDataService,
      { run: runPython } as unknown as PythonBacktestRunner,
      repository,
    );
    await service.onModuleInit();
  });

  afterEach(async () => {
    service.onApplicationShutdown();
    jest.restoreAllMocks();
    if (originalResultsDir === undefined) delete process.env.RESULTS_DIR;
    else process.env.RESULTS_DIR = originalResultsDir;
    if (originalMaxConcurrency === undefined) delete process.env.BACKTEST_MAX_CONCURRENCY;
    else process.env.BACKTEST_MAX_CONCURRENCY = originalMaxConcurrency;
    await fs.rm(resultsDir, { recursive: true, force: true });
  });

  it('persists queued, preparation, Python, result, and successful completion states', async () => {
    const events: string[] = [];
    const update = repository.update.bind(repository);
    const saveResult = repository.saveResult.bind(repository);
    jest.spyOn(repository, 'update').mockImplementation(async (task) => {
      events.push(`update:${task.status}:${task.phase}`);
      await update(task);
    });
    jest.spyOn(repository, 'saveResult').mockImplementation(async (id, value) => {
      events.push('save-result');
      await saveResult(id, value);
    });
    prepareCsv.mockImplementation(async () => {
      events.push('prepare-csv');
      return prepared;
    });
    runPython.mockImplementation(async () => {
      events.push('run-python');
      return result;
    });

    const created = await service.create(request());
    expect(created).toMatchObject({
      status: 'queued',
      phase: 'queued',
      resultAvailable: false,
      request: {
        symbol: '0050',
        strategy: 'ma-trend',
        maPeriod: 60,
        initialCapital: 100_000,
        allocation: 0.5,
        feeRate: 0,
        slippageRate: 0,
        maxDrawdownWarningPct: 20,
      },
    });

    const completed = await waitForStatus(created.id, ['succeeded']);
    expect(completed).toMatchObject({
      status: 'succeeded',
      phase: 'complete',
      resultAvailable: true,
      marketData: {
        symbol: '0050',
        sourceSymbol: '0050.TW',
        dataVersion: prepared.dataVersion,
        rows: 85,
      },
    });
    expect(completed.marketData).not.toHaveProperty('csvPath');
    expect(prepareCsv).toHaveBeenCalledWith('0050', '2024-01-02', '2024-01-03', 60);
    expect(runPython).toHaveBeenCalledWith(
      expect.objectContaining({ strategy: 'ma-trend', maPeriod: 60 }),
      prepared,
      expect.any(AbortSignal),
    );
    await expect(service.result(created.id)).resolves.toEqual(result);

    expect(events).toEqual([
      'update:running:preparing-data',
      'prepare-csv',
      'update:running:running-python',
      'run-python',
      'save-result',
      'update:succeeded:complete',
    ]);
    const persistedTask = JSON.parse(
      await fs.readFile(path.join(resultsDir, `${created.id}.task.json`), 'utf8'),
    ) as Record<string, unknown>;
    const persistedResult = JSON.parse(
      await fs.readFile(path.join(resultsDir, `${created.id}.result.json`), 'utf8'),
    ) as PythonBacktestResult;
    expect(persistedTask).toMatchObject({ id: created.id, status: 'succeeded', phase: 'complete' });
    expect(persistedResult).toEqual(result);
  });

  it('marks a Python runner error as failed and does not expose a result', async () => {
    runPython.mockRejectedValue(new PythonRunnerError('PYTHON_FAILED', 'strategy crashed'));

    const created = await service.create(request());
    const failed = await waitForStatus(created.id, ['failed']);

    expect(failed).toMatchObject({
      status: 'failed',
      phase: 'complete',
      resultAvailable: false,
      error: { code: 'PYTHON_FAILED', message: 'strategy crashed' },
    });
    await expect(service.result(created.id)).rejects.toBeInstanceOf(ConflictException);
    await expect(repository.readResult(created.id)).resolves.toBeNull();
  });

  it('aborts a running Python job and persists cancellation', async () => {
    let runnerStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      runnerStarted = resolve;
    });
    let receivedSignal: AbortSignal | undefined;
    runPython.mockImplementation(
      async (_request, _marketData, signal) =>
        new Promise<PythonBacktestResult>((_resolve, reject) => {
          receivedSignal = signal;
          runnerStarted();
          const rejectCancelled = (): void =>
            reject(new PythonRunnerError('CANCELLED', 'cancelled by test'));
          if (signal.aborted) rejectCancelled();
          else signal.addEventListener('abort', rejectCancelled, { once: true });
        }),
    );

    const created = await service.create(request());
    await started;
    const cancelled = await service.cancel(created.id);

    expect(cancelled).toMatchObject({
      status: 'cancelled',
      phase: 'complete',
      resultAvailable: false,
      error: { code: 'CANCELLED' },
    });
    expect(receivedSignal?.aborted).toBe(true);
    await expect(repository.readResult(created.id)).resolves.toBeNull();
    expect((await repository.find(created.id))?.status).toBe('cancelled');
  });

  it('rejects invalid calendar ranges before a task is queued', async () => {
    await expect(service.create(request({ from: '2024-02-30' }))).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(service.create(request({ from: '2024-01-04' }))).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(repository.list()).resolves.toEqual([]);
    expect(prepareCsv).not.toHaveBeenCalled();
  });

  async function waitForStatus(
    id: string,
    statuses: BacktestTaskView['status'][],
  ): Promise<BacktestTaskView> {
    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline) {
      const task = await service.get(id);
      if (statuses.includes(task.status)) return task;
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
    const task = await service.get(id);
    throw new Error(`Timed out waiting for ${statuses.join(', ')}; current status is ${task.status}`);
  }
});
