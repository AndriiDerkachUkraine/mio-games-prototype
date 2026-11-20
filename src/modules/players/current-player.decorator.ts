import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { AuthenticatedPlayer, PlayerRequest } from './player-auth.guard';

/** The player resolved by PlayerAuthGuard; only valid on guarded routes. */
export const CurrentPlayer = createParamDecorator((_data: unknown, context: ExecutionContext): AuthenticatedPlayer => {
  const player = context.switchToHttp().getRequest<PlayerRequest>().player;
  if (!player) throw new Error('CurrentPlayer used on a route without PlayerAuthGuard');
  return player;
});
