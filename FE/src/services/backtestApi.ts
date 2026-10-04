const DEFAULT_API_BASE_URL = 'http://localhost:5500'

const STRATEGIES_PATH = '/api/strategies'
const MARKET_DATA_PATH = '/api/market-data'
const BACKTESTS_PATH = '/api/backtests'

type HttpMethod = 'GET' | 'POST' | 'DELETE'
type JsonRecord = Record<string, unknown>

interface ValidationContext {
  readonly endpoint: string
  readonly source: 'request' | 'response'
}

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

/** HTTP 非成功狀態；保留 status 與 response body 供畫面判斷。 */
export class HttpError extends Error {
  override readonly name = 'HttpError'

  constructor(
    public readonly status: number,
    public readonly statusText: string,
    public readonly method: HttpMethod,
    public readonly url: string,
    public readonly body: unknown,
  ) {
    super(createHttpErrorMessage(status, statusText, method, url, body))
  }
}

/** 成功回應不是前端已知 schema 時拋出，避免不可信資料進入 UI。 */
export class ApiResponseError extends Error {
  override readonly name = 'ApiResponseError'

  constructor(
    public readonly endpoint: string,
    public readonly path: string,
    expected: string,
  ) {
    super(`${endpoint} 回應格式錯誤：${path} 應為${expected}`)
  }
}

/** 呼叫端在 runtime 傳入不合法資料時拋出。 */
export class ApiRequestError extends Error {
  override readonly name = 'ApiRequestError'

  constructor(
    public readonly endpoint: string,
    public readonly path: string,
    expected: string,
  ) {
    super(`${endpoint} 請求格式錯誤：${path} 應為${expected}`)
  }
}

export async function listStrategies(
  signal?: AbortSignal,
): Promise<StrategyOption[]> {
  return requestJson(
    'GET',
    STRATEGIES_PATH,
    signal,
    undefined,
    decodeStrategies,
  )
}

export async function listMarketData(
  signal?: AbortSignal,
): Promise<MarketDataEntry[]> {
  return requestJson(
    'GET',
    MARKET_DATA_PATH,
    signal,
    undefined,
    decodeMarketData,
  )
}

export async function createBacktest(
  request: RunBacktestRequest,
  signal?: AbortSignal,
): Promise<BacktestTask> {
  const payload = decodeRunBacktestRequest(request)
  return requestJson('POST', BACKTESTS_PATH, signal, payload, (value) =>
    decodeBacktestTask(value, `POST ${BACKTESTS_PATH}`),
  )
}

export async function getBacktestTask(
  taskId: string,
  signal?: AbortSignal,
): Promise<BacktestTask> {
  const id = normalizeTaskId(taskId)
  const path = `${BACKTESTS_PATH}/${id}`
  return requestJson('GET', path, signal, undefined, (value) =>
    decodeBacktestTask(value, `GET ${path}`),
  )
}

export async function getBacktestResult(
  taskId: string,
  signal?: AbortSignal,
): Promise<BacktestResult> {
  const id = normalizeTaskId(taskId)
  const path = `${BACKTESTS_PATH}/${id}/result`
  return requestJson('GET', path, signal, undefined, (value) =>
    decodeBacktestResult(value, `GET ${path}`),
  )
}

export async function cancelBacktest(
  taskId: string,
  signal?: AbortSignal,
): Promise<BacktestTask> {
  const id = normalizeTaskId(taskId)
  const path = `${BACKTESTS_PATH}/${id}`
  return requestJson('DELETE', path, signal, undefined, (value) =>
    decodeBacktestTask(value, `DELETE ${path}`),
  )
}

/** 輪詢至 terminal status；AbortSignal 同時中止 HTTP 與等待計時器。 */
export async function waitForBacktestTask(
  taskId: string,
  options: WaitForTaskOptions = {},
): Promise<BacktestTask> {
  const interval = options.pollIntervalMs ?? 1000
  if (!Number.isFinite(interval) || interval < 0) {
    throw new ApiRequestError(
      `GET ${BACKTESTS_PATH}/:id`,
      '$.pollIntervalMs',
      '非負有限數字',
    )
  }

  while (true) {
    const task = await getBacktestTask(taskId, options.signal)
    options.onUpdate?.(task)
    if (
      task.status === 'succeeded' ||
      task.status === 'failed' ||
      task.status === 'cancelled'
    ) {
      return task
    }
    await delay(interval, options.signal)
  }
}

