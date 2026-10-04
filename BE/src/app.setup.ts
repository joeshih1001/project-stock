import { INestApplication, ValidationPipe } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

/** 主程式與整合測試共用同一份 HTTP 設定，避免測到的路由和實際啟動不同。 */
export function configureApp(app: INestApplication): void {
  app.setGlobalPrefix('api');
  app.enableCors();
  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: true,
    }),
  );

  const swaggerConfig = new DocumentBuilder()
    .setTitle('台股 Python 回測任務 API')
    .setDescription('Node.js 管理行情 CSV 與任務，以受控子程序執行 Python 回測')
    .setVersion('1.0.0')
    .build();
  const document = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('docs', app, document);
}
