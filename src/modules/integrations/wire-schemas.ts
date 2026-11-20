import { z } from 'zod';
import { decimalToMinorUnits } from './money';

export const ExternalId = z.string().min(1).max(128);

export const CurrencyCode = z.string().regex(/^[A-Z]{3}$/, 'must be an ISO 4217 code');

/** "50.00" → 5000 (positive integer minor units). */
export const PositiveDecimalAmount = z.string().transform((value, ctx) => {
  const minor = decimalToMinorUnits(value);
  if (minor === null || minor <= 0) {
    ctx.addIssue({ code: 'custom', message: 'must be a positive decimal amount' });
    return z.NEVER;
  }
  return minor;
});
