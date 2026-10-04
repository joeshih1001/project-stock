import { Injectable, Logger, OnApplicationShutdown } from '@nestjs/common';
import { ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import * as path from 'node:path';
import { PreparedMarketData } from '../market-data/types';
import {
  BacktestRequestSnapshot,
  PythonBacktestResult,
} from './job.types';

export class PythonRunnerError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'PythonRunnerError';
  }
}

@Injectable()
export class PythonBacktestRunner implements OnApplicationShutdown {
  private readonly logger = new Logger(PythonBacktestRunner.name);
  private readonly pythonExecutable =
    process.env.PYTHON_EXECUTABLE ?? (process.platform === 'win32' ? 'python' : 'python3');
  private readonly scriptPath = path.resolve(
    process.env.BACKTEST_SCRIPT ?? path.join(process.cwd(), 'python', 'backtest.py'),
  );
  private readonly timeoutMs = this.positiveIntegerEnv('BACKTEST_TIMEOUT_MS', 120_000);
  private readonly maxOutputBytes = this.positiveIntegerEnv(
    'BACKTEST_MAX_OUTPUT_BYTES',
    20 * 1024 * 1024,
  );
  private readonly maxStderrBytes = this.positiveIntegerEnv(
    'BACKTEST_MAX_STDERR_BYTES',
    1024 * 1024,
  );
  private readonly children = new Set<ChildProcessWithoutNullStreams>();

  run(
    request: BacktestRequestSnapshot,
    marketData: PreparedMarketData,
    abortSignal: AbortSignal,
  ): Promise<PythonBacktestResult> {
    if (abortSignal.aborted) {
      throw new PythonRunnerError('CANCELLED', '回測已取消');
    }

    const args = [
      this.scriptPath,
      '--data',
      marketData.csvPath,
      '--symbol',
      request.symbol,
      '--from',
      request.from,
      '--to',
      request.to,
      '--cash',
      String(request.initialCapital),
      '--ma',
      String(request.maPeriod),
      '--allocation',
      String(request.allocation),
      '--fee-rate',
      String(request.feeRate),
      '--sell-fee-rate',
      String(request.sellFeeRate ?? request.feeRate),
      '--fee-discount',
      String(request.feeDiscount ?? 1),
      '--min-fee',
      String(request.minFee ?? 0),
      '--fee-rounding',
      request.feeRounding ?? 'NONE',
      '--product-type',
      request.productType ?? 'UNSPECIFIED',
      '--lot-size',
      String(request.lotSize ?? 1),
      '--tax-rate',
      request.productType === 'ETF' ? '0.001' : request.productType === 'STOCK' ? '0.003' : '0',
      '--slippage-rate',
      String(request.slippageRate),
      '--max-drawdown-warning-pct',
      String(request.maxDrawdownWarningPct),
      '--data-source',
      marketData.source,
      '--data-version',
      marketData.dataVersion,
      '--adjustment',
      marketData.adjustmentMode,
      '--volume-unit',
      marketData.volumeUnit,
    ];

    return new Promise<PythonBacktestResult>((resolve, reject) => {
      let child: ChildProcessWithoutNullStreams;
      try {
        child = spawn(this.pythonExecutable, args, {
          cwd: process.cwd(),
          shell: false,
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe'],
          env: { ...process.env, PYTHONUTF8: '1' },
        });
      } catch (error) {
        reject(
          new PythonRunnerError(
            'SPAWN_FAILED',
            `無法啟動 Python：${error instanceof Error ? error.message : String(error)}`,
          ),
        );
        return;
      }

      child.stdin.end();
      this.children.add(child);
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let settled = false;

      const cleanup = (): void => {
        clearTimeout(timer);
        abortSignal.removeEventListener('abort', onAbort);
        this.children.delete(child);
      };
      const fail = (error: PythonRunnerError): void => {
        if (settled) return;
        settled = true;
        cleanup();
        child.kill();
        reject(error);
      };
      const onAbort = (): void => fail(new PythonRunnerError('CANCELLED', '回測已取消'));
      const timer = setTimeout(
        () =>
          fail(
            new PythonRunnerError(
              'TIMEOUT',
              `Python 回測超過 ${this.timeoutMs} ms，已終止`,
            ),
          ),
        this.timeoutMs,
      );
      timer.unref();
      abortSignal.addEventListener('abort', onAbort, { once: true });

      child.stdout.on('data', (chunk: Buffer) => {
        if (settled) return;
        stdoutBytes += chunk.length;
        if (stdoutBytes > this.maxOutputBytes) {
          fail(new PythonRunnerError('OUTPUT_TOO_LARGE', 'Python 回測結果超過輸出大小上限'));
          return;
        }
        stdoutChunks.push(chunk);
      });
      child.stderr.on('data', (chunk: Buffer) => {
        if (settled) return;
        stderrBytes += chunk.length;
        if (stderrBytes <= this.maxStderrBytes) stderrChunks.push(chunk);
        if (stderrBytes > this.maxStderrBytes) {
          fail(new PythonRunnerError('STDERR_TOO_LARGE', 'Python 診斷輸出超過大小上限'));
        }
      });
      child.once('error', (error) => {
        fail(new PythonRunnerError('SPAWN_FAILED', `無法啟動 Python：${error.message}`));
      });
      child.once('close', (code) => {
        if (settled) return;
        settled = true;
        cleanup();
        const stderr = Buffer.concat(stderrChunks).toString('utf8').trim();
        if (code !== 0) {
          reject(
            new PythonRunnerError(
              'PYTHON_FAILED',
              stderr
                ? `Python 回測失敗（exit ${String(code)}）：${this.truncate(stderr, 2000)}`
                : `Python 回測失敗（exit ${String(code)}）`,
            ),
          );
          return;
        }

        try {
          const parsed = JSON.parse(Buffer.concat(stdoutChunks).toString('utf8')) as unknown;
          const result = this.validateResult(parsed, request, marketData);
          if (stderr) this.logger.debug(this.truncate(stderr, 2000));
          resolve(result);
        } catch (error) {
          reject(
            error instanceof PythonRunnerError
              ? error
              : new PythonRunnerError(
                  'INVALID_RESULT',
                  `Python 回傳的 JSON 無效：${error instanceof Error ? error.message : String(error)}`,
                ),
          );
        }
      });
    });
  }

