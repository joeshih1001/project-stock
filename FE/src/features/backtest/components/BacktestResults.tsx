import type {
  BacktestResult,
  BacktestTask,
  BacktestTrade,
  RunBacktestRequest,
} from '../../../services/backtestApi'
import { EquityCurveChart } from './EquityCurveChart'

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

interface BacktestResultsProps {
  state: BacktestRunState
  isStale: boolean
}

const numberFormatter = new Intl.NumberFormat('zh-TW', {
  maximumFractionDigits: 2,
})
const moneyFormatter = new Intl.NumberFormat('zh-TW', {
  style: 'currency',
  currency: 'TWD',
  maximumFractionDigits: 2,
})

function formatNumber(value: number | null): string {
  return value === null ? '—' : numberFormatter.format(value)
}

function formatMoney(value: number | null): string {
  return value === null ? '—' : moneyFormatter.format(value)
}

function formatPercent(value: number | null, showSign = false): string {
  if (value === null) return '—'
  const sign = showSign && value > 0 ? '+' : ''
  return `${sign}${numberFormatter.format(value)}%`
}

function loadingLabel(
  state: Extract<BacktestRunState, { status: 'loading' }>,
): string {
  if (state.stage === 'submitting') return '正在建立回測任務'
  if (state.stage === 'cancelling') return '正在取消回測任務'
  if (state.task?.phase === 'preparing-data') return '正在準備行情 CSV'
  if (state.task?.phase === 'running-python') return 'Python 正在執行回測'
  return '任務正在排隊'
}

