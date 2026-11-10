// npm run selftest: a scripted tour that checks every README claim and prints PASS / FAIL.
//   offline (default): no network, no API key, no wallet. Uses a fake NEAR RPC seeded with values recorded from mainnet.
//   LIVE=1           : additionally reads public NEAR mainnet (read-only) and asks NEAR Intents for a quote.
// Nothing is ever signed or sent. Exit code 0 only when every check passed.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

if (Number(process.versions.node.split('.')[0]) < 22) { console.error('NEAR Sentinel needs Node 22 or newer.'); process.exit(1); }
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.env.SENTINEL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sentinel-selftest-'));
delete process.env.LLM_API_KEY; // the tour is the offline mode
const LIVE = process.env.LIVE === '1';
const imp = (p) => import(path.join(ROOT, p));

const { installFakeChain, RECORDED_DERIVED, SIGNER_ROOT_KEY_0 } = await imp('test/fakechain.js');
const { runTool, TOOLS } = await imp('src/agent/tools.js');
const { chatOffline } = await imp('src/agent/offline.js');
const { llmSettings, llmConfigured } = await imp('src/agent/llm.js');
const { evaluate, mergePolicy } = await imp('src/guard/policy.js');
const { makeCard } = await imp('src/guard/pipeline.js');
const { checkKeyAllows } = await imp('src/guard/keys.js');
const { settle, entries } = await imp('src/guard/ledger.js');
const audit = await imp('src/guard/audit.js');
const cs = await imp('src/near/chainsig.js');
const { tx, fnCall, transfer, addFunctionCallKey } = await imp('src/near/actions.js');
const { createServer } = await imp('src/server.js');

const NEAR = (n) => (BigInt(Math.round(n * 1e6)) * 10n ** 18n).toString();
const ME = 'alice.near';
const rows = [];
const check = (track, requirement, fn, { live = false } = {}) => rows.push({ track, requirement, fn, live });
const card = async (text, account = ME) => {
  const r = await chatOffline([{ content: text }], account);
  if (!r.cards[0]) throw new Error(`no card for "${text}": ${r.reply.slice(0, 100)}`);
  return r.cards[0];
};
const PAYLOAD = 'ab'.repeat(32);

