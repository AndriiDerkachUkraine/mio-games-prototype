import { z } from 'zod';
import { CurrencyCode } from '../../common/schemas';

/** What a store item grants, in platform-agnostic terms; each casino adapter translates it to its own API. */
export const RewardDescriptorSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('FREE_SPINS'),
    quantity: z.number().int().positive(),
    game: z.string().min(1).max(64),
  }),
  z.object({
    type: z.literal('BONUS_MONEY'),
    amountMinor: z.number().int().positive(),
    currency: CurrencyCode,
  }),
]);

export type RewardDescriptor = z.infer<typeof RewardDescriptorSchema>;
