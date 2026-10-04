/** Python 回測程式使用的標準日線欄位。 */
export interface Candle {
  /** 交易日，YYYY-MM-DD。 */
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  /** 成交量固定以股（shares）為單位。 */
  volume: number;
}

/** CSV 旁的中繼資料，讓每次回測都能追溯資料來源及版本。 */
export interface MarketDataMetadata {
  schemaVersion: 1;
  source: 'yahoo-finance2';
  sourceSymbol: string;
  adjustmentMode: 'adjclose-ratio';
  volumeUnit: 'shares';
  fetchedAt: string;
  lastCompleteDate: string;
  rangeFrom: string;
  rangeTo: string;
  dataFrom: string;
  dataTo: string;
  rows: number;
  csvFile: string;
  /** CSV 原始 bytes 的 SHA-256。 */
  sha256: string;
}

/** 只會由 MarketDataService 產生，呼叫端不得接受使用者傳入任意檔案路徑。 */
export interface PreparedMarketData {
  symbol: string;
  sourceSymbol: string;
  csvPath: string;
  dataVersion: string;
  source: MarketDataMetadata['source'];
  adjustmentMode: MarketDataMetadata['adjustmentMode'];
  volumeUnit: MarketDataMetadata['volumeUnit'];
  from: string;
  to: string;
  rows: number;
  fetchedAt: string;
}

/** HTTP 可公開的行情資訊，不包含伺服器絕對路徑。 */
export type PreparedMarketDataView = Omit<PreparedMarketData, 'csvPath'>;

/** 舊版 JSON 快取型別保留給既有純 TypeScript 引擎的相容測試。 */
export interface CachedSeries {
  schemaVersion: 1;
  source: 'yahoo-finance2';
  adjustmentMode: 'adjclose-ratio';
  symbol: string;
  fetchedAt: string;
  lastCompleteDate: string;
  rangeFrom: string;
  rangeTo: string;
  candles: Candle[];
}
