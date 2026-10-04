import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { App } from './App'

const taskId = '11111111-1111-4111-8111-111111111111'
const dataVersion = 'a'.repeat(64)
const defaultRequest = {
  symbol: '0050',
  from: '2018-01-01',
  to: '2025-12-31',
  strategy: 'ma-trend',
  maPeriod: 60,
  initialCapital: 100000,
  allocation: 0.5,
  feeRate: 0,
  slippageRate: 0,
  maxDrawdownWarningPct: 20,
}

const strategiesResponse = [
  {
    key: 'ma-trend',
    name: 'MA 趨勢策略',
    description: '收盤價高於移動平均線時進場，跌回均線時離場。',
    version: '1.0.0',
    defaultParams: { maPeriod: 60, allocation: 0.5 },
  },
]

const marketDataResponse = [
  {
    symbol: '0050',
    sourceSymbol: '0050.TW',
    dataVersion,
    source: 'yahoo-finance2',
    adjustmentMode: 'adjclose-ratio',
    volumeUnit: 'shares',
    from: '2017-09-01',
    to: '2025-12-31',
    rows: 1300,
    fetchedAt: '2026-09-30T08:00:00.000Z',
  },
]

function makeTask(status: 'queued' | 'running' | 'succeeded' | 'cancelled') {
  return {
    schemaVersion: 1,
    id: taskId,
    status,
    phase:
      status === 'queued'
        ? 'queued'
        : status === 'running'
          ? 'running-python'
          : 'complete',
    request: defaultRequest,
    createdAt: '2026-09-30T08:00:00.000Z',
    updatedAt: '2026-09-30T08:00:01.000Z',
    ...(status === 'queued' ? {} : { startedAt: '2026-09-30T08:00:00.500Z' }),
    ...(status === 'queued' || status === 'running'
      ? {}
      : { completedAt: '2026-09-30T08:00:01.000Z' }),
    resultAvailable: status === 'succeeded',
    links: {
      self: `/api/backtests/${taskId}`,
      result: `/api/backtests/${taskId}/result`,
    },
  }
}

const resultResponse = {
  schemaVersion: 1,
  symbol: '0050',
  engine: {
    name: 'stdlib-ma-backtester',
    version: '1.0.0',
    language: 'python',
    pythonVersion: '3.12.10',
    endOfPeriodPolicy: 'MARK_TO_MARKET',
  },
  strategy: {
    key: 'ma-trend',
    name: 'MA 趨勢策略',
    version: '1.0.0',
    params: { maPeriod: 60 },
    description: '收盤價高於移動平均線時進場，跌回均線時離場。',
  },
  config: {
    symbol: '0050',
    from: '2018-01-01',
    to: '2025-12-31',
    initialCash: 100000,
    maPeriod: 60,
    allocation: 0.5,
    feeRate: 0,
    slippageRate: 0,
    maxDrawdownWarningPct: 20,
    signalTiming: 'CLOSE',
    executionTiming: 'NEXT_TRADING_DAY_OPEN',
    shareSizing: 'WHOLE_SHARES',
    endOfPeriodPolicy: 'MARK_TO_MARKET',
  },
  data: {
    fileName: '0050_TW.csv',
    symbol: '0050',
    source: 'yahoo-finance2',
    version: dataVersion,
    sha256: dataVersion,
    adjustment: 'adjclose-ratio',
    volumeUnit: 'shares',
    rowsInFile: 1300,
    rowsInRange: 2,
    warmupRows: 60,
    fileFirstDate: '2017-09-01',
    fileLastDate: '2025-12-31',
    firstDate: '2018-01-02',
    lastDate: '2025-12-31',
  },
  metrics: {
    initialCash: 100000,
    finalCash: 108000,
    finalMarketValue: 0,
    finalEquity: 108000,
    totalPnl: 8000,
    realizedPnl: 8000,
    unrealizedPnl: 0,
    totalReturnPct: 8,
    annualizedReturnPct: 0.97,
    maxDrawdownPct: 4.2,
    totalFees: 0,
    totalTrades: 0,
    closedTrades: 0,
    openTrades: 0,
    winningTrades: 0,
    losingTrades: 0,
    winRatePct: null,
    profitFactor: null,
    exposurePct: 42,
    equityPoints: 2,
  },
  equityCurve: [
    {
      date: '2018-01-02',
      cash: 100000,
      marketValue: 0,
      equity: 100000,
      positionShares: 0,
      close: 82,
      movingAverage: null,
      drawdownPct: 0,
    },
    {
      date: '2025-12-31',
      cash: 108000,
      marketValue: 0,
      equity: 108000,
      positionShares: 0,
      close: 190,
      movingAverage: 185,
      drawdownPct: 0,
    },
  ],
  trades: [],
  warnings: ['此結果僅供測試。'],
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function getRequestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.toString()
  return input.url
}

