import { randomUUID } from 'node:crypto';
import express, { type Request, type Response } from 'express';

/*
 * Simulated reward APIs of the two casino platforms, with failure injection for reliability tests and demos.
 * Both are idempotent on the caller's reference, as MIO requires of a real casino.
 */

export type Platform = 'platform-a' | 'platform-b';
type Operation = 'issue' | 'status';
/**
 * error-500: fail, nothing granted · timeout: answer too late, nothing granted · lost-response: grant, then
 * answer too late · reject: refuse · reject-later (B): accept, then reject on completion.
 */
type FailureMode = 'error-500' | 'timeout' | 'lost-response' | 'reject' | 'reject-later';

interface Grant {
  id: string;
  reference: string;
  playerId: string;
  reward: unknown;
  state: 'QUEUED' | 'COMPLETED' | 'REJECTED';
  rejectOnCompletion: boolean;
}

interface PlatformApi {
  authorized: (req: Request) => boolean;
  /** Platform A settles synchronously; Platform B queues and settles on the next status check. */
  async: boolean;
  view: (grant: Grant) => object;
  errorBody: (code: string) => object;
}

export interface MockCasinoOptions {
  apiKeys: Record<Platform, string>;
  /** How late "timeout" / "lost-response" answers arrive; must exceed MIO's reward API timeout. */
  slowResponseMs: number;
}

export function createMockCasino(options: MockCasinoOptions) {
  const grants: Record<Platform, Map<string, Grant>> = { 'platform-a': new Map(), 'platform-b': new Map() };
  const failures: Record<Platform, Record<Operation, FailureMode[]>> = {
    'platform-a': { issue: [], status: [] },
    'platform-b': { issue: [], status: [] },
  };

  const apis: Record<Platform, PlatformApi> = {
    'platform-a': {
      authorized: (req) => req.header('authorization') === `Bearer ${options.apiKeys['platform-a']}`,
      async: false,
      view: (g) => ({ bonus_id: g.id, status: 'granted' }),
      errorBody: (code) => ({ error: code }),
    },
    'platform-b': {
      authorized: (req) => req.header('x-api-key') === options.apiKeys['platform-b'],
      async: true,
      view: (g) => ({
        orderId: g.id,
        state: g.state,
        ...(g.state === 'REJECTED' ? { reason: 'CUSTOMER_BLOCKED' } : {}),
      }),
      errorBody: (code) => ({ code }),
    },
  };

  const answerLate = (res: Response) => setTimeout(() => res.status(504).end(), options.slowResponseMs).unref();

  function issue(
    platform: Platform,
    req: Request,
    res: Response,
    fields: { reference: unknown; playerId: unknown; reward: unknown },
  ) {
    const api = apis[platform];
    if (!api.authorized(req)) return void res.status(401).json(api.errorBody('UNAUTHORIZED'));
    const { reference, playerId, reward } = fields;
    if (typeof reference !== 'string' || typeof playerId !== 'string' || !reward) {
      return void res.status(400).json(api.errorBody('BAD_REQUEST'));
    }

    const mode = failures[platform].issue.shift();
    if (mode === 'error-500') return void res.status(500).json(api.errorBody('INTERNAL'));
    if (mode === 'timeout') return void answerLate(res);
    if (mode === 'reject') return void res.status(422).json(api.errorBody('NOT_ELIGIBLE'));

    let grant = grants[platform].get(reference);
    const created = !grant;
    if (!grant) {
      grant = {
        id: randomUUID(),
        reference,
        playerId,
        reward,
        state: api.async ? 'QUEUED' : 'COMPLETED',
        rejectOnCompletion: mode === 'reject-later',
      };
      grants[platform].set(reference, grant);
    }
    if (mode === 'lost-response') return void answerLate(res);
    res.status(created ? (api.async ? 202 : 201) : 200).json(api.view(grant));
  }

  function status(platform: Platform, req: Request, res: Response, reference: string) {
    const api = apis[platform];
    if (!api.authorized(req)) return void res.status(401).json(api.errorBody('UNAUTHORIZED'));
    const mode = failures[platform].status.shift();
    if (mode === 'error-500') return void res.status(500).json(api.errorBody('INTERNAL'));
    if (mode === 'timeout') return void answerLate(res);

    const grant = grants[platform].get(reference);
    if (!grant) return void res.status(404).json(api.errorBody('NOT_FOUND'));
    if (grant.state === 'QUEUED') grant.state = grant.rejectOnCompletion ? 'REJECTED' : 'COMPLETED';
    res.json(api.view(grant));
  }

  const app = express();
  app.use(express.json());

  app.post('/platform-a/bonuses', (req, res) =>
    issue('platform-a', req, res, {
      reference: req.body?.reference,
      playerId: req.body?.player_id,
      reward: req.body?.bonus,
    }),
  );
  app.get('/platform-a/bonuses/by-reference/:reference', (req, res) =>
    status('platform-a', req, res, String(req.params.reference)),
  );
  app.post('/platform-b/v2/reward-orders', (req, res) =>
    issue('platform-b', req, res, {
      reference: req.body?.clientOrderId,
      playerId: req.body?.customerRef,
      reward: req.body?.reward,
    }),
  );
  app.get('/platform-b/v2/reward-orders', (req, res) =>
    status('platform-b', req, res, String(req.query.clientOrderId)),
  );

  app.post('/__control/:platform/failures', (req, res) => {
    const { operation = 'issue', modes } = req.body as { operation?: Operation; modes: FailureMode[] };
    failures[req.params.platform as Platform][operation].push(...modes);
    res.status(204).end();
  });
  app.get('/__control/:platform/grants', (req, res) => {
    res.json([...grants[req.params.platform as Platform].values()]);
  });
  app.post('/__control/reset', (_req, res) => {
    for (const platform of Object.keys(grants) as Platform[]) {
      grants[platform].clear();
      failures[platform] = { issue: [], status: [] };
    }
    res.status(204).end();
  });

  return app;
}
