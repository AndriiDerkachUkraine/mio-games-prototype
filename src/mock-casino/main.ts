import { DEV_TENANTS } from '../db/seed';
import { createMockCasino } from './mock-casino';

const port = Number(process.env.PORT ?? 4100);

const app = createMockCasino({
  apiKeys: {
    'platform-a': DEV_TENANTS['casino-a'].rewardApiKey,
    'platform-b': DEV_TENANTS['casino-b'].rewardApiKey,
  },
  slowResponseMs: Number(process.env.SLOW_RESPONSE_MS ?? 5000),
});

app.listen(port, () => console.log(`Mock casino listening on :${port}`));
