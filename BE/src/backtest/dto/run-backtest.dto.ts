import { Transform } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsIn,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
} from 'class-validator';

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export class RunBacktestDto {
  @ApiProperty({ example: '0050', description: '台股代號；純數字預設對應上市 .TW' })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toUpperCase() : value,
  )
  @IsString()
  @IsNotEmpty()
  @Matches(/^[A-Z0-9^][A-Z0-9.^-]{0,19}$/, {
    message: 'symbol 只能包含英數字、點、連字號或 ^，長度上限 20',
  })
  symbol!: string;

  @ApiProperty({ example: '2018-01-01', description: '回測起始日（含）' })
  @IsString()
  @Matches(DATE_PATTERN, { message: 'from 必須是 YYYY-MM-DD 格式' })
  from!: string;

  @ApiProperty({ example: '2025-12-31', description: '回測結束日（含）' })
  @IsString()
  @Matches(DATE_PATTERN, { message: 'to 必須是 YYYY-MM-DD 格式' })
  to!: string;

  @ApiPropertyOptional({
    default: 'ma-trend',
    enum: ['ma-trend'],
    description: '第一版只開放單均線趨勢策略',
  })
  @IsOptional()
  @IsString()
  @IsIn(['ma-trend'])
  strategy = 'ma-trend';

  @ApiPropertyOptional({ default: 60, minimum: 2, maximum: 1000 })
  @IsOptional()
  @IsInt()
  @Min(2)
  @Max(1000)
  maPeriod = 60;

  @ApiPropertyOptional({ default: 100_000, minimum: 1 })
  @IsOptional()
  @IsNumber({ allowInfinity: false, allowNaN: false })
  @Min(1)
  initialCapital = 100_000;

  @ApiPropertyOptional({
    default: 0.5,
    minimum: 0,
    maximum: 1,
    description: '每次進場最多使用當時帳戶資產的比例',
  })
  @IsOptional()
  @IsNumber({ allowInfinity: false, allowNaN: false })
  @Min(Number.EPSILON)
  @Max(1)
  allocation = 0.5;

  @ApiPropertyOptional({
    default: 0,
    minimum: 0,
    maximum: 0.1,
    description: '單邊手續費率；文件尚未定案，因此預設不暗自假設費率',
  })
  @IsOptional()
  @IsNumber({ allowInfinity: false, allowNaN: false })
  @Min(0)
  @Max(0.1)
  feeRate = 0;

  @ApiPropertyOptional({ default: 0, minimum: 0, maximum: 0.1 })
  @IsOptional()
  @IsNumber({ allowInfinity: false, allowNaN: false })
  @Min(0)
  @Max(0.1)
  slippageRate = 0;

  @ApiPropertyOptional({
    default: 20,
    minimum: 0,
    maximum: 100,
    description: '只用來標示結果是否超過容忍度，不會自動停損或中止交易',
  })
  @IsOptional()
  @IsNumber({ allowInfinity: false, allowNaN: false })
  @Min(0)
  @Max(100)
  maxDrawdownWarningPct = 20;
}
