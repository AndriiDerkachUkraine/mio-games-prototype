import type { IncomingHttpHeaders } from 'node:http';
import type { FreshnessPolicy } from './casino-platform';
import { unauthorizedEvent } from './inbound-errors';

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
