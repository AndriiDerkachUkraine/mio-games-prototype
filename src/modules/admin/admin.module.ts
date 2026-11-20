import { Module } from '@nestjs/common';
import { RedemptionModule } from '../redemption/redemption.module';
import { RulesModule } from '../rules/rules.module';
import { StoreModule } from '../store/store.module';
import { TenancyModule } from '../tenancy/tenancy.module';
import { WheelModule } from '../wheel/wheel.module';
import { AdminController } from './admin.controller';

@Module({
  imports: [TenancyModule, WheelModule, StoreModule, RulesModule, RedemptionModule],
  controllers: [AdminController],
})
export class AdminModule {}
