import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { z } from 'zod';
import { DomainError } from '../../common/domain-error';
import { APP_CONFIG, type AppConfig } from '../../config';
import { DB, type Db } from '../../db/db.provider';
import { LedgerService } from '../ledger/ledger.service';
import type { AuthenticatedPlayer } from '../players/player-auth.guard';
import { RewardTablesRepository } from './reward-tables.repository';
import { pickSegment } from './spin-outcome';
import { SpinsRepository, type PlayedSpin } from './spins.repository';

export type SpinResult = PlayedSpin & { spinId: string };

const SpinId = z.uuid();
const spinNotFound = (): DomainError => new DomainError(HttpStatus.NOT_FOUND, 'SPIN_NOT_FOUND', 'spin not found');

@Injectable()
export class WheelService {
  constructor(
    @InjectPinoLogger(WheelService.name) private readonly logger: PinoLogger,
    @Inject(DB) private readonly db: Db,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly rewardTables: RewardTablesRepository,
    private readonly spins: SpinsRepository,
    private readonly ledger: LedgerService,
  ) {}

  /** Idempotent: playing an already played spin returns its stored outcome and credits nothing. */
  async play(player: AuthenticatedPlayer, spinId: string): Promise<SpinResult> {
    if (!SpinId.safeParse(spinId).success) throw spinNotFound();

    const table = await this.rewardTables.getActive(player.tenantId);
    const segment = pickSegment(this.config.SPIN_SEED_SECRET, spinId, table.segments);

    const playedAt = await this.db.transaction().execute(async (tx) => {
      const claimedAt = await this.spins.claim(tx, player, spinId, { rewardTableId: table.id, segment });
      if (!claimedAt) return undefined;
      await this.ledger.post(tx, {
        tenantId: player.tenantId,
        playerId: player.playerId,
        amount: segment.coins,
        kind: 'SPIN_REWARD',
        referenceId: spinId,
        idempotencyKey: `spin:${spinId}`,
      });
      return claimedAt;
    });

    if (playedAt) {
      this.logger.info(
        { tenantId: player.tenantId, spinId, segment: segment.key, coins: segment.coins },
        'spin played',
      );
      const { key, label, coins } = segment;
      return { spinId, segment: { key, label, coins }, rewardTableVersion: table.version, playedAt };
    }
    // Replay, or a concurrent request won the claim: answer with what was actually recorded.
    const played = await this.spins.findPlayed(player, spinId);
    if (!played) throw spinNotFound();
    return { spinId, ...played };
  }
}