export function BacktestResults({ state, isStale }: BacktestResultsProps) {
  if (state.status === 'idle') {
    return (
      <section className="flex min-h-[30rem] min-w-0 items-center justify-center rounded-3xl border border-dashed border-line bg-panel/40 p-7 text-center">
        <div className="max-w-sm">
          <div
            aria-hidden="true"
            className="mx-auto grid size-14 place-items-center rounded-2xl border border-line bg-panel text-2xl text-accent"
          >
            ↗
          </div>
          <h2 className="mt-5 text-xl font-bold">等待回測結果</h2>
          <p className="mt-2 text-sm leading-6 text-muted">
            設定 0050、MA
            週期、投入比例與成本後建立任務；完成後會顯示完整績效、資產曲線與交易明細。
          </p>
        </div>
      </section>
    )
  }

  if (state.status === 'loading') {
    return (
      <section
        aria-live="polite"
        aria-busy="true"
        className="min-h-[30rem] min-w-0 rounded-3xl border border-line bg-panel/95 p-6 sm:p-8"
      >
        <div className="flex items-center gap-3">
          <span
            aria-hidden="true"
            className="size-5 animate-spin rounded-full border-2 border-accent/25 border-t-accent motion-reduce:animate-none"
          />
          <div className="min-w-0">
            <h2 className="font-bold">{loadingLabel(state)}</h2>
            <p className="mt-1 text-xs text-muted">
              {state.request.symbol} · {state.request.from} 至{' '}
              {state.request.to}
            </p>
            {state.task ? (
              <p className="mt-1 font-mono text-[11px] break-all text-muted">
                Task {state.task.id}
              </p>
            ) : null}
          </div>
        </div>
        <ol className="mt-7 grid gap-3 text-xs sm:grid-cols-3">
          {[
            ['queued', '建立與排隊'],
            ['preparing-data', '準備行情 CSV'],
            ['running-python', 'Python 回測'],
          ].map(([phase, label]) => {
            const active = state.task?.phase === phase
            return (
              <li
                key={phase}
                className={`rounded-xl border p-4 ${active ? 'border-accent bg-accent/10 text-ink' : 'border-line bg-canvas/35 text-muted'}`}
              >
                {label}
              </li>
            )
          })}
        </ol>
        <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 6 }, (_, index) => (
            <div
              key={index}
              className="h-28 animate-pulse rounded-2xl bg-canvas/65 motion-reduce:animate-none"
            />
          ))}
        </div>
      </section>
    )
  }

  if (state.status === 'cancelled') {
    return (
      <section
        role="status"
        className="min-w-0 rounded-3xl border border-warning/30 bg-panel/95 p-6 sm:p-8"
      >
        <p className="text-xs font-semibold tracking-[0.18em] text-warning uppercase">
          Cancelled
        </p>
        <h2 className="mt-2 text-xl font-bold">回測任務已取消</h2>
        <p className="mt-3 text-sm text-muted">
          {state.request.symbol} 的任務不會產生可讀取的結果。
        </p>
        <p className="mt-2 font-mono text-xs break-all text-muted">
          {state.task.id}
        </p>
      </section>
    )
  }

  if (state.status === 'error') {
    return (
      <section
        role="alert"
        className="min-w-0 rounded-3xl border border-red-400/30 bg-panel/95 p-6 sm:p-8"
      >
        <p className="text-xs font-semibold tracking-[0.18em] text-red-300 uppercase">
          Task failed
        </p>
        <h2 className="mt-2 text-xl font-bold">回測執行失敗</h2>
        <p className="mt-3 rounded-xl bg-red-400/10 p-4 text-sm leading-6 [overflow-wrap:anywhere] text-red-100">
          {state.message}
        </p>
        <p className="mt-4 text-xs leading-5 text-muted">
          請確認台股代號、日期、行情來源與 Python 環境後再試一次。
        </p>
      </section>
    )
  }

  const { result, task } = state
  const metrics = [
    {
      label: '總報酬率',
      value: formatPercent(result.metrics.totalReturnPct, true),
      detail: formatMoney(result.metrics.totalPnl),
    },
    {
      label: '年化報酬率',
      value: formatPercent(result.metrics.annualizedReturnPct, true),
      detail: '依日曆天數年化',
    },
    {
      label: '最大回撤',
      value: formatPercent(-Math.abs(result.metrics.maxDrawdownPct)),
      detail: `提醒門檻 ${formatPercent(result.config.maxDrawdownWarningPct)}`,
    },
    {
      label: '交易勝率',
      value: formatPercent(result.metrics.winRatePct),
      detail: `${result.metrics.closedTrades} 筆已平倉`,
    },
    {
      label: '曝險比例',
      value: formatPercent(result.metrics.exposurePct),
      detail: `${result.metrics.openTrades} 筆未平倉`,
    },
    {
      label: '總交易數',
      value: formatNumber(result.metrics.totalTrades),
      detail: `${result.metrics.winningTrades} 勝 / ${result.metrics.losingTrades} 負`,
    },
  ]

  return (
    <section
      aria-labelledby="results-title"
      className="min-w-0 overflow-hidden rounded-3xl border border-line bg-panel/95 shadow-2xl shadow-black/10"
    >
      <div className="flex flex-col gap-4 border-b border-line px-5 py-5 sm:flex-row sm:items-center sm:justify-between sm:px-7">
        <div>
          <p className="text-xs font-semibold tracking-[0.18em] text-accent uppercase">
            Result
          </p>
          <h2 id="results-title" className="mt-1 text-xl font-bold">
            {result.symbol} 回測結果
          </h2>
        </div>
        <div className="max-w-full self-start rounded-full border border-line bg-canvas/45 px-3 py-1.5 text-xs [overflow-wrap:anywhere] text-muted sm:self-auto">
          {result.strategy.description}
        </div>
      </div>

      {isStale ? (
        <div
          role="status"
          className="border-b border-warning/30 bg-warning/10 px-5 py-3 text-sm text-warning sm:px-7"
        >
          目前表單已變更；以下仍是上一次送出條件的結果。
        </div>
      ) : null}

      <div className="p-5 sm:p-7">
        <div className="flex flex-wrap items-end justify-between gap-4 rounded-2xl border border-line bg-canvas/40 p-5">
          <div>
            <p className="text-xs text-muted">期末總資產</p>
            <p className="mt-1 text-3xl font-bold tracking-tight tabular-nums">
              {formatMoney(result.metrics.finalEquity)}
            </p>
          </div>
          <dl className="grid grid-cols-2 gap-x-7 gap-y-2 text-xs">
            <div>
              <dt className="text-muted">有效資料</dt>
              <dd className="mt-1 font-semibold tabular-nums">
                {result.data.rowsInRange.toLocaleString()} 根日 K
              </dd>
            </div>
            <div>
              <dt className="text-muted">暖身資料</dt>
              <dd className="mt-1 font-semibold tabular-nums">
                {result.data.warmupRows.toLocaleString()} 根
              </dd>
            </div>
          </dl>
        </div>

        <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {metrics.map((metric) => (
            <article
              key={metric.label}
              className="rounded-2xl border border-line bg-canvas/30 p-4"
            >
              <p className="text-xs text-muted">{metric.label}</p>
              <p className="mt-2 text-2xl font-bold tabular-nums">
                {metric.value}
              </p>
              <p className="mt-2 text-xs text-muted">{metric.detail}</p>
            </article>
          ))}
        </div>

        <dl className="mt-5 grid gap-3 rounded-2xl border border-line p-4 text-sm sm:grid-cols-2 lg:grid-cols-4">
          <MetricDetail
            label="已實現損益"
            value={formatMoney(result.metrics.realizedPnl)}
          />
          <MetricDetail
            label="未實現損益"
            value={formatMoney(result.metrics.unrealizedPnl)}
          />
          <MetricDetail
            label="累計手續費"
            value={formatMoney(result.metrics.totalFees)}
          />
          <MetricDetail
            label="Profit Factor"
            value={formatNumber(result.metrics.profitFactor)}
          />
        </dl>

        {result.warnings.length > 0 ? (
          <div className="mt-5 rounded-2xl border border-warning/30 bg-warning/10 p-4">
            <h3 className="text-sm font-bold text-warning">回測提醒</h3>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-xs leading-5 [overflow-wrap:anywhere] text-muted">
              {result.warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          </div>
        ) : null}

        <div className="mt-6">
          <EquityCurveChart points={result.equityCurve} />
        </div>
        <TradesTable trades={result.trades} />

        <details className="mt-6 rounded-2xl border border-line bg-canvas/25 p-4 text-xs">
          <summary className="cursor-pointer font-bold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent">
            本次參數、版本與執行假設
          </summary>
          <dl className="mt-4 grid gap-3 text-muted sm:grid-cols-2 lg:grid-cols-3">
            <Detail label="任務 ID" value={task.id} mono />
            <Detail
              label="回測期間"
              value={`${result.config.from} – ${result.config.to}`}
            />
            <Detail
              label="初始資金"
              value={formatMoney(result.config.initialCash)}
            />
            <Detail
              label="投入比例"
              value={formatPercent(result.config.allocation * 100)}
            />
            <Detail
              label="手續費 / 滑價"
              value={`${formatPercent(result.config.feeRate * 100)} / ${formatPercent(result.config.slippageRate * 100)}`}
            />
            <Detail
              label="策略版本"
              value={`${result.strategy.key} @ ${result.strategy.version}`}
              mono
            />
            <Detail
              label="引擎版本"
              value={`${result.engine.name} @ ${result.engine.version}`}
              mono
            />
            <Detail
              label="資料來源"
              value={`${result.data.source} · ${result.data.adjustment}`}
            />
            <Detail label="資料版本 SHA-256" value={result.data.sha256} mono />
            <Detail label="訊號 / 成交" value="收盤確認 / 次一交易日開盤" />
            <Detail label="股數 / 期末" value="整股 / 未平倉按收盤價評價" />
            <Detail label="成交量單位" value={result.data.volumeUnit} />
          </dl>
        </details>
      </div>
    </section>
  )
}

