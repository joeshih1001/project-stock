import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { UpdateMarketDataDto } from '../market-data/dto/update-market-data.dto';
import { MarketDataService } from '../market-data/market-data.service';
import { BacktestJobService } from './backtest-job.service';
import { RunBacktestDto } from './dto/run-backtest.dto';

@ApiTags('backtests')
@Controller()
export class BacktestController {
  constructor(
    private readonly jobs: BacktestJobService,
    private readonly marketData: MarketDataService,
  ) {}

  @Get('strategies')
  @ApiOperation({ summary: '列出 Python 第一版可用策略及預設參數' })
  listStrategies() {
    return [
      {
        key: 'ma-trend',
        name: '單均線趨勢',
        description: '收盤價站上均線後於次一交易日開盤買進；跌破後於次日開盤賣出。',
        version: '1.0.0',
        defaultParams: { maPeriod: 60, allocation: 0.5 },
      },
    ];
  }

  @Get('market-data')
  @ApiOperation({ summary: '列出本機可重複使用的歷史行情 CSV 與版本' })
  listMarketData() {
    return this.marketData.listPrepared();
  }

  @Get('market-data/cache')
  @ApiOperation({ summary: '舊版行情清單路徑（相容別名）' })
  listCache() {
    return this.marketData.listPrepared();
  }

  @Post('market-data/update')
  @ApiOperation({ summary: '從 Yahoo 更新、整理並保存歷史行情 CSV' })
  @ApiResponse({ status: 201, description: 'CSV 與來源中繼資料已更新' })
  updateMarketData(@Body() request: UpdateMarketDataDto) {
    return this.marketData.updateCsv(request.symbol, request.from, request.to);
  }

  @Post('backtests')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({ summary: '建立 Python 回測任務' })
  @ApiResponse({ status: 202, description: '任務已保存並排入執行佇列' })
  @ApiResponse({ status: 400, description: '日期或回測參數不合法' })
  create(@Body() request: RunBacktestDto) {
    return this.jobs.create(request);
  }

  @Get('backtests')
  @ApiOperation({ summary: '列出已保存的回測任務' })
  list() {
    return this.jobs.list();
  }

  @Get('backtests/:id')
  @ApiOperation({ summary: '查詢回測任務狀態' })
  get(@Param('id', new ParseUUIDPipe({ version: '4' })) id: string) {
    return this.jobs.get(id);
  }

  @Get('backtests/:id/result')
  @ApiOperation({ summary: '讀取已完成的完整回測報告' })
  result(@Param('id', new ParseUUIDPipe({ version: '4' })) id: string) {
    return this.jobs.result(id);
  }

  @Delete('backtests/:id')
  @ApiOperation({ summary: '取消排隊中或執行中的回測任務' })
  cancel(@Param('id', new ParseUUIDPipe({ version: '4' })) id: string) {
    return this.jobs.cancel(id);
  }
}
