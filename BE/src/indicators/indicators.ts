/**
 * 技術指標。全部是純函式：輸入價格序列，輸出等長序列。
 *
 * 共同約定 —— 這點對回測正確性很關鍵：
 * 回傳陣列與輸入等長，指標尚未成形的位置一律填 `null`（不是 0，不是 NaN，
 * 也不是把陣列截短）。索引對齊原始 K 棒，策略層才不會不小心把「第 0 天的
 * MA20」當成真的均線，或是因為陣列位移而讀到未來的資料。
 */

/** 簡單移動平均 */
export function sma(values: number[], period: number): (number | null)[] {
  validateInput('sma', values, period);

  const out: (number | null)[] = new Array(values.length).fill(null);
  let sum = 0;

  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

/**
 * 指數移動平均。
 * 以前 `period` 根的 SMA 當作種子值，這是多數看盤軟體的作法，
 * 也讓不同起始日期跑出來的 EMA 比較接近。
 */
export function ema(values: number[], period: number): (number | null)[] {
  validateInput('ema', values, period);

  const out: (number | null)[] = new Array(values.length).fill(null);
  if (values.length < period) return out;

  const k = 2 / (period + 1);

  let seed = 0;
  for (let i = 0; i < period; i++) seed += values[i];
  let prev = seed / period;
  out[period - 1] = prev;

  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

/**
 * RSI，Wilder 平滑法（非簡單平均）。
 * 第一個值落在索引 `period`，因為需要 period 根「價差」，而 n 根 K 棒只有 n-1 根價差。
 */
export function rsi(values: number[], period = 14): (number | null)[] {
  validateInput('rsi', values, period);

  const out: (number | null)[] = new Array(values.length).fill(null);
  if (values.length <= period) return out;

  let gainSum = 0;
  let lossSum = 0;
  for (let i = 1; i <= period; i++) {
    const diff = values[i] - values[i - 1];
    if (diff >= 0) gainSum += diff;
    else lossSum -= diff;
  }

  let avgGain = gainSum / period;
  let avgLoss = lossSum / period;
  out[period] = toRsi(avgGain, avgLoss);

  for (let i = period + 1; i < values.length; i++) {
    const diff = values[i] - values[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;

    // Wilder 平滑：等價於 alpha = 1/period 的 EMA
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    out[i] = toRsi(avgGain, avgLoss);
  }
  return out;
}

function toRsi(avgGain: number, avgLoss: number): number {
  // 全期間都沒下跌時 RS 會是無限大，直接回 100，避免 0/0 產生 NaN
  if (avgLoss === 0) return avgGain === 0 ? 50 : 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

export interface MacdResult {
  macd: (number | null)[];
  signal: (number | null)[];
  histogram: (number | null)[];
}

/** MACD：快線 EMA - 慢線 EMA，再對其取 EMA 當訊號線 */
export function macd(
  values: number[],
  fastPeriod = 12,
  slowPeriod = 26,
  signalPeriod = 9,
): MacdResult {
  validatePeriod('macd fastPeriod', fastPeriod);
  validatePeriod('macd slowPeriod', slowPeriod);
  validatePeriod('macd signalPeriod', signalPeriod);
  if (fastPeriod >= slowPeriod) {
    throw new Error(
      `macd: fastPeriod (${fastPeriod}) 必須小於 slowPeriod (${slowPeriod})`,
    );
  }
  validateValues('macd', values);

  const fast = ema(values, fastPeriod);
  const slow = ema(values, slowPeriod);

  const macdLine: (number | null)[] = values.map((_, i) =>
    fast[i] !== null && slow[i] !== null ? fast[i]! - slow[i]! : null,
  );

  // 訊號線是「MACD 線的 EMA」，而 MACD 線前面有一段 null。
  // 必須只餵已成形的片段給 ema()，再把結果放回原本的索引，
  // 否則 null 會被當成 0 拉低訊號線。
  const firstValid = macdLine.findIndex((v) => v !== null);
  const signal: (number | null)[] = new Array(values.length).fill(null);

  if (firstValid !== -1) {
    const dense = macdLine.slice(firstValid) as number[];
    const signalDense = ema(dense, signalPeriod);
    for (let i = 0; i < signalDense.length; i++) {
      signal[firstValid + i] = signalDense[i];
    }
  }

  const histogram: (number | null)[] = values.map((_, i) =>
    macdLine[i] !== null && signal[i] !== null ? macdLine[i]! - signal[i]! : null,
  );

  return { macd: macdLine, signal, histogram };
}

/**
 * 判斷索引 i 是否發生「a 由下往上穿越 b」。
 * 兩條線在 i 或 i-1 只要有一邊還沒成形就回 false —— 指標剛成形的第一天
 * 不該被當成交叉訊號。
 */
export function crossesAbove(
  a: (number | null)[],
  b: (number | null)[],
  i: number,
): boolean {
  if (!Number.isInteger(i) || i < 1 || i >= a.length || i >= b.length) return false;
  const [aPrev, aNow, bPrev, bNow] = [a[i - 1], a[i], b[i - 1], b[i]];
  if (aPrev === null || aNow === null || bPrev === null || bNow === null) return false;
  return aPrev <= bPrev && aNow > bNow;
}

/** 判斷索引 i 是否發生「a 由上往下跌破 b」 */
export function crossesBelow(
  a: (number | null)[],
  b: (number | null)[],
  i: number,
): boolean {
  if (!Number.isInteger(i) || i < 1 || i >= a.length || i >= b.length) return false;
  const [aPrev, aNow, bPrev, bNow] = [a[i - 1], a[i], b[i - 1], b[i]];
  if (aPrev === null || aNow === null || bPrev === null || bNow === null) return false;
  return aPrev >= bPrev && aNow < bNow;
}

function validateInput(name: string, values: number[], period: number): void {
  validatePeriod(name, period);
  validateValues(name, values);
}

function validatePeriod(name: string, period: number): void {
  if (!Number.isSafeInteger(period) || period <= 0 || period > 1_000_000) {
    throw new Error(`${name}: period 必須是 1~1000000 的整數，收到 ${period}`);
  }
}

function validateValues(name: string, values: number[]): void {
  const invalidIndex = values.findIndex((value) => !Number.isFinite(value));
  if (invalidIndex !== -1) {
    throw new Error(`${name}: values[${invalidIndex}] 必須是有限數字`);
  }
}
