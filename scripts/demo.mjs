#!/usr/bin/env node
// End-to-end demo against the compose stack (`docker compose up --build`), using plain HTTP only.
// Walks the assignment's steps 1–8 for both casinos, then the reliability scenarios.
// Exits non-zero on any surprise, so it doubles as a smoke test.

const MIO = process.env.MIO_URL ?? 'http://localhost:3100';
const CASINO = process.env.CASINO_URL ?? 'http://localhost:4100';
const ADMIN_KEYS = { 'casino-a': 'dev-casino-a-admin-key', 'casino-b': 'dev-casino-b-admin-key' };
const run = Date.now().toString(36);

let failures = 0;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const step = (text) => console.log(`\n▸ ${text}`);
const check = (ok, text) => {
  console.log(`  ${ok ? '✓' : '✗'} ${text}`);
  if (!ok) failures++;
};

async function http(base, method, path, { body, headers = {} } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined };
}

const casino = {
  deposit: (tenant, playerId, extra = {}) =>
    http(CASINO, 'POST', `/__simulate/${tenant}/deposit`, { body: { playerId, ...extra } }),
  token: async (tenant, playerId) =>
    (await http(CASINO, 'POST', `/__simulate/${tenant}/player-token`, { body: { playerId } })).body.token,
  fail: (platform, modes, operation = 'issue') =>
    http(CASINO, 'POST', `/__control/${platform}/failures`, { body: { modes, operation } }),
  grants: async (platform) => (await http(CASINO, 'GET', `/__control/${platform}/grants`)).body,
};

const asPlayer = (token) => ({
  get: (path) => http(MIO, 'GET', path, { headers: { authorization: `Bearer ${token}` } }),
  post: (path, body, headers = {}) =>
    http(MIO, 'POST', path, { body, headers: { authorization: `Bearer ${token}`, ...headers } }),
});

async function untilSettled(player, redemptionId) {
  for (let i = 0; i < 60; i++) {
    const { body } = await player.get(`/v1/me/redemptions/${redemptionId}`);
    if (['ISSUED', 'FAILED', 'MANUAL_REVIEW'].includes(body.status)) return body;
    await sleep(500);
  }
  throw new Error(`redemption ${redemptionId} did not settle`);
}

/** Deposits until the player holds at least `coins`, spinning every granted spin. */
async function earnCoins(tenant, playerId, player, coins) {
  for (let i = 0; i < 20; i++) {
    const balance = (await player.get('/v1/me/wallet')).body.balance;
    if (balance >= coins) return balance;
    await casino.deposit(tenant, playerId);
    for (const { spinId } of (await player.get('/v1/me/spins')).body.available) {
      await player.post(`/v1/me/spins/${spinId}/play`);
    }
  }
  throw new Error('could not earn enough coins');
}

async function happyPath(tenant) {
  const playerId = `demo-${tenant}-${run}`;
  const player = asPlayer(await casino.token(tenant, playerId));
  step(`${tenant}: steps 1–3 — the casino sends a successful deposit, MIO grants a spin`);
  const deposit = await casino.deposit(tenant, playerId, { amount: '25.00' });
  console.log('  casino sent:', JSON.stringify(deposit.body.sent));
  check(deposit.body.mio.body.status === 'processed', `MIO answered ${JSON.stringify(deposit.body.mio.body)}`);

  step(`${tenant}: steps 4–5 — the player spins; the server picks the reward and credits coins`);
  const [{ spinId }] = (await player.get('/v1/me/spins')).body.available;
  const spin = await player.post(`/v1/me/spins/${spinId}/play`);
  check(spin.status === 200, `spin → ${spin.body.segment.label} (table v${spin.body.rewardTableVersion})`);
  const replay = await player.post(`/v1/me/spins/${spinId}/play`);
  check(JSON.stringify(replay.body) === JSON.stringify(spin.body), 'replaying the spin returns the same outcome');
  const wallet = (await player.get('/v1/me/wallet')).body;
  check(wallet.entries.length === 1 && wallet.balance === spin.body.segment.coins, `balance ${wallet.balance} coins`);

  step(`${tenant}: steps 6–8 — redeem in the Bonus Store; the casino issues the reward; status is tracked`);
  await earnCoins(tenant, playerId, player, 20);
  const [item] = (await player.get('/v1/store/items')).body.items;
  const redeemed = await player.post(
    '/v1/me/redemptions',
    { itemId: item.itemId },
    { 'idempotency-key': `buy-${run}` },
  );
  check(redeemed.status === 202, `redeem "${item.name}" for ${item.priceCoins} coins → ${redeemed.body.status}`);
  const settled = await untilSettled(player, redeemed.body.redemptionId);
  check(settled.status === 'ISSUED', `delivered: ${settled.history.map((h) => h.to).join(' → ')}`);
}

