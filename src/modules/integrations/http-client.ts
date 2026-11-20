import type { ZodType } from 'zod';
import type { RewardOutcome } from './casino-platform';

type HttpResult = { ok: true; status: number; body: unknown } | { ok: false; reason: string };

/** JSON over HTTP with a hard timeout. Transport failures are returned, not thrown, so they can be classified. */
export async function requestJson(
  url: string,
  init: { method: 'GET' | 'POST'; headers: Record<string, string>; body?: unknown },
  timeoutMs: number,
): Promise<HttpResult> {
  try {
    const res = await fetch(url, {
      method: init.method,
      headers: { 'content-type': 'application/json', ...init.headers },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    return { ok: true, status: res.status, body: text ? parseJson(text) : undefined };
  } catch (err) {
    // Checked by name: fetch throws a DOMException, which is not an `instanceof Error` in every realm.
    const timedOut = (err as { name?: unknown } | null)?.name === 'TimeoutError';
    return { ok: false, reason: timedOut ? `timeout after ${timeoutMs}ms` : `network error: ${String(err)}` };
  }
}

/**
 * Classification shared by all casino adapters. Only an explicit 4xx answer means "not issued";
 * timeouts, network errors, 5xx, 429 and unreadable 2xx bodies leave the outcome unknown.
 */
export function toRewardOutcome<T>(
  result: HttpResult,
  successSchema: ZodType<T>,
  onSuccess: (body: T) => RewardOutcome,
  opts: { notFoundOn404?: boolean } = {},
): RewardOutcome {
  if (!result.ok) return { kind: 'RETRYABLE', reason: result.reason };
  const { status, body } = result;
  if (status >= 200 && status < 300) {
    const parsed = successSchema.safeParse(body);
    return parsed.success ? onSuccess(parsed.data) : { kind: 'RETRYABLE', reason: `unexpected ${status} body` };
  }
  if (opts.notFoundOn404 && status === 404) return { kind: 'NOT_FOUND' };
  if (status >= 500 || status === 429) return { kind: 'RETRYABLE', reason: `HTTP ${status}` };
  return { kind: 'REJECTED', reason: `HTTP ${status}: ${JSON.stringify(body) ?? ''}`.slice(0, 500) };
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
