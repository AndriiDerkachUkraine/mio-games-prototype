import { Body, Controller, Get, Headers, Param, Post, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { CurrentPlayer } from '../players/current-player.decorator';
import { PlayerAuthGuard, type AuthenticatedPlayer } from '../players/player-auth.guard';
import { RedemptionService, type RedemptionView } from './redemption.service';

@Controller('v1/me/redemptions')
@UseGuards(PlayerAuthGuard)
export class RedemptionsController {
  constructor(private readonly redemptions: RedemptionService) {}

  /** 202 when a new redemption is accepted for delivery, 200 when the Idempotency-Key replays an earlier one. */
  @Post()
  async redeem(
    @CurrentPlayer() player: AuthenticatedPlayer,
    @Body() body: { itemId?: unknown },
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<RedemptionView> {
    const itemId = typeof body?.itemId === 'string' ? body.itemId : '';
    const { redemption, created } = await this.redemptions.redeem(player, itemId, idempotencyKey);
    res.status(created ? 202 : 200);
    return redemption;
  }

  @Get()
  list(@CurrentPlayer() player: AuthenticatedPlayer): Promise<RedemptionView[]> {
    return this.redemptions.list(player);
  }

  @Get(':redemptionId')
  get(@CurrentPlayer() player: AuthenticatedPlayer, @Param('redemptionId') redemptionId: string) {
    return this.redemptions.get(player, redemptionId);
  }
}