function installApiMock(
  options: { keepRunning?: boolean; trades?: unknown[] } = {},
) {
  const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
    const url = getRequestUrl(input)
    const method = init?.method ?? 'GET'

    if (url.endsWith('/api/strategies')) return jsonResponse(strategiesResponse)
    if (url.endsWith('/api/market-data'))
      return jsonResponse(marketDataResponse)
    if (url.endsWith('/api/backtests') && method === 'POST') {
      return jsonResponse(makeTask('queued'), 202)
    }
    if (url.endsWith(`/api/backtests/${taskId}/result`)) {
      return jsonResponse({
        ...resultResponse,
        metrics: {
          ...resultResponse.metrics,
          totalTrades: options.trades?.length ?? 0,
          closedTrades: options.trades?.length ?? 0,
        },
        trades: options.trades ?? resultResponse.trades,
      })
    }
    if (url.endsWith(`/api/backtests/${taskId}`) && method === 'DELETE') {
      return jsonResponse(makeTask('cancelled'))
    }
    if (url.endsWith(`/api/backtests/${taskId}`)) {
      return jsonResponse(
        makeTask(options.keepRunning ? 'running' : 'succeeded'),
      )
    }

    return jsonResponse({ message: 'Not found' }, 404)
  })

  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('App', () => {
  it('載入策略、行情資訊與後端預設參數', async () => {
    installApiMock()
    render(<App />)

    expect(
      screen.getByRole('heading', { name: '台股策略回測' }),
    ).toBeInTheDocument()
    expect(
      await screen.findByRole('option', { name: 'MA 趨勢策略' }),
    ).toBeInTheDocument()
    expect(screen.getByLabelText('台股代號')).toHaveValue('0050')
    expect(screen.getByLabelText('均線週期（交易日）')).toHaveValue(60)
    expect(screen.getByLabelText('每次投入比例')).toHaveValue(50)
    expect(await screen.findByText(/共 1,300 根日 K/)).toBeInTheDocument()
  })

  it('建立任務、輪詢狀態並顯示 Python 回測結果', async () => {
    const fetchMock = installApiMock()
    const user = userEvent.setup()
    render(<App />)

    await screen.findByRole('option', { name: 'MA 趨勢策略' })
    await user.click(screen.getByRole('button', { name: /建立回測任務/ }))

    expect(
      await screen.findByRole('heading', { name: '0050 回測結果' }),
    ).toBeInTheDocument()
    expect(screen.getByText('+8%')).toBeInTheDocument()
    expect(
      screen.getByRole('img', { name: /每日權益曲線/ }),
    ).toBeInTheDocument()
    expect(screen.getByText('這段期間沒有產生交易。')).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: '下載交易明細 CSV' }),
    ).toBeDisabled()

    await waitFor(() => {
      const postCall = fetchMock.mock.calls.find(
        ([input, init]) =>
          getRequestUrl(input).endsWith('/api/backtests') &&
          init?.method === 'POST',
      )
      expect(postCall).toBeDefined()
      expect(JSON.parse(String(postCall?.[1]?.body))).toEqual(defaultRequest)
      expect(
        fetchMock.mock.calls.some(([input]) =>
          getRequestUrl(input).endsWith(`/api/backtests/${taskId}/result`),
        ),
      ).toBe(true)
    })
  })

  it('有交易時可下載 CSV，檔名含回測識別資訊', async () => {
    const trade = {
      tradeId: 1,
      status: 'CLOSED',
      shares: 1000,
      entrySignalDate: '2025-01-01',
      entryDate: '2025-01-02',
      entryPrice: 50,
      entryGross: 50000,
      entryFee: 0,
      entryCashOutflow: 50000,
      exitSignalDate: '2025-01-09',
      exitDate: '2025-01-10',
      exitPrice: 55,
      exitGross: 55000,
      exitFee: 0,
      exitCashInflow: 55000,
      grossPnl: 5000,
      netPnl: 5000,
      returnPct: 10,
      holdingTradingDays: 7,
      holdingCalendarDays: 8,
      exitReason: 'STRATEGY_SIGNAL',
      markDate: null,
      markPrice: null,
      unrealizedPnl: null,
      unrealizedReturnPct: null,
    }
    installApiMock({ trades: [trade] })
    const createObjectURL = vi.fn((blob: Blob) => {
      if (!(blob instanceof Blob)) throw new Error('Expected a CSV Blob')
      return 'blob:backtest-trades'
    })
    const revokeObjectURL = vi.fn()
    vi.stubGlobal(
      'URL',
      class extends URL {
        static createObjectURL = createObjectURL
        static revokeObjectURL = revokeObjectURL
      },
    )
    let downloadedFileName = ''
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      downloadedFileName = this.download
    })
    const user = userEvent.setup()
    render(<App />)

    await screen.findByRole('option', { name: 'MA 趨勢策略' })
    await user.click(screen.getByRole('button', { name: /建立回測任務/ }))
    await screen.findByRole('heading', { name: '0050 回測結果' })
    await user.click(screen.getByRole('button', { name: '下載交易明細 CSV' }))

    expect(createObjectURL).toHaveBeenCalledOnce()
    expect(createObjectURL.mock.calls[0][0].type).toBe('text/csv;charset=utf-8')
    expect(downloadedFileName).toBe(
      `backtest-0050-2018-01-01-2025-12-31-${taskId}-trades.csv`,
    )
  })

  it('可取消執行中的任務', async () => {
    const fetchMock = installApiMock({ keepRunning: true })
    const user = userEvent.setup()
    render(<App />)

    await screen.findByRole('option', { name: 'MA 趨勢策略' })
    await user.click(screen.getByRole('button', { name: /建立回測任務/ }))
    await screen.findByText('Python 正在執行回測')
    await user.click(screen.getByRole('button', { name: '取消任務' }))

    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(
          ([input, init]) =>
            getRequestUrl(input).endsWith(`/api/backtests/${taskId}`) &&
            init?.method === 'DELETE',
        ),
      ).toBe(true)
    })
    await waitFor(() => {
      expect(
        screen.getAllByRole('heading').map((heading) => heading.textContent),
      ).toContain('回測任務已取消')
    })
  })

  it('股票代號空白時不送出任務', async () => {
    const fetchMock = installApiMock()
    const user = userEvent.setup()
    render(<App />)

    const symbolInput = await screen.findByLabelText('台股代號')
    await user.clear(symbolInput)
    await user.click(screen.getByRole('button', { name: /建立回測任務/ }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      '請輸入股票代號。',
    )
    expect(symbolInput).toHaveAttribute('aria-invalid', 'true')
    expect(
      fetchMock.mock.calls.some(
        ([input, init]) =>
          getRequestUrl(input).endsWith('/api/backtests') &&
          init?.method === 'POST',
      ),
    ).toBe(false)
  })
})