async function reliability() {
  const tenant = 'casino-a';
  const playerId = `demo-reliability-${run}`;
  const player = asPlayer(await casino.token(tenant, playerId));

  step('C1 — the casino redelivers a deposit');
  await casino.deposit(tenant, playerId, { eventId: `evt-${run}` });
  const again = await casino.deposit(tenant, playerId, { eventId: `evt-${run}` });
  check(again.body.mio.body.status === 'duplicate', 'second delivery acknowledged as duplicate, no extra spin');

  step('C8 — a forged webhook');
  const forged = await http(MIO, 'POST', `/v1/integrations/${tenant}/events`, {
    body: {
      event_id: 'x',
      event_type: 'deposit',
      player_id: playerId,
      amount_cents: 999999,
      currency: 'EUR',
      status: 'SUCCESS',
    },
    headers: { 'x-timestamp': String(Math.floor(Date.now() / 1000)), 'x-signature': 'sha256=forged' },
  });
  check(forged.status === 401, `rejected with ${forged.status} ${forged.body.error}`);

  step('C2 — ten concurrent plays of one spin');
  await casino.deposit(tenant, playerId);
  const [{ spinId }] = (await player.get('/v1/me/spins')).body.available;
  const before = (await player.get('/v1/me/wallet')).body.entries.length;
  const plays = await Promise.all(Array.from({ length: 10 }, () => player.post(`/v1/me/spins/${spinId}/play`)));
  const after = (await player.get('/v1/me/wallet')).body.entries.length;
  check(plays.every((p) => p.status === 200) && after - before === 1, 'all answered, exactly one ledger credit');

  await earnCoins(tenant, playerId, player, 60);
  const [item] = (await player.get('/v1/store/items')).body.items;
  const redeem = (key) => player.post('/v1/me/redemptions', { itemId: item.itemId }, { 'idempotency-key': key });

  step('C3 — the same redemption request sent twice');
  const first = await redeem(`dup-${run}`);
  const second = await redeem(`dup-${run}`);
  check(second.status === 200 && second.body.redemptionId === first.body.redemptionId, 'one redemption, one debit');
  await untilSettled(player, first.body.redemptionId);

  step('C4 — the casino issues the reward but the answer is lost (MIO times out)');
  await casino.fail('platform-a', ['lost-response']);
  const lost = await redeem(`lost-${run}`);
  const lostDone = await untilSettled(player, lost.body.redemptionId);
  const grants = (await casino.grants('platform-a')).filter((g) => g.reference === lost.body.redemptionId);
  check(
    lostDone.status === 'ISSUED' && grants.length === 1,
    `retried with the same reference: ${lostDone.attempts} attempts, 1 grant`,
  );

  step('C5 — the casino refuses the reward');
  const balanceBefore = (await player.get('/v1/me/wallet')).body.balance;
  await casino.fail('platform-a', ['reject']);
  const refused = await redeem(`reject-${run}`);
  const refusedDone = await untilSettled(player, refused.body.redemptionId);
  const balanceAfter = (await player.get('/v1/me/wallet')).body.balance;
  check(refusedDone.status === 'FAILED' && balanceAfter === balanceBefore, 'FAILED and the coins came back');

  step('C7 — tenant isolation');
  const outsider = asPlayer(await casino.token('casino-b', playerId)); // same player id, other casino
  const peek = await outsider.get(`/v1/me/redemptions/${first.body.redemptionId}`);
  check(peek.status === 404, `casino-b's player with the same id gets ${peek.status}`);
  const adminB = await http(MIO, 'GET', '/v1/admin/redemptions?status=ISSUED', {
    headers: { 'x-admin-key': ADMIN_KEYS['casino-b'] },
  });
  check(
    !adminB.body.redemptions.some((r) => r.redemptionId === first.body.redemptionId),
    "casino-b's admin cannot see it",
  );
}

const abort = (reason) => {
  console.error(`\n✗ demo aborted: ${reason}\n  Is the stack up? docker compose up --build`);
  process.exit(1);
};

try {
  const health = await http(MIO, 'GET', '/health');
  if (health.status !== 200) abort(`MIO is not healthy at ${MIO}`);
  await happyPath('casino-a');
  await happyPath('casino-b');
  await reliability();
} catch (err) {
  abort(err.message);
}
console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
