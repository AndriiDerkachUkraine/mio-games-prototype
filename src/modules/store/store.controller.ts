import { Controller, Get, UseGuards } from '@nestjs/common';
import { CurrentPlayer } from '../players/current-player.decorator';
import { PlayerAuthGuard, type AuthenticatedPlayer } from '../players/player-auth.guard';
import { StoreItemsRepository, type StoreItem } from './store-items.repository';

@Controller('v1/store/items')
@UseGuards(PlayerAuthGuard)
export class StoreController {
  constructor(private readonly items: StoreItemsRepository) {}

  @Get()
  async list(@CurrentPlayer() player: AuthenticatedPlayer): Promise<{ items: StoreItem[] }> {
    return { items: await this.items.listActive(player.tenantId) };
  }
}
