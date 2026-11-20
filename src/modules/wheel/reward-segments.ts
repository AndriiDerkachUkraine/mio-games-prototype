import { z } from 'zod';

export const RewardSegmentsSchema = z
  .array(
    z.object({
      key: z.string().min(1).max(64),
      label: z.string().min(1).max(128),
      coins: z.number().int().positive(),
      weight: z.number().int().positive(),
    }),
  )
  .min(1)
  .refine((segments) => new Set(segments.map((s) => s.key)).size === segments.length, 'segment keys must be unique')
  // Keeps the draw in pickSegment far inside its 48-bit range.
  .refine((segments) => segments.reduce((sum, s) => sum + s.weight, 0) <= 1_000_000_000, 'total weight is too large');

export type RewardSegment = z.infer<typeof RewardSegmentsSchema>[number];
