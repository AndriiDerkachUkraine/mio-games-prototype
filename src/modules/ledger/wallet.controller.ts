import { Controller, Get, UseGuards } from '@nestjs/common';
import { CurrentPlayer } from '../players/current-player.decorator';
import { PlayerAuthGuard, type AuthenticatedPlayer } from '../players/player-auth.guard';
import { LedgerService, type LedgerEntryView } from './ledger.service';

@Controller('v1/me/wallet')
@UseGuards(PlayerAuthGuard)
export class WalletController {
  constructor(private readonly ledger: LedgerService) {}

  @Get()
  get(@CurrentPlayer() player: AuthenticatedPlayer): Promise<{ balance: number; entries: LedgerEntryView[] }> {
    return this.ledger.wallet(player.tenantId, player.playerId);
  }
}
