import { BadRequestException } from '@nestjs/common';
import { StrategyRegistry } from './strategy.registry';

describe('StrategyRegistry', () => {
  const registry = new StrategyRegistry();

  it('列出三個策略並套用預設參數', () => {
    expect(registry.list().map((definition) => definition.key)).toEqual([
      'ma-cross',
      'rsi',
      'macd-cross',
    ]);
    expect(registry.create('ma-cross').params).toEqual({ fastPeriod: 20, slowPeriod: 60 });
  });

  it('把未知策略、拼錯參數及錯誤參數值轉成 400', () => {
    expect(() => registry.create('missing')).toThrow(BadRequestException);
    expect(() => registry.create('ma-cross', { fastperiod: 10 })).toThrow(/不支援參數/);
    expect(() => registry.create('ma-cross', { fastPeriod: 60, slowPeriod: 20 })).toThrow(
      BadRequestException,
    );
    expect(() => registry.create('rsi', { period: 10_001 })).toThrow(/1~10000/);
  });
});
