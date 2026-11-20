import { Inject, Injectable, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { APP_CONFIG, type AppConfig } from '../../config';
import { DeliveryProcessor } from './delivery.processor';
import { RedemptionsRepository } from './redemptions.repository';

const BATCH_SIZE = 10;

/** Polls the redemptions table for due deliveries. In production this loop would run as its own deployment. */
@Injectable()
export class DeliveryWorker implements OnApplicationBootstrap, OnApplicationShutdown {
  private timer?: NodeJS.Timeout;
  private inFlight?: Promise<number>;

  constructor(
    @InjectPinoLogger(DeliveryWorker.name) private readonly logger: PinoLogger,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly redemptions: RedemptionsRepository,
    private readonly processor: DeliveryProcessor,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.config.WORKER_ENABLED) return;
    this.timer = setInterval(() => void this.tick(), this.config.WORKER_POLL_INTERVAL_MS);
  }

  async onApplicationShutdown(): Promise<void> {
    clearInterval(this.timer);
    await this.inFlight; // let the current batch finish recording its outcomes
  }

  /** Claims and processes one batch; returns how many jobs it handled. Tests call this directly. */
  async runOnce(): Promise<number> {
    const jobs = await this.redemptions.claimDue(BATCH_SIZE, this.config.WORKER_LEASE_SECONDS);
    for (const job of jobs) {
      try {
        await this.processor.process(job);
      } catch (err) {
        // The lease expires and the job is retried; nothing was recorded for this attempt.
        this.logger.error({ err, redemptionId: job.id }, 'delivery attempt crashed');
      }
    }
    return jobs.length;
  }

  private async tick(): Promise<void> {
    if (this.inFlight) return;
    this.inFlight = this.runOnce().catch((err: unknown) => {
      this.logger.error({ err }, 'delivery batch failed');
      return 0;
    });
    await this.inFlight;
    this.inFlight = undefined;
  }
}