// ------------------------------------------------------------------ AI Security & Defense
check('AI Security', 'Spending limits: 0.5 NEAR allowed, 2 NEAR needs confirmation, 50 NEAR blocked', async () => {
  const a = await card('send 0.5 NEAR to root.near'), b = await card('send 2 NEAR to root.near'), c = await card('send 50 NEAR to root.near');
  assert.deepEqual([a.policy.verdict, b.policy.verdict, c.policy.verdict], ['allow', 'confirm', 'deny']);
  assert.equal(c.canSign, false);
  return 'allow / confirm / deny, blocked card cannot be signed';
});
check('AI Security', 'Hard rules no configuration can lift (full-access key, deploy, delete account)', async () => {
  const p = mergePolicy({ allowedContracts: ['evil.near'] });
  const full = evaluate(p, [tx(ME, [{ type: 'AddKey', params: { publicKey: 'ed25519:x', accessKey: { permission: 'FullAccess' } } }])], { signer: ME });
  const dep = evaluate(p, [tx(ME, [{ type: 'DeployContract', params: {} }])], { signer: ME });
  const del = evaluate(p, [tx(ME, [{ type: 'DeleteAccount', params: { beneficiaryId: 'x.near' } }])], { signer: ME });
  assert.deepEqual([full.verdict, dep.verdict, del.verdict], ['deny', 'deny', 'deny']);
  return 'AddKey(FullAccess), DeployContract, DeleteAccount all denied';
});
check('AI Security', 'Function-call key sandbox: protocol forbids deposits; agent key card is checked', async () => {
  const key = { type: 'function_call', receiverId: 'wrap.near', methodNames: ['near_deposit'], allowanceYocto: NEAR(0.01) };
  const ok = checkKeyAllows(key, [tx('wrap.near', [fnCall('near_deposit', {}, 30n * 10n ** 12n, 0n)])]);
  const dep = checkKeyAllows(key, [tx('wrap.near', [fnCall('near_deposit', {}, 30n * 10n ** 12n, 10n ** 24n)])]);
  assert.equal(ok.allowed, true); assert.equal(dep.allowed, false);
  const any = await card('create agent key for wrap.near allowance 0.05');
  assert.equal(any.canSign, false);
  const good = await card('create agent key for wrap.near methods near_deposit allowance 0.05');
  assert.equal(good.policy.verdict, 'allow');
  return 'deposit refused for a scoped key; key without method list blocked; scoped key within policy';
});
check('AI Security', 'Pre-sign checks: typo recipient refused from chain state; explanation derived from actions', async () => {
  const r = await chatOffline([{ content: 'send 1 NEAR to nonexistentaccount99887.near' }], ME);
  assert.match(r.reply, /does not exist/);
  const c = await card('send 0.5 NEAR to root.near');
  assert.ok(c.checks.some((x) => /exists/.test(x)) && /Send 0.5 NEAR to root.near/.test(c.explain.flat()[0]));
  return 'refused with "does not exist"; checks list + plain-words line present';
});
check('AI Security', 'The agent has no tool that signs, broadcasts or edits policy', async () => {
  const names = TOOLS.map((t) => t.name);
  assert.ok(TOOLS.every((t) => Boolean(t.read) !== Boolean(t.build)));
  assert.ok(!names.some((n) => /^sign$|broadcast|submit|set_?policy|edit_?policy|private|secret/.test(n)));
  const src = fs.readdirSync(path.join(ROOT, 'src/agent')).map((f) => fs.readFileSync(path.join(ROOT, 'src/agent', f), 'utf8')).join('\n');
  assert.ok(!/setPolicy|broadcast_tx|send_tx|signAndSend/.test(src));
  return `${names.length} tools, all read-only or card builders (full proof: test/agent.test.js)`;
});
check('AI Security', 'Ledger counts only chain-confirmed spend (a signature is not a success)', async () => {
  const t = tx('root.near', [transfer(BigInt(NEAR(1)))]);
  const o = (status) => ({ status, receipts_outcome: [], transaction: { signer_id: ME, receiver_id: 'root.near', actions: [{ Transfer: {} }] } });
  const fc = installFakeChain({ txOutcomes: { FAIL: o({ Failure: {} }), GOOD: o({ SuccessValue: '' }) } });
  try {
    const before = entries(ME).length;
    assert.equal((await settle(ME, 'FAIL', t)).settled, false);
    assert.equal(entries(ME).length, before);
    assert.equal((await settle(ME, 'GOOD', t)).settled, true);
    assert.equal(entries(ME).length, before + 1);
  } finally { fc.restore(); }
  return 'failed transaction not counted; successful one counted';
});
check('AI Security', 'Agent safety report: every proposal logged, hash-chained, exportable, tamper-evident', async () => {
  const r = audit.report(ME);
  assert.ok(r.entries.length >= 6);
  assert.ok(['allow', 'confirm', 'deny', 'refused'].every((v) => r.entries.some((e) => e.verdict === v)));
  assert.ok(r.entries.every((e) => e.reason && Array.isArray(e.rules) && Array.isArray(e.checks)));
  assert.equal(r.hashChain.ok, true);
  const bad = JSON.parse(JSON.stringify(r.entries)); bad[0].verdict = 'allow'; bad[0].reason = 'edited';
  assert.equal(audit.verifyChain(bad).ok, false);
  JSON.parse(JSON.stringify(r));
  return `${r.entries.length} entries, chain intact, edit detected`;
});

