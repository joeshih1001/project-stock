import { BadRequestException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { MarketDataService } from './market-data.service';
import { Candle, MarketDataMetadata } from './types';

type MarketDataInternals = {
  fetchFromYahoo: (
    symbol: string,
    from: string,
    to: string,
  ) => Promise<{ candles: Candle[]; lastCompleteDate: string }>;
  toCandle: (quote: Record<string, unknown>, timezone: string) => Candle | null;
};

const candles: Candle[] = [
  { date: '2023-12-29', open: 98, high: 101, low: 97, close: 100, volume: 1_000 },
  { date: '2024-01-02', open: 100, high: 103, low: 99, close: 102, volume: 2_000 },
  { date: '2024-01-03', open: 102, high: 104, low: 101, close: 103, volume: 3_000 },
];

describe('MarketDataService CSV preparation', () => {
  let service: MarketDataService;
  let internals: MarketDataInternals;
  let dataDir: string;
  let originalDataDir: string | undefined;

  beforeEach(async () => {
    originalDataDir = process.env.MARKET_DATA_DIR;
    dataDir = await fs.mkdtemp(path.join(tmpdir(), 'stock-market-data-'));
    process.env.MARKET_DATA_DIR = dataDir;
    service = new MarketDataService();
    internals = service as unknown as MarketDataInternals;
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    if (originalDataDir === undefined) delete process.env.MARKET_DATA_DIR;
    else process.env.MARKET_DATA_DIR = originalDataDir;
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  it('prepares an adjusted, versioned CSV for Python and reuses it offline', async () => {
    const fetchFromYahoo = jest.spyOn(internals, 'fetchFromYahoo').mockResolvedValue({
      candles,
      lastCompleteDate: '2024-01-03',
    });

    const prepared = await service.prepareCsv(' 0050 ', '2024-01-02', '2024-01-03', 2);
    const rawCsv = await fs.readFile(prepared.csvPath, 'utf8');
    const metadataFile = (await fs.readdir(dataDir)).find((file) => file.endsWith('.meta.json'));
    expect(metadataFile).toBeDefined();
    const metadata = JSON.parse(
      await fs.readFile(path.join(dataDir, metadataFile!), 'utf8'),
    ) as MarketDataMetadata;

    expect(fetchFromYahoo).toHaveBeenCalledWith('0050.TW', '2023-11-29', '2024-01-03');
    expect(path.dirname(prepared.csvPath)).toBe(dataDir);
    expect(prepared).toMatchObject({
      symbol: '0050',
      sourceSymbol: '0050.TW',
      source: 'yahoo-finance2',
      adjustmentMode: 'adjclose-ratio',
      volumeUnit: 'shares',
      from: '2023-12-29',
      to: '2024-01-03',
      rows: 3,
    });
    expect(rawCsv).toBe(
      'Date,Open,High,Low,Close,Volume\n' +
        '2023-12-29,98,101,97,100,1000\n' +
        '2024-01-02,100,103,99,102,2000\n' +
        '2024-01-03,102,104,101,103,3000\n',
    );
    expect(prepared.dataVersion).toBe(
      createHash('sha256').update(rawCsv, 'utf8').digest('hex'),
    );
    expect(metadata).toMatchObject({
      schemaVersion: 1,
      sourceSymbol: '0050.TW',
      rangeFrom: '2023-11-29',
      rangeTo: '2024-01-03',
      dataFrom: '2023-12-29',
      dataTo: '2024-01-03',
      rows: 3,
      sha256: prepared.dataVersion,
    });

    const reused = await service.prepareCsv('0050', '2024-01-02', '2024-01-03', 2);
    expect(reused).toEqual(prepared);
    expect(fetchFromYahoo).toHaveBeenCalledTimes(1);

    await expect(service.getCandles('0050', '2024-01-02', '2024-01-03')).resolves.toEqual(
      candles.slice(1),
    );
    expect(fetchFromYahoo).toHaveBeenCalledTimes(1);
  });

  it('lists only prepared CSV files whose metadata and checksum are valid', async () => {
    jest.spyOn(internals, 'fetchFromYahoo').mockResolvedValue({
      candles,
      lastCompleteDate: '2024-01-03',
    });
    await service.prepareCsv('0050', '2024-01-02', '2024-01-03');
    await fs.writeFile(path.join(dataDir, 'broken.meta.json'), '{not-json', 'utf8');

    await expect(service.listPrepared()).resolves.toEqual([
      expect.objectContaining({
        symbol: '0050.TW',
        sourceSymbol: '0050.TW',
        rows: 3,
      }),
    ]);
  });

  it('rejects invalid ranges, symbols, and warmup values before any fetch', async () => {
    const fetchFromYahoo = jest.spyOn(internals, 'fetchFromYahoo');

    await expect(
      service.prepareCsv('0050', '2024-02-30', '2024-03-01'),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.prepareCsv('0050', '2024-03-02', '2024-03-01'),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.prepareCsv('0050', '9999-01-01', '9999-01-02'),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.prepareCsv('../0050', '2024-01-02', '2024-01-03'),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.prepareCsv('0050', '2024-01-02', '2024-01-03', -1),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(fetchFromYahoo).not.toHaveBeenCalled();
  });

  it('uses the adjusted-close ratio for all OHLC values', () => {
    expect(
      internals.toCandle(
        {
          date: new Date('2024-01-02T14:30:00Z'),
          open: 100,
          high: 110,
          low: 90,
          close: 100,
          adjclose: 50,
          volume: 123,
        },
        'America/New_York',
      ),
    ).toEqual({
      date: '2024-01-02',
      open: 50,
      high: 55,
      low: 45,
      close: 50,
      volume: 123,
    });
  });

  it('preserves exact OHLC bounds when adjusted-close arithmetic differs by one ulp', () => {
    const close = 33;
    const adjclose = 15.578435897827148;

    const adjusted = internals.toCandle(
      {
        date: new Date('2024-01-02T06:00:00Z'),
        open: 32.5,
        high: close,
        low: 32,
        close,
        adjclose,
        volume: 123,
      },
      'Asia/Taipei',
    );

    expect(adjusted).not.toBeNull();
    expect(adjusted!.high).toBeGreaterThanOrEqual(adjusted!.close);
    expect(adjusted!.low).toBeLessThanOrEqual(adjusted!.close);
  });

  it('rejects incomplete or invalid Yahoo rows instead of mixing raw and adjusted prices', () => {
    const base = {
      date: new Date('2024-01-02T14:30:00Z'),
      open: 100,
      high: 110,
      low: 90,
      close: 100,
      volume: 123,
    };

    expect(internals.toCandle(base, 'America/New_York')).toBeNull();
    expect(
      internals.toCandle({ ...base, adjclose: 100, volume: -1 }, 'America/New_York'),
    ).toBeNull();
    expect(
      internals.toCandle(
        { ...base, high: 99, adjclose: 100 },
        'America/New_York',
      ),
    ).toBeNull();
  });
});
