import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import YahooFinance from 'yahoo-finance2';
import {
  CachedSeries,
  Candle,
  MarketDataMetadata,
  PreparedMarketData,
  PreparedMarketDataView,
} from './types';

const CACHE_TTL_MS = 12 * 60 * 60 * 1000;
const TAIPEI_TIMEZONE = 'Asia/Taipei';
const CSV_HEADER = 'Date,Open,High,Low,Close,Volume';

@Injectable()
export class MarketDataService {
  private readonly logger = new Logger(MarketDataService.name);
  private readonly yf = new YahooFinance({ suppressNotices: ['yahooSurvey'] });
  private readonly dataDir = path.resolve(
    process.env.MARKET_DATA_DIR ?? path.join(process.cwd(), 'data', 'market-data'),
  );
  private readonly symbolQueues = new Map<string, Promise<void>>();

  /**
   * 準備一份受後端控制的 CSV 給 Python。numeric 台股代號（例如 0050）會自動
   * 對應 Yahoo 的 .TW 代號；呼叫端只能傳代號，不能指定任意檔案路徑。
   */
  async prepareCsv(
    symbol: string,
    from: string,
    to: string,
    warmupBars = 0,
    forceRefresh = false,
  ): Promise<PreparedMarketData> {
    this.validateDateRange(from, to);
    if (!Number.isInteger(warmupBars) || warmupBars < 0 || warmupBars > 10_000) {
      throw new BadRequestException(`warmupBars 必須是 0~10000 的整數，收到 ${warmupBars}`);
    }

    const normalizedSymbol = this.normalizeRequestedSymbol(symbol);
    const sourceSymbol = this.toYahooSymbol(normalizedSymbol);
    const fetchFrom = this.addDays(
      from,
      -(Math.ceil(warmupBars * 1.7) + (warmupBars > 0 ? 30 : 0)),
    );

    return this.withSymbolLock(sourceSymbol, () =>
      this.prepareCsvUnlocked(
        normalizedSymbol,
        sourceSymbol,
        fetchFrom,
        to,
        forceRefresh,
      ),
    );
  }

  /** 供管理 API 顯式更新行情；回測本身也會自動呼叫 prepareCsv。 */
  async updateCsv(
    symbol: string,
    from: string,
    to: string,
  ): Promise<PreparedMarketDataView> {
    return this.toPublicPrepared(await this.prepareCsv(symbol, from, to, 0, true));
  }

  async listPrepared(): Promise<PreparedMarketDataView[]> {
    let files: string[];
    try {
      files = await fs.readdir(this.dataDir);
    } catch {
      return [];
    }

    const prepared: PreparedMarketDataView[] = [];
    for (const file of files.filter((name) => name.endsWith('.meta.json'))) {
      const metadata = await this.readMetadata(path.join(this.dataDir, file));
      if (!metadata) continue;
      const stored = await this.readStored(metadata.sourceSymbol);
      if (stored) {
        prepared.push(
          this.toPublicPrepared(this.toPrepared(metadata.sourceSymbol, stored.metadata)),
        );
      }
    }
    return prepared.sort((a, b) => a.sourceSymbol.localeCompare(b.sourceSymbol));
  }

  /** 舊 API 名稱保留為相容別名。 */
  async listCached(): Promise<
    { symbol: string; from: string; to: string; bars: number; fetchedAt: string }[]
  > {
    return (await this.listPrepared()).map((item) => ({
      symbol: item.symbol,
      from: item.from,
      to: item.to,
      bars: item.rows,
      fetchedAt: item.fetchedAt,
    }));
  }

  /** 舊 TypeScript 引擎仍可讀取同一份 CSV；正式 API 已改由 Python 執行。 */
  async getCandles(symbol: string, from: string, to: string): Promise<Candle[]> {
    const prepared = await this.prepareCsv(symbol, from, to);
    const raw = await fs.readFile(prepared.csvPath, 'utf8');
    return this.parseCsv(raw).filter((bar) => bar.date >= from && bar.date <= to);
  }