async function requestJson<T>(
  method: HttpMethod,
  path: string,
  signal: AbortSignal | undefined,
  body: JsonRecord | undefined,
  decode: (value: unknown) => T,
): Promise<T> {
  const url = `${getApiBaseUrl()}${path}`
  const response = await fetch(url, {
    method,
    headers: {
      Accept: 'application/json',
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    ...(signal === undefined ? {} : { signal }),
  })
  const responseBody = await readResponseBody(response)

  if (!response.ok) {
    throw new HttpError(
      response.status,
      response.statusText,
      method,
      url,
      responseBody,
    )
  }
  return decode(responseBody)
}

function getApiBaseUrl(): string {
  const configuredBaseUrl = import.meta.env.VITE_API_BASE_URL?.trim()
  return (configuredBaseUrl || DEFAULT_API_BASE_URL).replace(/\/+$/, '')
}

async function readResponseBody(response: Response): Promise<unknown> {
  const text = await response.text()
  if (text.length === 0) return undefined
  try {
    return JSON.parse(text) as unknown
  } catch {
    return text
  }
}

function createHttpErrorMessage(
  status: number,
  statusText: string,
  method: HttpMethod,
  url: string,
  body: unknown,
): string {
  const detail = getServerErrorMessage(body)
  const statusLabel = statusText ? `${status} ${statusText}` : String(status)
  return `${method} ${url} 失敗（${statusLabel}）${detail ? `：${detail}` : ''}`
}

function getServerErrorMessage(body: unknown): string | undefined {
  if (typeof body === 'string') return body || undefined
  if (!isRecord(body)) return undefined
  if (typeof body.message === 'string') return body.message
  if (
    Array.isArray(body.message) &&
    body.message.every((item) => typeof item === 'string')
  ) {
    return body.message.join('；')
  }
  return typeof body.error === 'string' ? body.error : undefined
}

function decodeStrategies(value: unknown): StrategyOption[] {
  const context = responseContext(`GET ${STRATEGIES_PATH}`)
  return readArray(value, '$', context).map((item, index) => {
    const path = `$[${index}]`
    const record = readRecord(item, path, context)
    return {
      key: readNonEmptyString(record.key, `${path}.key`, context),
      name: readNonEmptyString(record.name, `${path}.name`, context),
      description: readString(
        record.description,
        `${path}.description`,
        context,
      ),
      version: readNonEmptyString(record.version, `${path}.version`, context),
      defaultParams: readNumberRecord(
        record.defaultParams,
        `${path}.defaultParams`,
        context,
      ),
    }
  })
}

function decodeMarketData(value: unknown): MarketDataEntry[] {
  const context = responseContext(`GET ${MARKET_DATA_PATH}`)
  return readArray(value, '$', context).map((item, index) =>
    decodeMarketDataEntry(item, `$[${index}]`, context),
  )
}

function decodeMarketDataEntry(
  value: unknown,
  path: string,
  context: ValidationContext,
): MarketDataEntry {
  const record = readRecord(value, path, context)
  return {
    symbol: readNonEmptyString(record.symbol, `${path}.symbol`, context),
    sourceSymbol: readNonEmptyString(
      record.sourceSymbol,
      `${path}.sourceSymbol`,
      context,
    ),
    dataVersion: readSha256(record.dataVersion, `${path}.dataVersion`, context),
    source: readNonEmptyString(record.source, `${path}.source`, context),
    adjustmentMode: readNonEmptyString(
      record.adjustmentMode,
      `${path}.adjustmentMode`,
      context,
    ),
    volumeUnit: readNonEmptyString(
      record.volumeUnit,
      `${path}.volumeUnit`,
      context,
    ),
    from: readIsoDate(record.from, `${path}.from`, context),
    to: readIsoDate(record.to, `${path}.to`, context),
    rows: readNonNegativeInteger(record.rows, `${path}.rows`, context),
    fetchedAt: readIsoTimestamp(record.fetchedAt, `${path}.fetchedAt`, context),
  }
}

function decodeRunBacktestRequest(request: RunBacktestRequest): JsonRecord {
  const context: ValidationContext = {
    endpoint: `POST ${BACKTESTS_PATH}`,
    source: 'request',
  }
  const record = readRecord(request, '$', context)
  const symbol = readNonEmptyString(record.symbol, '$.symbol', context)
    .trim()
    .toUpperCase()
  const from = readIsoDate(record.from, '$.from', context)
  const to = readIsoDate(record.to, '$.to', context)
  if (!/^[A-Z0-9^][A-Z0-9.^-]{0,19}$/.test(symbol)) {
    failValidation(context, '$.symbol', '合法的股票代號')
  }
  if (from > to) failValidation(context, '$.from', '不晚於 $.to 的日期')

  const strategy = readNonEmptyString(record.strategy, '$.strategy', context)
  const maPeriod = readIntegerInRange(
    record.maPeriod,
    '$.maPeriod',
    context,
    2,
    1000,
  )
  const initialCapital = readNumberInRange(
    record.initialCapital,
    '$.initialCapital',
    context,
    1,
    Number.MAX_VALUE,
  )
  const allocation = readNumberInRange(
    record.allocation,
    '$.allocation',
    context,
    Number.EPSILON,
    1,
  )
  const feeRate = readNumberInRange(
    record.feeRate,
    '$.feeRate',
    context,
    0,
    0.1,
  )
  const slippageRate = readNumberInRange(
    record.slippageRate,
    '$.slippageRate',
    context,
    0,
    0.1,
  )
  const maxDrawdownWarningPct = readNumberInRange(
    record.maxDrawdownWarningPct,
    '$.maxDrawdownWarningPct',
    context,
    0,
    100,
  )

  return {
    symbol,
    from,
    to,
    strategy,
    maPeriod,
    initialCapital,
    allocation,
    feeRate,
    slippageRate,
    maxDrawdownWarningPct,
  }
}

function decodeBacktestTask(value: unknown, endpoint: string): BacktestTask {
  const context = responseContext(endpoint)
  const record = readRecord(value, '$', context)
  const status = readEnum(record.status, '$.status', context, [
    'queued',
    'running',
    'succeeded',
    'failed',
    'cancelled',
  ] as const)
  const phase = readEnum(record.phase, '$.phase', context, [
    'queued',
    'preparing-data',
    'running-python',
    'complete',
  ] as const)
  const resultAvailable = readBoolean(
    record.resultAvailable,
    '$.resultAvailable',
    context,
  )
  if (resultAvailable !== (status === 'succeeded')) {
    failValidation(context, '$.resultAvailable', '與任務狀態一致的布林值')
  }

  const task: BacktestTask = {
    schemaVersion: readSchemaVersion(
      record.schemaVersion,
      '$.schemaVersion',
      context,
    ),
    id: readUuid(record.id, '$.id', context),
    status,
    phase,
    request: decodeRequestSnapshot(record.request, '$.request', context),
    createdAt: readIsoTimestamp(record.createdAt, '$.createdAt', context),
    updatedAt: readIsoTimestamp(record.updatedAt, '$.updatedAt', context),
    resultAvailable,
    links: decodeTaskLinks(record.links, '$.links', context),
  }
  if (record.startedAt !== undefined) {
    task.startedAt = readIsoTimestamp(record.startedAt, '$.startedAt', context)
  }
  if (record.completedAt !== undefined) {
    task.completedAt = readIsoTimestamp(
      record.completedAt,
      '$.completedAt',
      context,
    )
  }
  if (record.marketData !== undefined) {
    task.marketData = decodeMarketDataEntry(
      record.marketData,
      '$.marketData',
      context,
    )
  }
  if (record.error !== undefined) {
    const error = readRecord(record.error, '$.error', context)
    task.error = {
      code: readNonEmptyString(error.code, '$.error.code', context),
      message: readNonEmptyString(error.message, '$.error.message', context),
    }
  }
  return task
}

function decodeRequestSnapshot(
  value: unknown,
  path: string,
  context: ValidationContext,
): RunBacktestRequest {
  const record = readRecord(value, path, context)
  return {
    symbol: readNonEmptyString(record.symbol, `${path}.symbol`, context),
    from: readIsoDate(record.from, `${path}.from`, context),
    to: readIsoDate(record.to, `${path}.to`, context),
    strategy: readNonEmptyString(record.strategy, `${path}.strategy`, context),
    maPeriod: readIntegerInRange(
      record.maPeriod,
      `${path}.maPeriod`,
      context,
      2,
      1000,
    ),
    initialCapital: readNumberInRange(
      record.initialCapital,
      `${path}.initialCapital`,
      context,
      1,
      Number.MAX_VALUE,
    ),
    allocation: readNumberInRange(
      record.allocation,
      `${path}.allocation`,
      context,
      Number.EPSILON,
      1,
    ),
    feeRate: readNumberInRange(
      record.feeRate,
      `${path}.feeRate`,
      context,
      0,
      0.1,
    ),
    slippageRate: readNumberInRange(
      record.slippageRate,
      `${path}.slippageRate`,
      context,
      0,
      0.1,
    ),
    maxDrawdownWarningPct: readNumberInRange(
      record.maxDrawdownWarningPct,
      `${path}.maxDrawdownWarningPct`,
      context,
      0,
      100,
    ),
  }
}

function decodeTaskLinks(
  value: unknown,
  path: string,
  context: ValidationContext,
): BacktestTask['links'] {
  const record = readRecord(value, path, context)
  return {
    self: readApiPath(record.self, `${path}.self`, context),
    result: readApiPath(record.result, `${path}.result`, context),
  }
}

function decodeBacktestResult(
  value: unknown,
  endpoint: string,
): BacktestResult {
  const context = responseContext(endpoint)
  const record = readRecord(value, '$', context)
  const engineRecord = readRecord(record.engine, '$.engine', context)
  const strategyRecord = readRecord(record.strategy, '$.strategy', context)
  const configRecord = readRecord(record.config, '$.config', context)
  const dataRecord = readRecord(record.data, '$.data', context)

  const result: BacktestResult = {
    schemaVersion: readSchemaVersion(
      record.schemaVersion,
      '$.schemaVersion',
      context,
    ),
    symbol: readNonEmptyString(record.symbol, '$.symbol', context),
    engine: {
      name: readNonEmptyString(engineRecord.name, '$.engine.name', context),
      version: readNonEmptyString(
        engineRecord.version,
        '$.engine.version',
        context,
      ),
      language: readEnum(engineRecord.language, '$.engine.language', context, [
        'python',
      ] as const),
      pythonVersion: readNonEmptyString(
        engineRecord.pythonVersion,
        '$.engine.pythonVersion',
        context,
      ),
      endOfPeriodPolicy: readEnum(
        engineRecord.endOfPeriodPolicy,
        '$.engine.endOfPeriodPolicy',
        context,
        ['MARK_TO_MARKET'] as const,
      ),
    },
    strategy: {
      key: readNonEmptyString(strategyRecord.key, '$.strategy.key', context),
      name: readNonEmptyString(strategyRecord.name, '$.strategy.name', context),
      version: readNonEmptyString(
        strategyRecord.version,
        '$.strategy.version',
        context,
      ),
      params: readNumberRecord(
        strategyRecord.params,
        '$.strategy.params',
        context,
      ),
      description: readString(
        strategyRecord.description,
        '$.strategy.description',
        context,
      ),
    },
    config: decodeBacktestConfig(configRecord, context),
    data: decodeBacktestData(dataRecord, context),
    metrics: decodeBacktestMetrics(record.metrics, context),
    equityCurve: decodeEquityCurve(record.equityCurve, context),
    trades: decodeBacktestTrades(record.trades, context),
    warnings: readStringArray(record.warnings, '$.warnings', context),
  }

  if (
    result.equityCurve.length !== result.data.rowsInRange ||
    result.equityCurve.length !== result.metrics.equityPoints
  ) {
    failValidation(
      context,
      '$.equityCurve',
      '長度與資料範圍及績效統計一致的陣列',
    )
  }
  if (result.trades.length !== result.metrics.totalTrades) {
    failValidation(context, '$.trades', '長度與 metrics.totalTrades 一致的陣列')
  }
  return result
}

function decodeBacktestConfig(
  record: JsonRecord,
  context: ValidationContext,
): BacktestConfig {
  return {
    symbol: readNonEmptyString(record.symbol, '$.config.symbol', context),
    from: readIsoDate(record.from, '$.config.from', context),
    to: readIsoDate(record.to, '$.config.to', context),
    initialCash: readFiniteNumber(
      record.initialCash,
      '$.config.initialCash',
      context,
    ),
    maPeriod: readPositiveInteger(
      record.maPeriod,
      '$.config.maPeriod',
      context,
    ),
    allocation: readFiniteNumber(
      record.allocation,
      '$.config.allocation',
      context,
    ),
    feeRate: readFiniteNumber(record.feeRate, '$.config.feeRate', context),
    slippageRate: readFiniteNumber(
      record.slippageRate,
      '$.config.slippageRate',
      context,
    ),
    maxDrawdownWarningPct: readFiniteNumber(
      record.maxDrawdownWarningPct,
      '$.config.maxDrawdownWarningPct',
      context,
    ),
    signalTiming: readEnum(
      record.signalTiming,
      '$.config.signalTiming',
      context,
      ['CLOSE'] as const,
    ),
    executionTiming: readEnum(
      record.executionTiming,
      '$.config.executionTiming',
      context,
      ['NEXT_TRADING_DAY_OPEN'] as const,
    ),
    shareSizing: readEnum(record.shareSizing, '$.config.shareSizing', context, [
      'WHOLE_SHARES',
    ] as const),
    endOfPeriodPolicy: readEnum(
      record.endOfPeriodPolicy,
      '$.config.endOfPeriodPolicy',
      context,
      ['MARK_TO_MARKET'] as const,
    ),
  }
}

function decodeBacktestData(
  record: JsonRecord,
  context: ValidationContext,
): BacktestData {
  return {
    fileName: readFileName(record.fileName, '$.data.fileName', context),
    symbol: readNonEmptyString(record.symbol, '$.data.symbol', context),
    source: readNonEmptyString(record.source, '$.data.source', context),
    version: readNonEmptyString(record.version, '$.data.version', context),
    sha256: readSha256(record.sha256, '$.data.sha256', context),
    adjustment: readNonEmptyString(
      record.adjustment,
      '$.data.adjustment',
      context,
    ),
    volumeUnit: readNonEmptyString(
      record.volumeUnit,
      '$.data.volumeUnit',
      context,
    ),
    rowsInFile: readNonNegativeInteger(
      record.rowsInFile,
      '$.data.rowsInFile',
      context,
    ),
    rowsInRange: readPositiveInteger(
      record.rowsInRange,
      '$.data.rowsInRange',
      context,
    ),
    warmupRows: readNonNegativeInteger(
      record.warmupRows,
      '$.data.warmupRows',
      context,
    ),
    fileFirstDate: readIsoDate(
      record.fileFirstDate,
      '$.data.fileFirstDate',
      context,
    ),
    fileLastDate: readIsoDate(
      record.fileLastDate,
      '$.data.fileLastDate',
      context,
    ),
    firstDate: readIsoDate(record.firstDate, '$.data.firstDate', context),
    lastDate: readIsoDate(record.lastDate, '$.data.lastDate', context),
  }
}

function decodeBacktestMetrics(
  value: unknown,
  context: ValidationContext,
): BacktestMetrics {
  const path = '$.metrics'
  const record = readRecord(value, path, context)
  return {
    initialCash: readFiniteNumber(
      record.initialCash,
      `${path}.initialCash`,
      context,
    ),
    finalCash: readFiniteNumber(record.finalCash, `${path}.finalCash`, context),
    finalMarketValue: readFiniteNumber(
      record.finalMarketValue,
      `${path}.finalMarketValue`,
      context,
    ),
    finalEquity: readFiniteNumber(
      record.finalEquity,
      `${path}.finalEquity`,
      context,
    ),
    totalPnl: readFiniteNumber(record.totalPnl, `${path}.totalPnl`, context),
    realizedPnl: readFiniteNumber(
      record.realizedPnl,
      `${path}.realizedPnl`,
      context,
    ),
    unrealizedPnl: readFiniteNumber(
      record.unrealizedPnl,
      `${path}.unrealizedPnl`,
      context,
    ),
    totalReturnPct: readFiniteNumber(
      record.totalReturnPct,
      `${path}.totalReturnPct`,
      context,
    ),
    annualizedReturnPct: readNullableFiniteNumber(
      record.annualizedReturnPct,
      `${path}.annualizedReturnPct`,
      context,
    ),
    maxDrawdownPct: readFiniteNumber(
      record.maxDrawdownPct,
      `${path}.maxDrawdownPct`,
      context,
    ),
    totalFees: readFiniteNumber(record.totalFees, `${path}.totalFees`, context),
    totalTrades: readNonNegativeInteger(
      record.totalTrades,
      `${path}.totalTrades`,
      context,
    ),
    closedTrades: readNonNegativeInteger(
      record.closedTrades,
      `${path}.closedTrades`,
      context,
    ),
    openTrades: readNonNegativeInteger(
      record.openTrades,
      `${path}.openTrades`,
      context,
    ),
    winningTrades: readNonNegativeInteger(
      record.winningTrades,
      `${path}.winningTrades`,
      context,
    ),
    losingTrades: readNonNegativeInteger(
      record.losingTrades,
      `${path}.losingTrades`,
      context,
    ),
    winRatePct: readNullableFiniteNumber(
      record.winRatePct,
      `${path}.winRatePct`,
      context,
    ),
    profitFactor: readNullableFiniteNumber(
      record.profitFactor,
      `${path}.profitFactor`,
      context,
    ),
    exposurePct: readFiniteNumber(
      record.exposurePct,
      `${path}.exposurePct`,
      context,
    ),
    equityPoints: readPositiveInteger(
      record.equityPoints,
      `${path}.equityPoints`,
      context,
    ),
  }
}

function decodeEquityCurve(
  value: unknown,
  context: ValidationContext,
): BacktestEquityPoint[] {
  let previousDate: string | null = null
  return readArray(value, '$.equityCurve', context).map((item, index) => {
    const path = `$.equityCurve[${index}]`
    const record = readRecord(item, path, context)
    const date = readIsoDate(record.date, `${path}.date`, context)
    if (previousDate !== null && date <= previousDate) {
      failValidation(context, `${path}.date`, '嚴格遞增且不重複的日期')
    }
    previousDate = date
    return {
      date,
      cash: readFiniteNumber(record.cash, `${path}.cash`, context),
      marketValue: readFiniteNumber(
        record.marketValue,
        `${path}.marketValue`,
        context,
      ),
      equity: readFiniteNumber(record.equity, `${path}.equity`, context),
      positionShares: readNonNegativeInteger(
        record.positionShares,
        `${path}.positionShares`,
        context,
      ),
      close: readFiniteNumber(record.close, `${path}.close`, context),
      movingAverage: readNullableFiniteNumber(
        record.movingAverage,
        `${path}.movingAverage`,
        context,
      ),
      drawdownPct: readFiniteNumber(
        record.drawdownPct,
        `${path}.drawdownPct`,
        context,
      ),
    }
  })
}

function decodeBacktestTrades(
  value: unknown,
  context: ValidationContext,
): BacktestTrade[] {
  return readArray(value, '$.trades', context).map((item, index) => {
    const path = `$.trades[${index}]`
    const record = readRecord(item, path, context)
    return {
      tradeId: readPositiveInteger(record.tradeId, `${path}.tradeId`, context),
      status: readEnum(record.status, `${path}.status`, context, [
        'OPEN',
        'CLOSED',
      ] as const),
      shares: readPositiveInteger(record.shares, `${path}.shares`, context),
      entrySignalDate: readIsoDate(
        record.entrySignalDate,
        `${path}.entrySignalDate`,
        context,
      ),
      entryDate: readIsoDate(record.entryDate, `${path}.entryDate`, context),
      entryPrice: readFiniteNumber(
        record.entryPrice,
        `${path}.entryPrice`,
        context,
      ),
      entryGross: readFiniteNumber(
        record.entryGross,
        `${path}.entryGross`,
        context,
      ),
      entryFee: readFiniteNumber(record.entryFee, `${path}.entryFee`, context),
      entryCashOutflow: readFiniteNumber(
        record.entryCashOutflow,
        `${path}.entryCashOutflow`,
        context,
      ),
      exitSignalDate: readNullableIsoDate(
        record.exitSignalDate,
        `${path}.exitSignalDate`,
        context,
      ),
      exitDate: readNullableIsoDate(
        record.exitDate,
        `${path}.exitDate`,
        context,
      ),
      exitPrice: readNullableFiniteNumber(
        record.exitPrice,
        `${path}.exitPrice`,
        context,
      ),
      exitGross: readNullableFiniteNumber(
        record.exitGross,
        `${path}.exitGross`,
        context,
      ),
      exitFee: readNullableFiniteNumber(
        record.exitFee,
        `${path}.exitFee`,
        context,
      ),
      exitCashInflow: readNullableFiniteNumber(
        record.exitCashInflow,
        `${path}.exitCashInflow`,
        context,
      ),
      grossPnl: readNullableFiniteNumber(
        record.grossPnl,
        `${path}.grossPnl`,
        context,
      ),
      netPnl: readNullableFiniteNumber(
        record.netPnl,
        `${path}.netPnl`,
        context,
      ),
      returnPct: readNullableFiniteNumber(
        record.returnPct,
        `${path}.returnPct`,
        context,
      ),
      holdingTradingDays: readNullableNonNegativeInteger(
        record.holdingTradingDays,
        `${path}.holdingTradingDays`,
        context,
      ),
      holdingCalendarDays: readNullableNonNegativeInteger(
        record.holdingCalendarDays,
        `${path}.holdingCalendarDays`,
        context,
      ),
      exitReason: readNullableEnum(
        record.exitReason,
        `${path}.exitReason`,
        context,
        ['STRATEGY_SIGNAL'] as const,
      ),
      markDate: readNullableIsoDate(
        record.markDate,
        `${path}.markDate`,
        context,
      ),
      markPrice: readNullableFiniteNumber(
        record.markPrice,
        `${path}.markPrice`,
        context,
      ),
      unrealizedPnl: readNullableFiniteNumber(
        record.unrealizedPnl,
        `${path}.unrealizedPnl`,
        context,
      ),
      unrealizedReturnPct: readNullableFiniteNumber(
        record.unrealizedReturnPct,
        `${path}.unrealizedReturnPct`,
        context,
      ),
    }
  })
}

function normalizeTaskId(value: string): string {
  const context: ValidationContext = {
    endpoint: `GET ${BACKTESTS_PATH}/:id`,
    source: 'request',
  }
  return readUuid(value, '$.taskId', context)
}

function responseContext(endpoint: string): ValidationContext {
  return { endpoint, source: 'response' }
}

function readRecord(
  value: unknown,
  path: string,
  context: ValidationContext,
): JsonRecord {
  if (!isRecord(value)) failValidation(context, path, '物件')
  return value
}

function readArray(
  value: unknown,
  path: string,
  context: ValidationContext,
): unknown[] {
  if (!Array.isArray(value)) failValidation(context, path, '陣列')
  return value
}

function readString(
  value: unknown,
  path: string,
  context: ValidationContext,
): string {
  if (typeof value !== 'string') failValidation(context, path, '字串')
  return value
}

function readNonEmptyString(
  value: unknown,
  path: string,
  context: ValidationContext,
): string {
  const result = readString(value, path, context)
  if (result.trim().length === 0) failValidation(context, path, '非空字串')
  return result
}

function readBoolean(
  value: unknown,
  path: string,
  context: ValidationContext,
): boolean {
  if (typeof value !== 'boolean') failValidation(context, path, '布林值')
  return value
}

function readFiniteNumber(
  value: unknown,
  path: string,
  context: ValidationContext,
): number {
  if (typeof value !== 'number' || !Number.isFinite(value))
    failValidation(context, path, '有限數字')
  return value
}

function readNullableFiniteNumber(
  value: unknown,
  path: string,
  context: ValidationContext,
): number | null {
  return value === null ? null : readFiniteNumber(value, path, context)
}

function readNonNegativeInteger(
  value: unknown,
  path: string,
  context: ValidationContext,
): number {
  const result = readFiniteNumber(value, path, context)
  if (!Number.isInteger(result) || result < 0)
    failValidation(context, path, '非負整數')
  return result
}

function readPositiveInteger(
  value: unknown,
  path: string,
  context: ValidationContext,
): number {
  const result = readFiniteNumber(value, path, context)
  if (!Number.isInteger(result) || result < 1)
    failValidation(context, path, '正整數')
  return result
}

function readNullableNonNegativeInteger(
  value: unknown,
  path: string,
  context: ValidationContext,
): number | null {
  return value === null ? null : readNonNegativeInteger(value, path, context)
}

function readNumberInRange(
  value: unknown,
  path: string,
  context: ValidationContext,
  min: number,
  max: number,
): number {
  const result = readFiniteNumber(value, path, context)
  if (result < min || result > max)
    failValidation(context, path, `${min} 到 ${max} 之間的數字`)
  return result
}

function readIntegerInRange(
  value: unknown,
  path: string,
  context: ValidationContext,
  min: number,
  max: number,
): number {
  const result = readNumberInRange(value, path, context, min, max)
  if (!Number.isInteger(result))
    failValidation(context, path, `${min} 到 ${max} 之間的整數`)
  return result
}

function readNumberRecord(
  value: unknown,
  path: string,
  context: ValidationContext,
): Record<string, number> {
  const record = readRecord(value, path, context)
  return Object.fromEntries(
    Object.entries(record).map(([key, item]) => [
      key,
      readFiniteNumber(item, `${path}.${key}`, context),
    ]),
  )
}

function readStringArray(
  value: unknown,
  path: string,
  context: ValidationContext,
): string[] {
  return readArray(value, path, context).map((item, index) =>
    readString(item, `${path}[${index}]`, context),
  )
}

function readIsoDate(
  value: unknown,
  path: string,
  context: ValidationContext,
): string {
  const result = readString(value, path, context)
  if (!isIsoDate(result))
    failValidation(context, path, '有效的 YYYY-MM-DD 日期')
  return result
}

function readNullableIsoDate(
  value: unknown,
  path: string,
  context: ValidationContext,
): string | null {
  return value === null ? null : readIsoDate(value, path, context)
}

function readIsoTimestamp(
  value: unknown,
  path: string,
  context: ValidationContext,
): string {
  const result = readString(value, path, context)
  if (
    !/(?:Z|[+-]\d{2}:\d{2})$/.test(result) ||
    Number.isNaN(Date.parse(result))
  ) {
    failValidation(context, path, '含時區 offset 的 ISO 8601 timestamp')
  }
  return result
}

function readUuid(
  value: unknown,
  path: string,
  context: ValidationContext,
): string {
  const result = readString(value, path, context)
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      result,
    )
  ) {
    failValidation(context, path, 'UUID v4')
  }
  return result
}

