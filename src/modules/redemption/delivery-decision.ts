import type { RewardOutcome } from '../integrations/casino-platform';

export type InFlightStatus = 'PENDING' | 'AWAITING_CONFIRMATION';

export type Transition =
  | { status: 'ISSUED'; externalReference: string }
  /** Definitively not issued: the coins go back to the player. */
  | { status: 'FAILED'; reason: string }
  /** Outcome cannot be established: a human decides, coins stay debited. */
  | { status: 'MANUAL_REVIEW'; reason: string }
  | { status: InFlightStatus; retry: true; reason: string; externalReference?: string };

/**
 * The delivery state machine. `exhausted` means this was the last attempt; by then any unknown outcome
 * has already been reconciled through the casino's status endpoint.
 */
export function decide(current: InFlightStatus, outcome: RewardOutcome, exhausted: boolean): Transition {
  switch (outcome.kind) {
    case 'ISSUED':
      return { status: 'ISSUED', externalReference: outcome.externalReference };
    case 'REJECTED':
      return { status: 'FAILED', reason: outcome.reason };
    case 'PENDING':
      return exhausted
        ? { status: 'MANUAL_REVIEW', reason: 'accepted by the casino but never completed' }
        : {
            status: 'AWAITING_CONFIRMATION',
            retry: true,
            reason: 'accepted',
            externalReference: outcome.externalReference,
          };
    case 'NOT_FOUND':
      // The casino confirms it holds nothing for our reference: refund if out of attempts, else issue again.
      return exhausted
        ? { status: 'FAILED', reason: 'casino has no record of the reward' }
        : { status: 'PENDING', retry: true, reason: 'casino has no record; re-issuing' };
    case 'RETRYABLE':
      return exhausted
        ? { status: 'MANUAL_REVIEW', reason: `outcome unknown: ${outcome.reason}` }
        : { status: current, retry: true, reason: outcome.reason };
  }
}

/** Exponential backoff with jitter, so retries of many failed deliveries do not arrive in lockstep. */
export function retryDelayMs(attempt: number, baseMs: number, maxMs: number, random = Math.random): number {
  const exponential = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt - 1));
  return Math.round(exponential * (0.5 + random() / 2));
}
