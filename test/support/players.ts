import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { DEV_TENANTS, type DevTenantId } from '../../src/db/seed';
import { DB, type Db } from '../../src/db/db.provider';
import { LedgerService } from '../../src/modules/ledger/ledger.service';
import { issuePlayerToken } from '../../src/modules/players/player-token';
import { PlayersRepository } from '../../src/modules/players/players.repository';
import { platformADeposit, platformBDeposit, sendPlatformA, sendPlatformB } from './webhooks';

export const playerToken = (tenantId: DevTenantId, externalPlayerId = 'player-1'): string =>
  issuePlayerToken(tenantId, externalPlayerId, DEV_TENANTS[tenantId].playerTokenSecret);

/** Player API client authenticated with the given bearer token. */
export function asPlayer(app: INestApplication, token: string) {
  const server = app.getHttpServer();
  return {
    get: (path: string) => request(server).get(path).set('authorization', `Bearer ${token}`),
    post: (path: string) => request(server).post(path).set('authorization', `Bearer ${token}`),
  };
}

let depositSeq = 0;

/** Sends `count` successful deposits through the tenant's casino integration; returns all available spin ids. */
export async function grantSpins(
  app: INestApplication,
  tenantId: DevTenantId,
  externalPlayerId = 'player-1',
  count = 1,
): Promise<string[]> {
  for (let i = 0; i < count; i++) {
    const id = `deposit-${++depositSeq}`;
    const send =
      tenantId === 'casino-a'
        ? sendPlatformA(app, platformADeposit({ event_id: id, player_id: externalPlayerId }))
        : sendPlatformB(app, platformBDeposit({ notificationId: id, data: { customer: { ref: externalPlayerId } } }));
    await send.expect(200);
  }
  const res = await asPlayer(app, playerToken(tenantId, externalPlayerId)).get('/v1/me/spins').expect(200);
  return res.body.available.map((s: { spinId: string }) => s.spinId);
}

/** Test setup shortcut: credits coins straight through the ledger, as a played spin would. */
export async function creditCoins(
  app: INestApplication,
  tenantId: DevTenantId,
  amount: number,
  externalPlayerId = 'player-1',
): Promise<void> {
  const players = app.get(PlayersRepository);
  const ledger = app.get(LedgerService);
  await app
    .get<Db>(DB)
    .transaction()
    .execute(async (tx) => {
      const playerId = await players.resolve(tx, tenantId, externalPlayerId);
      const referenceId = randomUUID();
      await ledger.post(tx, {
        tenantId,
        playerId,
        amount,
        kind: 'SPIN_REWARD',
        referenceId,
        idempotencyKey: referenceId,
      });
    });
}
