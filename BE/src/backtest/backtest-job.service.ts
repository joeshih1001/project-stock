import {
  BadRequestException,
  ConflictException,
  HttpException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  OnApplicationShutdown,
  OnModuleInit,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { MarketDataService } from '../market-data/market-data.service';
import { RunBacktestDto } from './dto/run-backtest.dto';
import {
  BacktestRequestSnapshot,
  BacktestTask,
  BacktestTaskError,
  BacktestTaskView,
  PythonBacktestResult,
} from './job.types';
import { PythonBacktestRunner, PythonRunnerError } from './python-backtest.runner';
import { BacktestTaskRepository } from './backtest-task.repository';

@Injectable()
export class BacktestJobService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(BacktestJobService.name);
  private readonly maxConcurrency = this.positiveIntegerEnv('BACKTEST_MAX_CONCURRENCY', 1);
  private readonly queue: string[] = [];
  private readonly active = new Map<string, AbortController>();
  private running = 0;
  private shuttingDown = false;

  constructor(
    private readonly marketData: MarketDataService,
    private readonly runner: PythonBacktestRunner,
    private readonly repository: BacktestTaskRepository,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.repository.initialize();
  }

  async create(request: RunBacktestDto): Promise<BacktestTaskView> {
    this.validateRequest(request);
    if (this.shuttingDown) throw new ConflictException('服務正在關閉，暫不接受新任務');

    const now = new Date().toISOString();
    const task: BacktestTask = {
      schemaVersion: 1,
      id: randomUUID(),
      status: 'queued',
      phase: 'queued',
      request: this.snapshot(request),
      createdAt: now,
      updatedAt: now,
    };
    await this.repository.create(task);
    this.queue.push(task.id);
    queueMicrotask(() => void this.pump());
    return this.toView(task);
  }

  async list(): Promise<BacktestTaskView[]> {
    return Promise.all((await this.repository.list()).map((task) => this.toView(task)));
  }

  async get(id: string): Promise<BacktestTaskView> {
    const task = await this.requireTask(id);
    return this.toView(task);
  }

  async result(id: string): Promise<PythonBacktestResult> {
    const task = await this.requireTask(id);
    if (task.status !== 'succeeded') {
      throw new ConflictException(`任務狀態為 ${task.status}，目前沒有可讀取的結果`);
    }
    const result = await this.repository.readResult(id);
    if (!result) throw new InternalServerErrorException('任務完成但結果檔不存在或損壞');
    return result;
  }

  async cancel(id: string): Promise<BacktestTaskView> {
    const task = await this.requireTask(id);
    if (['succeeded', 'failed', 'cancelled'].includes(task.status)) return this.toView(task);

    const now = new Date().toISOString();
    task.status = 'cancelled';
    task.phase = 'complete';
    task.updatedAt = now;
    task.completedAt = now;
    task.error = { code: 'CANCELLED', message: '使用者取消回測任務' };
    try {
      await this.repository.update(task);
    } catch (error) {
      const latest = await this.requireTask(id);
      if (['succeeded', 'failed', 'cancelled'].includes(latest.status)) {
        return this.toView(latest);
      }
      throw error;
    }
    this.active.get(id)?.abort();
    return this.toView(task);
  }

  onApplicationShutdown(): void {
    this.shuttingDown = true;
    for (const controller of this.active.values()) controller.abort();
  }

  private async pump(): Promise<void> {
    while (!this.shuttingDown && this.running < this.maxConcurrency && this.queue.length > 0) {
      const id = this.queue.shift();
      if (!id) continue;
      this.running++;
      void this.execute(id).finally(() => {
        this.running--;
        void this.pump();
      });
    }
  }

  private async execute(id: string): Promise<void> {
    const task = await this.repository.find(id);
    if (!task || task.status !== 'queued') return;

    const abortController = new AbortController();
    this.active.set(id, abortController);
    try {
      const startedAt = new Date().toISOString();
      task.status = 'running';
      task.phase = 'preparing-data';
      task.startedAt = startedAt;
      task.updatedAt = startedAt;
      await this.repository.update(task);

      const prepared = await this.marketData.prepareCsv(
        task.request.symbol,
        task.request.from,
        task.request.to,
        task.request.maPeriod,
      );
      if (abortController.signal.aborted) {
        throw new PythonRunnerError('CANCELLED', '回測已取消');
      }

      task.marketData = {
        symbol: prepared.symbol,
        sourceSymbol: prepared.sourceSymbol,
        dataVersion: prepared.dataVersion,
        source: prepared.source,
        adjustmentMode: prepared.adjustmentMode,
        volumeUnit: prepared.volumeUnit,
        from: prepared.from,
        to: prepared.to,
        rows: prepared.rows,
        fetchedAt: prepared.fetchedAt,
      };
      task.phase = 'running-python';
      task.updatedAt = new Date().toISOString();
      await this.repository.update(task);

      const result = await this.runner.run(task.request, prepared, abortController.signal);
      const latest = await this.repository.find(id);
      if (abortController.signal.aborted || latest?.status === 'cancelled') return;
      await this.repository.saveResult(id, result);

      const afterSave = await this.repository.find(id);
      if (abortController.signal.aborted || afterSave?.status === 'cancelled') return;

      task.status = 'succeeded';
      task.phase = 'complete';
      task.updatedAt = new Date().toISOString();
      task.completedAt = task.updatedAt;
      delete task.error;
      await this.repository.update(task);
    } catch (error) {
      await this.finishWithError(id, error);
    } finally {
      this.active.delete(id);
    }
  }

  private async finishWithError(id: string, error: unknown): Promise<void> {
    const task = await this.repository.find(id);
    if (!task || task.status === 'cancelled') return;

    const failure = this.toTaskError(error);
    const now = new Date().toISOString();
    task.status = failure.code === 'CANCELLED' ? 'cancelled' : 'failed';
    task.phase = 'complete';
    task.error = failure;
    task.updatedAt = now;
    task.completedAt = now;
    try {
      await this.repository.update(task);
    } catch (persistenceError) {
      this.logger.error(
        `無法保存任務 ${id} 的失敗狀態`,
        persistenceError instanceof Error ? persistenceError.stack : String(persistenceError),
      );
    }
  }

  private toTaskError(error: unknown): BacktestTaskError {
    if (error instanceof PythonRunnerError) {
      return { code: error.code, message: error.message };
    }
    if (error instanceof HttpException) {
      const response = error.getResponse();
      let message = error.message;
      if (typeof response === 'string') message = response;
      else if (response && typeof response === 'object' && 'message' in response) {
        const value = (response as { message: unknown }).message;
        message = Array.isArray(value) ? value.join('; ') : String(value);
      }
      return { code: `HTTP_${error.getStatus()}`, message };
    }
    return {
      code: 'INTERNAL_ERROR',
      message: error instanceof Error ? error.message : String(error),
    };
  }

  private async requireTask(id: string): Promise<BacktestTask> {
    const task = await this.repository.find(id);
    if (!task) throw new NotFoundException(`找不到回測任務 ${id}`);
    return task;
  }

  private snapshot(request: RunBacktestDto): BacktestRequestSnapshot {
    return {
      symbol: request.symbol.trim().toUpperCase(),
      from: request.from,
      to: request.to,
      strategy: 'ma-trend',
      maPeriod: request.maPeriod,
      initialCapital: request.initialCapital,
      allocation: request.allocation,
      feeRate: request.feeRate,
      slippageRate: request.slippageRate,
      maxDrawdownWarningPct: request.maxDrawdownWarningPct,
    };
  }

  private toView(task: BacktestTask): BacktestTaskView {
    return {
      ...structuredClone(task),
      resultAvailable: task.status === 'succeeded',
      links: {
        self: `/api/backtests/${task.id}`,
        result: `/api/backtests/${task.id}/result`,
      },
    };
  }

  private validateDateRange(from: string, to: string): void {
    if (!this.isCalendarDate(from)) throw new BadRequestException(`from 不是有效日期：${from}`);
    if (!this.isCalendarDate(to)) throw new BadRequestException(`to 不是有效日期：${to}`);
    if (from > to) throw new BadRequestException(`from (${from}) 不可晚於 to (${to})`);
    const today = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Taipei',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date());
    if (to > today) throw new BadRequestException(`to (${to}) 不可晚於台北日期 ${today}`);
  }

  private validateRequest(request: RunBacktestDto): void {
    this.validateDateRange(request.from, request.to);
    const symbol = request.symbol.trim().toUpperCase();
    if (!/^[A-Z0-9^][A-Z0-9.^-]{0,19}$/.test(symbol)) {
      throw new BadRequestException(`無效的股票代號 '${request.symbol}'`);
    }
    if (request.strategy !== 'ma-trend') {
      throw new BadRequestException(`第一版不支援策略 '${request.strategy}'`);
    }
    if (!Number.isInteger(request.maPeriod) || request.maPeriod < 2 || request.maPeriod > 1000) {
      throw new BadRequestException('maPeriod 必須是 2~1000 的整數');
    }
    this.requireFiniteRange('initialCapital', request.initialCapital, 1, Number.MAX_VALUE);
    this.requireFiniteRange('allocation', request.allocation, Number.EPSILON, 1);
    this.requireFiniteRange('feeRate', request.feeRate, 0, 0.1);
    this.requireFiniteRange('slippageRate', request.slippageRate, 0, 0.1);
    this.requireFiniteRange(
      'maxDrawdownWarningPct',
      request.maxDrawdownWarningPct,
      0,
      100,
    );
  }

  private requireFiniteRange(name: string, value: number, min: number, max: number): void {
    if (!Number.isFinite(value) || value < min || value > max) {
      throw new BadRequestException(`${name} 必須介於 ${min} 與 ${max} 之間`);
    }
  }

  private isCalendarDate(value: string): boolean {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const parsed = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
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
}
