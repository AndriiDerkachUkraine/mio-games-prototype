import { decimalToMinorUnits, minorUnitsToDecimal } from '../src/modules/integrations/money';

describe('decimalToMinorUnits', () => {
  it.each([
    ['50', 5000],
    ['50.5', 5050],
    ['50.05', 5005],
    ['0.01', 1],
    ['0.10', 10],
    ['999999999999.99', 99999999999999],
  ])('%s → %d', (input, expected) => {
    expect(decimalToMinorUnits(input)).toBe(expected);
  });

  it.each(['', 'abc', '-1.00', '1.005', '1,00', '1.', '.5', '1e3', ' 1.00', '1000000000000.00'])(
    'rejects %p',
    (input) => {
      expect(decimalToMinorUnits(input)).toBeNull();
    },
  );
});

describe('minorUnitsToDecimal', () => {
  it.each([
    [0, '0.00'],
    [5, '0.05'],
    [500, '5.00'],
    [5050, '50.50'],
  ])('%d → %s', (input, expected) => {
    expect(minorUnitsToDecimal(input)).toBe(expected);
  });

  it('round-trips with decimalToMinorUnits', () => {
    for (const minor of [1, 99, 100, 123456]) expect(decimalToMinorUnits(minorUnitsToDecimal(minor))).toBe(minor);
  });

  it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1])('rejects %p', (input) => {
    expect(() => minorUnitsToDecimal(input)).toThrow(/Invalid minor amount/);
  });
});
