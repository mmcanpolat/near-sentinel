import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkKeyAllows } from '../src/guard/keys.js';
import { tx, fnCall, transfer, NEAR } from './helpers.js';

const key = { type: 'function_call', receiverId: 'wrap.near', methodNames: ['near_deposit'], allowanceYocto: NEAR(0.01).toString() };
const call = (c, m, dep = 0n, gas = 30n * 10n ** 12n) => [tx(c, [fnCall(m, {}, gas, dep)])];

test('the protocol lets a scoped key call a listed method with no deposit', () => {
  assert.equal(checkKeyAllows(key, call('wrap.near', 'near_deposit')).allowed, true);
});
test('a function-call key cannot attach a deposit, so it cannot move funds', () => {
  const r = checkKeyAllows(key, call('wrap.near', 'near_deposit', NEAR(1)));
  assert.equal(r.allowed, false);
  assert.match(r.reasons[0], /cannot attach a deposit/);
});
test('wrong contract, wrong method and non-call actions are refused', () => {
  assert.equal(checkKeyAllows(key, call('other.near', 'near_deposit')).allowed, false);
  assert.equal(checkKeyAllows(key, call('wrap.near', 'near_withdraw')).allowed, false);
  assert.equal(checkKeyAllows(key, [tx('wrap.near', [transfer(1n)])]).allowed, false);
});
test('a key cannot sign multi-action transactions', () => {
  const two = [tx('wrap.near', [fnCall('near_deposit', {}, 1n, 0n), fnCall('near_deposit', {}, 1n, 0n)])];
  assert.equal(checkKeyAllows(key, two).allowed, false);
});
test('the gas allowance is a hard budget', () => {
  // 0.01 NEAR at 1e8 yocto/gas = 1e14 gas. 30 Tgas costs 3e12*1e8... use a price that makes one call exceed it.
  const r = checkKeyAllows(key, call('wrap.near', 'near_deposit', 0n, 300n * 10n ** 12n), { gasPrice: 10n ** 12n });
  assert.equal(r.allowed, false);
  assert.match(r.reasons.join(' '), /allowance/);
});
test('a full-access key is not a sandbox', () => {
  assert.equal(checkKeyAllows({ type: 'full' }, call('wrap.near', 'near_deposit')).allowed, false);
});

test('generated agent keys never expose the private half and are valid ed25519 keys', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sentinel-'));
  process.env.SENTINEL_DATA_DIR = dir;
  const { generateAgentKey } = await import('../src/guard/keys.js?fresh');
  const { validPublicKey, b58decode } = await import('../src/lib/base58.js');
  const k = generateAgentKey('t');
  assert.deepEqual(Object.keys(k), ['publicKey']);
  assert.ok(validPublicKey(k.publicKey));
  const f = fs.readdirSync(path.join(dir, 'agent-keys'))[0];
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'agent-keys', f), 'utf8'));
  assert.equal(b58decode(saved.secretKey.slice(8)).length, 64);
  assert.equal(fs.statSync(path.join(dir, 'agent-keys', f)).mode & 0o077, 0);
  delete process.env.SENTINEL_DATA_DIR;
});
