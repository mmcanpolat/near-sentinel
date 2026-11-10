// Sputnik DAO v2: builders + policy engine, fully offline against a fake NEAR RPC.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.SENTINEL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sentinel-sputnik-'));
const { sputnikPropose, sputnikVote, sputnikInfo, sputnikProposals, canAct, kindLabel } = await import('../src/near/sputnik.js');
const { evaluate } = await import('../src/guard/policy.js');
const { makeCard } = await import('../src/guard/pipeline.js');
const { chatOffline } = await import('../src/agent/offline.js');
const { TOOLS } = await import('../src/agent/tools.js');
const { tx, fnCall } = await import('./helpers.js');

const DAO = 'club.sputnik-dao.near', ME = 'alice.near', OUTSIDER = 'mallory.near';
const BOND = '100000000000000000000000'; // 0.1 NEAR
const DAY = 86_400_000_000_000n;
const nowNs = () => BigInt(Date.now()) * 1_000_000n;
const POLICY = {
  roles: [
    { name: 'council', kind: { Group: [ME, 'bob.near'] }, permissions: ['transfer:AddProposal', 'vote:*', '*:VoteApprove', '*:VoteReject', '*:Finalize', 'add_member_to_role:AddProposal', 'call:AddProposal'], vote_policy: {} },
    { name: 'all', kind: 'Everyone', permissions: ['vote:AddProposal'], vote_policy: {} },
  ],
  default_vote_policy: { weight_kind: 'RoleWeight', quorum: '0', threshold: [1, 2] },
  proposal_bond: BOND, proposal_period: (7n * DAY).toString(), bounty_bond: BOND, bounty_forgiveness_period: DAY.toString(),
};
const proposals = {
  1: { id: 1, proposer: 'bob.near', description: 'Pay for hosting', kind: { Transfer: { token_id: '', receiver_id: 'bob.near', amount: '1000', msg: null } }, status: 'InProgress', vote_counts: { council: [1, 0, 0] }, votes: { 'bob.near': 'Approve' }, submission_time: (nowNs() - DAY).toString() },
  2: { id: 2, proposer: 'bob.near', description: 'Old', kind: 'Vote', status: 'InProgress', vote_counts: {}, votes: {}, submission_time: (nowNs() - 9n * DAY).toString() },
  3: { id: 3, proposer: 'bob.near', description: 'Done', kind: 'Vote', status: 'Approved', vote_counts: {}, votes: {}, submission_time: (nowNs() - DAY).toString() },
  4: { id: 4, proposer: 'bob.near', description: 'Change the rules', kind: { ChangePolicy: { policy: {} } }, status: 'InProgress', vote_counts: {}, votes: {}, submission_time: (nowNs() - DAY).toString() },
  5: { id: 5, proposer: 'bob.near', description: 'Already voted', kind: 'Vote', status: 'InProgress', vote_counts: { council: [1, 0, 0] }, votes: { [ME]: 'Approve' }, submission_time: (nowNs() - DAY).toString() },
};