function TradesTable({ trades }: { trades: BacktestTrade[] }) {
  return (
    <div className="mt-6">
      <div className="mb-3 flex items-end justify-between gap-3">
        <div>
          <p className="text-xs font-semibold tracking-[0.16em] text-accent uppercase">
            Trades
          </p>
          <h3 className="mt-1 font-bold">交易明細</h3>
        </div>
        <span className="text-xs text-muted">{trades.length} 筆</span>
      </div>
      {trades.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-line p-5 text-sm text-muted">
          這段期間沒有產生交易。
        </p>
      ) : (
        <div className="overflow-x-auto rounded-2xl border border-line">
          <table className="w-full min-w-[840px] border-collapse text-left text-xs">
            <thead className="bg-canvas/70 text-muted">
              <tr>
                {[
                  '狀態',
                  '進場日',
                  '出場 / 評價日',
                  '股數',
                  '進場價',
                  '出場 / 評價價',
                  '損益',
                  '報酬率',
                ].map((heading) => (
                  <th
                    key={heading}
                    scope="col"
                    className="table-cell font-semibold"
                  >
                    {heading}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {trades.map((trade) => {
                const isOpen = trade.status === 'OPEN'
                return (
                  <tr key={trade.tradeId} className="border-t border-line">
                    <td className="table-cell">
                      <span
                        className={`rounded-full px-2 py-1 ${isOpen ? 'bg-warning/10 text-warning' : 'bg-accent/10 text-accent'}`}
                      >
                        {isOpen ? '未平倉' : '已平倉'}
                      </span>
                    </td>
                    <td className="table-cell tabular-nums">
                      {trade.entryDate}
                    </td>
                    <td className="table-cell tabular-nums">
                      {isOpen ? trade.markDate : trade.exitDate}
                    </td>
                    <td className="table-cell tabular-nums">
                      {trade.shares.toLocaleString()}
                    </td>
                    <td className="table-cell tabular-nums">
                      {formatNumber(trade.entryPrice)}
                    </td>
                    <td className="table-cell tabular-nums">
                      {formatNumber(isOpen ? trade.markPrice : trade.exitPrice)}
                    </td>
                    <td className="table-cell tabular-nums">
                      {formatMoney(isOpen ? trade.unrealizedPnl : trade.netPnl)}
                    </td>
                    <td className="table-cell font-semibold tabular-nums">
                      {formatPercent(
                        isOpen ? trade.unrealizedReturnPct : trade.returnPct,
                        true,
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

function MetricDetail({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="mt-1 font-semibold tabular-nums">{value}</dd>
    </div>
  )
}

function Detail({
  label,
  value,
  mono = false,
}: {
  label: string
  value: string
  mono?: boolean
}) {
  return (
    <div className="min-w-0">
      <dt>{label}</dt>
      <dd className={`mt-1 break-all text-ink ${mono ? 'font-mono' : ''}`}>
        {value}
      </dd>
    </div>
  )
}
