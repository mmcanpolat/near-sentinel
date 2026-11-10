// The agent's tool layer is read-only: no tool signs, broadcasts, or edits the policy. Plus NEAR AI Cloud wiring and the audit trail.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'sentinel-agent-'));
process.env.SENTINEL_DATA_DIR = DATA;
const { TOOLS, toolSpecs, runTool } = await import('../src/agent/tools.js');
const { llmSettings, chatWithTools, PROVIDERS } = await import('../src/agent/llm.js');
const { chatOffline } = await import('../src/agent/offline.js');
const audit = await import('../src/guard/audit.js');
const { installFakeChain } = await import('./fakechain.js');
const SRC = path.resolve(import.meta.dirname, '../src');
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));

test('every tool is either a read or a card builder, and none is named or parameterised like a signer or policy editor', () => {
  for (const t of TOOLS) {
    assert.ok(Boolean(t.read) !== Boolean(t.build), `${t.name} must be exactly one of read / build`);
    assert.doesNotMatch(t.name, /^sign$|broadcast|submit|send_tx|execute|set_?policy|edit_?policy|update_?policy|put_?policy|private|secret|seed/i, t.name);
    for (const p of Object.keys(t.parameters.properties)) assert.doesNotMatch(p, /policy|private|secret|seed|mnemonic/i, `${t.name}.${p}`);
  }
  assert.ok(toolSpecs().length === TOOLS.length);
});

test('source check: the agent layer cannot reach policy writers, broadcasting, or key material', () => {
  const agentSrc = walk(path.join(SRC, 'agent')).map((f) => fs.readFileSync(f, 'utf8')).join('\n');
  for (const word of ['setPolicy', 'settle(', 'record(', 'broadcast_tx', 'send_tx', 'signAndSend', 'secretKey', 'writeFileSync', 'PUT']) assert.ok(!agentSrc.includes(word), `agent layer mentions ${word}`);
  const all = walk(SRC).map((f) => fs.readFileSync(f, 'utf8')).join('\n');
  assert.ok(!/broadcast_tx|send_tx/.test(all), 'no RPC method that submits a transaction exists anywhere in src/');
  // the only caller of setPolicy is the HTTP route for the human's Policy panel
  const callers = walk(SRC).filter((f) => /setPolicy\(/.test(fs.readFileSync(f, 'utf8')) && !/export function setPolicy/.test(fs.readFileSync(f, 'utf8'))).map((f) => path.relative(SRC, f));
  assert.deepEqual(callers, ['server.js']);
});

test('behaviour check: running EVERY tool leaves the policy untouched, only issues read-only RPC calls, and leaks no key', async () => {
  const fc = installFakeChain();
  const urls = [];
  const inner = globalThis.fetch;
  globalThis.fetch = async (u, init) => { if (!String(u).includes('rpc')) { urls.push(String(u)); throw new Error('offline test: external call blocked'); } return inner(u, init); };
  const before = fs.existsSync(path.join(DATA, 'policy.json'));
  const args = {
    send_near: { to: 'root.near', amount: '0.5' }, chainsig_request_signature: { path: 'ethereum-1', payloadHex: 'ab'.repeat(32) }, chainsig_addresses: { path: 'ethereum-1' },
    agent_key_create: { contract: 'wrap.near', methods: ['near_deposit'], allowanceNear: '0.05' }, agent_key_revoke: { publicKey: 'ed25519:6E8sCci9badyRkXb3JoRpBj5p8C6Tw41ELDZoiihKEtp' },
    dao_propose: { dao: 'x.sputnik-dao.near', type: 'poll', description: 'q' }, dao_vote: { dao: 'x.sputnik-dao.near', id: 1, action: 'approve' },
  };
  try {
    const out = [];
    for (const t of TOOLS) out.push(JSON.stringify((await runTool(t.name, args[t.name] ?? {}, 'alice.near')).toModel));
    assert.ok(fc.calls.length > 0);
    assert.ok(fc.calls.every((m) => ['query', 'gas_price', 'tx', 'validators'].includes(m)), `RPC methods used: ${[...new Set(fc.calls)]}`);
    assert.equal(fs.existsSync(path.join(DATA, 'policy.json')), before, 'policy file must not be created or changed by a tool');
    assert.ok(!out.join('').match(/secretKey|"d":|ed25519:[1-9A-HJ-NP-Za-km-z]{80,}/), 'no private key in any tool result');
  } finally { globalThis.fetch = inner; fc.restore(); }
});

test('NEAR AI Cloud preset and overrides', () => {
  assert.deepEqual(PROVIDERS['near-ai'].baseUrl, 'https://cloud-api.near.ai/v1');
  assert.equal(llmSettings({}).baseUrl, 'https://api.openai.com/v1');
  const n = llmSettings({ LLM_PROVIDER: 'near-ai' });
  assert.equal(n.baseUrl, 'https://cloud-api.near.ai/v1');
  assert.equal(n.label, 'NEAR AI Cloud');
  assert.equal(llmSettings({ LLM_PROVIDER: 'NEAR_AI' }).provider, 'near-ai');
  const o = llmSettings({ LLM_PROVIDER: 'near-ai', LLM_BASE_URL: 'http://localhost:11434/v1/', LLM_MODEL: 'm' });
  assert.deepEqual([o.baseUrl, o.model], ['http://localhost:11434/v1', 'm']);
});

test('the LLM loop talks to NEAR AI Cloud, offers only the read-only tool set, and a tool call yields a policy-checked card', async () => {
  const saved = { ...process.env };
  Object.assign(process.env, { LLM_PROVIDER: 'near-ai', LLM_API_KEY: 'test-key-not-real' }); delete process.env.LLM_BASE_URL; delete process.env.LLM_MODEL;
  const fc = installFakeChain();
  const inner = globalThis.fetch, seen = [];
  let step = 0;
  globalThis.fetch = async (u, init) => {
    if (!String(u).includes('cloud-api.near.ai')) return inner(u, init);
    const body = JSON.parse(init.body);
    seen.push({ u: String(u), auth: init.headers.authorization, body });
    const msg = step++ === 0
      ? { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'chainsig_request_signature', arguments: JSON.stringify({ path: 'ethereum-1', payloadHex: 'cd'.repeat(32) }) } }] }
      : { role: 'assistant', content: 'Prepared; please confirm in your wallet.' };
    return new Response(JSON.stringify({ choices: [{ message: msg }] }));
  };
  try {
    const r = await chatWithTools([{ role: 'user', content: 'sign this hash for my ethereum address' }], 'alice.near');
    assert.equal(seen[0].u, 'https://cloud-api.near.ai/v1/chat/completions');
    assert.equal(seen[0].auth, 'Bearer test-key-not-real');
    assert.equal(seen[0].body.model, 'zai-org/GLM-5.1-FP8');
    assert.deepEqual(seen[0].body.tools.map((t) => t.function.name).sort(), TOOLS.map((t) => t.name).sort());
    assert.equal(r.cards.length, 1);
    assert.equal(r.cards[0].policy.verdict, 'confirm');
    assert.equal(r.reply, 'Prepared; please confirm in your wallet.');
    // the tool result the model sees contains no raw transaction to sign
    const toolMsg = seen[1].body.messages.find((m) => m.role === 'tool');
    assert.ok(!toolMsg.content.includes('"transactions"'));
  } finally { globalThis.fetch = inner; fc.restore(); for (const k of ['LLM_PROVIDER', 'LLM_API_KEY']) { if (saved[k] == null) delete process.env[k]; else process.env[k] = saved[k]; } }
});