// ------------------------------------------------------------------ Agent Economy / Chain Signatures
check('Agent Economy', 'Chain Signatures: derived EVM + Bitcoin addresses equal values recorded from the live MPC contract', async () => {
  for (const v of RECORDED_DERIVED) {
    const a = cs.addressesOf(cs.deriveChildKey(SIGNER_ROOT_KEY_0, v.predecessor, v.path));
    assert.equal(a.evm, v.evm); assert.equal(a.bitcoin, v.btc);
  }
  return `${RECORDED_DERIVED.length} vectors (keccak256, secp256k1, bech32 written from scratch)`;
});
check('Agent Economy', 'Chain Signatures: sign() request is unsigned, 1 yocto, gas from contract config, goes through the policy', async () => {
  const fc = installFakeChain();
  try {
    const c = await card(`sign payload 0x${PAYLOAD} path ethereum-1`);
    const a = c.transactions[0].actions[0].params;
    assert.deepEqual([c.transactions[0].receiverId, a.methodName, a.deposit, a.gas], ['v1.signer', 'sign', '1', '24000000000000']);
    assert.deepEqual(a.args, { request: { path: 'ethereum-1', payload_v2: { Ecdsa: PAYLOAD }, domain_id: 0 } });
    assert.equal(c.policy.verdict, 'confirm');
    const off = await makeCard(ME, { transactions: [tx('v1.signer', [fnCall('sign', { request: { path: 'solana-1', payload_v2: { Ecdsa: PAYLOAD }, domain_id: 0 } }, 24n * 10n ** 12n, 1n)])] });
    assert.equal(off.canSign, false);
    assert.ok(off.policy.findings.some((f) => f.rule === 'chainsig.path_not_allowed'));
  } finally { fc.restore(); }
  return 'allowed path -> confirm; other path -> blocked (chainsig.path_not_allowed)';
});
check('Agent Economy', 'Chain Signatures: daily cap on signature requests', async () => {
  const p = mergePolicy({ chainSig: { maxPerDay: 1 } });
  const t = [tx('v1.signer', [fnCall('sign', { request: { path: 'ethereum-1', payload_v2: { Ecdsa: PAYLOAD }, domain_id: 0 } }, 24n * 10n ** 12n, 1n)])];
  const r = evaluate(p, t, { signer: ME, ledger: [{ ts: Date.now() - 1000, token: 'chainsig:sign', amount: '1' }] });
  assert.ok(r.findings.some((f) => f.rule === 'chainsig.daily_limit'));
  return 'second request within 24h denied when maxPerDay=1';
});
check('Agent Economy', 'Agent can earn/pay across chains through NEAR Intents (tools registered; quotes need network)', async () => {
  assert.ok(['intents_swap', 'intents_receive', 'intents_status', 'intents_chains'].every((n) => TOOLS.some((t) => t.name === n)));
  return 'intents_swap / intents_receive registered; live quote runs with LIVE=1';
});

