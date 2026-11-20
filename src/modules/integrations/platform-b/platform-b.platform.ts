import { z } from 'zod';
import { constantTimeEquals, hmacSha256 } from '../../../common/crypto';
import { ExternalId } from '../../../common/external-id';
import type {
  CasinoPlatform,
  DepositStatus,
  FreshnessPolicy,
  InboundParseResult,
  InboundRequest,
} from '../casino-platform';
import { invalidEvent, unauthorizedEvent } from '../inbound-errors';
import { assertFresh, singleHeader } from '../signatures';
import { CurrencyCode, PositiveDecimalAmount } from '../wire-schemas';

/*
 * Platform B (simulated), deliberately unlike Platform A:
 *   X-PB-Signature: <base64 HMAC(secret, raw body)>; the timestamp travels inside the signed body
 *   { notificationId, timestamp, type: "PAYMENT", data: { operation: "DEPOSIT", amount: "50.00",
 *     currency, customer: { ref }, state: 1 pending | 2 approved | 3 declined } }
 */

const SIGNATURE_HEADER = 'x-pb-signature';

const SignedTimestampSchema = z.object({ timestamp: z.number().int() });

const EnvelopeSchema = SignedTimestampSchema.extend({
  notificationId: ExternalId,
  type: z.string().min(1),
  data: z.object({ operation: z.string().min(1) }).loose(),
});

const DepositSchema = EnvelopeSchema.extend({
  type: z.literal('PAYMENT'),
  data: z.object({
    operation: z.literal('DEPOSIT'),
    state: z.union([z.literal(1), z.literal(2), z.literal(3)]),
    amount: PositiveDecimalAmount,
    currency: CurrencyCode,
    customer: z.object({ ref: ExternalId }),
  }),
});

const STATE: Record<1 | 2 | 3, DepositStatus> = { 1: 'PENDING', 2: 'SUCCEEDED', 3: 'FAILED' };

const signature = (secret: string, rawBody: string): string => hmacSha256(secret, rawBody).toString('base64');

/** Signs a request exactly as Casino B does. */
export function signPlatformB(rawBody: string, secret: string): Record<string, string> {
  return { [SIGNATURE_HEADER]: signature(secret, rawBody) };
}

export class PlatformB implements CasinoPlatform {
  readonly key = 'platform-b';

  verifyInbound(request: InboundRequest, webhookSecret: string, freshness: FreshnessPolicy): void {
    const provided = singleHeader(request.headers, SIGNATURE_HEADER);
    if (!provided) throw unauthorizedEvent('missing signature header');

    const expected = signature(webhookSecret, request.rawBody.toString('utf8'));
    if (!constantTimeEquals(provided, expected)) throw unauthorizedEvent('invalid signature');
    // Only now is the body authentic, so its timestamp can be trusted.
    const signed = SignedTimestampSchema.safeParse(request.body);
    assertFresh(signed.success ? signed.data.timestamp : NaN, freshness);
  }

  parseInbound(body: unknown): InboundParseResult {
    const envelope = EnvelopeSchema.safeParse(body);
    if (!envelope.success) throw invalidEvent(envelope.error);
    const { notificationId, type, data } = envelope.data;
    if (type !== 'PAYMENT' || data.operation !== 'DEPOSIT') {
      return { kind: 'unsupported', externalEventId: notificationId, eventType: `${type}/${data.operation}` };
    }

    const deposit = DepositSchema.safeParse(body);
    if (!deposit.success) throw invalidEvent(deposit.error);
    const d = deposit.data.data;
    return {
      kind: 'deposit',
      event: {
        externalEventId: notificationId,
        externalPlayerId: d.customer.ref,
        amountMinor: d.amount,
        currency: d.currency,
        status: STATE[d.state],
      },
    };
  }
}
