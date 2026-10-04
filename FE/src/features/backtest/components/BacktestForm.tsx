import { useRef, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'

import type {
  MarketDataEntry,
  RunBacktestRequest,
  StrategyOption,
} from '../../../services/backtestApi'

type MarketDataStatus = 'loading' | 'success' | 'empty' | 'error'

interface BacktestFormProps {
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

function formatDate(date: string): string {
  return new Intl.DateTimeFormat('zh-TW', {
    dateStyle: 'medium',
    timeZone: 'UTC',
  }).format(new Date(`${date}T00:00:00Z`))
}

function getTaipeiToday(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Taipei',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date())
}

function sourceSymbolFor(symbol: string): string {
  const normalized = symbol.trim().toUpperCase()
  return /^\d{4,6}$/.test(normalized) ? `${normalized}.TW` : normalized
}

export function BacktestForm({
  strategies,
  marketDataEntries,
  marketDataStatus,
  marketDataError,
  isSubmitting,
  onSubmit,
  onCancel,
  onDirty,
  onRetryMarketData,
}: BacktestFormProps) {
  const initialStrategy = strategies.at(0)
  const [symbol, setSymbol] = useState('0050')
  const [from, setFrom] = useState('2018-01-01')
  const [to, setTo] = useState('2025-12-31')
  const [strategyKey, setStrategyKey] = useState(initialStrategy?.key ?? '')
  const [maPeriod, setMaPeriod] = useState(
    String(initialStrategy?.defaultParams.maPeriod ?? 60),
  )
  const [initialCapital, setInitialCapital] = useState('100000')
  const [allocationPct, setAllocationPct] = useState(
    String((initialStrategy?.defaultParams.allocation ?? 0.5) * 100),
  )
  const [feeRatePct, setFeeRatePct] = useState('0')
  const [slippageRatePct, setSlippageRatePct] = useState('0')
  const [maxDrawdownWarningPct, setMaxDrawdownWarningPct] = useState('20')
  const [errors, setErrors] = useState<Record<string, string>>({})
  const errorSummaryRef = useRef<HTMLDivElement>(null)

  const selectedStrategy = strategies.find(
    (strategy) => strategy.key === strategyKey,
  )
  const matchedMarketData = marketDataEntries.find(
    (entry) => entry.sourceSymbol.toUpperCase() === sourceSymbolFor(symbol),
  )
  const taipeiToday = getTaipeiToday()

  function clearError(field: string) {
    setErrors((current) => {
      if (!(field in current)) return current
      const next = { ...current }
      delete next[field]
      return next
    })
  }

  function updateField(field: string, update: () => void) {
    update()
    clearError(field)
    onDirty()
  }

  function handleStrategyChange(nextKey: string) {
    const nextStrategy = strategies.find((strategy) => strategy.key === nextKey)
    setStrategyKey(nextKey)
    setMaPeriod(String(nextStrategy?.defaultParams.maPeriod ?? 60))
    setAllocationPct(
      String((nextStrategy?.defaultParams.allocation ?? 0.5) * 100),
    )
    clearError('strategy')
    clearError('maPeriod')
    clearError('allocationPct')
    onDirty()
  }

  function validate(): RunBacktestRequest | null {
    const nextErrors: Record<string, string> = {}
    const normalizedSymbol = symbol.trim().toUpperCase()
    const period = Number(maPeriod)
    const capital = Number(initialCapital)
    const allocationPercent = Number(allocationPct)
    const feePercent = Number(feeRatePct)
    const slippagePercent = Number(slippageRatePct)
    const drawdownPercent = Number(maxDrawdownWarningPct)

    if (!normalizedSymbol) {
      nextErrors.symbol = '請輸入股票代號。'
    } else if (!/^[A-Z0-9^][A-Z0-9.^-]{0,19}$/.test(normalizedSymbol)) {
      nextErrors.symbol = '股票代號只能包含英數字、點、連字號或 ^。'
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from)) {
      nextErrors.from = '請選擇有效的起始日期。'
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(to)) {
      nextErrors.to = '請選擇有效的結束日期。'
    } else if (from && from > to) {
      nextErrors.to = '結束日期不得早於起始日期。'
    } else if (to > taipeiToday) {
      nextErrors.to = '結束日期不得晚於台北今天。'
    }
    if (!selectedStrategy) nextErrors.strategy = '請選擇有效的策略。'
    if (!Number.isInteger(period) || period < 2 || period > 1000) {
      nextErrors.maPeriod = '均線週期必須是 2 到 1000 的整數。'
    }
    if (!Number.isFinite(capital) || capital < 1) {
      nextErrors.initialCapital = '初始資金必須大於或等於 1。'
    }
    if (
      !Number.isFinite(allocationPercent) ||
      allocationPercent <= 0 ||
      allocationPercent > 100
    ) {
      nextErrors.allocationPct = '投入比例必須大於 0% 且不超過 100%。'
    }
    if (!Number.isFinite(feePercent) || feePercent < 0 || feePercent > 10) {
      nextErrors.feeRatePct = '單邊手續費率必須介於 0% 到 10%。'
    }
    if (
      !Number.isFinite(slippagePercent) ||
      slippagePercent < 0 ||
      slippagePercent > 10
    ) {
      nextErrors.slippageRatePct = '滑價率必須介於 0% 到 10%。'
    }
    if (
      !Number.isFinite(drawdownPercent) ||
      drawdownPercent < 0 ||
      drawdownPercent > 100
    ) {
      nextErrors.maxDrawdownWarningPct = '回撤提醒門檻必須介於 0% 到 100%。'
    }

    setErrors(nextErrors)
    if (Object.keys(nextErrors).length > 0 || !selectedStrategy) {
      queueMicrotask(() => errorSummaryRef.current?.focus())
      return null
    }

    return {
      symbol: normalizedSymbol,
      from,
      to,
      strategy: selectedStrategy.key,
      maPeriod: period,
      initialCapital: capital,
      allocation: allocationPercent / 100,
      feeRate: feePercent / 100,
      slippageRate: slippagePercent / 100,
      maxDrawdownWarningPct: drawdownPercent,
    }
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const request = validate()
    if (request) void onSubmit(request)
  }

  const errorMessages = [...new Set(Object.values(errors))]

  return (
    <form onSubmit={handleSubmit} noValidate className="min-w-0">
      <fieldset
        disabled={isSubmitting}
        className="min-w-0 space-y-6 p-5 sm:p-7"
      >
        {errorMessages.length > 0 ? (
          <div
            ref={errorSummaryRef}
            role="alert"
            tabIndex={-1}
            className="rounded-xl border border-red-400/35 bg-red-400/10 p-4 text-sm [overflow-wrap:anywhere] text-red-200 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-300"
          >
            <p className="font-bold">請修正以下欄位：</p>
            <ul className="mt-2 list-disc space-y-1 pl-5">
              {errorMessages.map((message) => (
                <li key={message}>{message}</li>
              ))}
            </ul>
          </div>
        ) : null}

        <div>
          <label htmlFor="symbol" className="field-label">
            台股代號
          </label>
          <div className="relative mt-2">
            <span
              aria-hidden="true"
              className="pointer-events-none absolute top-1/2 left-4 -translate-y-1/2 text-muted"
            >
              ⌕
            </span>
            <input
              id="symbol"
              name="symbol"
              type="search"
              list="prepared-symbols"
              autoComplete="off"
              value={symbol}
              onChange={(event) =>
                updateField('symbol', () => setSymbol(event.target.value))
              }
              placeholder="例如 0050、2330 或 00687B.TWO"
              aria-invalid={Boolean(errors.symbol)}
              aria-describedby={errors.symbol ? 'symbol-error' : 'symbol-help'}
              className="field-input pl-12 font-mono uppercase"
            />
            <datalist id="prepared-symbols">
              {marketDataEntries.map((entry) => (
                <option key={entry.sourceSymbol} value={entry.symbol}>
                  {entry.from} – {entry.to} · {entry.rows} 筆
                </option>
              ))}
            </datalist>
          </div>
          {errors.symbol ? (
            <p id="symbol-error" className="field-error">
              {errors.symbol}
            </p>
          ) : matchedMarketData ? (
            <p id="symbol-help" className="field-help text-positive">
              已有行情 CSV：{formatDate(matchedMarketData.from)} 至{' '}
              {formatDate(matchedMarketData.to)}，共{' '}
              {matchedMarketData.rows.toLocaleString()} 根日 K。
            </p>
          ) : marketDataStatus === 'loading' ? (
            <p id="symbol-help" className="field-help">
              正在載入本機行情資料…
            </p>
          ) : marketDataStatus === 'error' ? (
            <p id="symbol-help" className="field-help">
              行情清單載入失敗：{marketDataError ?? '未知錯誤'}{' '}
              <button
                type="button"
                onClick={onRetryMarketData}
                className="font-semibold text-accent underline underline-offset-2"
              >
                重試
              </button>
            </p>
          ) : (
            <p id="symbol-help" className="field-help">
              純數字代號會自動使用 Yahoo 上市市場的 .TW；首次回測會下載行情。
            </p>
          )}
        </div>

        <div>
          <label htmlFor="strategy" className="field-label">
            交易策略
          </label>
          <select
            id="strategy"
            name="strategy"
            value={strategyKey}
            onChange={(event) => handleStrategyChange(event.target.value)}
            aria-invalid={Boolean(errors.strategy)}
            aria-describedby="strategy-description"
            className="field-input mt-2 appearance-none"
          >
            {strategies.map((strategy) => (
              <option key={strategy.key} value={strategy.key}>
                {strategy.name}
              </option>
            ))}
          </select>
          <p id="strategy-description" className="field-help leading-5">
            {selectedStrategy?.description}
          </p>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            id="from"
            label="回測起始日"
            error={errors.from}
            input={
              <input
                id="from"
                name="from"
                type="date"
                value={from}
                max={to}
                onChange={(event) =>
                  updateField('from', () => setFrom(event.target.value))
                }
                aria-invalid={Boolean(errors.from)}
                aria-describedby={errors.from ? 'from-error' : undefined}
                className="field-input mt-2"
              />
            }
          />
          <Field
            id="to"
            label="回測結束日"
            error={errors.to}
            input={
              <input
                id="to"
                name="to"
                type="date"
                value={to}
                min={from}
                max={taipeiToday}
                onChange={(event) =>
                  updateField('to', () => setTo(event.target.value))
                }
                aria-invalid={Boolean(errors.to)}
                aria-describedby={errors.to ? 'to-error' : undefined}
                className="field-input mt-2"
              />
            }
          />
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            id="ma-period"
            label="均線週期（交易日）"
            error={errors.maPeriod}
            input={
              <input
                id="ma-period"
                name="maPeriod"
                type="number"
                min="2"
                max="1000"
                step="1"
                value={maPeriod}
                onChange={(event) =>
                  updateField('maPeriod', () => setMaPeriod(event.target.value))
                }
                aria-invalid={Boolean(errors.maPeriod)}
                aria-describedby={
                  errors.maPeriod ? 'ma-period-error' : 'ma-period-help'
                }
                className="field-input mt-2 tabular-nums"
              />
            }
          />
          <Field
            id="initial-capital"
            label="初始資金（TWD）"
            error={errors.initialCapital}
            input={
              <input
                id="initial-capital"
                name="initialCapital"
                type="number"
                min="1"
                step="1000"
                inputMode="decimal"
                value={initialCapital}
                onChange={(event) =>
                  updateField('initialCapital', () =>
                    setInitialCapital(event.target.value),
                  )
                }
                aria-invalid={Boolean(errors.initialCapital)}
                aria-describedby={
                  errors.initialCapital ? 'initial-capital-error' : undefined
                }
                className="field-input mt-2 tabular-nums"
              />
            }
          />
        </div>
        {!errors.maPeriod ? (
          <p id="ma-period-help" className="-mt-5 text-xs text-muted">
            均線使用起始日前的 CSV 暖身資料，但暖身期間不會交易。
          </p>
        ) : null}

        <div className="grid gap-4 sm:grid-cols-2">
          <PercentField
            id="allocation"
            label="每次投入比例"
            value={allocationPct}
            error={errors.allocationPct}
            min="0.01"
            max="100"
            step="1"
            onChange={(value) =>
              updateField('allocationPct', () => setAllocationPct(value))
            }
          />
          <PercentField
            id="drawdown-warning"
            label="最大回撤提醒門檻"
            value={maxDrawdownWarningPct}
            error={errors.maxDrawdownWarningPct}
            min="0"
            max="100"
            step="1"
            onChange={(value) =>
              updateField('maxDrawdownWarningPct', () =>
                setMaxDrawdownWarningPct(value),
              )
            }
          />
          <PercentField
            id="fee-rate"
            label="單邊手續費率"
            value={feeRatePct}
            error={errors.feeRatePct}
            min="0"
            max="10"
            step="0.01"
            onChange={(value) =>
              updateField('feeRatePct', () => setFeeRatePct(value))
            }
          />
          <PercentField
            id="slippage-rate"
            label="單邊滑價率"
            value={slippageRatePct}
            error={errors.slippageRatePct}
            min="0"
            max="10"
            step="0.01"
            onChange={(value) =>
              updateField('slippageRatePct', () => setSlippageRatePct(value))
            }
          />
        </div>

        <div className="rounded-2xl border border-warning/30 bg-warning/10 p-4 text-xs leading-5 text-muted">
          <p className="font-bold text-warning">成本與風控假設</p>
          <p className="mt-1">
            費率欄位以百分比輸入，例如 0.1% 會送出
            0.001。回撤門檻只產生提醒，不會停損；目前不自動加入台股交易稅或最低手續費。
          </p>
        </div>
      </fieldset>

      <div className="flex flex-col-reverse gap-3 border-t border-line bg-canvas/20 px-5 py-5 sm:flex-row sm:justify-end sm:px-7">
        {isSubmitting ? (
          <button
            type="button"
            onClick={() => void onCancel()}
            className="min-h-12 rounded-xl border border-line px-5 text-sm font-bold transition hover:border-red-300 hover:text-red-200 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-300"
          >
            取消任務
          </button>
        ) : null}
        <button
          type="submit"
          disabled={isSubmitting}
          className="inline-flex min-h-12 items-center justify-center gap-2 rounded-xl bg-accent px-6 text-sm font-extrabold text-canvas transition hover:brightness-110 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-wait disabled:opacity-65"
        >
          {isSubmitting ? (
            <>
              <span
                aria-hidden="true"
                className="size-4 animate-spin rounded-full border-2 border-canvas/25 border-t-canvas motion-reduce:animate-none"
              />
              任務處理中
            </>
          ) : (
            <>
              建立回測任務<span aria-hidden="true">→</span>
            </>
          )}
        </button>
      </div>
    </form>
  )
}

interface FieldProps {
  id: string
  label: string
  error?: string
  input: ReactNode
}

function Field({ id, label, error, input }: FieldProps) {
  return (
    <div className="min-w-0">
      <label htmlFor={id} className="field-label">
        {label}
      </label>
      {input}
      {error ? (
        <p id={`${id}-error`} className="field-error">
          {error}
        </p>
      ) : null}
    </div>
  )
}

interface PercentFieldProps {
  id: string
  label: string
  value: string
  error?: string
  min: string
  max: string
  step: string
  onChange: (value: string) => void
}

function PercentField({
  id,
  label,
  value,
  error,
  min,
  max,
  step,
  onChange,
}: PercentFieldProps) {
  return (
    <Field
      id={id}
      label={label}
      error={error}
      input={
        <div className="relative mt-2">
          <input
            id={id}
            type="number"
            min={min}
            max={max}
            step={step}
            inputMode="decimal"
            value={value}
            onChange={(event) => onChange(event.target.value)}
            aria-invalid={Boolean(error)}
            aria-describedby={error ? `${id}-error` : undefined}
            className="field-input pr-10 tabular-nums"
          />
          <span className="pointer-events-none absolute top-1/2 right-4 -translate-y-1/2 text-sm text-muted">
            %
          </span>
        </div>
      }
    />
  )
}
