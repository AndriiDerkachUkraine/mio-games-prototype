import { z } from 'zod';

/** An identifier issued by a casino (player, event, notification). */
export const ExternalId = z.string().min(1).max(128);

export const Uuid = z.uuid();

export const CurrencyCode = z.string().regex(/^[A-Z]{3}$/, 'must be an ISO 4217 code');