  private async prepareCsvUnlocked(
    normalizedSymbol: string,
    sourceSymbol: string,
    from: string,
    to: string,
    forceRefresh: boolean,
  ): Promise<PreparedMarketData> {
    const stored = await this.readStored(sourceSymbol);
    const today = this.today();
    if (
      !forceRefresh &&
      stored &&
      this.covers(stored.metadata, from, to) &&
      this.isReusable(stored.metadata, to, today)
    ) {
      return this.toPrepared(normalizedSymbol, stored.metadata);
    }

    const fetchFrom = stored ? this.minDate(from, stored.metadata.rangeFrom) : from;
    const fetchTo = stored ? this.maxDate(to, stored.metadata.rangeTo) : to;
    let fetched: YahooFetchResult;
    try {
      fetched = await this.fetchFromYahoo(sourceSymbol, fetchFrom, fetchTo);
    } catch (error) {
      if (stored && this.covers(stored.metadata, from, to)) {
        this.logger.warn(`行情更新失敗，改用 ${sourceSymbol} 的既有 CSV`);
        return this.toPrepared(normalizedSymbol, stored.metadata);
      }
      throw error;
    }

    const csv = this.serializeCsv(fetched.candles);
    const sha256 = this.sha256(csv);
    const paths = this.pathsFor(sourceSymbol);
    const metadata: MarketDataMetadata = {
      schemaVersion: 1,
      source: 'yahoo-finance2',
      sourceSymbol,
      adjustmentMode: 'adjclose-ratio',
      volumeUnit: 'shares',
      fetchedAt: new Date().toISOString(),
      lastCompleteDate: fetched.lastCompleteDate,
      rangeFrom: fetchFrom,
      rangeTo: fetchTo,
      dataFrom: fetched.candles[0].date,
      dataTo: fetched.candles[fetched.candles.length - 1].date,
      rows: fetched.candles.length,
      csvFile: path.basename(paths.csvPath),
      sha256,
    };

    await fs.mkdir(this.dataDir, { recursive: true });
    await this.atomicWrite(paths.csvPath, csv);
    await this.atomicWrite(paths.metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
    return this.toPrepared(normalizedSymbol, metadata);
  }

  private async fetchFromYahoo(
    sourceSymbol: string,
    from: string,
    to: string,
  ): Promise<YahooFetchResult> {
    this.logger.log(`向 Yahoo 抓取 ${sourceSymbol} ${from}~${to}`);
    let quotes: YahooQuote[];
    let marketTimezone = TAIPEI_TIMEZONE;
    try {
      const result = await this.yf.chart(sourceSymbol, {
        period1: from,
        period2: this.addDays(to, 1),
        interval: '1d',
        includePrePost: false,
      });
      quotes = (result?.quotes ?? []) as YahooQuote[];
      marketTimezone = result?.meta?.exchangeTimezoneName || TAIPEI_TIMEZONE;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/not found|No data found|Invalid symbol/i.test(message)) {
        throw new NotFoundException(`找不到代號 '${sourceSymbol}' 的行情`);
      }
      if (/Too Many Requests|429/i.test(message)) {
        throw new ServiceUnavailableException('Yahoo Finance 請求過於頻繁，請稍候再試');
      }
      throw new ServiceUnavailableException(`抓取 ${sourceSymbol} 行情失敗：${message}`);
    }

    const today = this.today(marketTimezone);
    const candles = quotes
      .map((quote) => this.toCandle(quote, marketTimezone))
      .filter((bar): bar is Candle => bar !== null && bar.date < today)
      .sort((a, b) => a.date.localeCompare(b.date));
    const unique = [...new Map(candles.map((bar) => [bar.date, bar])).values()];
    if (unique.length === 0) {
      throw new NotFoundException(`${sourceSymbol} 在 ${from} ~ ${to} 沒有完整日線資料`);
    }
    return { candles: unique, lastCompleteDate: this.addDays(today, -1) };
  }

  private toCandle(quote: YahooQuote, marketTimezone: string): Candle | null {
    const { date, open, high, low, close, adjclose, volume } = quote;
    if (
      date == null ||
      open == null ||
      high == null ||
      low == null ||
      close == null ||
      adjclose == null ||
      ![open, high, low, close, adjclose].every(Number.isFinite) ||
      open <= 0 ||
      high <= 0 ||
      low <= 0 ||
      close <= 0 ||
      adjclose <= 0 ||
      high < Math.max(open, close) ||
      low > Math.min(open, close) ||
      (volume !== null && (!Number.isFinite(volume) || volume < 0))
    ) {
      return null;
    }
    const factor = adjclose / close;
    const adjustedOpen = open * factor;
    const adjustedHigh = high * factor;
    const adjustedLow = low * factor;
    if (![factor, adjustedOpen, adjustedHigh, adjustedLow].every(Number.isFinite)) {
      return null;
    }

    // `adjclose` is supplied independently by Yahoo. Even when raw High === Close,
    // IEEE-754 division/multiplication can make High a few ulps smaller than
    // adjclose. Clamp only after validating the raw OHLC relationship so the CSV
    // retains exact OHLC invariants without hiding genuinely invalid vendor data.
    return {
      date: this.toMarketDate(date, marketTimezone),
      open: adjustedOpen,
      high: Math.max(adjustedHigh, adjustedOpen, adjclose),
      low: Math.min(adjustedLow, adjustedOpen, adjclose),
      close: adjclose,
      volume: volume ?? 0,
    };
  }

