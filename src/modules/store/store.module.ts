import { Module } from '@nestjs/common';
import { PlayersModule } from '../players/players.module';
import { StoreItemsRepository } from './store-items.repository';
import { StoreController } from './store.controller';

@Module({
  imports: [PlayersModule],
  controllers: [StoreController],
  providers: [StoreItemsRepository],
  exports: [StoreItemsRepository],
})
export class StoreModule {}
