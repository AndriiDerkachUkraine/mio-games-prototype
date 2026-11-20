import { randomUUID } from 'node:crypto';
import type { RewardSegment } from '../src/modules/wheel/reward-segments';
import { pickSegment } from '../src/modules/wheel/spin-outcome';

const SECRET = 'unit-test-spin-secret-0123456789abcdef';

const segment = (key: string, weight: number): RewardSegment => ({ key, label: key, coins: 10, weight });

const frequencies = (segments: RewardSegment[], draws: number, secret = SECRET): Record<string, number> => {
  const counts: Record<string, number> = {};
  for (let i = 0; i < draws; i++) {
    const { key } = pickSegment(secret, randomUUID(), segments);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).map(([k, n]) => [k, n / draws]));
};

describe('pickSegment', () => {
  const table = [segment('a', 50), segment('b', 30), segment('c', 15), segment('d', 5)];

  it('is deterministic for a given secret and spin id', () => {
    const spinId = randomUUID();
    const first = pickSegment(SECRET, spinId, table);
    for (let i = 0; i < 20; i++) expect(pickSegment(SECRET, spinId, table)).toBe(first);
  });

  it('depends on the server secret, so outcomes cannot be precomputed without it', () => {
    const ids = Array.from({ length: 200 }, () => randomUUID());
    const withSecret = ids.map((id) => pickSegment(SECRET, id, table).key);
    const withOther = ids.map((id) => pickSegment('another-secret-0123456789abcdef0123', id, table).key);
    const same = withSecret.filter((key, i) => key === withOther[i]).length;
    expect(same).toBeLessThan(150); // independent draws agree ~37% of the time (sum of squared weights)
  });

  it('follows the configured weights', () => {
    const observed = frequencies(table, 50_000);
    const expected = { a: 0.5, b: 0.3, c: 0.15, d: 0.05 };
    // ±0.01 is ~4.5 standard deviations at 50k draws: stable, yet catches a wrong mapping.
    for (const [key, p] of Object.entries(expected)) expect(Math.abs(observed[key] - p)).toBeLessThan(0.01);
  });

  it('is unbiased for a total weight that does not divide the draw range', () => {
    const observed = frequencies([segment('x', 1), segment('y', 1), segment('z', 1)], 30_000);
    for (const key of ['x', 'y', 'z']) expect(Math.abs(observed[key] - 1 / 3)).toBeLessThan(0.015);
  });

  it('redraws instead of folding rejected draws onto low segments', () => {
    // Total weight just above 2^47 makes ~50% of raw draws fall into the rejected tail.
    const huge = [segment('only', 2 ** 47 + 1)];
    for (let i = 0; i < 50; i++) expect(pickSegment(SECRET, randomUUID(), huge).key).toBe('only');
  });

  it('refuses a table without positive total weight', () => {
    expect(() => pickSegment(SECRET, randomUUID(), [segment('zero', 0)])).toThrow(/Invalid total weight/);
  });
});
