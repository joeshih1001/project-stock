import { describe, expect, it } from 'vitest'

import type { BacktestTrade } from '../../services/backtestApi'
import { buildTradesCsv, tradeCsvFileName } from './tradesCsv'

const closedTrade: BacktestTrade = {
  tradeId: 1,
  status: 'CLOSED',
  shares: 1000,
  entrySignalDate: '2025-01-01',
  entryDate: '2025-01-02',
  entryPrice: 12.345,
  entryGross: 12345,
  entryFee: 0,
  entryCashOutflow: 12345,
  exitSignalDate: '2025-01-09',
  exitDate: '2025-01-10',
  exitPrice: 14.5,
  exitGross: 14500,
  exitFee: 0,
  exitCashInflow: 14500,
  grossPnl: 2155,
  netPnl: 2155,
  returnPct: 17.456,
  holdingTradingDays: 7,
  holdingCalendarDays: 8,
  exitReason: 'STRATEGY_SIGNAL',
  markDate: null,
  markPrice: null,
  unrealizedPnl: null,
  unrealizedReturnPct: null,
}

describe('交易明細 CSV', () => {
  it('保留已平倉及未平倉交易的原始數值與日期', () => {
    const csv = buildTradesCsv([
      closedTrade,
      {
        ...closedTrade,
        tradeId: 2,
        status: 'OPEN',
        exitDate: null,
        exitPrice: null,
        netPnl: null,
        returnPct: null,
        markDate: '2025-01-20',
        markPrice: 15.125,
        unrealizedPnl: -250.75,
        unrealizedReturnPct: -2.031,
      },
    ])

    expect(csv).toMatch(/^\uFEFF"交易 ID",/u)
    expect(csv).toContain(
      '1,"已平倉","2025-01-02","2025-01-10",1000,12.345,14.5,2155,17.456\r\n',
    )
    expect(csv).toContain(
      '2,"未平倉","2025-01-02","2025-01-20",1000,12.345,15.125,-250.75,-2.031\r\n',
    )
  })

  it('避免文字欄位成為試算表公式，並正規化檔名', () => {
    const csv = buildTradesCsv([
      { ...closedTrade, entryDate: '\t=HYPERLINK("https://example.test")' },
    ])

    expect(csv).toContain('"\'=HYPERLINK(""https://example.test"")"')
    expect(
      tradeCsvFileName('../0050', '2025-01-01', '2025-12-31', 'task'),
    ).toBe('backtest-0050-2025-01-01-2025-12-31-task-trades.csv')
  })
})