function readSha256(
  value: unknown,
  path: string,
  context: ValidationContext,
): string {
  const result = readString(value, path, context)
  if (!/^[a-f0-9]{64}$/.test(result))
    failValidation(context, path, '小寫 SHA-256')
  return result
}

function readFileName(
  value: unknown,
  path: string,
  context: ValidationContext,
): string {
  const result = readNonEmptyString(value, path, context)
  if (/[\\/]/.test(result)) failValidation(context, path, '不含路徑的檔名')
  return result
}

function readApiPath(
  value: unknown,
  path: string,
  context: ValidationContext,
): string {
  const result = readNonEmptyString(value, path, context)
  if (!result.startsWith('/api/'))
    failValidation(context, path, '以 /api/ 開頭的路徑')
  return result
}

function readSchemaVersion(
  value: unknown,
  path: string,
  context: ValidationContext,
): 1 {
  if (value !== 1) failValidation(context, path, '1')
  return 1
}

function readEnum<const T extends readonly string[]>(
  value: unknown,
  path: string,
  context: ValidationContext,
  values: T,
): T[number] {
  if (typeof value !== 'string' || !values.includes(value)) {
    failValidation(context, path, values.join('、'))
  }
  return value as T[number]
}

function readNullableEnum<const T extends readonly string[]>(
  value: unknown,
  path: string,
  context: ValidationContext,
  values: T,
): T[number] | null {
  return value === null ? null : readEnum(value, path, context, values)
}

function failValidation(
  context: ValidationContext,
  path: string,
  expected: string,
): never {
  if (context.source === 'request')
    throw new ApiRequestError(context.endpoint, path, expected)
  throw new ApiResponseError(context.endpoint, path, expected)
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const parsed = new Date(`${value}T00:00:00Z`)
  return (
    !Number.isNaN(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === value
  )
}

function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(createAbortError())
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, milliseconds)
    const onAbort = () => {
      window.clearTimeout(timeout)
      reject(createAbortError())
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function createAbortError(): DOMException {
  return new DOMException('The operation was aborted.', 'AbortError')
}
