// Fixed-point helpers. All on-chain amounts are BigInt strings; humans see decimals.

export const YOCTO = 10n ** 24n;

/** "1.5" with 24 decimals -> 1500000000000000000000000n. Throws on malformed input. */
export function parseUnits(text, decimals) {
  const s = String(text).trim().replace(/_/g, '');
  if (!/^\d+(\.\d+)?$/.test(s)) throw new Error(`"${text}" is not a plain positive number.`);
  const [whole, frac = ''] = s.split('.');
  if (frac.length > decimals) throw new Error(`"${text}" has more than ${decimals} decimal places.`);
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, '0') || '0');
}

/** 1500000000000000000000000n with 24 decimals -> "1.5". */
export function formatUnits(raw, decimals, maxFrac = 6) {
  const v = BigInt(raw);
  const neg = v < 0n;
  const a = neg ? -v : v;
  const base = 10n ** BigInt(decimals);
  const whole = a / base;
  let frac = (a % base).toString().padStart(decimals, '0').slice(0, maxFrac).replace(/0+$/, '');
  return `${neg ? '-' : ''}${whole}${frac ? '.' + frac : ''}`;
}

export const nearToYocto = (t) => parseUnits(t, 24);
export const yoctoToNear = (y, maxFrac = 6) => formatUnits(y, 24, maxFrac);
export const tgas = (n) => BigInt(Math.round(n * 1e12));

/** NEAR account id syntax (named or implicit). */
export function validAccountId(id) {
  if (typeof id !== 'string' || id.length < 2 || id.length > 64) return false;
  return /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/.test(id);
}
export const isImplicit = (id) => /^[0-9a-f]{64}$/.test(id);