// ---- audit trail
test('every proposal is recorded with verdict, rules, checks and a plain reason; the hash chain detects edits', async () => {
  process.env.SENTINEL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sentinel-audit-'));
  const fc = installFakeChain({ accounts: { 'alice.near': { amount: '500000000000000000000000000', locked: '0', code_hash: 'ABC', storage_usage: 500, storage_paid_at: 0 } } });
  try {
    await chatOffline([{ content: 'send 0.5 NEAR to root.near' }], 'alice.near');
    await chatOffline([{ content: 'send 50 NEAR to root.near' }], 'alice.near');
    await chatOffline([{ content: 'send 1 NEAR to nonexistentaccount99887.near' }], 'alice.near');
    await chatOffline([{ content: 'sign payload 0x' + 'ab'.repeat(32) + ' path ethereum-1' }], 'alice.near');
    const r = audit.report('alice.near');
    assert.deepEqual(r.entries.map((e) => e.verdict), ['allow', 'deny', 'refused', 'confirm']);
    assert.match(r.entries[0].reason, /^Allowed:/);
    assert.match(r.entries[1].reason, /^Blocked: .*per-transaction cap/);
    assert.match(r.entries[2].reason, /Refused before any card was built: .*does not exist/);
    assert.match(r.entries[3].reason, /^Needs your explicit confirmation/);
    assert.ok(r.entries[0].checks.length > 0 && r.entries[1].rules.length > 0);
    assert.equal(r.entries[1].canSign, false);
    assert.deepEqual(r.totals, { proposed: 4, allowed: 1, needConfirmation: 1, blocked: 1, refused: 1, confirmedOnChain: 0 });
    assert.equal(r.hashChain.ok, true);
    // outcome is attached outside the hash and does not break the chain
    assert.ok(audit.recordOutcome('alice.near', r.entries[0].id, { settled: true, hash: 'h' }));
    assert.equal(audit.report('alice.near').totals.confirmedOnChain, 1);
    assert.equal(audit.report('alice.near').hashChain.ok, true);
    // tampering with a verdict is detected, and so is deleting a middle entry
    const e = JSON.parse(JSON.stringify(audit.auditEntries('alice.near')));
    e[1].verdict = 'allow';
    assert.deepEqual(audit.verifyChain(e), { ok: false, brokenAt: 2 });
    const cut = JSON.parse(JSON.stringify(audit.auditEntries('alice.near'))); cut.splice(1, 1);
    assert.equal(audit.verifyChain(cut).ok, false);
  } finally { fc.restore(); }
});