function fakeRpc() {
  const real = globalThis.fetch;
  const acct = (amount, code = 'ABC') => ({ amount, locked: '0', code_hash: code, storage_usage: 500, storage_paid_at: 0 });
  const views = {
    [`${DAO}.get_policy`]: () => POLICY,
    [`${DAO}.get_last_proposal_id`]: () => 6,
    [`${DAO}.get_proposal`]: (a) => proposals[a.id] ?? (() => { throw new Error('ERR_NO_PROPOSAL'); })(),
    [`${DAO}.get_proposals`]: (a) => Object.values(proposals).filter((p) => p.id >= a.from_index && p.id < a.from_index + a.limit),
  };
  const accounts = { [ME]: acct('50000000000000000000000000'), [DAO]: acct('5000000000000000000000000'), 'bob.near': acct('1000000000000000000000000', '11111111111111111111111111111111'), 'wrap.near': acct('1000000000000000000000000') };
  globalThis.fetch = async (url, init) => {
    if (!String(url).includes('rpc')) return real(url, init);
    const { method, params } = JSON.parse(init.body);
    const reply = (result) => new Response(JSON.stringify({ jsonrpc: '2.0', id: 'x', result }));
    if (method === 'gas_price') return reply({ gas_price: '100000000' });
    if (params.request_type === 'view_account') {
      const a = accounts[params.account_id];
      return a ? reply(a) : new Response(JSON.stringify({ jsonrpc: '2.0', id: 'x', error: { message: 'x', cause: { name: 'UNKNOWN_ACCOUNT' }, data: `account ${params.account_id} does not exist while viewing` } }));
    }
    if (params.request_type === 'call_function') {
      const f = views[`${params.account_id}.${params.method_name}`];
      if (!f) return reply({ error: 'method not found' });
      try { return reply({ result: [...Buffer.from(JSON.stringify(f(JSON.parse(Buffer.from(params.args_base64, 'base64').toString() || '{}'))))] }); } catch (e) { return reply({ error: e.message }); }
    }
    throw new Error(`unexpected rpc ${method}`);
  };
  return () => { globalThis.fetch = real; };
}
let restore;
test.before(() => { restore = fakeRpc(); });
test.after(() => restore());

test('kind labels match the contract permission labels', () => {
  assert.equal(kindLabel('Vote'), 'vote');
  assert.equal(kindLabel({ FunctionCall: {} }), 'call');
  assert.equal(kindLabel({ AddMemberToRole: {} }), 'add_member_to_role');
});

test('canAct honours wildcards, Everyone and non-members', () => {
  assert.ok(canAct(POLICY, ME, 'transfer', 'AddProposal').ok);
  assert.ok(canAct(POLICY, ME, 'anything', 'VoteApprove').ok);
  assert.ok(!canAct(POLICY, ME, 'transfer', 'VoteRemove').ok);
  assert.ok(canAct(POLICY, OUTSIDER, 'vote', 'AddProposal').ok);
  assert.ok(!canAct(POLICY, OUTSIDER, 'transfer', 'AddProposal').ok);
});

test('transfer proposal has the verified argument shape and attaches the live bond', async () => {
  const b = await sputnikPropose({ account: ME, dao: DAO, type: 'transfer', receiver: 'bob.near', amount: '1.5', description: 'Hosting' });
  const [t] = b.transactions, a = t.actions[0];
  assert.equal(t.receiverId, DAO);
  assert.equal(a.params.methodName, 'add_proposal');
  assert.equal(a.params.deposit, BOND);
  assert.deepEqual(a.params.args, { proposal: { description: 'Hosting', kind: { Transfer: { token_id: '', receiver_id: 'bob.near', amount: '1500000000000000000000000', msg: null } } } });
});

test('poll proposal uses the bare "Vote" kind', async () => {
  const b = await sputnikPropose({ account: OUTSIDER, dao: DAO, type: 'poll', description: 'Ship it?' });
  assert.equal(b.transactions[0].actions[0].params.args.proposal.kind, 'Vote');
});

test('role member and function-call proposals', async () => {
  const add = await sputnikPropose({ account: ME, dao: DAO, type: 'add_member', member: 'carol.near', role: 'council', description: 'New member' });
  assert.deepEqual(add.transactions[0].actions[0].params.args.proposal.kind, { AddMemberToRole: { member_id: 'carol.near', role: 'council' } });
  await assert.rejects(sputnikPropose({ account: ME, dao: DAO, type: 'add_member', member: 'bob.near', role: 'council', description: 'x' }), /already in role/);
  await assert.rejects(sputnikPropose({ account: ME, dao: DAO, type: 'add_member', member: 'carol.near', role: 'nope', description: 'x' }), /no role/);
  const fc = await sputnikPropose({ account: ME, dao: DAO, type: 'function_call', contract: 'wrap.near', method: 'near_deposit', args: {}, depositNear: '1', description: 'Wrap' });
  const k = fc.transactions[0].actions[0].params.args.proposal.kind.FunctionCall;
  assert.equal(k.receiver_id, 'wrap.near');
  assert.equal(k.actions[0].method_name, 'near_deposit');
  assert.equal(Buffer.from(k.actions[0].args, 'base64').toString(), '{}');
  await assert.rejects(sputnikPropose({ account: ME, dao: DAO, type: 'function_call', contract: 'bob.near', method: 'x', description: 'x' }), /no contract/);
});

