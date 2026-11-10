import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, validatePolicy, mergePolicy, DEFAULT_POLICY } from '../src/guard/policy.js';
import { tx, fnCall, transfer, addFunctionCallKey, NEAR, sendNear, ftSend, policy, levels, KEY } from './helpers.js';

const ME = 'alice.near';
const ctx = (extra = {}) => ({ signer: ME, now: 1_000_000_000_000, ledger: [], decimals: {}, ...extra });

test('a small transfer inside every limit is allowed', () => {
  const r = evaluate(policy(), sendNear('bob.near', 0.5), ctx());
  assert.equal(r.verdict, 'allow');
});

test('per-transaction cap denies', () => {
  const r = evaluate(policy(), sendNear('bob.near', 6), ctx());
  assert.equal(r.verdict, 'deny');
  assert.ok(levels(r).includes('deny:limit.per_tx'));
});

test('confirmation threshold asks, without denying', () => {
  const r = evaluate(policy(), sendNear('bob.near', 2), ctx());
  assert.equal(r.verdict, 'confirm');
  assert.deepEqual(levels(r), ['confirm:limit.confirm_above']);
});

test('daily cap counts the rolling 24h ledger', () => {
  const now = 1_000_000_000_000;
  const ledger = [{ ts: now - 3600e3, token: 'near', amount: NEAR(9).toString() }];
  const r = evaluate(policy(), sendNear('bob.near', 2), ctx({ ledger }));
  assert.ok(levels(r).includes('deny:limit.daily'));
});

test('spend older than 24h no longer counts', () => {
  const now = 1_000_000_000_000;
  const ledger = [{ ts: now - 25 * 3600e3, token: 'near', amount: NEAR(9.9).toString() }];
  const r = evaluate(policy(), sendNear('bob.near', 2), ctx({ ledger }));
  assert.ok(!levels(r).includes('deny:limit.daily'));
});

test('several actions in one batch are summed against the per-tx cap', () => {
  const txs = [...sendNear('bob.near', 3), ...sendNear('carol.near', 3)];
  assert.ok(levels(evaluate(policy(), txs, ctx())).includes('deny:limit.per_tx'));
});

test('recipient allowlist denies unknown recipients and permits listed ones', () => {
  const p = policy({ recipients: { mode: 'allowlist', list: ['bob.near'] } });
  assert.equal(evaluate(p, sendNear('bob.near', 0.5), ctx()).verdict, 'allow');
  const r = evaluate(p, sendNear('mallory.near', 0.5), ctx());
  assert.ok(levels(r).includes('deny:recipient.not_allowed'));
});

test('allowlisted token transfer to an unlisted recipient is denied (ft_transfer receiver is checked)', () => {
  const p = policy({ recipients: { mode: 'allowlist', list: ['bob.near'] }, limits: { 'usdc.tkn.near': { perTx: '100' } } });
  const r = evaluate(p, ftSend('usdc.tkn.near', 'mallory.near', 5_000_000), ctx({ decimals: { 'usdc.tkn.near': 6 }, symbols: { 'usdc.tkn.near': 'USDC' } }));
  assert.ok(levels(r).includes('deny:recipient.not_allowed'));
});

test('contract allowlist: unknown contract is denied, known is allowed', () => {
  const call = (c, m) => [tx(c, [fnCall(m, {}, 30n * 10n ** 12n, 0n)])];
  assert.ok(levels(evaluate(policy(), call('evil.near', 'drain'), ctx())).includes('deny:contract.not_allowed'));
  assert.equal(evaluate(policy(), call('meta-pool.near', 'withdraw_all'), ctx()).verdict, 'allow');
});

test('method allowlist: wrap.near only allows listed methods', () => {
  const r = evaluate(policy(), [tx('wrap.near', [fnCall('ft_transfer_call', { receiver_id: 'x.near', amount: '1', msg: '' }, 30n * 10n ** 12n, 1n)])], ctx({ decimals: { 'wrap.near': 24 } }));
  assert.ok(levels(r).includes('deny:method.not_allowed'));
});

test('blocked contract wins over the allow list', () => {
  const p = policy({ blockedContracts: ['meta-pool.near'] });
  const r = evaluate(p, [tx('meta-pool.near', [fnCall('deposit_and_stake', {}, 30n * 10n ** 12n, NEAR(0.1))])], ctx());
  assert.ok(levels(r).includes('deny:contract.blocked'));
});

test('hard rules: full-access key, deploy, delete account are always denied', () => {
  const full = [tx(ME, [{ type: 'AddKey', params: { publicKey: KEY, accessKey: { permission: 'FullAccess' } } }])];
  assert.ok(levels(evaluate(policy(), full, ctx())).includes('deny:hard.full_access_key'));
  assert.ok(levels(evaluate(policy(), [tx(ME, [{ type: 'DeployContract', params: { code: 'AA==' } }])], ctx())).includes('deny:hard.deploy'));
  assert.ok(levels(evaluate(policy(), [tx(ME, [{ type: 'DeleteAccount', params: { beneficiaryId: 'evil.near' } }])], ctx())).includes('deny:hard.delete_account'));
  // even a maximally permissive policy cannot allow them
  const open = policy({ allowedContracts: [ME], unlistedToken: 'allow' });
  assert.equal(evaluate(open, full, ctx()).verdict, 'deny');
});

test('unknown action types are refused rather than ignored', () => {
  assert.ok(levels(evaluate(policy(), [tx(ME, [{ type: 'Mystery', params: {} }])], ctx())).includes('deny:hard.unknown_action'));
});

