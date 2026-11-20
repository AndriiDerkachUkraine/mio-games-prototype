import type { IncomingHttpHeaders } from 'node:http';
import type { RewardDescriptor } from '../store/reward-descriptor';

/** Everything casino-specific (wire format, auth, units, status codes) stays behind this contract. */
export interface CasinoPlatform {
  readonly key: string;
  /** Throws 401 unless the request is signed with the tenant's secret and fresh. */
  verifyInbound(request: InboundRequest, webhookSecret: string, freshness: FreshnessPolicy): void;
  /** Throws 422 when the payload does not match the platform schema. */
  parseInbound(body: unknown): InboundParseResult;
  /** Must be idempotent on `request.reference`: retries after a timeout reuse it. Never throws. */
  issueReward(api: RewardApi, request: RewardRequest): Promise<RewardOutcome>;
  /** Looks the reward up by our reference; used to poll async issuance and to reconcile. Never throws. */
  rewardStatus(api: RewardApi, reference: string): Promise<RewardOutcome>;
}

export interface InboundRequest {
  /** Exact bytes the signature covers. */
  rawBody: Buffer;
  /** The same bytes parsed as JSON; trustworthy only after the signature check. */
  body: unknown;
  headers: IncomingHttpHeaders;
}

export interface FreshnessPolicy {
  nowSeconds: number;
  toleranceSeconds: number;
}

export type DepositStatus = 'SUCCEEDED' | 'FAILED' | 'PENDING';

/** The only deposit shape the core sees. */
export interface DepositEvent {
  externalEventId: string;
  externalPlayerId: string;
  amountMinor: number;
  currency: string;
  status: DepositStatus;
}

export type InboundParseResult =
  | { kind: 'deposit'; event: DepositEvent }
  // Well-formed but not acted on (e.g. withdrawal): recorded for dedup and audit only.
  | { kind: 'unsupported'; externalEventId: string; eventType: string };

/** The tenant's reward endpoint. */
export interface RewardApi {
  baseUrl: string;
  apiKey: string;
  timeoutMs: number;
}

export interface RewardRequest {
  /** Our redemption id: the casino's idempotency key for this issuance. */
  reference: string;
  externalPlayerId: string;
  reward: RewardDescriptor;
}

export type RewardOutcome =
  | { kind: 'ISSUED'; externalReference: string }
  /** Accepted, completion reported later through rewardStatus. */
  | { kind: 'PENDING'; externalReference: string }
  /** Definitively not issued: safe to refund. */
  | { kind: 'REJECTED'; reason: string }
  /** The casino has no record of the reference (rewardStatus only). */
  | { kind: 'NOT_FOUND' }
  /** Outcome unknown (timeout, 5xx, 429, network): never refund on this alone. */
  | { kind: 'RETRYABLE'; reason: string };
