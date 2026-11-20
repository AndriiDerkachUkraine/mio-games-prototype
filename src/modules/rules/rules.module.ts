import { Module } from '@nestjs/common';
import { RulesEngine } from './rules.engine';
import { RulesRepository } from './rules.repository';

@Module({ providers: [RulesEngine, RulesRepository], exports: [RulesEngine, RulesRepository] })
export class RulesModule {}
