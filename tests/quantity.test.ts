import { describe, expect, it } from 'vitest';
import { milli, milliToDecimalString, milliToJsonNumber, parseMilli, QuantityError } from '../src/domain/quantity.js';

describe('parseMilli', () => {
  it.each([
    ['12.3456', 12346],
    ['12.3454', 12345],
    ['12.3455', 12346],
    ['0.0005', 1],
    ['-0.0005', -1],
    ['-0.0004', 0],
    ['1000', 1_000_000],
    ['  7.5 ', 7500],
    ['+3', 3000],
    ['.5', null],
    ['31790.0', 31_790_000],
    [37, 37_000],
    [1.0005, 1001],
    [0.1 + 0.2, 300],
    [1e-7, 0],
  ] as const)('parses %j', (input, expected) => {
    if (expected === null) {
      expect(() => parseMilli(input)).toThrow(QuantityError);
    } else {
      expect(parseMilli(input)).toBe(expected);
    }
  });

  it.each(['', '  ', 'NaN', 'Infinity', '-Infinity', '1e3', '1E3', '1,5', '1 000', '0x10', '--1', '1.', 'abc', '12.3.4'])(
    'rejects %j',
    (input) => {
      expect(() => parseMilli(input)).toThrow(QuantityError);
    },
  );

  it('rejects non-finite and huge numbers', () => {
    expect(() => parseMilli(Number.NaN)).toThrow(QuantityError);
    expect(() => parseMilli(Number.POSITIVE_INFINITY)).toThrow(QuantityError);
    expect(() => parseMilli(1e21)).toThrow(QuantityError);
    expect(() => parseMilli('1000000000.001')).toThrow(QuantityError);
    expect(() => parseMilli('99999999999999999999')).toThrow(QuantityError);
  });

  it('never returns negative zero', () => {
    expect(Object.is(parseMilli('-0'), 0)).toBe(true);
    expect(Object.is(parseMilli('-0.0001'), 0)).toBe(true);
  });
});

describe('formatting', () => {
  it('writes three decimals and keeps the sign', () => {
    expect(milliToDecimalString(milli(12346))).toBe('12.346');
    expect(milliToDecimalString(milli(-1))).toBe('-0.001');
    expect(milliToDecimalString(milli(0))).toBe('0.000');
    expect(milliToDecimalString(milli(31_776_000))).toBe('31776.000');
  });

  it('round-trips through the JSON number', () => {
    for (const s of ['0.001', '14250.5', '31776', '999999.999', '-12.345']) {
      const m = parseMilli(s);
      expect(parseMilli(String(milliToJsonNumber(m)))).toBe(m);
    }
    expect(JSON.stringify({ v: milliToJsonNumber(milli(14_250_500)) })).toBe('{"v":14250.5}');
  });

  it('rejects a non-integer thousandths value', () => {
    expect(() => milli(1.5)).toThrow(QuantityError);
  });
});

describe('roundMilli', () => {
  it('rounds half away from zero to two decimals and leaves three decimals alone', async () => {
    const { roundMilli, milli } = await import('../src/domain/quantity.js');
    expect(roundMilli(milli(1_000_125), 2)).toBe(1_000_130);
    expect(roundMilli(milli(1_000_124), 2)).toBe(1_000_120);
    expect(roundMilli(milli(-1_000_125), 2)).toBe(-1_000_130);
    expect(roundMilli(milli(4), 2)).toBe(0);
    expect(roundMilli(milli(5), 2)).toBe(10);
    expect(roundMilli(milli(-4), 2)).toBe(0);
    expect(Object.is(roundMilli(milli(-4), 2), 0)).toBe(true); // never -0
    expect(roundMilli(milli(1_000_125), 3)).toBe(1_000_125);
  });
});
