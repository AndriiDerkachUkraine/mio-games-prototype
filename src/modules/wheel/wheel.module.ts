import { Module } from '@nestjs/common';
import { LedgerModule } from '../ledger/ledger.module';
import { PlayersModule } from '../players/players.module';
import { RewardTablesRepository } from './reward-tables.repository';
import { SpinsRepository } from './spins.repository';
import { WheelController } from './wheel.controller';
import { WheelService } from './wheel.service';

@Module({
  imports: [PlayersModule, LedgerModule],
  controllers: [WheelController],
  providers: [SpinsRepository, RewardTablesRepository, WheelService],
  exports: [SpinsRepository, RewardTablesRepository],
})
export class WheelModule {}