  private async readStored(
    sourceSymbol: string,
  ): Promise<{ metadata: MarketDataMetadata; candles: Candle[] } | null> {
    const paths = this.pathsFor(sourceSymbol);
    const metadata = await this.readMetadata(paths.metadataPath);
    if (!metadata || metadata.sourceSymbol !== sourceSymbol) return null;
    try {
      const raw = await fs.readFile(paths.csvPath, 'utf8');
      if (this.sha256(raw) !== metadata.sha256) return null;
      const candles = this.parseCsv(raw);
      if (
        candles.length !== metadata.rows ||
        candles[0]?.date !== metadata.dataFrom ||
        candles[candles.length - 1]?.date !== metadata.dataTo
      ) {
        return null;
      }
      return { metadata, candles };
    } catch {
      return null;
    }
  }

  private async readMetadata(file: string): Promise<MarketDataMetadata | null> {
    try {
      const parsed = JSON.parse(await fs.readFile(file, 'utf8')) as unknown;
      return this.parseMetadata(parsed);
    } catch {
      return null;
    }
  }

  private parseMetadata(value: unknown): MarketDataMetadata | null {
    if (!this.isRecord(value)) return null;
    if (
      value.schemaVersion !== 1 ||
      value.source !== 'yahoo-finance2' ||
      value.adjustmentMode !== 'adjclose-ratio' ||
      value.volumeUnit !== 'shares' ||
      typeof value.sourceSymbol !== 'string' ||
      typeof value.fetchedAt !== 'string' ||
      Number.isNaN(Date.parse(value.fetchedAt)) ||
      !this.isCalendarDate(value.lastCompleteDate) ||
      !this.isCalendarDate(value.rangeFrom) ||
      !this.isCalendarDate(value.rangeTo) ||
      !this.isCalendarDate(value.dataFrom) ||
      !this.isCalendarDate(value.dataTo) ||
      value.rangeFrom > value.rangeTo ||
      value.dataFrom > value.dataTo ||
      typeof value.rows !== 'number' ||
      !Number.isInteger(value.rows) ||
      value.rows <= 0 ||
      typeof value.csvFile !== 'string' ||
      typeof value.sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(value.sha256)
    ) {
      return null;
    }
    return value as unknown as MarketDataMetadata;
  }

  private serializeCsv(candles: Candle[]): string {
    return `${CSV_HEADER}\n${candles
      .map((bar) =>
        [bar.date, bar.open, bar.high, bar.low, bar.close, bar.volume].join(','),
      )
      .join('\n')}\n`;
  }

  private parseCsv(raw: string): Candle[] {
    const lines = raw.replace(/^\uFEFF/, '').split(/\r?\n/).filter((line) => line.length > 0);
    if (lines.shift() !== CSV_HEADER) throw new Error(`CSV 欄位必須是 ${CSV_HEADER}`);
    let previousDate: string | null = null;
    return lines.map((line, index) => {
      const fields = line.split(',');
      if (fields.length !== 6) throw new Error(`CSV 第 ${index + 2} 列欄位數錯誤`);
      const [date, ...rawNumbers] = fields;
      const [open, high, low, close, volume] = rawNumbers.map(Number);
      const bar = { date, open, high, low, close, volume };
      if (!this.isCandle(bar) || (previousDate !== null && date <= previousDate)) {
        throw new Error(`CSV 第 ${index + 2} 列行情無效或日期未遞增`);
      }
      previousDate = date;
      return bar;
    });
  }

