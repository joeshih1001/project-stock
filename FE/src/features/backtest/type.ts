import type { FormEvent, ReactNode } from 'react'

import type {
  BacktestEquityPoint,
  BacktestResult,
  BacktestTask,
  BacktestTrade,
  MarketDataEntry,
  RunBacktestRequest,
  StrategyOption,
} from '../../services/type'

export type ResourceState<T> =
  | { status: 'loading' }
  | { status: 'success'; data: T }
  | { status: 'empty' }
  | { status: 'error'; message: string }

export type BacktestRunState =
  | { status: 'idle' }
  | {
      status: 'loading'
      stage: 'submitting' | 'polling' | 'cancelling'
      request: RunBacktestRequest
      task?: BacktestTask
    }
  | { status: 'cancelled'; request: RunBacktestRequest; task: BacktestTask }
  | {
      status: 'success'
      request: RunBacktestRequest
      task: BacktestTask
      result: BacktestResult
    }
  | { status: 'error'; request: RunBacktestRequest; message: string }

export type MarketDataStatus = 'loading' | 'success' | 'empty' | 'error'

export interface BacktestFormProps {
  strategies: StrategyOption[]
  marketDataEntries: MarketDataEntry[]
  marketDataStatus: MarketDataStatus
  marketDataError?: string
  isSubmitting: boolean
  onSubmit: (request: RunBacktestRequest) => Promise<void>
  onCancel: () => void | Promise<void>
  onDirty: () => void
  onRetryMarketData: () => void
}

export interface FieldProps {
  id: string
  label: string
  error?: string
  input: ReactNode
}

export interface PercentFieldProps {
  id: string
  label: string
  value: string
  error?: string
  min: string
  max: string
  step: string
  onChange: (value: string) => void
}

export interface EquityCurveChartProps {
  points: BacktestEquityPoint[]
  benchmark100?: BacktestEquityPoint[]
  benchmark50?: BacktestEquityPoint[]
  valueKey?: 'equity' | 'drawdownPct'
}

export interface BacktestResultsProps {
  state: BacktestRunState
  isStale: boolean
}

export interface TradesTableProps {
  trades: BacktestTrade[]
  fileName: string
}

export interface LabelValueProps {
  label: string
  value: string
}

export interface DetailProps extends LabelValueProps {
  mono?: boolean
}

export interface CatalogMessageProps {
  title: string
  description: string
  onRetry: () => void
}

export type BacktestFormSubmitEvent = FormEvent<HTMLFormElement>
