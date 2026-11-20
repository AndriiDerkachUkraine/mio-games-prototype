import { Controller, HttpCode, HttpStatus, Param, Post, Req, type RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import { IngestionService, type IngestionResult } from './ingestion.service';

/** Casino → MIO webhook; the payload format is decided by the tenant's platform. */
@Controller('v1/integrations/:tenantId/events')
export class IngestionController {
  constructor(private readonly ingestion: IngestionService) {}

  // Duplicates and ignored events also get 200: casinos retry non-2xx, and retrying them can never succeed.
  @Post()
  @HttpCode(HttpStatus.OK)
  receive(@Param('tenantId') tenantId: string, @Req() req: RawBodyRequest<Request>): Promise<IngestionResult> {
    // No raw body (non-JSON content type) → the signature cannot match → 401.
    const rawBody = req.rawBody ?? Buffer.alloc(0);
    return this.ingestion.receive(tenantId, { rawBody, body: req.body, headers: req.headers });
  }
}
