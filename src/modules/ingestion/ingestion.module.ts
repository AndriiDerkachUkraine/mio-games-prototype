import { Module } from '@nestjs/common';
import { IntegrationsModule } from '../integrations/integrations.module';
import { PlayersModule } from '../players/players.module';
import { RulesModule } from '../rules/rules.module';
import { TenancyModule } from '../tenancy/tenancy.module';
import { WheelModule } from '../wheel/wheel.module';
import { IngestionController } from './ingestion.controller';
import { IngestionService } from './ingestion.service';

@Module({
  imports: [TenancyModule, IntegrationsModule, PlayersModule, RulesModule, WheelModule],
  controllers: [IngestionController],
  providers: [IngestionService],
})
export class IngestionModule {}
