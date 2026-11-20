import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { APP_CONFIG, type AppConfig } from '../../config';
import { DB, type Db, type Tx } from '../../db/db.provider';
import type { InboundParseResult, InboundRequest } from '../integrations/casino-platform';
import { unauthorizedEvent } from '../integrations/inbound-errors';
import { PlatformRegistry } from '../integrations/platform-registry';
import { PlayersRepository } from '../players/players.repository';
import { RulesEngine } from '../rules/rules.engine';
import { TenantsRepository } from '../tenancy/tenants.repository';
import { SpinsRepository } from '../wheel/spins.repository';

export type IngestionResult =
  | { status: 'processed'; eventId: string; spinsGranted: number }
  | { status: 'ignored'; eventId: string; reason: string }
  | { status: 'duplicate'; eventId: string };

@Injectable()
export class IngestionService {
  constructor(
    @InjectPinoLogger(IngestionService.name) private readonly logger: PinoLogger,
    @Inject(DB) private readonly db: Db,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly tenants: TenantsRepository,
    private readonly platforms: PlatformRegistry,
    private readonly players: PlayersRepository,
    private readonly rules: RulesEngine,
    private readonly spins: SpinsRepository,
  ) {}

  async receive(tenantId: string, request: InboundRequest): Promise<IngestionResult> {
    // The URL names the tenant; nothing is trusted until its secret verifies the signature.
    const tenant = await this.tenants.findActive(tenantId);
    if (!tenant) throw unauthorizedEvent('unknown tenant');
    const platform = this.platforms.get(tenant.platform);
    platform.verifyInbound(request, tenant.webhook_secret, {
      nowSeconds: Math.floor(Date.now() / 1000),
      toleranceSeconds: this.config.WEBHOOK_TOLERANCE_SECONDS,
    });
    const parsed = platform.parseInbound(request.body);

    const result = await this.db.transaction().execute((tx) => this.record(tx, tenant.id, parsed, request.body));
    this.logger.info({ tenantId: tenant.id, ...result }, 'inbound event handled');
    return result;
  }

  /** The event row (dedup anchor) and the spins it grants commit atomically. */
  private async record(
    tx: Tx,
    tenantId: string,
    parsed: InboundParseResult,
    payload: unknown,
  ): Promise<IngestionResult> {
    if (parsed.kind === 'unsupported') {
      const reason = `unsupported event type "${parsed.eventType}"`;
      const eventId = await this.insertEvent(tx, {
        tenantId,
        externalEventId: parsed.externalEventId,
        eventType: parsed.eventType,
        ignoreReason: reason,
        playerId: null,
        payload,
      });
      return eventId ? { status: 'ignored', eventId, reason } : this.duplicate(tx, tenantId, parsed.externalEventId);
    }

    const deposit = parsed.event;
    const playerId = await this.players.resolve(tx, tenantId, deposit.externalPlayerId);
    const reason = deposit.status === 'SUCCEEDED' ? null : `deposit status ${deposit.status}`;
    const eventId = await this.insertEvent(tx, {
      tenantId,
      externalEventId: deposit.externalEventId,
      eventType: 'DEPOSIT',
      ignoreReason: reason,
      playerId,
      payload,
    });
    if (!eventId) return this.duplicate(tx, tenantId, deposit.externalEventId);
    if (reason) return { status: 'ignored', eventId, reason };

    const grants = await this.rules.evaluateDeposit(tx, tenantId, deposit);
    const spinsGranted = await this.spins.grant(tx, { tenantId, playerId, sourceEventId: eventId }, grants);
    return { status: 'processed', eventId, spinsGranted };
  }

  /** undefined = already recorded (unique tenant_id + external_event_id). */
  private async insertEvent(
    tx: Tx,
    e: {
      tenantId: string;
      externalEventId: string;
      eventType: string;
      ignoreReason: string | null;
      playerId: string | null;
      payload: unknown;
    },
  ): Promise<string | undefined> {
    const row = await tx
      .insertInto('inbound_events')
      .values({
        tenant_id: e.tenantId,
        external_event_id: e.externalEventId,
        event_type: e.eventType,
        status: e.ignoreReason ? 'IGNORED' : 'PROCESSED',
        ignore_reason: e.ignoreReason,
        player_id: e.playerId,
        payload: JSON.stringify(e.payload),
      })
      .onConflict((oc) => oc.columns(['tenant_id', 'external_event_id']).doNothing())
      .returning('id')
      .executeTakeFirst();
    return row?.id;
  }

  private async duplicate(tx: Tx, tenantId: string, externalEventId: string): Promise<IngestionResult> {
    const { id } = await tx
      .selectFrom('inbound_events')
      .select('id')
      .where('tenant_id', '=', tenantId)
      .where('external_event_id', '=', externalEventId)
      .executeTakeFirstOrThrow();
    return { status: 'duplicate', eventId: id };
  }
}
