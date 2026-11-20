import { Module } from '@nestjs/common';
import { SpinsRepository } from './spins.repository';

@Module({ providers: [SpinsRepository], exports: [SpinsRepository] })
export class WheelModule {}