  onApplicationShutdown(): void {
    for (const child of this.children) child.kill();
    this.children.clear();
  }

  private validateResult(
    value: unknown,
    request: BacktestRequestSnapshot,
    marketData: PreparedMarketData,
  ): PythonBacktestResult {
    if (!this.isRecord(value)) {
      throw new PythonRunnerError('INVALID_RESULT', 'Python 結果必須是 JSON object');
    }
    const requiredRecords = ['engine', 'strategy', 'data', 'config', 'metrics'] as const;
    if (
      value.schemaVersion !== 1 ||
      value.symbol !== request.symbol ||
      requiredRecords.some((key) => !this.isRecord(value[key])) ||
      !Array.isArray(value.equityCurve) ||
      !Array.isArray(value.trades) ||
      !Array.isArray(value.warnings) ||
      !value.warnings.every((warning) => typeof warning === 'string')
    ) {
      throw new PythonRunnerError('INVALID_RESULT', 'Python 結果不符合 schemaVersion 1 契約');
    }
    const strategy = value.strategy as Record<string, unknown>;
    const engine = value.engine as Record<string, unknown>;
    const strategyParams = strategy.params;
    if (
      engine.language !== 'python' ||
      engine.endOfPeriodPolicy !== 'MARK_TO_MARKET' ||
      strategy.key !== request.strategy ||
      typeof strategy.version !== 'string' ||
      !this.isRecord(strategyParams) ||
      strategyParams.maPeriod !== request.maPeriod
    ) {
      throw new PythonRunnerError('INVALID_RESULT', 'Python 結果的策略與請求不一致');
    }
    const config = value.config as Record<string, unknown>;
    if (
      config.symbol !== request.symbol ||
      config.from !== request.from ||
      config.to !== request.to ||
      config.maPeriod !== request.maPeriod ||
      !this.sameNumber(config.initialCash, request.initialCapital) ||
      !this.sameNumber(config.allocation, request.allocation) ||
      !this.sameNumber(config.feeRate, request.feeRate) ||
      !this.sameNumber(config.sellFeeRate, request.sellFeeRate ?? request.feeRate) ||
      !this.sameNumber(config.feeDiscount, request.feeDiscount ?? 1) ||
      !this.sameNumber(config.minFee, request.minFee ?? 0) ||
      config.feeRounding !== (request.feeRounding ?? 'NONE') ||
      config.productType !== (request.productType ?? 'UNSPECIFIED') ||
      config.lotSize !== (request.lotSize ?? 1) ||
      !this.sameNumber(config.taxRate, request.productType === 'ETF' ? 0.001 : request.productType === 'STOCK' ? 0.003 : 0) ||
      !this.sameNumber(config.slippageRate, request.slippageRate) ||
      !this.sameNumber(config.maxDrawdownWarningPct, request.maxDrawdownWarningPct) ||
      config.signalTiming !== 'CLOSE' ||
      config.executionTiming !== 'NEXT_TRADING_DAY_OPEN' ||
      config.shareSizing !== 'WHOLE_SHARES' ||
      config.endOfPeriodPolicy !== 'MARK_TO_MARKET'
    ) {
      throw new PythonRunnerError('INVALID_RESULT', 'Python 結果的參數與請求不一致');
    }
    const data = value.data as Record<string, unknown>;
    if (
      data.version !== marketData.dataVersion ||
      data.sha256 !== marketData.dataVersion ||
      data.source !== marketData.source ||
      data.adjustment !== marketData.adjustmentMode ||
      data.volumeUnit !== marketData.volumeUnit ||
      data.symbol !== request.symbol ||
      typeof data.fileName !== 'string' ||
      data.fileName.length === 0 ||
      /[\\/]/.test(data.fileName) ||
      !this.isCalendarDate(data.firstDate) ||
      !this.isCalendarDate(data.lastDate) ||
      typeof data.rowsInRange !== 'number' ||
      !Number.isInteger(data.rowsInRange) ||
      data.rowsInRange <= 0 ||
      typeof data.rowsInFile !== 'number' ||
      !Number.isInteger(data.rowsInFile) ||
      data.rowsInFile < data.rowsInRange ||
      typeof data.warmupRows !== 'number' ||
      !Number.isInteger(data.warmupRows) ||
      data.warmupRows < 0 ||
      data.rowsInFile < data.rowsInRange + data.warmupRows
    ) {
      throw new PythonRunnerError('INVALID_RESULT', 'Python 結果的資料版本或來源與 CSV 中繼資料不一致');
    }
    const metrics = value.metrics as Record<string, unknown>;
    for (const key of ['finalEquity', 'totalReturnPct', 'maxDrawdownPct']) {
      if (typeof metrics[key] !== 'number' || !Number.isFinite(metrics[key])) {
        throw new PythonRunnerError('INVALID_RESULT', `Python 結果缺少有效 metrics.${key}`);
      }
    }
    this.validateEquityCurve(value.equityCurve, data, metrics);
    this.validateTrades(value.trades, data, metrics);
    if (value.benchmarks !== undefined) {
      if (!this.isRecord(value.benchmarks)) {
        throw new PythonRunnerError('INVALID_RESULT', 'Python 基準結果必須是 object');
      }
      for (const key of ['buyHold100', 'buyHold50']) {
        const benchmark = value.benchmarks[key];
        if (!this.isRecord(benchmark) || !this.isRecord(benchmark.metrics) || !Array.isArray(benchmark.equityCurve)) {
          throw new PythonRunnerError('INVALID_RESULT', `Python 缺少基準 ${key}`);
        }
        this.validateEquityCurve(benchmark.equityCurve, data, benchmark.metrics);
        for (let index = 0; index < value.equityCurve.length; index++) {
          const strategyPoint = value.equityCurve[index] as Record<string, unknown>;
          const benchmarkPoint = benchmark.equityCurve[index] as Record<string, unknown>;
          if (strategyPoint.date !== benchmarkPoint.date) {
            throw new PythonRunnerError('INVALID_RESULT', `基準 ${key} 與策略交易日不一致`);
          }
        }
      }
    }
    if (value.accountingStatus !== undefined && !['INCOMPLETE', 'PENDING_CORPORATE_ACTIONS', 'ASSUMED_COST'].includes(String(value.accountingStatus))) {
      throw new PythonRunnerError('INVALID_RESULT', 'Python 會計狀態無效');
    }
    return value as unknown as PythonBacktestResult;
  }

