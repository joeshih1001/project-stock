import { Module } from '@nestjs/common';
import { MarketDataService } from '../market-data/market-data.service';
import { BacktestController } from './backtest.controller';
import { BacktestJobService } from './backtest-job.service';
import { BacktestTaskRepository } from './backtest-task.repository';
import { PythonBacktestRunner } from './python-backtest.runner';

@Module({
  controllers: [BacktestController],
  providers: [
    BacktestJobService,
    BacktestTaskRepository,
    MarketDataService,
    PythonBacktestRunner,
  ],
})
export class BacktestModule {}
