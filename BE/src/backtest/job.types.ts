import { PreparedMarketData } from '../market-data/types';

export type BacktestTaskStatus =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled';

export type BacktestTaskPhase =
  | 'queued'
  | 'preparing-data'
  | 'running-python'
  | 'complete';

export interface BacktestRequestSnapshot {
  symbol: string;
  from: string;
  to: string;
  strategy: 'ma-trend';
  maPeriod: number;
  initialCapital: number;
  allocation: number;
  feeRate: number;
  sellFeeRate?: number;
  feeDiscount?: number;
  minFee?: number;
  feeRounding?: 'NONE' | 'FLOOR' | 'HALF_UP';
  productType?: 'ETF' | 'STOCK' | 'UNSPECIFIED';
  lotSize?: number;
  usedForTuning?: 'YES' | 'NO' | 'UNKNOWN';
  previouslyViewed?: 'YES' | 'NO' | 'UNKNOWN';
  slippageRate: number;
  maxDrawdownWarningPct: number;
}

export interface BacktestTaskError {
  code: string;
  message: string;
}

export interface BacktestTask {
  schemaVersion: 1;
  id: string;
  status: BacktestTaskStatus;
  phase: BacktestTaskPhase;
  request: BacktestRequestSnapshot;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  marketData?: Omit<PreparedMarketData, 'csvPath'>;
  error?: BacktestTaskError;
}

/** Python JSON 契約的外框；細部數值仍會在 runner 中做 runtime 驗證。 */
export interface PythonBacktestResult {
  schemaVersion: 1;
  symbol: string;
  engine: Record<string, unknown>;
  strategy: Record<string, unknown>;
  data: Record<string, unknown>;
  config: Record<string, unknown>;
  metrics: Record<string, unknown>;
  equityCurve: unknown[];
  trades: unknown[];
  warnings: string[];
  accountingStatus?: string;
  benchmarks?: Record<string, unknown>;
  noCostMetrics?: Record<string, unknown>;
  manifest?: Record<string, unknown>;
}

export interface BacktestTaskView extends BacktestTask {
  resultAvailable: boolean;
  links: {
    self: string;
    result: string;
  };
}
