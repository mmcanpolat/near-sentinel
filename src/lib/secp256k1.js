// Minimal secp256k1 for PUBLIC-key math only (adding a public tweak*G to a public key).
// No private key ever passes through here, so non-constant-time arithmetic is acceptable.

export const P = 0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2fn;
export const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
export const G = {
  x: 0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798n,
  y: 0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8n,
};
const mod = (a, m = P) => ((a % m) + m) % m;
function inv(a, m = P) {
  let [r0, r1, s0, s1] = [mod(a, m), m, 1n, 0n];
  while (r1 !== 0n) { const q = r0 / r1; [r0, r1] = [r1, r0 - q * r1]; [s0, s1] = [s1, s0 - q * s1]; }
  if (r0 !== 1n) throw new Error('not invertible');
  return mod(s0, m);
}
export const onCurve = (p) => p === null || mod(p.y * p.y - (p.x ** 3n + 7n)) === 0n;

export function add(a, b) {
  if (a === null) return b;
  if (b === null) return a;
  if (a.x === b.x) {
    if (mod(a.y + b.y) === 0n) return null;
    const l = mod(3n * a.x * a.x * inv(2n * a.y));
    const x = mod(l * l - 2n * a.x);
    return { x, y: mod(l * (a.x - x) - a.y) };
  }
  const l = mod((b.y - a.y) * inv(b.x - a.x));
  const x = mod(l * l - a.x - b.x);
  return { x, y: mod(l * (a.x - x) - a.y) };
}

export function mul(k, p = G) {
  let r = null, q = p;
  for (let n = mod(k, N); n > 0n; n >>= 1n) { if (n & 1n) r = add(r, q); q = add(q, q); }
  return r;
}

const hex32 = (n) => n.toString(16).padStart(64, '0');
export const toBytes64 = (p) => Buffer.from(hex32(p.x) + hex32(p.y), 'hex');
export const toCompressed = (p) => Buffer.from((p.y % 2n === 0n ? '02' : '03') + hex32(p.x), 'hex');
export function fromBytes64(b) {
  if (b.length !== 64) throw new Error('expected 64 bytes (x||y)');
  const p = { x: BigInt('0x' + Buffer.from(b.subarray(0, 32)).toString('hex')), y: BigInt('0x' + Buffer.from(b.subarray(32)).toString('hex')) };
  if (!onCurve(p)) throw new Error('point is not on secp256k1');
  return p;
}
