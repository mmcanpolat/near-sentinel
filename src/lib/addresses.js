// Address encodings for a secp256k1 public key: EVM (EIP-55), Bitcoin P2WPKH (bech32) and P2PKH (base58check).

import crypto from 'node:crypto';
import { keccak256 } from './keccak.js';
import { b58encode } from './base58.js';
import { toBytes64, toCompressed } from './secp256k1.js';

const sha256 = (b) => crypto.createHash('sha256').update(b).digest();
export const hash160 = (b) => crypto.createHash('ripemd160').update(sha256(b)).digest();

export function evmAddress(point) {
  const addr = keccak256(toBytes64(point)).subarray(12).toString('hex');
  const h = keccak256(Buffer.from(addr, 'ascii')).toString('hex');
  return '0x' + [...addr].map((c, i) => (parseInt(h[i], 16) >= 8 ? c.toUpperCase() : c)).join('');
}

const B32 = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const polymod = (values) => {
  const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) { const top = chk >>> 25; chk = ((chk & 0x1ffffff) << 5) ^ v; for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk ^= GEN[i]; }
  return chk >>> 0;
};
function convertBits(data, from, to) {
  let acc = 0, bits = 0; const out = [];
  for (const v of data) { acc = (acc << from) | v; bits += from; while (bits >= to) { bits -= to; out.push((acc >> bits) & ((1 << to) - 1)); } }
  if (bits > 0) out.push((acc << (to - bits)) & ((1 << to) - 1));
  return out;
}
/** Segwit v0 bech32 (BIP 173). */
export function bech32Segwit(hrp, program) {
  const data = [0, ...convertBits(program, 8, 5)];
  const exp = [...[...hrp].map((c) => c.charCodeAt(0) >> 5), 0, ...[...hrp].map((c) => c.charCodeAt(0) & 31)];
  const mod = polymod([...exp, ...data, 0, 0, 0, 0, 0, 0]) ^ 1;
  const chk = Array.from({ length: 6 }, (_, i) => (mod >>> (5 * (5 - i))) & 31);
  return `${hrp}1${[...data, ...chk].map((d) => B32[d]).join('')}`;
}

export const btcP2wpkh = (point, hrp = 'bc') => bech32Segwit(hrp, hash160(toCompressed(point)));
export function btcP2pkh(point, version = 0x00) {
  const body = Buffer.concat([Buffer.from([version]), hash160(toCompressed(point))]);
  return b58encode(Buffer.concat([body, sha256(sha256(body)).subarray(0, 4)]));
}
