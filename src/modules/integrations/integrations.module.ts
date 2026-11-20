import { Module } from '@nestjs/common';
import { PlatformA } from './platform-a/platform-a.platform';
import { PlatformB } from './platform-b/platform-b.platform';
import { PlatformRegistry } from './platform-registry';

@Module({
  providers: [
    { provide: PlatformRegistry, useFactory: () => new PlatformRegistry([new PlatformA(), new PlatformB()]) },
  ],
  exports: [PlatformRegistry],
})
export class IntegrationsModule {}