// ------------------------------------------------------------------ Unstoppable DeFi / Social Money / Open Innovation
check('Unstoppable DeFi', 'Non-custodial: cards are unsigned transaction data; the server holds no signing key', async () => {
  const c = await card('send 0.5 NEAR to root.near');
  assert.ok(!JSON.stringify(c.transactions).match(/signature|secret|private/i));
  assert.deepEqual(Object.keys(c.transactions[0]).sort(), ['actions', 'receiverId']);
  return 'transactions carry only receiverId + actions';
});
check('Social Money', 'Sputnik DAO: agents may create Transfer/Vote proposals, never policy changes or upgrades', async () => {
  const prop = (kind) => [tx('club.sputnik-dao.near', [fnCall('add_proposal', { proposal: { description: 'x', kind } }, 100n * 10n ** 12n, 10n ** 23n)])];
  const ok = evaluate(mergePolicy({}), prop('Vote'), { signer: ME });
  const bad = evaluate(mergePolicy({}), prop({ ChangePolicy: { policy: {} } }), { signer: ME });
  assert.equal(ok.verdict, 'allow'); assert.equal(bad.verdict, 'deny');
  return 'Vote allowed, ChangePolicy denied (full DAO flow tested in test/sputnik.test.js)';
});
check('Open Innovation', 'Web UI serves chat, policy, cross-chain and safety-report views; API answers', async () => {
  const fc = installFakeChain();
  const srv = createServer().listen(0, '127.0.0.1');
  await new Promise((r) => srv.once('listening', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    const html = await (await fetch(base + '/')).text();
    assert.ok(html.includes('Cross-chain') && html.includes('Agent safety report') && html.includes('Chain Signatures'));
    assert.equal((await (await fetch(base + '/api/config')).json()).mode, 'offline');
    const dl = await fetch(`${base}/api/audit?account=${ME}&download=1`);
    assert.match(dl.headers.get('content-disposition'), /attachment/);
    assert.ok((await dl.json()).entries.length > 0);
    const cs1 = await (await fetch(`${base}/api/chainsig?account=${ME}&path=ethereum-1`)).json();
    assert.equal(cs1.addresses.evm, RECORDED_DERIVED[2].evm);
    const put = await fetch(`${base}/api/policy?account=${ME}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...mergePolicy({}), chainSig: { ...mergePolicy({}).chainSig, maxPerDay: 3 } }) });
    assert.equal((await put.json()).chainSig.maxPerDay, 3);
  } finally { srv.close(); fc.restore(); }
  return 'GET / , /api/config, /api/audit?download=1, /api/chainsig, PUT /api/policy';
});
check('LLM options', 'Default is offline; NEAR AI Cloud is a first-class OpenAI-compatible option via env', async () => {
  assert.equal(llmConfigured(), false);
  const n = llmSettings({ LLM_PROVIDER: 'near-ai' });
  assert.deepEqual([n.baseUrl, n.label], ['https://cloud-api.near.ai/v1', 'NEAR AI Cloud']);
  return 'no key -> offline commands; LLM_PROVIDER=near-ai + LLM_API_KEY -> cloud-api.near.ai (key required)';
});
check('Packaging', 'Zero npm dependencies, Node 22+', async () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.ok(!pkg.dependencies && !pkg.devDependencies && !fs.existsSync(path.join(ROOT, 'node_modules')));
  assert.match(pkg.engines.node, /22/);
  return `node ${process.versions.node}, no dependencies`;
});

// ------------------------------------------------------------------ LIVE (read-only)
check('LIVE', 'MPC contract v1.signer: derived key from the contract view equals local math; domains from state', async () => {
  const r = await cs.chainSigAddresses({ account: 'near', path: 'ethereum-1' });
  assert.equal(r.localDerivationMatchesContract, true);
  assert.equal(r.addresses.evm, RECORDED_DERIVED[0].evm);
  const c = await cs.chainSigConfig();
  return `v${c.version}, domains ${c.domains.filter((d) => d.usable).map((d) => d.id)} usable, gas ${c.gasTgas} Tgas, evm ${r.addresses.evm}`;
}, { live: true });
check('LIVE', 'Live card: send 0.5 NEAR is read against mainnet and allowed; 50 NEAR blocked', async () => {
  const a = await card('send 0.5 NEAR to root.near', 'near'), b = await card('send 50 NEAR to root.near', 'near');
  assert.equal(a.policy.verdict, 'allow'); assert.equal(b.canSign, false);
  return `${a.checks.length} live checks on the allowed card`;
}, { live: true });
check('LIVE', 'Live Chain Signatures card through the same pipeline', async () => {
  const c = await card(`sign payload 0x${PAYLOAD} path ethereum-1`, 'near');
  assert.equal(c.policy.verdict, 'confirm');
  return c.checks[0];
}, { live: true });
check('LIVE', 'Sputnik DAO read: ref-finance.sputnik-dao.near', async () => {
  const r = await runTool('dao_info', { dao: 'ref-finance.sputnik-dao.near' }, 'near');
  assert.ok(r.toModel.roles?.length || r.toModel.proposalBondNear, JSON.stringify(r.toModel).slice(0, 120));
  return `bond ${r.toModel.proposalBondNear} NEAR`;
}, { live: true });
check('LIVE', 'NEAR Intents: cross-chain quote (no deposit address created)', async () => {
  const c = await card('quote 1 NEAR to USDC on base', 'near');
  assert.ok(c && (c.explain.flat().length || c.note));
  return (c.note ?? c.explain.flat()[0] ?? '').slice(0, 90);
}, { live: true });

// ------------------------------------------------------------------ run
const out = [];
const offlineFc = installFakeChain({ accounts: { 'alice.near': { amount: NEAR(500), locked: '0', code_hash: 'ABC', storage_usage: 500, storage_paid_at: 0 } } });
// alice.near's offline vectors for ethereum-1 are index 2 in RECORDED_DERIVED.
let failed = 0;
for (const r of rows) {
  if (r.live && !LIVE) { out.push({ ...r, status: 'SKIP', detail: 'set LIVE=1 to run' }); continue; }
  if (r.live) offlineFc.restore();
  try {
    const detail = r.live ? await retry(r.fn) : await r.fn();
    out.push({ ...r, status: 'PASS', detail });
  } catch (e) { failed++; out.push({ ...r, status: 'FAIL', detail: String(e.message).split('\n')[0].slice(0, 140) }); }
}
async function retry(fn) { try { return await fn(); } catch { await new Promise((r) => setTimeout(r, 3000)); return fn(); } }
offlineFc.restore();

const w = (k) => Math.max(...out.map((r) => r[k].length));
const line = (a, b, c, d) => `${a.padEnd(w('track'))}  ${b.padEnd(6)}  ${c.padEnd(w('requirement'))}  ${d}`;
console.log(`NEAR Sentinel self-test (${LIVE ? 'offline + LIVE read-only' : 'offline'}; nothing is signed or sent)\n`);
console.log(line('TRACK', 'RESULT', 'REQUIREMENT', 'EVIDENCE'));
for (const r of out) console.log(line(r.track, r.status, r.requirement, r.detail));
const n = (s) => out.filter((r) => r.status === s).length;
console.log(`\n${n('PASS')} passed, ${n('FAIL')} failed, ${n('SKIP')} skipped${n('SKIP') ? ' (live checks: run  LIVE=1 npm run selftest)' : ''}`);
process.exit(failed ? 1 : 0);
