import { loadConfig } from '../src/config';

describe('loadConfig', () => {
  const required = { DATABASE_URL: 'postgres://x', SPIN_SEED_SECRET: 's'.repeat(32) };

  it('applies defaults', () => {
    expect(loadConfig(required)).toEqual({
      ...required,
      PORT: 3100,
      LOG_LEVEL: 'info',
      WEBHOOK_TOLERANCE_SECONDS: 300,
      PLAYER_TOKEN_MAX_AGE_SECONDS: 3600,
      WORKER_ENABLED: true,
      WORKER_POLL_INTERVAL_MS: 1000,
      WORKER_LEASE_SECONDS: 30,
      REDEMPTION_MAX_ATTEMPTS: 5,
      RETRY_BASE_DELAY_MS: 1000,
      RETRY_MAX_DELAY_MS: 60_000,
    });
  });

  it('fails fast and names every invalid variable', () => {
    expect(() => loadConfig({ PORT: 'abc', LOG_LEVEL: 'loud' })).toThrow(
      /Invalid configuration: PORT: .*; DATABASE_URL: .*; LOG_LEVEL: .*; SPIN_SEED_SECRET: /,
    );
  });

  it('rejects a guessable spin secret', () => {
    expect(() => loadConfig({ ...required, SPIN_SEED_SECRET: 'short' })).toThrow(/SPIN_SEED_SECRET/);
  });
});
