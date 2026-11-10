// NEAR Chain Signatures: derivation math against known vectors, the unsigned sign request, and the policy rules. Offline.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.SENTINEL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sentinel-cs-'));
const { keccak256 } = await import('../src/lib/keccak.js');
const { G, mul, add, onCurve } = await import('../src/lib/secp256k1.js');
const A = await import('../src/lib/addresses.js');
const cs = await import('../src/near/chainsig.js');
const { evaluate, validatePolicy, mergePolicy } = await import('../src/guard/policy.js');
const { makeCard } = await import('../src/guard/pipeline.js');
const { installFakeChain, RECORDED_DERIVED, SIGNER_ROOT_KEY_0, SIGNER_STATE, SIGNER_CONFIG } = await import('./fakechain.js');
const { tx, fnCall, policy, levels } = await import('./helpers.js');

const PAYLOAD = 'ab'.repeat(32);
const signTx = (over = {}, deposit = 1n, receiver = 'v1.signer', method = 'sign') =>
  [tx(receiver, [fnCall(method, { request: { path: 'ethereum-1', payload_v2: { Ecdsa: PAYLOAD }, domain_id: 0, ...over } }, 24n * 10n ** 12n, deposit)])];
const ctx = (extra = {}) => ({ signer: 'alice.near', now: 1_000_000_000_000, ledger: [], ...extra });

