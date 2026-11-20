import { loadConfig } from '../src/config';

describe('loadConfig', () => {
  it('applies defaults', () => {
    expect(loadConfig({ DATABASE_URL: 'postgres://x' })).toEqual({
      PORT: 3100,
      DATABASE_URL: 'postgres://x',
      LOG_LEVEL: 'info',
      WEBHOOK_TOLERANCE_SECONDS: 300,
    });
  });

  it('fails fast and names every invalid variable', () => {
    expect(() => loadConfig({ PORT: 'abc', LOG_LEVEL: 'loud' })).toThrow(
      /Invalid configuration: PORT: .*; DATABASE_URL: .*; LOG_LEVEL: /,
    );
  });
});