  private async atomicWrite(target: string, content: string): Promise<void> {
    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, content, 'utf8');
      await fs.rename(temporary, target);
    } catch (error) {
      await fs.unlink(temporary).catch(() => undefined);
      throw error;
    }
  }

  private pathsFor(sourceSymbol: string): { csvPath: string; metadataPath: string } {
    const digest = createHash('sha256').update(sourceSymbol).digest('hex').slice(0, 12);
    const readable = sourceSymbol.replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    const stem = `${readable}-${digest}`;
    return {
      csvPath: path.join(this.dataDir, `${stem}.csv`),
      metadataPath: path.join(this.dataDir, `${stem}.meta.json`),
    };
  }

  private toPrepared(symbol: string, metadata: MarketDataMetadata): PreparedMarketData {
    const paths = this.pathsFor(metadata.sourceSymbol);
    return {
      symbol,
      sourceSymbol: metadata.sourceSymbol,
      csvPath: paths.csvPath,
      dataVersion: metadata.sha256,
      source: metadata.source,
      adjustmentMode: metadata.adjustmentMode,
      volumeUnit: metadata.volumeUnit,
      from: metadata.dataFrom,
      to: metadata.dataTo,
      rows: metadata.rows,
      fetchedAt: metadata.fetchedAt,
    };
  }

  private toPublicPrepared(prepared: PreparedMarketData): PreparedMarketDataView {
    const { csvPath: _csvPath, ...view } = prepared;
    return view;
  }

  private async withSymbolLock<T>(symbol: string, action: () => Promise<T>): Promise<T> {
    const previous = this.symbolQueues.get(symbol) ?? Promise.resolve();
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = previous.then(() => gate);
    this.symbolQueues.set(symbol, queued);
    await previous;
    try {
      return await action();
    } finally {
      release();
      if (this.symbolQueues.get(symbol) === queued) this.symbolQueues.delete(symbol);
    }
  }

  private normalizeRequestedSymbol(symbol: string): string {
    const normalized = symbol.trim().toUpperCase();
    if (!/^[A-Z0-9^][A-Z0-9.^-]{0,19}$/.test(normalized)) {
      throw new BadRequestException(`無效的股票代號 '${symbol}'`);
    }
    return normalized;
  }

  private toYahooSymbol(symbol: string): string {
    return /^\d{4,6}$/.test(symbol) ? `${symbol}.TW` : symbol;
  }

  private validateDateRange(from: string, to: string): void {
    if (!this.isCalendarDate(from) || !this.isCalendarDate(to)) {
      throw new BadRequestException('行情日期必須是有效的 YYYY-MM-DD');
    }
    if (from > to) throw new BadRequestException(`行情起始日 ${from} 不可晚於結束日 ${to}`);
    const today = this.today();
    if (to > today) throw new BadRequestException(`行情結束日 ${to} 不可晚於台北日期 ${today}`);
  }

  private isReusable(metadata: MarketDataMetadata, to: string, today: string): boolean {
    const fresh = Date.now() - Date.parse(metadata.fetchedAt) < CACHE_TTL_MS;
    return to <= metadata.lastCompleteDate || (to >= today && fresh);
  }

  private covers(metadata: MarketDataMetadata, from: string, to: string): boolean {
    return metadata.rangeFrom <= from && metadata.rangeTo >= to;
  }

  private sha256(content: string): string {
    return createHash('sha256').update(content, 'utf8').digest('hex');
  }

  private toMarketDate(date: Date, timezone: string): string {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(date);
  }

  private today(timezone = TAIPEI_TIMEZONE): string {
    return this.toMarketDate(new Date(), timezone);
  }

  private addDays(value: string, days: number): string {
    const date = new Date(`${value}T00:00:00Z`);
    date.setUTCDate(date.getUTCDate() + days);
    return date.toISOString().slice(0, 10);
  }

  private minDate(a: string, b: string): string {
    return a <= b ? a : b;
  }

  private maxDate(a: string, b: string): string {
    return a >= b ? a : b;
  }

  private isCalendarDate(value: unknown): value is string {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const parsed = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  }

  private isCandle(value: unknown): value is Candle {
    if (!this.isRecord(value) || !this.isCalendarDate(value.date)) return false;
    const prices = [value.open, value.high, value.low, value.close];
    if (prices.some((price) => typeof price !== 'number' || !Number.isFinite(price) || price <= 0)) {
      return false;
    }
    if (
      (value.high as number) <
        Math.max(value.open as number, value.close as number, value.low as number) ||
      (value.low as number) >
        Math.min(value.open as number, value.close as number, value.high as number)
    ) {
      return false;
    }
    return typeof value.volume === 'number' && Number.isFinite(value.volume) && value.volume >= 0;
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }

  /** 舊版 JSON 快取 parser 保留，避免舊引擎的單元測試失去保護。 */
  private parseCachedSeries(value: unknown, expectedSymbol: string): CachedSeries | null {
    if (!this.isRecord(value)) return null;
    const candidate = value as unknown as Partial<CachedSeries>;
    if (
      candidate.symbol !== expectedSymbol ||
      candidate.schemaVersion !== 1 ||
      candidate.source !== 'yahoo-finance2' ||
      candidate.adjustmentMode !== 'adjclose-ratio' ||
      typeof candidate.fetchedAt !== 'string' ||
      Number.isNaN(Date.parse(candidate.fetchedAt)) ||
      !this.isCalendarDate(candidate.lastCompleteDate) ||
      !this.isCalendarDate(candidate.rangeFrom) ||
      !this.isCalendarDate(candidate.rangeTo) ||
      !Array.isArray(candidate.candles) ||
      !candidate.candles.every((bar) => this.isCandle(bar))
    ) {
      return null;
    }
    const sorted = [...candidate.candles].sort((a, b) => a.date.localeCompare(b.date));
    const candles = [...new Map(sorted.map((bar) => [bar.date, bar])).values()];
    return { ...(candidate as CachedSeries), candles };
  }
}

interface YahooQuote {
  date: Date;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  adjclose?: number | null;
  volume: number | null;
}

interface YahooFetchResult {
  candles: Candle[];
  lastCompleteDate: string;
}
