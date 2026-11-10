// Live tests hit public NEAR mainnet RPC and the NEAR Intents API. They only READ and QUOTE.
// Run with: npm run test:live
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const LIVE = process.env.LIVE === '1';
const opts = { skip: LIVE ? false : 'set LIVE=1 to run (needs network)', timeout: 90000 };
process.env.SENTINEL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sentinel-live-'));

test('server: a 50 NEAR transfer is built, pre-checked live, and BLOCKED by the default policy', opts, async () => {
  const { createServer } = await import('../src/server.js');
  const srv = createServer().listen(0, '127.0.0.1');
  await new Promise((r) => srv.once('listening', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const post = (content) => fetch(`${base}/api/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ messages: [{ role: 'user', content }], account: 'near' }) }).then((r) => r.json());
  try {
    const big = (await post('send 50 NEAR to root.near')).cards[0];
    assert.equal(big.canSign, false);
    assert.equal(big.policy.verdict, 'deny');
    assert.ok(big.checks.some((c) => /exists/.test(c)));
    const small = (await post('send 0.5 NEAR to root.near')).cards[0];
    assert.equal(small.canSign, true);
    assert.equal(small.transactions[0].actions[0].type, 'Transfer');
    const typo = await post('send 1 NEAR to nonexistentaccount99887.near');
    assert.match(typo.reply, /does not exist/);
    assert.equal(typo.cards.length, 0);
    const evm = await post('send 1 NEAR to 0x00000000000000000000000000000000000dead1');
    assert.match(evm.reply, /Ethereum-style/);
    const key = (await post('create agent key for wrap.near methods near_deposit allowance 0.05')).cards[0];
    assert.equal(key.canSign, true);
    assert.equal(key.transactions[0].actions[0].type, 'AddKey');
    assert.ok(key.explain[0][0].includes('cannot move funds'));
    const loose = (await post('create agent key for wrap.near allowance 0.05')).cards[0];
    assert.equal(loose.canSign, false);
    const swap = (await post('swap 1 NEAR to USDC')).cards[0];
    assert.match(swap.checks.join(' '), /predict_swap_actions/);
    const cross = (await post('quote 1 NEAR to USDC on base')).cards[0];
    assert.equal(cross.transactions.length, 0);
    assert.match(cross.preview.minAmountOut, /\d/);
  } finally { srv.close(); }
});

test('policy cannot be changed through chat, only through the policy endpoint', opts, async () => {
  const { TOOLS } = await import('../src/agent/tools.js');
  assert.ok(!TOOLS.some((t) => /policy/.test(t.name) && !t.read), 'no tool may write the policy');
  assert.ok(!TOOLS.some((t) => /sign|send_transaction|broadcast/.test(t.name)), 'no tool may sign or broadcast');
});
