import { PlatformA } from '../src/modules/integrations/platform-a/platform-a.platform';
import { PlatformB } from '../src/modules/integrations/platform-b/platform-b.platform';
import { PlatformRegistry } from '../src/modules/integrations/platform-registry';

describe('PlatformRegistry', () => {
  const registry = new PlatformRegistry([new PlatformA(), new PlatformB()]);

  it('resolves platforms by key', () => {
    expect(registry.get('platform-a')).toBeInstanceOf(PlatformA);
    expect(registry.get('platform-b')).toBeInstanceOf(PlatformB);
  });

  it('treats an unknown platform as a configuration error', () => {
    expect(() => registry.get('platform-x')).toThrow('No casino platform registered under "platform-x"');
  });
});
