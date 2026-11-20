import { z } from 'zod';
import { constantTimeEquals, hmacSha256 } from '../../../common/crypto';
import { ExternalId } from '../../../common/external-id';
import type { RewardDescriptor } from '../../store/reward-descriptor';
import type {
  CasinoPlatform,
  DepositStatus,
  FreshnessPolicy,
  InboundParseResult,
  InboundRequest,
  RewardApi,
  RewardOutcome,
  RewardRequest,
} from '../casino-platform';
import { requestJson, toRewardOutcome } from '../http-client';
import { invalidEvent, unauthorizedEvent } from '../inbound-errors';
import { assertFresh, singleHeader } from '../signatures';
import { CurrencyCode } from '../wire-schemas';

/*
 * Platform A (simulated):
 *   webhook:  X-Timestamp: <unix s>, X-Signature: sha256=<hex HMAC(secret, "<timestamp>.<raw body>")>
 *             { event_id, event_type: "deposit", player_id, amount_cents, currency, status: SUCCESS|FAILED|PENDING }
 *   rewards:  synchronous, Authorization: Bearer <key>
 *             POST /bonuses { reference, player_id, bonus } → { bonus_id, status: "granted" }
 *             GET  /bonuses/by-reference/:reference → same, or 404
 */

const SIGNATURE_HEADER = 'x-signature';
const TIMESTAMP_HEADER = 'x-timestamp';

const EnvelopeSchema = z.object({ event_id: ExternalId, event_type: z.string().min(1) });

const DepositSchema = EnvelopeSchema.extend({
  event_type: z.literal('deposit'),
  player_id: ExternalId,
  amount_cents: z.number().int().positive(),
  currency: CurrencyCode,
  status: z.enum(['SUCCESS', 'FAILED', 'PENDING']),
});

const STATUS: Record<z.infer<typeof DepositSchema>['status'], DepositStatus> = {
  SUCCESS: 'SUCCEEDED',
  FAILED: 'FAILED',
  PENDING: 'PENDING',
};

const GrantedSchema = z.object({ bonus_id: z.string().min(1), status: z.literal('granted') });

const issued = (body: z.infer<typeof GrantedSchema>): RewardOutcome => ({
  kind: 'ISSUED',
  externalReference: body.bonus_id,
});

const toBonus = (reward: RewardDescriptor) =>
  reward.type === 'FREE_SPINS'
    ? { type: 'free_spins', count: reward.quantity, game: reward.game }
    : { type: 'cash', amount_cents: reward.amountMinor, currency: reward.currency };

const signature = (secret: string, timestamp: string, rawBody: string): string =>
  `sha256=${hmacSha256(secret, `${timestamp}.${rawBody}`).toString('hex')}`;

/** Signs a request exactly as Casino A does. */
export function signPlatformA(rawBody: string, secret: string, timestampSeconds: number): Record<string, string> {
  const timestamp = String(timestampSeconds);
  return { [TIMESTAMP_HEADER]: timestamp, [SIGNATURE_HEADER]: signature(secret, timestamp, rawBody) };
}

export class PlatformA implements CasinoPlatform {
  readonly key = 'platform-a';

  verifyInbound(request: InboundRequest, webhookSecret: string, freshness: FreshnessPolicy): void {
    const timestamp = singleHeader(request.headers, TIMESTAMP_HEADER);
    const provided = singleHeader(request.headers, SIGNATURE_HEADER);
    if (!timestamp || !provided) throw unauthorizedEvent('missing signature headers');

    const expected = signature(webhookSecret, timestamp, request.rawBody.toString('utf8'));
    if (!constantTimeEquals(provided, expected)) throw unauthorizedEvent('invalid signature');
    assertFresh(/^\d+$/.test(timestamp) ? Number(timestamp) : NaN, freshness);
  }

  parseInbound(body: unknown): InboundParseResult {
    const envelope = EnvelopeSchema.safeParse(body);
    if (!envelope.success) throw invalidEvent(envelope.error);
    if (envelope.data.event_type !== 'deposit') {
      return { kind: 'unsupported', externalEventId: envelope.data.event_id, eventType: envelope.data.event_type };
    }

    const deposit = DepositSchema.safeParse(body);
    if (!deposit.success) throw invalidEvent(deposit.error);
    const d = deposit.data;
    return {
      kind: 'deposit',
      event: {
        externalEventId: d.event_id,
        externalPlayerId: d.player_id,
        amountMinor: d.amount_cents,
        currency: d.currency,
        status: STATUS[d.status],
      },
    };
  }

  async issueReward(api: RewardApi, request: RewardRequest): Promise<RewardOutcome> {
    const result = await requestJson(
      `${api.baseUrl}/bonuses`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${api.apiKey}` },
        body: { reference: request.reference, player_id: request.externalPlayerId, bonus: toBonus(request.reward) },
      },
      api.timeoutMs,
    );
    return toRewardOutcome(result, GrantedSchema, issued);
  }

  async rewardStatus(api: RewardApi, reference: string): Promise<RewardOutcome> {
    const result = await requestJson(
      `${api.baseUrl}/bonuses/by-reference/${encodeURIComponent(reference)}`,
      { method: 'GET', headers: { authorization: `Bearer ${api.apiKey}` } },
      api.timeoutMs,
    );
    return toRewardOutcome(result, GrantedSchema, issued, { notFoundOn404: true });
  }
}
