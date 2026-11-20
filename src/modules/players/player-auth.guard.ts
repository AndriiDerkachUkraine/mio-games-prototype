import { CanActivate, ExecutionContext, HttpStatus, Inject, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { decode, verify, type JwtPayload } from 'jsonwebtoken';
import { DomainError } from '../../common/domain-error';
import { ExternalId } from '../../common/external-id';
import { APP_CONFIG, type AppConfig } from '../../config';
import { DB, type Db } from '../../db/db.provider';
import { TenantsRepository } from '../tenancy/tenants.repository';
import { PLAYER_TOKEN_ALGORITHM } from './player-token';
import { PlayersRepository } from './players.repository';

export interface AuthenticatedPlayer {
  tenantId: string;
  playerId: string;
  externalPlayerId: string;
}

export type PlayerRequest = Request & { player?: AuthenticatedPlayer };

const unauthorizedPlayer = (reason: string): DomainError =>
  new DomainError(HttpStatus.UNAUTHORIZED, 'UNAUTHORIZED_PLAYER', reason);

/**
 * Player API auth: a short-lived JWT signed by the casino with its tenant key.
 * The tenant comes from `iss`, but only that tenant's key can make the token valid.
 */
@Injectable()
export class PlayerAuthGuard implements CanActivate {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly tenants: TenantsRepository,
    private readonly players: PlayersRepository,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<PlayerRequest>();
    const token = /^Bearer (\S+)$/.exec(req.headers.authorization ?? '')?.[1];
    if (!token) throw unauthorizedPlayer('missing bearer token');

    // Unverified read, only to choose which tenant key to verify with.
    const issuer = decode(token, { json: true })?.iss;
    const tenant = typeof issuer === 'string' ? await this.tenants.findActive(issuer) : undefined;
    if (!tenant) throw unauthorizedPlayer('invalid token');

    const subject = ExternalId.safeParse(this.verify(token, tenant.player_token_secret, tenant.id).sub);
    if (!subject.success) throw unauthorizedPlayer('invalid token');
    const externalPlayerId = subject.data;

    const playerId = await this.db.transaction().execute((tx) => this.players.resolve(tx, tenant.id, externalPlayerId));
    req.player = { tenantId: tenant.id, playerId, externalPlayerId };
    return true;
  }

  private verify(token: string, secret: string, tenantId: string): JwtPayload {
    try {
      const claims = verify(token, secret, {
        algorithms: [PLAYER_TOKEN_ALGORITHM],
        issuer: tenantId,
        maxAge: this.config.PLAYER_TOKEN_MAX_AGE_SECONDS,
      });
      if (typeof claims === 'string' || typeof claims.exp !== 'number') throw new Error('token without exp');
      return claims;
    } catch {
      throw unauthorizedPlayer('invalid token');
    }
  }
}
