import { hmacSha256 } from '../../common/crypto';
import type { RewardSegment } from './reward-segments';

const DRAW_RANGE = 2 ** 48;

/**
 * Deterministic, server-authoritative outcome: HMAC(secret, spinId) drives the draw, so the same spin always
 * yields the same segment and nobody without the secret can predict or steer it. Rejection sampling keeps
 * the draw unbiased for any total weight.
 */
export function pickSegment(secret: string, spinId: string, segments: readonly RewardSegment[]): RewardSegment {
  const totalWeight = segments.reduce((sum, s) => sum + s.weight, 0);
  if (totalWeight <= 0 || totalWeight >= DRAW_RANGE) throw new Error(`Invalid total weight: ${totalWeight}`);
  const acceptBelow = DRAW_RANGE - (DRAW_RANGE % totalWeight);

  for (let attempt = 0; ; attempt++) {
    const draw = hmacSha256(secret, `${spinId}:${attempt}`).readUIntBE(0, 6);
    if (draw >= acceptBelow) continue; // rejected (probability < totalWeight / 2^48), draw again
    let ticket = draw % totalWeight;
    for (const segment of segments) {
      if (ticket < segment.weight) return segment;
      ticket -= segment.weight;
    }
  }
}
