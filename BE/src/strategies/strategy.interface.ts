import { Candle } from '../market-data/types';

/**
 * 單根 K 棒的策略輸出。
 * - BUY：送出進場意圖（尚未持有才會成交）
 * - SELL：送出出場意圖（持有中才會成交）
 * - HOLD：維持現狀
 *
 * 策略只負責發出事件，不必自己追蹤部位；重複或與現況不符的事件由引擎忽略。
 * 回測期初固定空手，暖身區最後一根的事件不會帶入首日成交。
 */
export type Signal = 'BUY' | 'SELL' | 'HOLD';

export interface Strategy {
  /** API 用的識別字，如 'ma-cross' */
  readonly key: string;
  /** 這次執行的參數快照，會原樣寫進回測報告，方便事後重現 */
  readonly params: Readonly<Record<string, number>>;
  /**
   * 指標成形所需的 K 棒數。
   * 引擎會據此往回測起始日之前多抓這麼多根 K 棒當暖身資料，
   * 讓起始日當天指標就已經有值 —— 否則 MA60 策略的前 60 個交易日
   * 會完全不交易，等於憑空少了一段回測期間。
   */
  readonly warmupBars: number;
  /** 人類可讀的策略描述，含實際參數，如 'MA(20) / MA(60) 交叉' */
  describe(): string;

  /**
   * 產生與 candles 等長的訊號陣列。
   *
   * 鐵律：索引 i 的訊號只能取用 candles[0..i] 的資料。
   * 任何一處讀到 i 之後的 K 棒都是前瞻偏誤（lookahead bias），
   * 會讓回測績效憑空變好而完全不可信。
   */
  generateSignals(candles: Candle[]): Signal[];
}

/** 策略在註冊表中的中繼資料 + 建構子 */
export interface StrategyDefinition {
  key: string;
  name: string;
  description: string;
  defaultParams: Record<string, number>;
  create(params: Record<string, number>): Strategy;
}

/** 參數讀取小工具：沒帶就用預設值，帶了非正整數就報錯 */
export function positiveInt(
  params: Record<string, number>,
  name: string,
  fallback: number,
): number {
  const raw = params[name];
  if (raw === undefined || raw === null) return fallback;
  if (!Number.isInteger(raw) || raw <= 0 || raw > 10_000) {
    throw new Error(`參數 ${name} 必須是 1~10000 的整數，收到 ${raw}`);
  }
  return raw;
}

/** 參數讀取小工具：限定在 [min, max] 之間的數字 */
export function numberInRange(
  params: Record<string, number>,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = params[name];
  if (raw === undefined || raw === null) return fallback;
  if (typeof raw !== 'number' || Number.isNaN(raw) || raw < min || raw > max) {
    throw new Error(`參數 ${name} 必須介於 ${min} 與 ${max} 之間，收到 ${raw}`);
  }
  return raw;
}
