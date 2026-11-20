import { Module } from '@nestjs/common';
import { TenancyModule } from '../tenancy/tenancy.module';
import { PlayersRepository } from './players.repository';

@Module({
  imports: [TenancyModule],
  providers: [PlayersRepository],
  // PlayerAuthGuard is instantiated in each consuming module, so its dependencies must be visible there.
  exports: [PlayersRepository, TenancyModule],
})
export class PlayersModule {}
