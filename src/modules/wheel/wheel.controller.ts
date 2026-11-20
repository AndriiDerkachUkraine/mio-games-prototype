import { Controller, Get, HttpCode, HttpStatus, Param, Post, UseGuards } from '@nestjs/common';
import { CurrentPlayer } from '../players/current-player.decorator';
import { PlayerAuthGuard, type AuthenticatedPlayer } from '../players/player-auth.guard';
import { SpinsRepository } from './spins.repository';
import { WheelService, type SpinResult } from './wheel.service';

@Controller('v1/me/spins')
@UseGuards(PlayerAuthGuard)
export class WheelController {
  constructor(
    private readonly wheel: WheelService,
    private readonly spins: SpinsRepository,
  ) {}

  @Get()
  async available(
    @CurrentPlayer() player: AuthenticatedPlayer,
  ): Promise<{ available: { spinId: string; grantedAt: Date }[] }> {
    const spins = await this.spins.listAvailable(player);
    return { available: spins.map((s) => ({ spinId: s.id, grantedAt: s.granted_at })) };
  }

  /** The client only names the spin; the outcome is decided and stored by the server. */
  @Post(':spinId/play')
  @HttpCode(HttpStatus.OK)
  play(@CurrentPlayer() player: AuthenticatedPlayer, @Param('spinId') spinId: string): Promise<SpinResult> {
    return this.wheel.play(player, spinId);
  }
}
