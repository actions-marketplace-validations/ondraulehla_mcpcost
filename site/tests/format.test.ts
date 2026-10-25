import { expect, it } from 'vitest';
import { grouped, num } from '../src/lib/format';

it('groups a number as toLocaleString("en-US") does, with the separator for the commas', () => {
  const values = [0, -0, 1, 9, 10, 999, 1000, 1001, 9999, 10_000, 123_456, 999_999, 1_000_000, 1_234_567, -1, -999, -1000, -1_234_567];
  values.push(Number.MAX_SAFE_INTEGER, -Number.MAX_SAFE_INTEGER, 2 ** 53, 1e21, 0.5, 1234.5678, -1234.5, 12.345, 1e-7, NaN, Infinity, -Infinity);
  // Integers of every length, from a fixed sequence.
  let seed = 7;
  for (let i = 0; i < 3000; i++) {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    values.push(Math.floor((seed / 2147483648) * 10 ** (i % 16)) * (i % 7 === 0 ? -1 : 1));
  }
  for (const n of values) {
    for (const separator of [' ', ' ']) expect(grouped(n, separator), String(n)).toBe(n.toLocaleString('en-US').replace(/,/g, separator));
  }
  expect(num(1234567)).toBe('1 234 567');
  expect(num(null)).toBe('');
});
