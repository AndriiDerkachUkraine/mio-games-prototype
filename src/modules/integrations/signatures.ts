import { createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';
import type { FreshnessPolicy } from './casino-platform';
import { unauthorizedEvent } from './inbound-errors';

export const hmacSha256 = (secret: string, data: string | Buffer): Buffer =>
  createHmac('sha256', secret).update(data).digest();

/** Constant time, so a mismatch does not leak how many leading characters matched. */
export function constantTimeEquals(actual: string, expected: string): boolean {
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function singleHeader(headers: IncomingHttpHeaders, name: string): string | undefined {
  const value = headers[name];
  return typeof value === 'string' ? value : undefined;
}

/** Replay protection: a captured signed request expires after the tolerance window. */
export function assertFresh(timestampSeconds: number, freshness: FreshnessPolicy): void {
  if (!Number.isSafeInteger(timestampSeconds)) throw unauthorizedEvent('invalid timestamp');
  if (Math.abs(freshness.nowSeconds - timestampSeconds) > freshness.toleranceSeconds) {
    throw unauthorizedEvent('timestamp outside the accepted window');
  }
}
