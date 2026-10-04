export type HttpMethod = 'GET' | 'POST' | 'DELETE'
export type JsonRecord = Record<string, unknown>

export interface ValidationContext {
  readonly endpoint: string
  readonly source: 'request' | 'response'
}

export type ValidationFailure = (
  context: ValidationContext,
  path: string,
  expected: string,
) => never

export interface StrategyOption {
  key: string
  name: string
  description: string
  version: string
  defaultParams: Record<string, number>
}

export interface MarketDataEntry {
  symbol: string
  sourceSymbol: string
  dataVersion: string
  source: string
  adjustmentMode: string
  volumeUnit: string
  from: string
  to: string
  rows: number
  fetchedAt: string
}

export interface RunBacktestRequest {
  symbol: string
  from: string
  to: string
  strategy: string
  maPeriod: number
  initialCapital: number
  allocation: number
  feeRate: number
  slippageRate: number
  maxDrawdownWarningPct: number
}

export type BacktestTaskStatus =
  'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'

export type BacktestTaskPhase =
  'queued' | 'preparing-data' | 'running-python' | 'complete'

export interface BacktestTaskError {
  code: string
  message: string
}

export interface BacktestTask {
  schemaVersion: 1
  id: string
  status: BacktestTaskStatus
  phase: BacktestTaskPhase
  request: RunBacktestRequest
  createdAt: string
  updatedAt: string
  startedAt?: string
  completedAt?: string
  marketData?: MarketDataEntry
  error?: BacktestTaskError
  resultAvailable: boolean
  links: {
    self: string
    result: string
  }
}

export interface BacktestEngine {
  name: string
  version: string
  language: 'python'
  pythonVersion: string
  endOfPeriodPolicy: 'MARK_TO_MARKET'
}

export interface BacktestStrategy {
  key: string
  name: string
  version: string
  params: Record<string, number>
  description: string
}

export interface BacktestConfig {
  symbol: string
  from: string
  to: string
  initialCash: number
  maPeriod: number
  allocation: number
  feeRate: number
  slippageRate: number
  maxDrawdownWarningPct: number
  signalTiming: 'CLOSE'
  executionTiming: 'NEXT_TRADING_DAY_OPEN'
  shareSizing: 'WHOLE_SHARES'
  endOfPeriodPolicy: 'MARK_TO_MARKET'
}

export interface BacktestData {
  fileName: string
  symbol: string
  source: string
  version: string
  sha256: string
  adjustment: string
  volumeUnit: string
  rowsInFile: number
  rowsInRange: number
  warmupRows: number
  fileFirstDate: string
  fileLastDate: string
  firstDate: string
  lastDate: string
}

export interface BacktestMetrics {
  initialCash: number
  finalCash: number
  finalMarketValue: number
  finalEquity: number
  totalPnl: number
  realizedPnl: number
  unrealizedPnl: number
  totalReturnPct: number
  annualizedReturnPct: number | null
  maxDrawdownPct: number
  totalFees: number
  totalTrades: number
  closedTrades: number
  openTrades: number
  winningTrades: number
  losingTrades: number
  winRatePct: number | null
  profitFactor: number | null
  exposurePct: number
  equityPoints: number
}

export interface BacktestEquityPoint {
  date: string
  cash: number
  marketValue: number
  equity: number
  positionShares: number
  close: number
  movingAverage: number | null
  drawdownPct: number
}

export interface BacktestTrade {
  tradeId: number
  status: 'OPEN' | 'CLOSED'
  shares: number
  entrySignalDate: string
  entryDate: string
  entryPrice: number
  entryGross: number
  entryFee: number
  entryCashOutflow: number
  exitSignalDate: string | null
  exitDate: string | null
  exitPrice: number | null
  exitGross: number | null
  exitFee: number | null
  exitCashInflow: number | null
  grossPnl: number | null
  netPnl: number | null
  returnPct: number | null
  holdingTradingDays: number | null
  holdingCalendarDays: number | null
  exitReason: 'STRATEGY_SIGNAL' | null
  markDate: string | null
  markPrice: number | null
  unrealizedPnl: number | null
  unrealizedReturnPct: number | null
}

export interface BacktestResult {
  schemaVersion: 1
  symbol: string
  engine: BacktestEngine
  strategy: BacktestStrategy
  config: BacktestConfig
  data: BacktestData
  metrics: BacktestMetrics
  equityCurve: BacktestEquityPoint[]
  trades: BacktestTrade[]
  warnings: string[]
}

export interface WaitForTaskOptions {
  signal?: AbortSignal
  pollIntervalMs?: number
  onUpdate?: (task: BacktestTask) => void
}