  private validateEquityCurve(
    curve: unknown[],
    data: Record<string, unknown>,
    metrics: Record<string, unknown>,
  ): void {
    if (
      curve.length !== data.rowsInRange ||
      metrics.equityPoints !== curve.length ||
      curve.length === 0
    ) {
      throw new PythonRunnerError('INVALID_RESULT', 'Python 結果的資產曲線長度與資料範圍不一致');
    }

    let previousDate: string | null = null;
    for (const point of curve) {
      if (
        !this.isRecord(point) ||
        !this.isCalendarDate(point.date) ||
        (previousDate !== null && point.date <= previousDate) ||
        !this.isNonNegativeNumber(point.cash) ||
        !this.isNonNegativeNumber(point.marketValue) ||
        !this.isPositiveNumber(point.equity) ||
        !this.isPositiveNumber(point.close) ||
        !this.isNonNegativeNumber(point.drawdownPct) ||
        (point.movingAverage !== null && !this.isPositiveNumber(point.movingAverage)) ||
        typeof point.positionShares !== 'number' ||
        !Number.isInteger(point.positionShares) ||
        point.positionShares < 0
      ) {
        throw new PythonRunnerError('INVALID_RESULT', 'Python 結果含無效或未排序的資產曲線');
      }
      previousDate = point.date;
    }

    const first = curve[0] as Record<string, unknown>;
    const last = curve[curve.length - 1] as Record<string, unknown>;
    if (
      first.date !== data.firstDate ||
      last.date !== data.lastDate ||
      !this.sameNumber(metrics.finalEquity, last.equity as number)
    ) {
      throw new PythonRunnerError('INVALID_RESULT', 'Python 結果的資產曲線首尾或期末資產不一致');
    }
  }

