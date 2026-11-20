import { z } from 'zod';

/** An identifier issued by a casino (player, event, notification). */
export const ExternalId = z.string().min(1).max(128);
