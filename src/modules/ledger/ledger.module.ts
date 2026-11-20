import { Module } from '@nestjs/common';
import { PlayersModule } from '../players/players.module';
import { LedgerService } from './ledger.service';
import { WalletController } from './wallet.controller';

@Module({
  imports: [PlayersModule],
  controllers: [WalletController],
  providers: [LedgerService],
  exports: [LedgerService],
})
export class LedgerModule {}