test('a proposer without the permission is refused before anything is built', async () => {
  await assert.rejects(sputnikPropose({ account: OUTSIDER, dao: DAO, type: 'transfer', receiver: 'bob.near', amount: '1', description: 'x' }), /not allowed to add "transfer"/);
  await assert.rejects(sputnikPropose({ account: ME, dao: 'ghost.sputnik-dao.near', type: 'poll', description: 'x' }), /does not look like a Sputnik DAO/);
  await assert.rejects(sputnikPropose({ account: ME, dao: DAO, type: 'transfer', receiver: 'nobody-here.near', amount: '1', description: 'x' }), /does not exist/);
});

test('vote builds act_proposal { id, action } with no deposit', async () => {
  const b = await sputnikVote({ account: ME, dao: DAO, id: 1, action: 'approve' });
  const a = b.transactions[0].actions[0];
  assert.deepEqual(a.params.args, { id: 1, action: 'VoteApprove' });
  assert.equal(a.params.deposit, '0');
  assert.equal((await sputnikVote({ account: ME, dao: DAO, id: 1, action: 'reject' })).transactions[0].actions[0].params.args.action, 'VoteReject');
});

test('vote refuses closed, expired, already-voted, unpermitted and unknown proposals', async () => {
  await assert.rejects(sputnikVote({ account: ME, dao: DAO, id: 3, action: 'approve' }), /is Approved/);
  await assert.rejects(sputnikVote({ account: ME, dao: DAO, id: 2, action: 'approve' }), /voting period .* ended/);
  await assert.rejects(sputnikVote({ account: ME, dao: DAO, id: 5, action: 'approve' }), /already voted/);
  await assert.rejects(sputnikVote({ account: OUTSIDER, dao: DAO, id: 1, action: 'approve' }), /may not VoteApprove/);
  await assert.rejects(sputnikVote({ account: ME, dao: DAO, id: 99, action: 'approve' }), /no proposal #99/);
  await assert.rejects(sputnikVote({ account: ME, dao: DAO, id: 1, action: 'burn' }), /Unknown vote action/);
});

test('finalize only works after the voting period ended', async () => {
  assert.deepEqual((await sputnikVote({ account: ME, dao: DAO, id: 2, action: 'finalize' })).transactions[0].actions[0].params.args, { id: 2, action: 'Finalize' });
  await assert.rejects(sputnikVote({ account: ME, dao: DAO, id: 1, action: 'finalize' }), /still open/);
});

test('approving a governance-changing proposal asks for confirmation through the card', async () => {
  const card = await makeCard(ME, await sputnikVote({ account: ME, dao: DAO, id: 4, action: 'approve' }));
  assert.equal(card.policy.verdict, 'confirm');
  assert.ok(card.canSign && card.needsConfirm);
});

test('full pipeline: a transfer proposal is allowed, explained and live pre-checked; the bond counts as a NEAR spend', async () => {
  const card = await makeCard(ME, await sputnikPropose({ account: ME, dao: DAO, type: 'transfer', receiver: 'bob.near', amount: '1', description: 'Hosting' }));
  assert.equal(card.policy.verdict, 'allow');
  assert.ok(card.canSign);
  assert.match(card.explain[0][0], /Propose to DAO club\.sputnik-dao\.near: pay .* to bob\.near/);
  assert.match(card.explain[0][0], /0\.1 NEAR proposal bond/);
  assert.ok(card.checks.some((c) => /get_policy/.test(c)));
  assert.equal(card.policy.spends[0].human, '0.1');
});

test('policy engine: DAO methods, proposal kinds and deposits', async () => {
  const { policy, levels } = await import('./helpers.js');
  const ctx = { signer: ME, now: Date.now(), ledger: [], decimals: {} };
  const propose = (kind, deposit = 1n) => [tx(DAO, [fnCall('add_proposal', { proposal: { description: 'd', kind } }, 100n * 10n ** 12n, deposit)])];
  const act = (action, deposit = 0n) => [tx(DAO, [fnCall('act_proposal', { id: 1, action }, 150n * 10n ** 12n, deposit)])];
  assert.equal(evaluate(policy(), propose('Vote'), ctx).verdict, 'allow');
  assert.ok(levels(evaluate(policy(), propose({ ChangePolicy: { policy: {} } }), ctx)).includes('deny:dao.kind_not_allowed'));
  assert.ok(levels(evaluate(policy(), propose({ UpgradeSelf: { hash: 'x' } }), ctx)).includes('deny:dao.kind_not_allowed'));
  assert.ok(levels(evaluate(policy(), propose({ FunctionCall: { receiver_id: 'x.near', actions: [{ method_name: 'drain' }] } }), ctx)).includes('confirm:dao.function_call'));
  assert.equal(evaluate(policy(), act('VoteApprove'), ctx).verdict, 'allow');
  assert.ok(levels(evaluate(policy(), act('MoveToHub'), ctx)).includes('deny:dao.action_not_allowed'));
  assert.ok(levels(evaluate(policy(), act('VoteApprove', 10n ** 24n), ctx)).includes('deny:dao.unexpected_deposit'));
  assert.ok(levels(evaluate(policy(), [tx(DAO, [fnCall('act_on_bounty', {}, 30n * 10n ** 12n, 0n)])], ctx)).includes('deny:method.not_allowed'));
  // a large bond is a real spend against the NEAR caps
  assert.ok(levels(evaluate(policy(), propose('Vote', 6n * 10n ** 24n), ctx)).includes('deny:limit.per_tx'));
  // the suffix rule can be switched off, and does not match look-alikes
  assert.ok(levels(evaluate(policy({ allowedContractSuffixes: [] }), propose('Vote'), ctx)).includes('deny:contract.not_allowed'));
  assert.ok(levels(evaluate(policy(), [tx('fake-sputnik-dao.near', [fnCall('add_proposal', {}, 1n, 0n)])], ctx)).includes('deny:contract.not_allowed'));
  assert.ok(levels(evaluate(policy(), [tx('.sputnik-dao.near', [fnCall('add_proposal', {}, 1n, 0n)])], ctx)).includes('deny:contract.not_allowed'));
});

test('chat commands reach the same builders', async () => {
  const r = await chatOffline([{ role: 'user', content: `propose transfer 1 NEAR to bob.near on ${DAO} for Hosting costs` }], ME);
  assert.equal(r.cards[0].transactions[0].actions[0].params.args.proposal.description, 'Hosting costs');
  const v = await chatOffline([{ role: 'user', content: `approve proposal 1 on ${DAO}` }], ME);
  assert.equal(v.cards[0].transactions[0].actions[0].params.args.action, 'VoteApprove');
  const poll = await chatOffline([{ role: 'user', content: `propose poll Should we meet on balance sheets? on ${DAO}` }], ME);
  assert.equal(poll.cards[0].preview.kind, 'Vote');
  const info = await chatOffline([{ role: 'user', content: `dao ${DAO}` }], ME);
  assert.match(info.reply, /council/);
});

test('reads: info and proposal list', async () => {
  const i = await sputnikInfo({ dao: DAO });
  assert.equal(i.proposalBondNear, '0.1');
  assert.equal(i.proposalPeriodDays, 7);
  const l = await sputnikProposals({ dao: DAO, status: 'InProgress', limit: 3 });
  assert.ok(l.shown.length >= 1 && l.shown.every((x) => x.status === 'InProgress'));
});

test('agent tools stay read-or-build only (still no signing tool)', () => {
  assert.ok(TOOLS.some((t) => t.name === 'dao_propose') && TOOLS.some((t) => t.name === 'dao_vote'));
  assert.ok(!TOOLS.some((t) => /sign|broadcast|policy/.test(t.name) && !t.read));
});
