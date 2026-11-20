import { sign } from 'jsonwebtoken';

export const PLAYER_TOKEN_ALGORITHM = 'HS256';

/** Issues a player session token exactly as a casino does. */
export function issuePlayerToken(tenantId: string, externalPlayerId: string, secret: string, ttlSeconds = 900): string {
  return sign({}, secret, {
    algorithm: PLAYER_TOKEN_ALGORITHM,
    issuer: tenantId,
    subject: externalPlayerId,
    expiresIn: ttlSeconds,
  });
}
