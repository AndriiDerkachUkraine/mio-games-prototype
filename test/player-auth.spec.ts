import { sign, type SignOptions } from 'jsonwebtoken';
import request from 'supertest';
import { DEV_TENANTS } from '../src/db/seed';
import { countRows } from './support/db';
import { asPlayer, playerToken } from './support/players';
import { createTestApp, resetDatabase, type TestContext } from './support/test-app';
import { nowSeconds, platformADeposit, sendPlatformA } from './support/webhooks';

const base64url = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');

/** A token as Casino A would sign it; each case breaks exactly one property. */
const tokenA = (
  claims: object = {},
  options: SignOptions = {},
  secret: string = DEV_TENANTS['casino-a'].playerTokenSecret,
) => sign(claims, secret, { issuer: 'casino-a', ...options });

describe('Player authentication', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestApp();
  });
  afterAll(() => ctx.app.close());
  beforeEach(() => resetDatabase(ctx.db));

  it('accepts a casino-signed token and maps the player on first contact', async () => {
    const res = await asPlayer(ctx.app, playerToken('casino-a')).get('/v1/me/spins').expect(200);
    expect(res.body).toEqual({ available: [] });
    expect(await countRows(ctx.db, 'players')).toBe(1);
    expect(await countRows(ctx.db, 'wallets')).toBe(1);
  });

  it.each([
    ['malformed token', 'not-a-jwt'],
    ['wrong signing key', tokenA({}, { subject: 'p', expiresIn: 60 }, 'attacker-key')],
    ['tenant B claimed, signed with tenant A key', tokenA({}, { subject: 'p', expiresIn: 60, issuer: 'casino-b' })],
    ['unknown issuer', tokenA({}, { subject: 'p', expiresIn: 60, issuer: 'casino-x' })],
    ['expired', tokenA({ exp: nowSeconds() - 10 }, { subject: 'p' })],
    ['no expiry', tokenA({}, { subject: 'p' })],
    [
      'issued too long ago (exceeds max age)',
      tokenA({ iat: nowSeconds() - 7200, exp: nowSeconds() + 60 }, { subject: 'p' }),
    ],
    ['no subject', tokenA({}, { expiresIn: 60 })],
    ['subject longer than an external id may be', tokenA({}, { subject: 'x'.repeat(129), expiresIn: 60 })],
    ['algorithm outside the allow-list (HS512)', tokenA({}, { subject: 'p', expiresIn: 60, algorithm: 'HS512' })],
    [
      'unsigned token (alg none)',
      `${base64url({ alg: 'none', typ: 'JWT' })}.${base64url({ iss: 'casino-a', sub: 'p', exp: nowSeconds() + 60 })}.`,
    ],
  ])('rejects %s with 401 and creates no player', async (_name, token) => {
    const res = await asPlayer(ctx.app, token).get('/v1/me/spins');
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('UNAUTHORIZED_PLAYER');
    expect(await countRows(ctx.db, 'players')).toBe(0);
  });

  it.each([
    ['no Authorization header', undefined],
    ['a non-bearer scheme', 'Basic abc'],
  ])('rejects %s with 401', async (_name, header) => {
    const req = request(ctx.app.getHttpServer()).get('/v1/me/spins');
    const res = await (header ? req.set('authorization', header) : req);
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('UNAUTHORIZED_PLAYER');
  });

  it('a new player contacting from both sides at once converges on one player and wallet', async () => {
    const token = playerToken('casino-a', 'newcomer');
    const results = await Promise.all([
      ...Array.from({ length: 5 }, () => asPlayer(ctx.app, token).get('/v1/me/spins')),
      ...Array.from({ length: 5 }, (_, i) =>
        sendPlatformA(ctx.app, platformADeposit({ event_id: `first-${i}`, player_id: 'newcomer' })),
      ),
    ]);
    expect(results.map((r) => r.status)).toEqual(Array(10).fill(200));
    expect(await countRows(ctx.db, 'players')).toBe(1);
    expect(await countRows(ctx.db, 'wallets')).toBe(1);
    expect(await countRows(ctx.db, 'spins')).toBe(5);
  });

  it('rejects tokens of a suspended tenant', async () => {
    await ctx.db.updateTable('tenants').set({ status: 'SUSPENDED' }).where('id', '=', 'casino-a').execute();
    await asPlayer(ctx.app, playerToken('casino-a')).get('/v1/me/spins').expect(401);
  });
});
