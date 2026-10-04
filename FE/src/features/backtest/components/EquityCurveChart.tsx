import { useId } from 'react'

import type { EquityCurveChartProps } from '../type'

const numberFormatter = new Intl.NumberFormat('zh-TW', {
  maximumFractionDigits: 0,
})

export const EquityCurveChart = ({ points }: EquityCurveChartProps) => {
  const titleId = useId()
  const descriptionId = useId()

  if (points.length === 0) {
    return (
      <div className="rounded-2xl border border-dashed border-line p-5">
        <h3 className="font-bold">每日權益曲線</h3>
        <p className="mt-2 text-sm text-muted">API 沒有回傳權益資料點。</p>
      </div>
    )
  }

  const width = 800
  const height = 240
  const paddingX = 20
  const paddingY = 18
  const values = points.map((point) => point.equity)
  const { min, max } = values.reduce(
    (range, value) => ({
      min: Math.min(range.min, value),
      max: Math.max(range.max, value),
    }),
    { min: values[0] ?? 0, max: values[0] ?? 0 },
  )
  const valueRange = max - min || 1
  const drawableWidth = width - paddingX * 2
  const drawableHeight = height - paddingY * 2
  const denominator = Math.max(points.length - 1, 1)
  const polylinePoints = points
    .map((point, index) => {
      const x = paddingX + (index / denominator) * drawableWidth
      const y = paddingY + ((max - point.equity) / valueRange) * drawableHeight
      return `${x.toFixed(2)},${y.toFixed(2)}`
    })
    .join(' ')
  const firstPoint = points.at(0)
  const lastPoint = points.at(-1)

  return (
    <figure className="min-w-0 rounded-2xl border border-line bg-canvas/30 p-4 sm:p-5">
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-xs font-semibold tracking-[0.16em] text-accent uppercase">
            Equity curve
          </p>
          <h3 className="mt-1 font-bold">每日權益曲線</h3>
        </div>
        <div className="text-right text-xs text-muted">
          <p>最高 {numberFormatter.format(max)}</p>
          <p className="mt-1">最低 {numberFormatter.format(min)}</p>
        </div>
      </div>

      <svg
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-labelledby={`${titleId} ${descriptionId}`}
        className="h-auto w-full overflow-visible text-accent"
      >
        <title id={titleId}>每日權益曲線</title>
        <desc id={descriptionId}>
          從 {firstPoint?.date} 的{' '}
          {numberFormatter.format(firstPoint?.equity ?? 0)} 變化到{' '}
          {lastPoint?.date} 的 {numberFormatter.format(lastPoint?.equity ?? 0)}
          ；期間最低值為 {numberFormatter.format(min)}，最高值為{' '}
          {numberFormatter.format(max)}。
        </desc>
        {[0, 0.5, 1].map((ratio) => (
          <line
            key={ratio}
            x1={paddingX}
            y1={paddingY + ratio * drawableHeight}
            x2={width - paddingX}
            y2={paddingY + ratio * drawableHeight}
            stroke="var(--color-line)"
            strokeWidth="1"
            vectorEffect="non-scaling-stroke"
          />
        ))}
        <polyline
          points={polylinePoints}
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
        />
      </svg>

      <figcaption className="mt-3 flex flex-col justify-between gap-1 text-xs text-muted tabular-nums sm:flex-row sm:gap-4">
        <span>
          {firstPoint?.date} · {numberFormatter.format(firstPoint?.equity ?? 0)}
        </span>
        <span className="text-right">
          {lastPoint?.date} · {numberFormatter.format(lastPoint?.equity ?? 0)}
        </span>
      </figcaption>
    </figure>
  )
}
