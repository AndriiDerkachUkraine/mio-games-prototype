import type { CasinoPlatform } from './casino-platform';

/** Many tenants share one platform: a new operator is config, a new platform is one adapter. */
export class PlatformRegistry {
  private readonly platforms: ReadonlyMap<string, CasinoPlatform>;

  constructor(platforms: CasinoPlatform[]) {
    this.platforms = new Map(platforms.map((p) => [p.key, p]));
  }

  get(key: string): CasinoPlatform {
    const platform = this.platforms.get(key);
    if (!platform) throw new Error(`No casino platform registered under "${key}"`);
    return platform;
  }
}
