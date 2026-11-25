/**
 * Exact BigInt rational arithmetic shared across scoring, FBA rate calculation, and unit economics.
 */
export function gcdBig(a, b) {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y !== 0n) {
    const t = y;
    y = x % y;
    x = t;
  }
  return x === 0n ? 1n : x;
}

export function lcmBig(a, b) {
  if (a === 0n || b === 0n) return 0n;
  const x = a < 0n ? -a : a;
  const y = b < 0n ? -b : b;
  return (x / gcdBig(x, y)) * y;
}

export function ceilDivBig(a, b) {
  return (a + b - 1n) / b;
}

export function normBigRat(n, d = 1n) {
  if (d === 0n) throw new RangeError('Zero denominator');
  if (n === 0n) return { n: 0n, d: 1n };
  const sign = d < 0n ? -1n : 1n;
  const g = gcdBig(n, d);
  return { n: (sign * n) / g, d: (sign * d) / g };
}

export function toBigRat(value) {
  if (typeof value === 'bigint') return { n: value, d: 1n };
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError('Finite number required for toBigRat');
  }
  const [mantissa, expPart = '0'] = value.toString().toLowerCase().split('e');
  const sign = mantissa.startsWith('-') ? -1n : 1n;
  const [intPart, fracPart = ''] = mantissa.replace(/^[+-]/, '').split('.');
  const digits = BigInt(intPart + fracPart);
  const exp = Number(expPart) - fracPart.length;
  return exp >= 0
    ? normBigRat(sign * digits * (10n ** BigInt(exp)), 1n)
    : normBigRat(sign * digits, 10n ** BigInt(-exp));
}

export function addBigRat(a, b) {
  return normBigRat(a.n * b.d + b.n * a.d, a.d * b.d);
}

export function subBigRat(a, b) {
  return normBigRat(a.n * b.d - b.n * a.d, a.d * b.d);
}

export function mulBigRat(a, b) {
  return normBigRat(a.n * b.n, a.d * b.d);
}

export function divBigRat(a, b) {
  return normBigRat(a.n * b.d, a.d * b.n);
}

export function ratCmp(a, b) {
  const diff = a.n * b.d - b.n * a.d;
  return diff < 0n ? -1 : diff > 0n ? 1 : 0;
}

export function ratMin(a, b) {
  return ratCmp(a, b) <= 0 ? a : b;
}

export function ratMax(a, b) {
  return ratCmp(a, b) >= 0 ? a : b;
}

export function roundBigRat(n, d, decimals = 10) {
  if (d === 0n) throw new RangeError('Zero denominator');
  const sign = (n < 0n) !== (d < 0n) ? -1n : 1n;
  const absN = n < 0n ? -n : n;
  const absD = d < 0n ? -d : d;
  const scale = 10n ** BigInt(decimals);
  const scaled = (absN * scale * 2n + absD) / (2n * absD);
  return Number(sign * scaled) / Number(scale);
}
