const DECIMAL_AMOUNT = /^(\d{1,12})(?:\.(\d{1,2}))?$/;

/** "50.5" → 5050, parsed as text so floats never touch money. Assumes 2-decimal currencies. */
export function decimalToMinorUnits(amount: string): number | null {
  const match = DECIMAL_AMOUNT.exec(amount);
  if (!match) return null;
  const [, units, fraction = ''] = match;
  return Number(units) * 100 + Number(fraction.padEnd(2, '0'));
}

/** 5050 → "50.50" (inverse of decimalToMinorUnits). */
export function minorUnitsToDecimal(minor: number): string {
  if (!Number.isSafeInteger(minor) || minor < 0) throw new Error(`Invalid minor amount: ${minor}`);
  return `${Math.floor(minor / 100)}.${String(minor % 100).padStart(2, '0')}`;
}