// ---- math: published vectors
test('keccak256 known vectors', () => {
  assert.equal(keccak256(Buffer.alloc(0)).toString('hex'), 'c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470');
  assert.equal(keccak256(Buffer.from('abc')).toString('hex'), '4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45');
  assert.equal(keccak256(Buffer.alloc(200, 0x61)).length, 32); // crosses the 136-byte rate boundary
});
test('secp256k1: private key 1 and 2 give the well-known EVM addresses', () => {
  assert.equal(A.evmAddress(G), '0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf');
  assert.equal(A.evmAddress(mul(2n)), '0x2B5AD5c4795c026514f8317c7a215E218DcCD6cF');
  assert.ok(onCurve(mul(123456789n)));
  assert.deepEqual(add(mul(3n), mul(4n)), mul(7n));
});
test('Bitcoin encodings: BIP-173 P2WPKH vector and the legacy address of private key 1', () => {
  assert.equal(A.btcP2wpkh(G), 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4');
  assert.equal(A.btcP2pkh(G), '1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH');
  assert.equal(A.btcP2wpkh(G, 'tb'), 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx');
});
test('derived keys equal values recorded from the live MPC contract (independent vectors)', () => {
  for (const v of RECORDED_DERIVED) {
    const p = cs.deriveChildKey(SIGNER_ROOT_KEY_0, v.predecessor, v.path);
    assert.equal(cs.formatSecpKey(p), v.key);
    const a = cs.addressesOf(p);
    assert.equal(a.evm, v.evm);
    assert.equal(a.bitcoin, v.btc);
  }
});
test('the tweak depends on the account and the path', () => {
  assert.notEqual(cs.tweakFor('alice.near', 'ethereum-1'), cs.tweakFor('bob.near', 'ethereum-1'));
  assert.notEqual(cs.tweakFor('alice.near', 'ethereum-1'), cs.tweakFor('alice.near', 'ethereum-2'));
});

// ---- contract-config driven values
test('domains and gas are read from the contract, not hardcoded', () => {
  const d = cs.domainsFromState(SIGNER_STATE);
  assert.deepEqual(d.filter((x) => x.usable).map((x) => x.id), [0]); // 1 is Ed25519, 2 is CKD, 3 is ForeignTx
  assert.equal(cs.signGasFromConfig(SIGNER_CONFIG), 24n * 10n ** 12n);
  assert.equal(cs.signGasFromConfig({ ...SIGNER_CONFIG, sign_call_gas_attachment_requirement_tera_gas: 40 }), 49n * 10n ** 12n);
  assert.throws(() => cs.signGasFromConfig({}), /no sign_call_gas/);
});

// ---- builder
test('the sign request has the contract argument shape, 1 yocto and config gas', async () => {
  const fc = installFakeChain();
  try {
    const b = await cs.buildChainSigRequest({ account: 'near', path: 'ethereum-1', payloadHex: '0x' + PAYLOAD.toUpperCase() });
    const [t] = b.transactions, a = t.actions[0];
    assert.equal(t.receiverId, 'v1.signer');
    assert.equal(a.type, 'FunctionCall');
    assert.equal(a.params.methodName, 'sign');
    assert.deepEqual(a.params.args, { request: { path: 'ethereum-1', payload_v2: { Ecdsa: PAYLOAD }, domain_id: 0 } });
    assert.equal(a.params.deposit, '1');
    assert.equal(a.params.gas, '24000000000000');
    assert.equal(b.preview.signingAddress, RECORDED_DERIVED[0].evm);
    await assert.rejects(cs.buildChainSigRequest({ account: 'near', path: 'ethereum-1', payloadHex: 'abcd' }), /32-byte hash/);
    await assert.rejects(cs.buildChainSigRequest({ account: 'near', path: '../x y', payloadHex: PAYLOAD }), /derivation path/);
    await assert.rejects(cs.buildChainSigRequest({ account: 'near', path: 'ethereum-1', payloadHex: PAYLOAD, domainId: 1 }), /only secp256k1/);
    await assert.rejects(cs.buildChainSigRequest({ account: 'near', path: 'ethereum-1', payloadHex: PAYLOAD, domainId: 3 }), /ForeignTx/);
    await assert.rejects(cs.buildChainSigRequest({ account: 'near', path: 'ethereum-1', payloadHex: PAYLOAD, domainId: 9 }), /does not exist/);
    assert.ok(fc.calls.every((m) => m === 'query' || m === 'gas_price'), 'only read-only RPC methods');
  } finally { fc.restore(); }
});
test('addresses are verified against the contract answer; a disagreeing contract is refused', async () => {
  const good = installFakeChain();
  try {
    const r = await cs.chainSigAddresses({ account: 'alice.near', path: 'bitcoin-1' });
    assert.equal(r.localDerivationMatchesContract, true);
    assert.equal(r.addresses.bitcoin, RECORDED_DERIVED[1].btc);
  } finally { good.restore(); }
  const evil = installFakeChain({ extraViews: { 'v1.signer.derived_public_key': () => RECORDED_DERIVED[0].key } });
  try {
    const r = await cs.chainSigAddresses({ account: 'alice.near', path: 'bitcoin-1' });
    assert.equal(r.localDerivationMatchesContract, false);
    assert.match(r.note, /WARNING/);
    await assert.rejects(cs.buildChainSigRequest({ account: 'alice.near', path: 'bitcoin-1', payloadHex: PAYLOAD }), /Refused: the key derived locally differs/);
  } finally { evil.restore(); }
});

// ---- policy rules
test('default policy: an allowed path asks for confirmation, never auto-allows', () => {
  const r = evaluate(policy(), signTx(), ctx());
  assert.equal(r.verdict, 'confirm');
  assert.deepEqual(levels(r), ['confirm:chainsig.confirm']);
});
test('confirmEach off: an allowed path is allowed', () => {
  const r = evaluate(policy({ chainSig: { confirmEach: false } }), signTx(), ctx());
  assert.equal(r.verdict, 'allow');
});
test('a derivation path outside the allowlist is denied; prefix wildcards work', () => {
  assert.ok(levels(evaluate(policy(), signTx({ path: 'solana-1' }), ctx())).includes('deny:chainsig.path_not_allowed'));
  assert.ok(!levels(evaluate(policy(), signTx({ path: 'base-7' }), ctx())).includes('deny:chainsig.path_not_allowed'));
  const exact = policy({ chainSig: { allowedPaths: ['ethereum-1'] } });
  assert.ok(!levels(evaluate(exact, signTx({ path: 'ethereum-1' }), ctx())).includes('deny:chainsig.path_not_allowed'));
  assert.ok(levels(evaluate(exact, signTx({ path: 'ethereum-10' }), ctx())).includes('deny:chainsig.path_not_allowed'));
  assert.ok(levels(evaluate(policy({ chainSig: { allowedPaths: [] } }), signTx(), ctx())).includes('deny:chainsig.path_not_allowed'));
});
test('daily cap counts settled signature requests in the rolling 24h ledger', () => {
  const now = 1_000_000_000_000;
  const p = policy({ chainSig: { maxPerDay: 2 } });
  const rows = (n, age) => Array.from({ length: n }, () => ({ ts: now - age, token: 'chainsig:sign', amount: '1' }));
  assert.ok(!levels(evaluate(p, signTx(), ctx({ ledger: rows(1, 3600e3) }))).includes('deny:chainsig.daily_limit'));
  assert.ok(levels(evaluate(p, signTx(), ctx({ ledger: rows(2, 3600e3) }))).includes('deny:chainsig.daily_limit'));
  assert.ok(!levels(evaluate(p, signTx(), ctx({ ledger: rows(2, 25 * 3600e3) }))).includes('deny:chainsig.daily_limit'));
  const two = [...signTx(), ...signTx()];
  assert.ok(levels(evaluate(policy({ chainSig: { maxPerDay: 1 } }), two, ctx())).includes('deny:chainsig.daily_limit'));
  assert.ok(levels(evaluate(policy({ chainSig: { maxPerDay: 0 } }), signTx(), ctx())).includes('deny:chainsig.daily_limit'));
});
test('disabled switch, wrong domain, bad payload, extra fields and wrong deposit are all denied', () => {
  assert.ok(levels(evaluate(policy({ chainSig: { enabled: false } }), signTx(), ctx())).includes('deny:chainsig.disabled'));
  assert.ok(levels(evaluate(policy(), signTx({ domain_id: 1 }), ctx())).includes('deny:chainsig.domain_not_allowed'));
  assert.ok(levels(evaluate(policy(), signTx({ payload_v2: { Ecdsa: 'abcd' } }), ctx())).includes('deny:chainsig.bad_payload'));
  assert.ok(levels(evaluate(policy(), signTx({ payload_v2: { Eddsa: PAYLOAD } }), ctx())).includes('deny:chainsig.bad_payload'));
  assert.ok(levels(evaluate(policy(), signTx({ payload: [1] }), ctx())).includes('deny:chainsig.bad_request'));
  assert.ok(levels(evaluate(policy(), signTx({}, 10n ** 24n), ctx())).includes('deny:chainsig.deposit'));
  assert.ok(levels(evaluate(policy(), signTx({}, 0n), ctx())).includes('deny:chainsig.deposit'));
});
test('only sign() is allowed on the signer; sign() on any other contract is denied', () => {
  const other = tx('v1.signer', [fnCall('respond', {}, 10n ** 13n, 0n)]);
  assert.ok(levels(evaluate(policy(), [other], ctx())).includes('deny:method.not_allowed'));
  const r = evaluate(policy(), signTx({}, 1n, 'evil.near'), ctx());
  assert.ok(levels(r).includes('deny:chainsig.unknown_signer'));
  assert.ok(levels(r).includes('deny:contract.not_allowed'));
});
test('a full card goes through the same pipeline: confirm, signable, explained, audited', async () => {
  const fc = installFakeChain();
  try {
    const b = await cs.buildChainSigRequest({ account: 'alice.near', path: 'ethereum-1', payloadHex: PAYLOAD });
    const card = await makeCard('alice.near', b, { tool: 'chainsig_prepare_request' });
    assert.equal(card.policy.verdict, 'confirm');
    assert.ok(card.policy.findings.some((f) => f.rule === 'chainsig.confirm'));
    assert.equal(card.canSign, true);
    assert.equal(card.needsConfirm, true);
    assert.match(card.explain.flat()[0], /MPC network.*sign the 32-byte hash/);
    assert.ok(card.checks.some((c) => /Running/.test(c)));
    const denied = await makeCard('alice.near', { transactions: signTx({ path: 'solana-1' }) });
    assert.equal(denied.canSign, false);
  } finally { fc.restore(); }
});
test('policy validation covers the chainSig block', () => {
  assert.equal(validatePolicy(mergePolicy({})).ok, true);
  assert.equal(validatePolicy(mergePolicy({ chainSig: { maxPerDay: -1 } })).ok, false);
  assert.equal(validatePolicy(mergePolicy({ chainSig: { allowedDomains: ['x'] } })).ok, false);
  assert.equal(validatePolicy(mergePolicy({ chainSig: { enabled: 'yes' } })).ok, false);
});

test('settlement counts a signature request only after the chain confirmed it, and the daily cap then bites', async () => {
  process.env.SENTINEL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sentinel-cs-ledger-'));
  const { settle, entries } = await import('../src/guard/ledger.js');
  const t = signTx()[0];
  const outcome = (status) => ({ status, receipts_outcome: [], transaction: { signer_id: 'alice.near', receiver_id: 'v1.signer', actions: [{ FunctionCall: {} }] } });
  const fc = installFakeChain({ txOutcomes: { OK: outcome({ SuccessValue: '' }), BAD: outcome({ Failure: { ActionError: {} } }) } });
  try {
    assert.equal((await settle('alice.near', 'BAD', t)).settled, false);
    assert.equal(entries('alice.near').length, 0);
    assert.equal((await settle('alice.near', 'OK', t)).settled, true);
    const rows = entries('alice.near');
    assert.deepEqual(rows.map((r) => [r.token, r.amount, r.to]), [['chainsig:sign', '1', 'ethereum-1']]);
    const p = policy({ chainSig: { maxPerDay: 1 } });
    assert.ok(levels(evaluate(p, signTx(), ctx({ ledger: rows.map((r) => ({ ...r, ts: 1_000_000_000_000 - 1000 })) }))).includes('deny:chainsig.daily_limit'));
  } finally { fc.restore(); }
});
