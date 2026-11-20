import { Module } from '@nestjs/common';
import { IntegrationsModule } from '../integrations/integrations.module';
import { LedgerModule } from '../ledger/ledger.module';
import { PlayersModule } from '../players/players.module';
import { StoreModule } from '../store/store.module';
import { DeliveryProcessor } from './delivery.processor';
import { DeliveryWorker } from './delivery.worker';
import { ManualReviewService } from './manual-review.service';
import { RedemptionService } from './redemption.service';
import { RedemptionsController } from './redemptions.controller';
import { RedemptionsRepository } from './redemptions.repository';

@Module({
  imports: [PlayersModule, LedgerModule, StoreModule, IntegrationsModule],
  controllers: [RedemptionsController],
  providers: [RedemptionsRepository, RedemptionService, DeliveryProcessor, DeliveryWorker, ManualReviewService],
  exports: [ManualReviewService],
})
export class RedemptionModule {}
