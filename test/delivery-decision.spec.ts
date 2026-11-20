import type { RewardOutcome } from '../src/modules/integrations/casino-platform';
import { decide, retryDelayMs, type InFlightStatus } from '../src/modules/redemption/delivery-decision';

const issued: RewardOutcome = { kind: 'ISSUED', externalReference: 'ext-1' };
const pending: RewardOutcome = { kind: 'PENDING', externalReference: 'ext-1' };
const rejected: RewardOutcome = { kind: 'REJECTED', reason: 'blocked' };
const notFound: RewardOutcome = { kind: 'NOT_FOUND' };
const retryable: RewardOutcome = { kind: 'RETRYABLE', reason: 'timeout after 300ms' };

describe('delivery decision', () => {
  it.each<[string, InFlightStatus, RewardOutcome, boolean, object]>([
    ['issued', 'PENDING', issued, false, { status: 'ISSUED', externalReference: 'ext-1' }],
    ['issued on the last attempt', 'PENDING', issued, true, { status: 'ISSUED' }],
    ['rejected → refund', 'PENDING', rejected, false, { status: 'FAILED', reason: 'blocked' }],
    ['accepted asynchronously', 'PENDING', pending, false, { status: 'AWAITING_CONFIRMATION', retry: true }],
    ['still pending at the end', 'AWAITING_CONFIRMATION', pending, true, { status: 'MANUAL_REVIEW' }],
    ['unknown outcome → retry in place', 'PENDING', retryable, false, { status: 'PENDING', retry: true }],
    ['poll failed → keep polling', 'AWAITING_CONFIRMATION', retryable, false, { status: 'AWAITING_CONFIRMATION' }],
    ['unknown at the end → human, no refund', 'PENDING', retryable, true, { status: 'MANUAL_REVIEW' }],
    ['casino lost the order → issue again', 'AWAITING_CONFIRMATION', notFound, false, { status: 'PENDING' }],
    ['casino has nothing at the end → refund', 'PENDING', notFound, true, { status: 'FAILED' }],
  ])('%s', (_name, current, outcome, exhausted, expected) => {
    expect(decide(current, outcome, exhausted)).toMatchObject(expected);
  });

  it('never refunds (FAILED) on an unknown outcome', () => {
    for (const current of ['PENDING', 'AWAITING_CONFIRMATION'] as const) {
      for (const exhausted of [false, true]) {
        expect(decide(current, retryable, exhausted).status).not.toBe('FAILED');
      }
    }
  });
});

describe('retryDelayMs', () => {
  it('grows exponentially and is capped', () => {
    const noJitter = () => 1;
    expect([1, 2, 3, 4].map((a) => retryDelayMs(a, 1000, 60_000, noJitter))).toEqual([1000, 2000, 4000, 8000]);
    expect(retryDelayMs(20, 1000, 60_000, noJitter)).toBe(60_000);
  });

  it('applies jitter between half and the full delay', () => {
    expect(retryDelayMs(3, 1000, 60_000, () => 0)).toBe(2000);
    expect(retryDelayMs(3, 1000, 60_000, () => 1)).toBe(4000);
  });
});
