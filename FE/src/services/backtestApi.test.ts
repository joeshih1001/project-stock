import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  ApiRequestError,
  ApiResponseError,
  HttpError,
  cancelBacktest,
  createBacktest,
  getBacktestResult,
  getBacktestTask,
  listMarketData,
  listStrategies,
  waitForBacktestTask,
  type RunBacktestRequest,
} from './backtestApi'

const taskId = '11111111-1111-4111-8111-111111111111'
const dataVersion = 'a'.repeat(64)

const request: RunBacktestRequest = {
  symbol: '0050',
  from: '2020-01-01',
  to: '2024-12-31',
  strategy: 'ma-trend',
  maPeriod: 60,
  initialCapital: 100000,
  allocation: 0.5,
  feeRate: 0.001,
  slippageRate: 0.0005,
  maxDrawdownWarningPct: 20,
}

const strategyResponse = [
  {
    key: 'ma-trend',
    name: 'MA 趨勢策略',
    description: '收盤價高於移動平均線時進場。',
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
    from: '2019-09-01',
    to: '2024-12-31',
    rows: 1300,
    fetchedAt: '2026-09-30T08:00:00.000Z',
  },
]

const makeTask = (
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled',
) => {
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
    request,
    createdAt: '2026-09-30T08:00:00.000Z',
    updatedAt: '2026-09-30T08:00:01.000Z',
    ...(status === 'queued' ? {} : { startedAt: '2026-09-30T08:00:00.500Z' }),
    ...(status === 'running' || status === 'queued'
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
    description: '收盤價高於移動平均線時進場。',
  },
  config: {
    symbol: '0050',
    from: '2020-01-01',
    to: '2024-12-31',
    initialCash: 100000,
    maPeriod: 60,
    allocation: 0.5,
    feeRate: 0.001,
    slippageRate: 0.0005,
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
    fileFirstDate: '2019-09-01',
    fileLastDate: '2024-12-31',
    firstDate: '2020-01-02',
    lastDate: '2024-12-31',
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
    annualizedReturnPct: 1.56,
    maxDrawdownPct: 4.2,
    totalFees: 100,
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
      date: '2020-01-02',
      cash: 100000,
      marketValue: 0,
      equity: 100000,
      positionShares: 0,
      close: 90,
      movingAverage: null,
      drawdownPct: 0,
    },
    {
      date: '2024-12-31',
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
  warnings: ['測試提醒'],
}

const fetchMock = vi.fn<typeof fetch>()

describe('backtestApi', () => {
  beforeEach(() => {
    fetchMock.mockReset()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
  })

  it('載入策略並將 AbortSignal 傳給 fetch', async () => {
    const controller = new AbortController()
    fetchMock.mockResolvedValue(jsonResponse(strategyResponse))

    await expect(listStrategies(controller.signal)).resolves.toEqual(
      strategyResponse,
    )
    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:5500/api/strategies',
      {
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      },
    )
  })

  it('從設定的 API base URL 載入行情清單', async () => {
    vi.stubEnv('VITE_API_BASE_URL', 'https://backtest.example.test/root/')
    fetchMock.mockResolvedValue(jsonResponse(marketDataResponse))

    await expect(listMarketData()).resolves.toEqual(marketDataResponse)
    expect(fetchMock).toHaveBeenCalledWith(
      'https://backtest.example.test/root/api/market-data',
      { method: 'GET', headers: { Accept: 'application/json' } },
    )
  })

  it('以完整欄位建立非同步任務', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(makeTask('queued'), 202, 'Accepted'),
    )

    await expect(createBacktest(request)).resolves.toMatchObject({
      id: taskId,
      status: 'queued',
    })
    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:5500/api/backtests',
      {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(request),
      },
    )
  })

  it('輪詢任務直到成功並回報每次狀態', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(makeTask('running')))
      .mockResolvedValueOnce(jsonResponse(makeTask('succeeded')))
    const onUpdate = vi.fn()

    await expect(
      waitForBacktestTask(taskId, { pollIntervalMs: 0, onUpdate }),
    ).resolves.toMatchObject({ status: 'succeeded', resultAvailable: true })
    expect(onUpdate).toHaveBeenCalledTimes(2)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('讀取任務、結果並可取消任務', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(makeTask('running')))
      .mockResolvedValueOnce(jsonResponse(resultResponse))
      .mockResolvedValueOnce(jsonResponse(makeTask('cancelled')))

    await expect(getBacktestTask(taskId)).resolves.toMatchObject({
      status: 'running',
    })
    await expect(getBacktestResult(taskId)).resolves.toEqual(resultResponse)
    await expect(cancelBacktest(taskId)).resolves.toMatchObject({
      status: 'cancelled',
    })
    expect(fetchMock.mock.calls[2]).toEqual([
      `http://localhost:5500/api/backtests/${taskId}`,
      { method: 'DELETE', headers: { Accept: 'application/json' } },
    ])
  })

  it('將後端錯誤內容保留在 HttpError', async () => {
    const body = {
      statusCode: 400,
      error: 'Bad Request',
      message: ['from 不得晚於 to', 'feeRate 超出範圍'],
    }
    fetchMock.mockResolvedValue(jsonResponse(body, 400, 'Bad Request'))

    const error: unknown = await listStrategies().catch(
      (reason: unknown) => reason,
    )

    expect(error).toBeInstanceOf(HttpError)
    expect(error).toMatchObject({ status: 400, method: 'GET', body })
    expect((error as Error).message).toContain(
      'from 不得晚於 to；feeRate 超出範圍',
    )
  })

  it('拒絕不符合策略 schema 的成功回應', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse([
        { ...strategyResponse[0], defaultParams: { maPeriod: '60' } },
      ]),
    )

    const error: unknown = await listStrategies().catch(
      (reason: unknown) => reason,
    )

    expect(error).toBeInstanceOf(ApiResponseError)
    expect(error).toMatchObject({
      endpoint: 'GET /api/strategies',
      path: '$[0].defaultParams.maPeriod',
    })
  })

  it('拒絕結果統計與資產曲線長度不一致的回應', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        ...resultResponse,
        metrics: { ...resultResponse.metrics, equityPoints: 3 },
      }),
    )

    const error: unknown = await getBacktestResult(taskId).catch(
      (reason: unknown) => reason,
    )

    expect(error).toBeInstanceOf(ApiResponseError)
    expect(error).toMatchObject({
      endpoint: `GET /api/backtests/${taskId}/result`,
      path: '$.equityCurve',
    })
  })

  it('送出前拒絕日期顛倒的請求', async () => {
    const error: unknown = await createBacktest({
      ...request,
      from: '2024-12-31',
      to: '2024-01-01',
    }).catch((reason: unknown) => reason)

    expect(error).toBeInstanceOf(ApiRequestError)
    expect(error).toMatchObject({
      endpoint: 'POST /api/backtests',
      path: '$.from',
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('在輪詢等待期間支援取消', async () => {
    fetchMock.mockResolvedValue(jsonResponse(makeTask('running')))
    const controller = new AbortController()
    const promise = waitForBacktestTask(taskId, {
      signal: controller.signal,
      pollIntervalMs: 10000,
    })

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce())
    controller.abort()

    await expect(promise).rejects.toMatchObject({ name: 'AbortError' })
  })
})

const jsonResponse = (
  body: unknown,
  status = 200,
  statusText = 'OK',
): Response => {
  return new Response(JSON.stringify(body), {
    status,
    statusText,
    headers: { 'Content-Type': 'application/json' },
  })
}