  private validateTrades(
    trades: unknown[],
    data: Record<string, unknown>,
    metrics: Record<string, unknown>,
  ): void {
    const firstDate = data.firstDate as string;
    const lastDate = data.lastDate as string;
    if (
      metrics.totalTrades !== trades.length ||
      typeof metrics.closedTrades !== 'number' ||
      typeof metrics.openTrades !== 'number'
    ) {
      throw new PythonRunnerError('INVALID_RESULT', 'Python 結果的交易統計與明細數量不一致');
    }

    const ids = new Set<number>();
    let closed = 0;
    let open = 0;
    for (const value of trades) {
      if (!this.isRecord(value)) {
        throw new PythonRunnerError('INVALID_RESULT', 'Python 交易明細必須是 object');
      }
      const trade = value;
      if (
        typeof trade.tradeId !== 'number' ||
        !Number.isInteger(trade.tradeId) ||
        trade.tradeId <= 0 ||
        ids.has(trade.tradeId) ||
        typeof trade.shares !== 'number' ||
        !Number.isInteger(trade.shares) ||
        trade.shares <= 0 ||
        !this.isCalendarDate(trade.entrySignalDate) ||
        !this.isCalendarDate(trade.entryDate) ||
        trade.entrySignalDate >= trade.entryDate ||
        trade.entryDate < firstDate ||
        trade.entryDate > lastDate ||
        !this.isPositiveNumber(trade.entryPrice) ||
        !this.isPositiveNumber(trade.entryGross) ||
        !this.isNonNegativeNumber(trade.entryFee) ||
        !this.isPositiveNumber(trade.entryCashOutflow)
      ) {
        throw new PythonRunnerError('INVALID_RESULT', 'Python 結果含無效的進場交易明細');
      }
      ids.add(trade.tradeId);

      if (trade.status === 'CLOSED') {
        closed++;
        if (
          !this.isCalendarDate(trade.exitSignalDate) ||
          !this.isCalendarDate(trade.exitDate) ||
          trade.exitSignalDate >= trade.exitDate ||
          trade.exitDate < trade.entryDate ||
          trade.exitDate > lastDate ||
          !this.isPositiveNumber(trade.exitPrice) ||
          !this.isPositiveNumber(trade.exitGross) ||
          !this.isNonNegativeNumber(trade.exitFee) ||
          !this.isNonNegativeNumber(trade.exitCashInflow) ||
          !this.isFiniteNumber(trade.grossPnl) ||
          !this.isFiniteNumber(trade.netPnl) ||
          !this.isFiniteNumber(trade.returnPct) ||
          typeof trade.holdingTradingDays !== 'number' ||
          !Number.isInteger(trade.holdingTradingDays) ||
          trade.holdingTradingDays < 1 ||
          typeof trade.holdingCalendarDays !== 'number' ||
          !Number.isInteger(trade.holdingCalendarDays) ||
          trade.holdingCalendarDays < 1 ||
          trade.exitReason !== 'STRATEGY_SIGNAL'
        ) {
          throw new PythonRunnerError('INVALID_RESULT', 'Python 結果含無效的出場交易明細');
        }
      } else if (trade.status === 'OPEN') {
        open++;
        if (
          open > 1 ||
          !this.isCalendarDate(trade.markDate) ||
          trade.markDate !== lastDate ||
          !this.isPositiveNumber(trade.markPrice) ||
          !this.isFiniteNumber(trade.unrealizedPnl) ||
          !this.isFiniteNumber(trade.unrealizedReturnPct) ||
          trade.exitDate !== null ||
          trade.exitPrice !== null ||
          trade.netPnl !== null
        ) {
          throw new PythonRunnerError('INVALID_RESULT', 'Python 結果含無效的期末未平倉明細');
        }
      } else {
        throw new PythonRunnerError('INVALID_RESULT', 'Python 交易狀態無效');
      }
    }

    if (metrics.closedTrades !== closed || metrics.openTrades !== open) {
      throw new PythonRunnerError('INVALID_RESULT', 'Python 結果的已平倉或未平倉統計不一致');
    }
  }

  private positiveIntegerEnv(name: string, fallback: number): number {
    const raw = process.env[name];
    if (raw === undefined) return fallback;
    const parsed = Number(raw);
    if (!Number.isSafeInteger(parsed) || parsed <= 0) {
      throw new Error(`${name} 必須是正整數，收到 ${raw}`);
    }
    return parsed;
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }

  private sameNumber(value: unknown, expected: number): boolean {
    if (typeof value !== 'number' || !Number.isFinite(value)) return false;
    const tolerance = Math.max(1, Math.abs(expected)) * 1e-12;
    return Math.abs(value - expected) <= tolerance;
  }

  private isFiniteNumber(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value);
  }

  private isNonNegativeNumber(value: unknown): value is number {
    return this.isFiniteNumber(value) && value >= 0;
  }

  private isPositiveNumber(value: unknown): value is number {
    return this.isFiniteNumber(value) && value > 0;
  }

  private isCalendarDate(value: unknown): value is string {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const parsed = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  }

  private truncate(value: string, maxLength: number): string {
    return value.length <= maxLength ? value : `${value.slice(0, maxLength)}…`;
  }
}
