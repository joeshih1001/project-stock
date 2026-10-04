import { Transform } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, Matches } from 'class-validator';

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export class UpdateMarketDataDto {
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

  @ApiProperty({ example: '2018-01-01' })
  @IsString()
  @Matches(DATE_PATTERN, { message: 'from 必須是 YYYY-MM-DD 格式' })
  from!: string;

  @ApiProperty({ example: '2025-12-31' })
  @IsString()
  @Matches(DATE_PATTERN, { message: 'to 必須是 YYYY-MM-DD 格式' })
  to!: string;
}
