import { BadRequestException } from '@nestjs/common';
import { PythonBacktestResult } from './job.types';

export const exportKinds = [
  'trades.csv', 'equity_daily.csv', 'benchmarks_daily.csv',
  'summary.json', 'run_manifest.json',
] as const;

export type ExportKind = (typeof exportKinds)[number];

const safeCell = (value: unknown): string => {
  if (value === null || value === undefined) return '';
  const raw = typeof value === 'object' ? JSON.stringify(value) : String(value);
  const escaped = /^[=+@\-\t\r]/.test(raw) && !/^-?\d+(\.\d+)?$/.test(raw)
    ? `'${raw}` : raw;
  return `"${escaped.replace(/"/g, '""')}"`;
};

const csv = (rows: Record<string, unknown>[], fields: string[]): string => {
  const lines = [fields.join(','), ...rows.map((row) => fields.map((field) => safeCell(row[field])).join(','))];
  return `\uFEFF${lines.join('\r\n')}\r\n`;
};

export const renderBacktestExport = (result: PythonBacktestResult, kind: string): string => {
  if (!exportKinds.includes(kind as ExportKind)) {
    throw new BadRequestException(`不支援的匯出格式：${kind}`);
  }
  if (kind === 'run_manifest.json') return `${JSON.stringify(result.manifest ?? {}, null, 2)}\n`;
  if (kind === 'summary.json') {
    return `${JSON.stringify({
      schemaVersion: result.schemaVersion,
      symbol: result.symbol,
      accountingStatus: result.accountingStatus,
      strategy: result.metrics,
      noCost: result.noCostMetrics,
      benchmarks: Object.fromEntries(
        Object.entries(result.benchmarks ?? {}).map(([key, value]) => [key, (value as { metrics?: unknown }).metrics]),
      ),
      warnings: result.warnings,
    }, null, 2)}\n`;
  }
  if (kind === 'trades.csv') {
    return csv(result.trades as Record<string, unknown>[], [
      'tradeId', 'status', 'entryShares', 'shares', 'entrySignalDate', 'entryDate',
      'entryReferencePrice', 'entryPrice', 'entrySlippageCost', 'entryGross', 'entryFee', 'entryCashOutflow',
      'dividendCash', 'dividendReceivable',
      'exitSignalDate', 'exitDate', 'exitReferencePrice', 'exitPrice', 'exitSlippageCost', 'exitGross',
      'exitFee', 'exitTax', 'exitCashInflow', 'grossPnl', 'netPnl',
      'markDate', 'markPrice', 'unrealizedPnl',
    ]);
  }
  if (kind === 'equity_daily.csv') {
    return csv(result.equityCurve as Record<string, unknown>[], [
      'date', 'cash', 'holdings', 'marketValue', 'dividendReceivable', 'equity',
      'dailyFees', 'dailyTax', 'dividendsReceived', 'highWaterMark', 'drawdownPct',
    ]);
  }
  const benchmarkData = result.benchmarks ?? {};
  const first = (benchmarkData.buyHold100 as { equityCurve?: Record<string, unknown>[] } | undefined)?.equityCurve ?? [];
  const second = (benchmarkData.buyHold50 as { equityCurve?: Record<string, unknown>[] } | undefined)?.equityCurve ?? [];
  return csv(first.map((point, index) => ({
    date: point.date,
    buyHold100Equity: point.equity,
    buyHold100DrawdownPct: point.drawdownPct,
    buyHold50Equity: second[index]?.equity,
    buyHold50DrawdownPct: second[index]?.drawdownPct,
  })), ['date', 'buyHold100Equity', 'buyHold100DrawdownPct', 'buyHold50Equity', 'buyHold50DrawdownPct']);
};
