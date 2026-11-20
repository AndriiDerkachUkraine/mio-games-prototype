import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { DEV_TENANTS } from '../../src/db/seed';
import { createMockCasino, type Platform } from '../../src/mock-casino/mock-casino';

export interface MockGrant {
  reference: string;
  playerId: string;
  reward: unknown;
  state: string;
}

export interface MockCasinoHandle {
  url: string;
  /** Queues failure modes consumed by the next calls of one operation (see mock-casino.ts). */
  fail(platform: Platform, modes: string[], operation?: 'issue' | 'status'): Promise<void>;
  grants(platform: Platform): Promise<MockGrant[]>;
  reset(): Promise<void>;
  close(): Promise<void>;
}

/** Starts the mock casino in-process on a random port. Slow answers outlast the 300 ms test timeout. */
export async function startMockCasino(): Promise<MockCasinoHandle> {
  const app = createMockCasino({
    apiKeys: { 'platform-a': DEV_TENANTS['casino-a'].rewardApiKey, 'platform-b': DEV_TENANTS['casino-b'].rewardApiKey },
    slowResponseMs: 600,
  });
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const control = (path: string, body?: object) =>
    fetch(`${url}/__control${path}`, {
      method: body ? 'POST' : 'GET',
      headers: { 'content-type': 'application/json' },
      body: body && JSON.stringify(body),
    });

  return {
    url,
    fail: async (platform, modes, operation = 'issue') => {
      await control(`/${platform}/failures`, { operation, modes });
    },
    grants: async (platform) => (await (await control(`/${platform}/grants`)).json()) as MockGrant[],
    reset: async () => {
      await control('/reset', {});
    },
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
