import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { APP_CONFIG, type AppConfig } from '../../config';
import { DB, type Db } from '../../db/db.provider';
import type { RewardOutcome } from '../integrations/casino-platform';
import { PlatformRegistry } from '../integrations/platform-registry';
import { LedgerService } from '../ledger/ledger.service';
import { RewardDescriptorSchema } from '../store/reward-descriptor';
import { TenantsRepository } from '../tenancy/tenants.repository';
import { decide, retryDelayMs, type InFlightStatus, type Transition } from './delivery-decision';
import { RedemptionsRepository, type DeliveryJob } from './redemptions.repository';

/** One delivery attempt for one leased job: call the casino (outside any DB transaction), then record the outcome. */
@Injectable()
export class DeliveryProcessor {
  constructor(
    @InjectPinoLogger(DeliveryProcessor.name) private readonly logger: PinoLogger,
    @Inject(DB) private readonly db: Db,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly tenants: TenantsRepository,
    private readonly platforms: PlatformRegistry,
    private readonly redemptions: RedemptionsRepository,
    private readonly ledger: LedgerService,
  ) {}

  async process(job: DeliveryJob): Promise<void> {
    const current = job.status as InFlightStatus;
    const exhausted = job.attempts >= this.config.REDEMPTION_MAX_ATTEMPTS;
    const outcome = await this.callCasino(job, current, exhausted);
    const transition = decide(current, outcome, exhausted);
    await this.record(job, current, transition);
  }

  private async callCasino(job: DeliveryJob, current: InFlightStatus, exhausted: boolean): Promise<RewardOutcome> {
    const tenant = await this.tenants.get(job.tenant_id);
    const platform = this.platforms.get(tenant.platform);
    const api = {
      baseUrl: tenant.reward_api_base_url,
      apiKey: tenant.reward_api_key,
      timeoutMs: tenant.reward_api_timeout_ms,
    };

    if (current === 'AWAITING_CONFIRMATION') return platform.rewardStatus(api, job.id);
    const outcome = await platform.issueReward(api, {
      reference: job.id,
      externalPlayerId: job.external_player_id,
      reward: RewardDescriptorSchema.parse(job.reward),
    });
    // Last attempt and still unknown: ask the casino what actually happened before deciding about the coins.
    return exhausted && outcome.kind === 'RETRYABLE' ? platform.rewardStatus(api, job.id) : outcome;
  }

  private async record(job: DeliveryJob, from: InFlightStatus, t: Transition): Promise<void> {
    const retryInMs =
      'retry' in t ? retryDelayMs(job.attempts, this.config.RETRY_BASE_DELAY_MS, this.config.RETRY_MAX_DELAY_MS) : 0;
    const recorded = await this.db.transaction().execute(async (tx) => {
      const owned = await this.redemptions.finishAttempt(
        tx,
        { id: job.id, leaseToken: job.lease_token as string },
        {
          status: t.status,
          externalReference: 'externalReference' in t ? t.externalReference : undefined,
          failureReason: t.status === 'FAILED' || t.status === 'MANUAL_REVIEW' ? t.reason : undefined,
          retryInMs,
        },
      );
      if (!owned) return false;
      if (t.status === 'FAILED') {
        await this.ledger.post(tx, {
          tenantId: job.tenant_id,
          playerId: job.player_id,
          amount: job.price_coins,
          kind: 'REDEMPTION_REFUND',
          referenceId: job.id,
          idempotencyKey: `redemption:${job.id}:refund`,
        });
      }
      await this.redemptions.addEvent(tx, {
        redemptionId: job.id,
        tenantId: job.tenant_id,
        from,
        to: t.status,
        detail: `attempt ${job.attempts}: ${'reason' in t ? t.reason : 'issued'}`,
      });
      return true;
    });

    const log = { tenantId: job.tenant_id, redemptionId: job.id, attempt: job.attempts, to: t.status };
    if (!recorded) return this.logger.warn(log, 'lease lost; another worker owns the delivery now');
    if (t.status === 'MANUAL_REVIEW') return this.logger.error({ ...log, reason: t.reason }, 'delivery needs review');
    this.logger.info(log, 'delivery attempt recorded');
  }
}