test('token without a limit follows unlistedToken: confirm by default, deny when configured', () => {
  const c = ctx({ decimals: { 'usdc.tkn.near': 6 }, symbols: { 'usdc.tkn.near': 'USDC' } });
  assert.equal(evaluate(policy(), ftSend('usdc.tkn.near', 'bob.near', 1_000_000), c).verdict, 'confirm');
  assert.equal(evaluate(policy({ unlistedToken: 'deny' }), ftSend('usdc.tkn.near', 'bob.near', 1_000_000), c).verdict, 'deny');
  assert.equal(evaluate(policy({ unlistedToken: 'allow' }), ftSend('usdc.tkn.near', 'bob.near', 1_000_000), c).verdict, 'allow');
});

test('per-token limits use the token decimals', () => {
  const p = policy({ limits: { near: DEFAULT_POLICY.limits.near, 'usdc.tkn.near': { perTx: '10', daily: '25' } } });
  const c = ctx({ decimals: { 'usdc.tkn.near': 6 }, symbols: { 'usdc.tkn.near': 'USDC' } });
  assert.equal(evaluate(p, ftSend('usdc.tkn.near', 'bob.near', 9_999_999), c).verdict, 'allow');
  assert.ok(levels(evaluate(p, ftSend('usdc.tkn.near', 'bob.near', 10_000_001), c)).includes('deny:limit.per_tx'));
});

test('unknown token decimals cannot be compared, so the user is asked', () => {
  const p = policy({ limits: { 'x.tkn.near': { perTx: '1' } } });
  assert.ok(levels(evaluate(p, ftSend('x.tkn.near', 'bob.near', 1), ctx())).includes('confirm:limit.unknown_decimals'));
});

test('wNEAR leaving the account counts against the NEAR limits', () => {
  const r = evaluate(policy(), ftSend('wrap.near', 'bob.near', NEAR(6)), ctx({ decimals: { 'wrap.near': 24 } }));
  assert.ok(levels(r).includes('deny:limit.per_tx'));
});

test('wrapping NEAR keeps the value in the account and is not a spend', () => {
  const r = evaluate(policy(), [tx('wrap.near', [fnCall('near_deposit', {}, 30n * 10n ** 12n, NEAR(100))])], ctx());
  assert.equal(r.verdict, 'allow');
});

test('a huge "storage deposit" is a real spend, a small one is a registration fee', () => {
  const sd = (n) => [tx('usdc.tkn.near', [fnCall('storage_deposit', { account_id: 'bob.near' }, 30n * 10n ** 12n, NEAR(n))])];
  assert.equal(evaluate(policy(), sd(0.00125), ctx()).verdict, 'allow');
  assert.ok(levels(evaluate(policy(), sd(20), ctx())).includes('deny:limit.per_tx'));
});

test('high attached gas asks for confirmation', () => {
  const p = policy({ maxGasTgas: 100 });
  const r = evaluate(p, [tx('meta-pool.near', [fnCall('deposit_and_stake', {}, 250n * 10n ** 12n, NEAR(0.1))])], ctx());
  assert.ok(levels(r).includes('confirm:gas.high'));
});

test('an Intents deposit address is accepted only when a trusted builder produced it', () => {
  const dep = 'a'.repeat(64);
  const p = policy({ recipients: { mode: 'allowlist', list: [] } });
  const c = ctx({ decimals: { 'wrap.near': 24 } });
  assert.ok(levels(evaluate(p, ftSend('wrap.near', dep, NEAR(1)), c)).includes('deny:recipient.not_allowed'));
  assert.ok(!levels(evaluate(p, ftSend('wrap.near', dep, NEAR(1)), { ...c, trustedRecipients: new Set([dep]) })).includes('deny:recipient.not_allowed'));
});

// ---- agent keys
const keyTx = (perm) => [tx(ME, [addFunctionCallKey(KEY, perm.receiverId, perm.methodNames, perm.allowance)])];

test('a scoped function-call key within the allowance cap is allowed', () => {
  const r = evaluate(policy(), keyTx({ receiverId: 'wrap.near', methodNames: ['near_deposit'], allowance: NEAR(0.1) }), ctx());
  assert.equal(r.verdict, 'allow');
});

test('a key with no method list, unlimited allowance, too-big allowance or a foreign contract is denied', () => {
  const run = (perm) => levels(evaluate(policy(), keyTx(perm), ctx()));
  assert.ok(run({ receiverId: 'wrap.near', methodNames: [], allowance: NEAR(0.1) }).includes('deny:key.any_method'));
  assert.ok(run({ receiverId: 'wrap.near', methodNames: ['near_deposit'], allowance: undefined }).includes('deny:key.unlimited_allowance'));
  assert.ok(run({ receiverId: 'wrap.near', methodNames: ['near_deposit'], allowance: NEAR(1) }).includes('deny:key.allowance_too_high'));
  assert.ok(run({ receiverId: 'evil.near', methodNames: ['x'], allowance: NEAR(0.1) }).includes('deny:key.receiver_not_allowed'));
});

// ---- policy objects
test('validatePolicy rejects malformed policies', () => {
  assert.equal(validatePolicy(mergePolicy({})).ok, true);
  assert.equal(validatePolicy(mergePolicy({ unlistedToken: 'maybe' })).ok, false);
  assert.equal(validatePolicy(mergePolicy({ limits: { near: { perTx: 'lots' } } })).ok, false);
  assert.equal(validatePolicy(mergePolicy({ maxGasTgas: 0 })).ok, false);
});

test('the default policy is not mutated by merging', () => {
  const m = mergePolicy({ allowedContracts: ['x.near'] });
  m.limits.near.perTx = '999';
  assert.equal(DEFAULT_POLICY.limits.near.perTx, '5');
});
