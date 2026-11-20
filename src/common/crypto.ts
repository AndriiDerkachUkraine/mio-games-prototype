import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export const sha256Hex = (value: string): string => createHash('sha256').update(value).digest('hex');

export const hmacSha256 = (secret: string, data: string | Buffer): Buffer =>
  createHmac('sha256', secret).update(data).digest();

/** Constant time, so a mismatch does not leak how many leading characters matched. */
export function constantTimeEquals(actual: string, expected: string): boolean {
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
