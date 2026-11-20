import type { IncomingHttpHeaders } from 'node:http';

/** Everything casino-specific (wire format, auth, units, status codes) stays behind this contract. */
export interface CasinoPlatform {
  readonly key: string;
  /** Throws 401 unless the request is signed with the tenant's secret and fresh. */
  verifyInbound(request: InboundRequest, webhookSecret: string, freshness: FreshnessPolicy): void;
  /** Throws 422 when the payload does not match the platform schema. */
  parseInbound(body: unknown): InboundParseResult;
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
