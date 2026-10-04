import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { BacktestTask, PythonBacktestResult } from './job.types';

@Injectable()
export class BacktestTaskRepository {
  private readonly logger = new Logger(BacktestTaskRepository.name);
  private readonly resultsDir = path.resolve(
    process.env.RESULTS_DIR ?? path.join(process.cwd(), 'results'),
  );
  private readonly tasks = new Map<string, BacktestTask>();
  private readonly taskQueues = new Map<string, Promise<void>>();
  private initialization: Promise<void> | null = null;

  initialize(): Promise<void> {
    this.initialization ??= this.load();
    return this.initialization;
  }

  async create(task: BacktestTask): Promise<void> {
    await this.initialize();
    await this.withTaskLock(task.id, async () => {
      if (this.tasks.has(task.id)) throw new Error(`回測任務 ${task.id} 已存在`);
      await this.writeTask(task);
      this.tasks.set(task.id, this.clone(task));
    });
  }

  async update(task: BacktestTask): Promise<void> {
    await this.initialize();
    await this.withTaskLock(task.id, async () => {
      const current = this.tasks.get(task.id);
      if (!current) throw new Error(`找不到回測任務 ${task.id}`);
      if (this.isTerminal(current.status) && current.status !== task.status) {
        throw new Error(`回測任務 ${task.id} 已結束為 ${current.status}`);
      }
      await this.writeTask(task);
      this.tasks.set(task.id, this.clone(task));
    });
  }

  async find(id: string): Promise<BacktestTask | null> {
    await this.initialize();
    const task = this.tasks.get(id);
    return task ? this.clone(task) : null;
  }

  async list(): Promise<BacktestTask[]> {
    await this.initialize();
    return [...this.tasks.values()]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((task) => this.clone(task));
  }

  async saveResult(id: string, result: PythonBacktestResult): Promise<void> {
    await this.initialize();
    this.assertId(id);
    await this.atomicWrite(this.resultFile(id), `${JSON.stringify(result, null, 2)}\n`);
  }

  async readResult(id: string): Promise<PythonBacktestResult | null> {
    await this.initialize();
    this.assertId(id);
    try {
      const value = JSON.parse(await fs.readFile(this.resultFile(id), 'utf8')) as unknown;
      return this.isResult(value) ? value : null;
    } catch {
      return null;
    }
  }

  private async load(): Promise<void> {
    await fs.mkdir(this.resultsDir, { recursive: true });
    let files: string[];
    try {
      files = await fs.readdir(this.resultsDir);
    } catch {
      return;
    }

    const interrupted: BacktestTask[] = [];
    for (const file of files.filter((name) => name.endsWith('.task.json'))) {
      try {
        const value = JSON.parse(
          await fs.readFile(path.join(this.resultsDir, file), 'utf8'),
        ) as unknown;
        if (!this.isTask(value)) {
          this.logger.warn(`忽略格式不合法的任務檔 ${file}`);
          continue;
        }
        const task = this.clone(value);
        if (task.status === 'queued' || task.status === 'running') {
          const now = new Date().toISOString();
          task.status = 'failed';
          task.phase = 'complete';
          task.updatedAt = now;
          task.completedAt = now;
          task.error = {
            code: 'SERVICE_RESTARTED',
            message: '服務重啟時任務尚未完成，已標記為失敗；請重新提交。',
          };
          interrupted.push(task);
        }
        this.tasks.set(task.id, task);
      } catch {
        this.logger.warn(`無法讀取任務檔 ${file}`);
      }
    }
    await Promise.all(interrupted.map((task) => this.writeTask(task)));
  }

  private async writeTask(task: BacktestTask): Promise<void> {
    this.assertId(task.id);
    await this.atomicWrite(this.taskFile(task.id), `${JSON.stringify(task, null, 2)}\n`);
  }

  private async atomicWrite(target: string, content: string): Promise<void> {
    await fs.mkdir(this.resultsDir, { recursive: true });
    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, content, 'utf8');
      await fs.rename(temporary, target);
    } catch (error) {
      await fs.unlink(temporary).catch(() => undefined);
      throw error;
    }
  }

  private async withTaskLock<T>(id: string, action: () => Promise<T>): Promise<T> {
    const previous = this.taskQueues.get(id) ?? Promise.resolve();
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = previous.then(() => gate);
    this.taskQueues.set(id, queued);
    await previous;
    try {
      return await action();
    } finally {
      release();
      if (this.taskQueues.get(id) === queued) this.taskQueues.delete(id);
    }
  }

  private taskFile(id: string): string {
    return path.join(this.resultsDir, `${id}.task.json`);
  }

  private resultFile(id: string): string {
    return path.join(this.resultsDir, `${id}.result.json`);
  }

  private assertId(id: string): void {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
      throw new Error(`非法任務 ID：${id}`);
    }
  }

  private isTask(value: unknown): value is BacktestTask {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
    const task = value as Partial<BacktestTask>;
    return (
      task.schemaVersion === 1 &&
      typeof task.id === 'string' &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        task.id,
      ) &&
      typeof task.createdAt === 'string' &&
      typeof task.updatedAt === 'string' &&
      task.request !== undefined &&
      ['queued', 'running', 'succeeded', 'failed', 'cancelled'].includes(
        String(task.status),
      ) &&
      ['queued', 'preparing-data', 'running-python', 'complete'].includes(
        String(task.phase),
      )
    );
  }

  private isResult(value: unknown): value is PythonBacktestResult {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
    const result = value as Partial<PythonBacktestResult>;
    return (
      result.schemaVersion === 1 &&
      typeof result.symbol === 'string' &&
      result.engine !== null &&
      typeof result.engine === 'object' &&
      result.strategy !== null &&
      typeof result.strategy === 'object' &&
      result.data !== null &&
      typeof result.data === 'object' &&
      result.config !== null &&
      typeof result.config === 'object' &&
      result.metrics !== null &&
      typeof result.metrics === 'object' &&
      Array.isArray(result.equityCurve) &&
      Array.isArray(result.trades) &&
      Array.isArray(result.warnings) &&
      result.warnings.every((warning) => typeof warning === 'string')
    );
  }

  private isTerminal(status: BacktestTask['status']): boolean {
    return status === 'succeeded' || status === 'failed' || status === 'cancelled';
  }

  private clone<T>(value: T): T {
    return structuredClone(value);
  }
}
