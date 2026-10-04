import { Controller, Get } from '@nestjs/common';
import { ApiExcludeEndpoint } from '@nestjs/swagger';

@Controller()
export class AppController {
  @Get('health')
  @ApiExcludeEndpoint()
  health() {
    return { status: 'ok' };
  }
}
