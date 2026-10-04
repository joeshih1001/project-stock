import type { BacktestTrade } from '../../services/backtestApi'

const HEADERS = [
  '交易 ID',
  '狀態',
  '進場日',
  '出場 / 評價日',
  '股數',
  '進場價 (TWD)',
  '出場 / 評價價 (TWD)',
  '損益 (TWD)',
  '報酬率 (%)',
]

function csvCell(value: string | number | null): string {
  if (value === null) return ''
  if (typeof value === 'number')
    return Number.isFinite(value) ? String(value) : ''

  // Spreadsheet apps may evaluate text beginning with these characters as a formula.
  const trimmedValue = value.replace(/^[\s\p{Cc}]+/u, '')
  const safeValue = /^[=+\-@]/u.test(trimmedValue) ? `'${trimmedValue}` : value
  return `"${safeValue.replaceAll('"', '""')}"`
}

/** 匯出畫面上的交易表格；數值保留原始精度，空值維持空白。 */
export function buildTradesCsv(trades: BacktestTrade[]): string {
  const rows = trades.map((trade) => {
    const isOpen = trade.status === 'OPEN'
    return [
      trade.tradeId,
      isOpen ? '未平倉' : '已平倉',
      trade.entryDate,
      isOpen ? trade.markDate : trade.exitDate,
      trade.shares,
      trade.entryPrice,
      isOpen ? trade.markPrice : trade.exitPrice,
      isOpen ? trade.unrealizedPnl : trade.netPnl,
      isOpen ? trade.unrealizedReturnPct : trade.returnPct,
    ]
  })

  return `\uFEFF${[HEADERS, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n')}\r\n`
}

export function tradeCsvFileName(
  symbol: string,
  from: string,
  to: string,
  taskId: string,
): string {
  const safePart = (value: string, maxLength: number) =>
    value
      .replace(/[^a-zA-Z0-9_-]/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, maxLength)
  return `backtest-${safePart(symbol, 24) || 'symbol'}-${safePart(from, 10)}-${safePart(to, 10)}-${safePart(taskId, 36)}-trades.csv`
}

export function downloadTradesCsv(
  trades: BacktestTrade[],
  fileName: string,
): void {
  const blob = new Blob([buildTradesCsv(trades)], {
    type: 'text/csv;charset=utf-8',
  })
  const url = URL.createObjectURL(blob)
  const revokeObjectURL = URL.revokeObjectURL.bind(URL)
  const link = document.createElement('a')
  link.href = url
  link.download = fileName
  document.body.append(link)
  link.click()
  link.remove()
  window.setTimeout(() => revokeObjectURL(url), 1_000)
}
