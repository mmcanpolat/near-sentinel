import test from 'node:test';
import assert from 'node:assert/strict';
import { parseUnits, formatUnits, validAccountId, nearToYocto, yoctoToNear } from '../src/lib/units.js';
import { b58encode, b58decode } from '../src/lib/base58.js';
import { analyze } from '../src/guard/analyze.js';
import { explainTx } from '../src/guard/explain.js';
import { sendNear, ftSend } from './helpers.js';

test('parseUnits is exact and strict', () => {
  assert.equal(parseUnits('1.5', 6), 1500000n);
  assert.equal(nearToYocto('0.000000000000000000000001'), 1n);
  assert.throws(() => parseUnits('1.1234567', 6));
  assert.throws(() => parseUnits('-1', 6));
  assert.throws(() => parseUnits('1e3', 6));
  assert.throws(() => parseUnits('', 6));
});
test('formatUnits round-trips', () => {
  assert.equal(formatUnits(1500000n, 6), '1.5');
  assert.equal(yoctoToNear(10n ** 24n), '1');
});
test('account ids', () => {
  for (const ok of ['alice.near', 'a-b_c.sub.near', 'e4ee8ccf48b071d6a2b81d5e550b6ec8694b7b2547158f2530007f3ff970bcf0']) assert.ok(validAccountId(ok), ok);
  for (const no of ['0xAbC0000000000000000000000000000000000000', 'A.near', '.near', 'a..near', 'x']) assert.ok(!validAccountId(no), no);
});
test('base58 round-trip with leading zeros', () => {
  const b = Uint8Array.from([0, 0, 1, 2, 255]);
  assert.deepEqual(b58decode(b58encode(b)), b);
});
test('analyze derives effects from actions, not from labels', () => {
  const e = analyze(ftSend('usdc.tkn.near', 'bob.near', 5));
  assert.ok(e.some((x) => x.kind === 'ft_out' && x.token === 'usdc.tkn.near' && x.to === 'bob.near' && x.amount === 5n));
});
test('explain says what the transaction does in words', () => {
  assert.equal(explainTx(sendNear('bob.near', 1.5)[0])[0], 'Send 1.5 NEAR to bob.near');
});
