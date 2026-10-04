import { useEffect, useRef, useState } from 'react'

import {
  cancelBacktest,
  createBacktest,
  getBacktestResult,
  listMarketData,
  listStrategies,
  waitForBacktestTask,
} from '../../services/backtestApi'
import type {
  MarketDataEntry,
  RunBacktestRequest,
  StrategyOption,
} from '../../services/backtestApi'
import { BacktestForm } from './components/BacktestForm'
import {
  BacktestResults,
  type BacktestRunState,
} from './components/BacktestResults'

type ResourceState<T> =
  | { status: 'loading' }
  | { status: 'success'; data: T }
  | { status: 'empty' }
  | { status: 'error'; message: string }

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (
    typeof error === 'object' &&
    error !== null &&
    'message' in error &&
    typeof error.message === 'string'
  ) {
    return error.message
  }
  return '發生無法辨識的錯誤。'
}

function isAbortError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    error.name === 'AbortError'
  )
}

export function BacktestPage() {
  const [strategiesState, setStrategiesState] = useState<
    ResourceState<StrategyOption[]>
  >({
    status: 'loading',
  })
  const [marketDataState, setMarketDataState] = useState<
    ResourceState<MarketDataEntry[]>
  >({
    status: 'loading',
  })
  const [runState, setRunState] = useState<BacktestRunState>({ status: 'idle' })
  const [isResultStale, setIsResultStale] = useState(false)
  const [strategiesRequestId, setStrategiesRequestId] = useState(0)
  const [marketDataRequestId, setMarketDataRequestId] = useState(0)
  const runControllerRef = useRef<AbortController | null>(null)
  const activeTaskIdRef = useRef<string | null>(null)
  const cancelRequestedRef = useRef(false)

  useEffect(() => {
    const controller = new AbortController()
    void listStrategies(controller.signal)
      .then((strategies) => {
        setStrategiesState(
          strategies.length > 0
            ? { status: 'success', data: strategies }
            : { status: 'empty' },
        )
      })
      .catch((error: unknown) => {
        if (!isAbortError(error)) {
          setStrategiesState({
            status: 'error',
            message: getErrorMessage(error),
          })
        }
      })
    return () => controller.abort()
  }, [strategiesRequestId])

  useEffect(() => {
    const controller = new AbortController()
    void listMarketData(controller.signal)
      .then((entries) => {
        setMarketDataState(
          entries.length > 0
            ? { status: 'success', data: entries }
            : { status: 'empty' },
        )
      })
      .catch((error: unknown) => {
        if (!isAbortError(error)) {
          setMarketDataState({
            status: 'error',
            message: getErrorMessage(error),
          })
        }
      })
    return () => controller.abort()
  }, [marketDataRequestId])

  useEffect(() => () => runControllerRef.current?.abort(), [])

  function retryStrategies() {
    setStrategiesState({ status: 'loading' })
    setStrategiesRequestId((requestId) => requestId + 1)
  }

  function retryMarketData() {
    setMarketDataState({ status: 'loading' })
    setMarketDataRequestId((requestId) => requestId + 1)
  }

  async function handleSubmit(request: RunBacktestRequest) {
    runControllerRef.current?.abort()
    const controller = new AbortController()
    runControllerRef.current = controller
    activeTaskIdRef.current = null
    cancelRequestedRef.current = false
    setRunState({ status: 'loading', stage: 'submitting', request })
    setIsResultStale(false)

    try {
      const created = await createBacktest(request, controller.signal)
      if (runControllerRef.current !== controller) return

      activeTaskIdRef.current = created.id
      setRunState({
        status: 'loading',
        stage: 'polling',
        request,
        task: created,
      })

      if (cancelRequestedRef.current) {
        const cancelled = await cancelBacktest(created.id)
        if (runControllerRef.current === controller) {
          setRunState({ status: 'cancelled', request, task: cancelled })
        }
        return
      }

      const terminalTask = await waitForBacktestTask(created.id, {
        signal: controller.signal,
        onUpdate: (task) => {
          if (
            runControllerRef.current === controller &&
            !cancelRequestedRef.current
          ) {
            setRunState({ status: 'loading', stage: 'polling', request, task })
          }
        },
      })

      if (terminalTask.status === 'cancelled') {
        setRunState({ status: 'cancelled', request, task: terminalTask })
        return
      }
      if (terminalTask.status === 'failed') {
        throw new Error(terminalTask.error?.message ?? '回測任務執行失敗。')
      }

      const result = await getBacktestResult(terminalTask.id, controller.signal)
      if (runControllerRef.current === controller) {
        setRunState({ status: 'success', request, task: terminalTask, result })
        retryMarketData()
      }
    } catch (error: unknown) {
      if (runControllerRef.current !== controller) return
      if (isAbortError(error) && cancelRequestedRef.current) return
      setRunState({ status: 'error', request, message: getErrorMessage(error) })
    } finally {
      if (runControllerRef.current === controller) {
        runControllerRef.current = null
        activeTaskIdRef.current = null
      }
    }
  }

  async function handleCancel() {
    const controller = runControllerRef.current
    if (!controller || runState.status !== 'loading') return
    cancelRequestedRef.current = true
    setRunState({ ...runState, stage: 'cancelling' })

    const taskId = activeTaskIdRef.current
    if (!taskId) return

    try {
      const task = await cancelBacktest(taskId)
      if (runControllerRef.current === controller) {
        setRunState({ status: 'cancelled', request: runState.request, task })
        controller.abort()
      }
    } catch (error: unknown) {
      if (runControllerRef.current === controller) {
        controller.abort()
        setRunState({
          status: 'error',
          request: runState.request,
          message: `取消任務失敗；任務 ${taskId} 可能仍在後端執行。${getErrorMessage(error)}`,
        })
      }
    }
  }

  function handleFormDirty() {
    if (runState.status === 'success') setIsResultStale(true)
  }

  const marketDataEntries =
    marketDataState.status === 'success' ? marketDataState.data : []
  const isApiReady = strategiesState.status === 'success'

  return (
    <main className="relative isolate min-h-screen overflow-x-hidden bg-canvas text-ink">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-[-18rem] -z-10 mx-auto h-[36rem] max-w-6xl rounded-full bg-accent/10 blur-3xl"
      />
      <div className="mx-auto max-w-[1440px] min-w-0 px-4 py-6 sm:px-6 lg:px-8 lg:py-9">
        <header className="mb-8 flex flex-col gap-5 border-b border-line pb-7 sm:flex-row sm:items-end sm:justify-between">
          <div className="min-w-0">
            <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-accent">
              <span
                aria-hidden="true"
                className="inline-block size-2 rounded-full bg-accent shadow-[0_0_18px_var(--color-accent)]"
              />
              TAIWAN QUANT LAB
            </div>
            <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">
              台股策略回測
            </h1>
          </div>
          <div
            className="flex items-center gap-2 self-start rounded-full border border-line bg-panel px-3 py-2 text-xs font-medium text-muted sm:self-auto"
            aria-live="polite"
          >
            <span
              aria-hidden="true"
              className={`size-2 rounded-full ${isApiReady ? 'bg-positive' : 'bg-warning'}`}
            />
            {isApiReady ? 'API 已連線' : '正在連接 API'}
          </div>
        </header>

        <div className="grid min-w-0 items-start gap-6 xl:grid-cols-[minmax(380px,0.78fr)_minmax(0,1.22fr)]">
          <section
            aria-labelledby="configuration-title"
            className="min-w-0 overflow-hidden rounded-3xl border border-line bg-panel/95 shadow-2xl shadow-black/10"
          >
            <div className="border-b border-line px-5 py-5 sm:px-7">
              <p className="text-xs font-semibold tracking-[0.18em] text-accent uppercase">
                Configuration
              </p>
              <h2 id="configuration-title" className="mt-1 text-xl font-bold">
                回測條件
              </h2>
            </div>

            {strategiesState.status === 'loading' ? (
              <div className="space-y-5 p-5 sm:p-7" aria-label="正在載入策略">
                {[0, 1, 2, 3].map((item) => (
                  <div
                    key={item}
                    className="h-14 animate-pulse rounded-xl bg-canvas/70 motion-reduce:animate-none"
                  />
                ))}
              </div>
            ) : null}
            {strategiesState.status === 'empty' ? (
              <CatalogMessage
                title="目前沒有可用策略"
                description="策略 API 回傳了空清單，請先確認後端服務。"
                onRetry={retryStrategies}
              />
            ) : null}
            {strategiesState.status === 'error' ? (
              <CatalogMessage
                title="無法載入策略"
                description={strategiesState.message}
                onRetry={retryStrategies}
              />
            ) : null}
            {strategiesState.status === 'success' ? (
              <BacktestForm
                key={strategiesState.data
                  .map((strategy) => strategy.key)
                  .join('|')}
                strategies={strategiesState.data}
                marketDataEntries={marketDataEntries}
                marketDataStatus={marketDataState.status}
                marketDataError={
                  marketDataState.status === 'error'
                    ? marketDataState.message
                    : undefined
                }
                isSubmitting={runState.status === 'loading'}
                onCancel={handleCancel}
                onDirty={handleFormDirty}
                onRetryMarketData={retryMarketData}
                onSubmit={handleSubmit}
              />
            ) : null}
          </section>

          <BacktestResults state={runState} isStale={isResultStale} />
        </div>

        <footer className="mt-7 border-t border-line pt-5 text-xs leading-5 text-muted">
          本工具僅供研究與模擬使用；畫面中的交易皆為歷史模擬，不代表真實成交、未來績效或投資建議。
        </footer>
      </div>
    </main>
  )
}

interface CatalogMessageProps {
  title: string
  description: string
  onRetry: () => void
}

function CatalogMessage({ title, description, onRetry }: CatalogMessageProps) {
  return (
    <div className="p-5 sm:p-7" role="alert">
      <div className="rounded-2xl border border-warning/30 bg-warning/10 p-5">
        <h3 className="font-bold text-warning">{title}</h3>
        <p className="mt-2 text-sm leading-6 [overflow-wrap:anywhere] text-muted">
          {description}
        </p>
        <button
          type="button"
          onClick={onRetry}
          className="mt-4 min-h-11 rounded-xl border border-line bg-canvas px-4 text-sm font-semibold transition hover:border-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          重新載入
        </button>
      </div>
    </div>
  )
}
