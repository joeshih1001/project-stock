import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { configureApp } from './app.setup';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  configureApp(app);
  app.enableShutdownHooks();

  const port = Number(process.env.PORT ?? 5500);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`PORT 必須是 1~65535 的整數，收到 ${process.env.PORT}`);
  }
  await app.listen(port);
}

void bootstrap().catch((error: unknown) => {
  // Nest 啟動前的設定錯誤（例如非法 PORT）也要留下可診斷訊息並以非零碼結束。
  console.error(error);
  process.exitCode = 1;
});
