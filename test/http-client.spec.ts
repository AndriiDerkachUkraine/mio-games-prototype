import { z } from 'zod';
import type { RewardOutcome } from '../src/modules/integrations/casino-platform';
import { requestJson, toRewardOutcome } from '../src/modules/integrations/http-client';
import { startMockCasino, type MockCasinoHandle } from './support/mock-casino';

const Body = z.object({ id: z.string() });
const issued = (b: { id: string }): RewardOutcome => ({ kind: 'ISSUED', externalReference: b.id });
const classify = (result: Parameters<typeof toRewardOutcome>[0], notFoundOn404 = false) =>
  toRewardOutcome(result, Body, issued, { notFoundOn404 });

describe('reward call classification', () => {
  it.each<[string, Parameters<typeof toRewardOutcome>[0], RewardOutcome['kind']]>([
    ['a well-formed 2xx', { ok: true, status: 201, body: { id: 'x' } }, 'ISSUED'],
    ['a 2xx with an unreadable body (outcome unknown)', { ok: true, status: 200, body: '<html>' }, 'RETRYABLE'],
    ['a transport failure', { ok: false, reason: 'timeout after 300ms' }, 'RETRYABLE'],
    ['a 5xx', { ok: true, status: 503, body: undefined }, 'RETRYABLE'],
    ['a 429', { ok: true, status: 429, body: undefined }, 'RETRYABLE'],
    ['an explicit 4xx refusal', { ok: true, status: 422, body: { error: 'NOT_ELIGIBLE' } }, 'REJECTED'],
    ['a 404 on issuance', { ok: true, status: 404, body: undefined }, 'REJECTED'],
  ])('%s → %s', (_name, result, kind) => {
    expect(classify(result).kind).toBe(kind);
  });

  it('a 404 on a status lookup means the casino holds nothing', () => {
    expect(classify({ ok: true, status: 404, body: undefined }, true)).toEqual({ kind: 'NOT_FOUND' });
  });
});

describe('requestJson', () => {
  let casino: MockCasinoHandle;

  beforeAll(async () => {
    casino = await startMockCasino();
  });
  afterAll(() => casino.close());

  it('keeps a non-JSON error page as text instead of throwing', async () => {
    const result = await requestJson(`${casino.url}/no-such-route`, { method: 'GET', headers: {} }, 1000);
    expect(result).toEqual({ ok: true, status: 404, body: expect.stringContaining('Cannot GET') });
  });

  it('reports a timeout as a transport failure', async () => {
    await casino.fail('platform-a', ['timeout']);
    const result = await requestJson(
      `${casino.url}/platform-a/bonuses`,
      {
        method: 'POST',
        headers: { authorization: 'Bearer dev-casino-a-reward-api-key' },
        body: { reference: 'r', player_id: 'p', bonus: {} },
      },
      100,
    );
    expect(result).toEqual({ ok: false, reason: 'timeout after 100ms' });
  });

  it('reports an unreachable host as a transport failure', async () => {
    const result = await requestJson('http://127.0.0.1:1/x', { method: 'GET', headers: {} }, 1000);
    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining('network error') });
  });
});
