import { Injectable, BadRequestException } from '@nestjs/common';
import { Strategy, StrategyDefinition } from './strategy.interface';
import { maCrossDefinition } from './ma-cross.strategy';
import { rsiDefinition } from './rsi.strategy';
import { macdCrossDefinition } from './macd-cross.strategy';

/**
 * 策略註冊表 —— 新增策略只要在這裡多加一筆 definition，
 * 引擎、Controller、Swagger 都不必改。
 */
const DEFINITIONS: StrategyDefinition[] = [
  maCrossDefinition,
  rsiDefinition,
  macdCrossDefinition,
];

@Injectable()
export class StrategyRegistry {
  private readonly byKey = new Map<string, StrategyDefinition>(
    DEFINITIONS.map((d) => [d.key, d]),
  );

  list(): StrategyDefinition[] {
    return [...this.byKey.values()];
  }

  /**
   * 依 key 建立策略實例。未帶的參數自動補預設值，
   * 策略建構子丟出的參數驗證錯誤會轉成 400 而非 500。
   */
  create(key: string, params: Record<string, number> = {}): Strategy {
    const def = this.byKey.get(key);
    if (!def) {
      throw new BadRequestException(
        `未知的策略 '${key}'。可用策略：${[...this.byKey.keys()].join(', ')}`,
      );
    }

    const unknownParams = Object.keys(params).filter(
      (name) => !Object.prototype.hasOwnProperty.call(def.defaultParams, name),
    );
    if (unknownParams.length > 0) {
      throw new BadRequestException(
        `策略 '${key}' 不支援參數：${unknownParams.join(', ')}。可用參數：${Object.keys(
          def.defaultParams,
        ).join(', ')}`,
      );
    }

    const merged = { ...def.defaultParams, ...params };
    try {
      return def.create(merged);
    } catch (err) {
      throw new BadRequestException(
        `策略 '${key}' 參數錯誤：${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
