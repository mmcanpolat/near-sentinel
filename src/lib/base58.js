const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export function b58encode(buf) {
  let n = 0n;
  for (const b of buf) n = (n << 8n) + BigInt(b);
  let out = '';
  while (n > 0n) { out = ALPHABET[Number(n % 58n)] + out; n /= 58n; }
  for (const b of buf) { if (b === 0) out = '1' + out; else break; }
  return out;
}

export function b58decode(str) {
  let n = 0n;
  for (const c of str) {
    const i = ALPHABET.indexOf(c);
    if (i < 0) throw new Error('invalid base58 character');
    n = n * 58n + BigInt(i);
  }
  const bytes = [];
  while (n > 0n) { bytes.unshift(Number(n & 0xffn)); n >>= 8n; }
  for (const c of str) { if (c === '1') bytes.unshift(0); else break; }
  return Uint8Array.from(bytes);
}

/** "ed25519:<base58 of 32 bytes>" -> true when it parses as a NEAR ed25519 public key. */
export function validPublicKey(k) {
  if (typeof k !== 'string' || !k.startsWith('ed25519:')) return false;
  try { return b58decode(k.slice(8)).length === 32; } catch { return false; }
}
