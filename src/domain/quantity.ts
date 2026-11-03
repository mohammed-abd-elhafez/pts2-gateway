/**
 * Quantities are integer thousandths (litres * 1000, metres * 1000), never floats.
 * MoEnergy compares fuel quantities to 0.001 L, so float noise is not acceptable.
 */
declare const brand: unique symbol;
export type Milli = number & { readonly [brand]: 'Milli' };

export class QuantityError extends Error {}

/** Largest magnitude accepted, in whole units. Keeps every value exact as a JSON number. */
const MAX_UNITS = 1e9;

const DECIMAL = /^([+-]?)(\d+)(?:\.(\d+))?$/;

/** Wraps an already-integer thousandths value. */
export function milli(n: number): Milli {
  if (!Number.isSafeInteger(n)) throw new QuantityError(`not an integer thousandths value: ${n}`);
  return n as Milli;
}

/**
 * Parses a plain decimal ("12.3456", "-0.5", 42) into thousandths, rounding half away from zero
 * at the third decimal (or refusing more than three decimals when `strict`). Exponent forms,
 * separators, NaN and Infinity are rejected.
 */
export function parseMilli(input: string | number, opts: { strict?: boolean } = {}): Milli {
  let text: string;
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) throw new QuantityError(`not a finite number: ${input}`);
    text = String(input);
    if (/e/i.test(text)) {
      if (Math.abs(input) >= MAX_UNITS) throw new QuantityError(`out of range: ${input}`);
      text = input.toFixed(12);
    }
  } else {
    text = input.trim();
  }

  const m = DECIMAL.exec(text);
  if (!m) throw new QuantityError(`not a plain decimal: "${text}"`);
  const [, sign, whole = '0', fraction = ''] = m;
  if (whole.replace(/^0+/, '').length > 9) throw new QuantityError(`out of range: "${text}"`);

  // strict: the guide says "up to 3 decimals", so a value with more significant decimals is refused, not rounded
  if (opts.strict && fraction.replace(/0+$/, '').length > 3) throw new QuantityError(`more than 3 decimals: "${text}"`);

  const frac3 = fraction.padEnd(3, '0').slice(0, 3);
  const roundUp = fraction.length > 3 && fraction.charCodeAt(3) >= 53 ? 1 : 0; // '5' = 53
  const magnitude = Number(whole) * 1000 + Number(frac3) + roundUp;
  if (magnitude > MAX_UNITS * 1000) throw new QuantityError(`out of range: "${text}"`);
  return milli(sign === '-' ? -magnitude || 0 : magnitude);
}

export function milliToDecimalString(m: Milli): string {
  const abs = Math.abs(m);
  const whole = Math.trunc(abs / 1000);
  const frac = String(abs % 1000).padStart(3, '0');
  return `${m < 0 ? '-' : ''}${whole}.${frac}`;
}

/** The JSON number MoEnergy receives, e.g. 12346 -> 12.346. */
export function milliToJsonNumber(m: Milli): number {
  return Number(milliToDecimalString(m));
}

/** Millimetres (a decimal string) to thousandths of a metre: 1 mm = 1. */
export function mmToMetersMilli(mm: string): Milli {
  return milli(Math.round(parseMilli(mm) / 1000));
}

/** Rounds to 2 or 3 decimals, half away from zero, in integer arithmetic. */
export function roundMilli(m: Milli, decimals: 2 | 3): Milli {
  if (decimals === 3) return m;
  const abs = Math.abs(m);
  const rounded = Math.trunc((abs + 5) / 10) * 10;
  return milli(m < 0 ? -rounded || 0 : rounded);
}

export const addMilli = (a: Milli, b: Milli): Milli => milli(a + b);
export const subMilli = (a: Milli, b: Milli): Milli => milli(a - b);
