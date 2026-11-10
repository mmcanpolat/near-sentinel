// Sputnik DAO v2 (the DAO contract behind AstroDAO and sputnik-dao.near). Social Money track.
// Written for this repo against the contract's public interface; every builder reads the live DAO
// first (policy, roles, proposal state) and returns UNSIGNED transactions. Nothing here signs.
//
//   add_proposal { proposal: { description, kind } }   deposit = the DAO's proposal_bond
//   act_proposal { id, action: "VoteApprove" | "VoteReject" | "VoteRemove" | "Finalize" }

import { fnCall, tx } from './actions.js';
import { view, viewAccount } from './rpc.js';
import { resolveFt } from './tokens.js';
import { parseUnits, formatUnits, nearToYocto, yoctoToNear, validAccountId } from '../lib/units.js';

const bad = (m) => Object.assign(new Error(m), { user: true });
const out = (o) => ({ checks: [], warnings: [], trustedRecipients: [], confirm: [], ...o });

export const DAO_SUFFIX = '.sputnik-dao.near';
export const GAS_PROPOSE = 100n * 10n ** 12n;
export const GAS_ACT = 150n * 10n ** 12n; // approval can execute the proposal (callbacks included)

/** Proposal kinds an agent may create. Governance kinds (ChangePolicy, UpgradeSelf, ...) are deliberately absent. */
export const AGENT_KINDS = ['Transfer', 'Vote', 'AddMemberToRole', 'RemoveMemberFromRole', 'FunctionCall'];
const ACTIONS = { approve: 'VoteApprove', reject: 'VoteReject', remove: 'VoteRemove', finalize: 'Finalize' };

/** The permission label the contract uses for a proposal kind ("transfer:AddProposal" ...). */
export function kindLabel(kind) {
  const k = typeof kind === 'string' ? kind : Object.keys(kind ?? {})[0];
  return {
    ChangeConfig: 'config', ChangePolicy: 'policy', AddMemberToRole: 'add_member_to_role', RemoveMemberFromRole: 'remove_member_from_role',
    FunctionCall: 'call', UpgradeSelf: 'upgrade_self', UpgradeRemote: 'upgrade_remote', Transfer: 'transfer', SetStakingContract: 'set_vote_token',
    AddBounty: 'add_bounty', BountyDone: 'bounty_done', Vote: 'vote', FactoryInfoUpdate: 'factory_info_update',
    ChangePolicyAddOrUpdateRole: 'policy_add_or_update_role', ChangePolicyRemoveRole: 'policy_remove_role',
    ChangePolicyUpdateDefaultVotePolicy: 'policy_update_default_vote_policy', ChangePolicyUpdateParameters: 'policy_update_parameters',
  }[k] ?? k;
}
export const kindName = (kind) => (typeof kind === 'string' ? kind : Object.keys(kind ?? {})[0]);

/** Kinds that change who controls the DAO or run code with its funds: voting on them needs an explicit tick. */
const RISKY = new Set(['ChangePolicy', 'ChangePolicyAddOrUpdateRole', 'ChangePolicyRemoveRole', 'ChangePolicyUpdateDefaultVotePolicy', 'ChangePolicyUpdateParameters', 'UpgradeSelf', 'UpgradeRemote', 'FunctionCall', 'ChangeConfig', 'FactoryInfoUpdate', 'SetStakingContract']);

/** Does `account` hold a role of this DAO policy that grants `label:action`? Pure. */
export function canAct(policy, account, label, action) {
  const roles = [];
  let unverifiable = false;
  for (const r of policy?.roles ?? []) {
    const k = r.kind;
    const member = k === 'Everyone' || (k?.Group && k.Group.includes(account));
    if (!member && k?.Member != null) unverifiable = true; // token-weighted membership: not decidable from the policy alone
    if (!member) continue;
    if ((r.permissions ?? []).some((p) => { const [l, a] = String(p).split(':'); return (l === '*' || l === label) && (a === '*' || a === action); })) roles.push(r.name);
  }
  return { ok: roles.length > 0, roles, unverifiable };
}

async function loadDao(dao) {
  const d = String(dao ?? '').trim().toLowerCase();
  if (!validAccountId(d)) throw bad(`"${dao}" is not a valid NEAR account id.`);
  const policy = await tryView(d, 'get_policy');
  if (!policy || !Array.isArray(policy.roles)) throw bad(`${d} does not look like a Sputnik DAO (no get_policy answer). Check the address; DAOs created on sputnik-dao.near end in ${DAO_SUFFIX}.`);
  return { id: d, policy };
}

/** Like a view that returns null when the contract/method/record is missing, but a dead RPC is still an error. */
async function tryView(contract, method, args = {}) {
  try { return await view(contract, method, args); } catch (e) { if (/RPC unavailable/i.test(e.message)) throw e; return null; }
}

const NS_PER_MS = 1_000_000n;
const deadlineMs = (p, policy) => Number((BigInt(p.submission_time) + BigInt(policy.proposal_period)) / NS_PER_MS);
const tally = (p) => Object.entries(p.vote_counts ?? {}).map(([role, [a, r, rm]]) => `${role}: ${a} approve, ${r} reject, ${rm} remove`).join('; ') || 'no votes yet';

function summarize(p, policy) {
  return {
    id: p.id, proposer: p.proposer, description: p.description, kind: kindName(p.kind), status: p.status,
    votes: tally(p), expires: new Date(deadlineMs(p, policy)).toISOString(),
    detail: typeof p.kind === 'object' ? JSON.stringify(p.kind[kindName(p.kind)]).slice(0, 300) : undefined,
  };
}

// ---------------------------------------------------------------- reads

export async function sputnikInfo({ dao }) {
  const { id, policy } = await loadDao(dao);
  const last = await tryView(id, 'get_last_proposal_id');
  const acct = await viewAccount(id);
  return {
    dao: id, balanceNear: acct ? yoctoToNear(BigInt(acct.amount)) : null, proposalCount: last, proposalBondNear: yoctoToNear(policy.proposal_bond),
    proposalPeriodDays: Number(BigInt(policy.proposal_period) / 86_400_000_000_000n),
    defaultVotePolicy: policy.default_vote_policy,
    roles: policy.roles.map((r) => ({ name: r.name, members: r.kind === 'Everyone' ? 'everyone' : r.kind.Group ? r.kind.Group : r.kind, permissions: r.permissions })),
  };
}

export async function sputnikProposals({ dao, status, limit = 5 }) {
  const { id, policy } = await loadDao(dao);
  const last = Number(await view(id, 'get_last_proposal_id'));
  const n = Math.min(Math.max(Number(limit) || 5, 1), 20);
  const want = status ? String(status).toLowerCase().replace(/\s+/g, '') : '';
  const found = [];
  // Newest first; scan at most 100 back so a quiet filter cannot trigger a long crawl.
  for (let to = last; to > 0 && found.length < n && last - to < 100; to -= 20) {
    const from = Math.max(0, to - 20);
    const page = await view(id, 'get_proposals', { from_index: from, limit: to - from });
    for (const p of page.reverse()) if (!want || String(p.status).toLowerCase() === want) found.push(p);
  }
  return { dao: id, totalProposals: last, shown: found.slice(0, n).map((p) => summarize(p, policy)) };
}

// ---------------------------------------------------------------- builders

function checkProposer(o, who, policy, kind, dao) {
  const label = kindLabel(kind);
  const r = canAct(policy, who, label, 'AddProposal');
  if (!r.ok) throw bad(`${who} is not allowed to add "${label}" proposals in ${dao} (the DAO's roles grant none of ${label}:AddProposal or *:AddProposal to this account).${r.unverifiable ? ' Token-weighted roles cannot be evaluated from the policy alone.' : ''}`);
  o.checks.push(`DAO policy (live get_policy): ${who} holds role ${r.roles.join(', ')} which allows ${label}:AddProposal.`);
}

export async function sputnikPropose({ account, dao, type, description, receiver, amount, token = 'NEAR', member, role, contract, method, args, depositNear = '0', gasTgas = 30 }) {
  if (!validAccountId(account)) throw bad('Connect a NEAR wallet first (no account is set).');
  const { id, policy } = await loadDao(dao);
  const t = String(type ?? '').toLowerCase().replace(/[\s_-]/g, '');
  const text = String(description ?? '').trim();
  let kind, label, summary;
  const o = out({});
  if (t === 'transfer') {
    const to = String(receiver ?? '').trim().toLowerCase();
    if (!validAccountId(to)) throw bad(`"${receiver}" is not a valid NEAR account id.`);
    const isNear = /^near$/i.test(String(token).trim());
    let amt, tokenId = '', dec = 24, sym = 'NEAR';
    if (isNear) amt = nearToYocto(amount);
    else { const ft = await resolveFt(token); tokenId = ft.contract; dec = ft.decimals; sym = ft.symbol; amt = parseUnits(amount, dec); }
    if (amt <= 0n) throw bad('Amount must be above zero.');
    if (!(await viewAccount(to))) throw bad(`${to} does not exist on NEAR mainnet; a DAO payment to a typo cannot be undone.`);
    // The DAO pays out later, so check its live balance now: a proposal it cannot pay would fail on approval.
    if (isNear) {
      const a = await viewAccount(id);
      if (a && BigInt(a.amount) < amt) o.warnings.push(`${id} currently holds ${yoctoToNear(BigInt(a.amount))} NEAR, less than the ${yoctoToNear(amt)} NEAR requested; approval would fail until it is funded.`);
      else if (a) o.checks.push(`${id} holds ${yoctoToNear(BigInt(a.amount))} NEAR (live), enough for this payment.`);
    } else {
      const bal = await tryView(tokenId, 'ft_balance_of', { account_id: id });
      if (bal != null && BigInt(bal) < amt) o.warnings.push(`${id} holds ${formatUnits(bal, dec)} ${sym}, less than the ${formatUnits(amt, dec)} requested; approval would fail.`);
      else if (bal != null) o.checks.push(`${id} holds ${formatUnits(bal, dec)} ${sym} (live ft_balance_of).`);
    }
    kind = { Transfer: { token_id: tokenId, receiver_id: to, amount: amt.toString(), msg: null } };
    summary = `pay ${formatUnits(amt, dec)} ${sym} to ${to}`;
  } else if (t === 'poll' || t === 'vote') {
    if (!text) throw bad('A poll needs its question as the description.');
    kind = 'Vote'; summary = 'poll (signal vote, no payment or action)';
  } else if (t === 'addmember' || t === 'removemember' || t === 'addmembertorole' || t === 'removememberfromrole') {
    const m = String(member ?? '').trim().toLowerCase(), r = String(role ?? '').trim();
    if (!validAccountId(m)) throw bad(`"${member}" is not a valid NEAR account id.`);
    const roleDef = policy.roles.find((x) => x.name === r);
    if (!roleDef) throw bad(`${id} has no role "${r}". Roles: ${policy.roles.map((x) => x.name).join(', ')}.`);
    const adding = t.startsWith('add');
    if (!roleDef.kind.Group) throw bad(`Role "${r}" is not a fixed member group, so members cannot be added or removed by proposal.`);
    const isMember = roleDef.kind.Group.includes(m);
    if (adding && isMember) throw bad(`${m} is already in role ${r}.`);
    if (!adding && !isMember) throw bad(`${m} is not in role ${r}.`);
    kind = { [adding ? 'AddMemberToRole' : 'RemoveMemberFromRole']: { member_id: m, role: r } };
    summary = `${adding ? 'add' : 'remove'} ${m} ${adding ? 'to' : 'from'} role ${r}`;
    o.checks.push(`Live DAO roles: ${m} ${adding ? 'is not yet' : 'is currently'} in ${r}.`);
  } else if (t === 'functioncall' || t === 'call') {
    const c = String(contract ?? '').trim().toLowerCase(), meth = String(method ?? '').trim();
    if (!validAccountId(c)) throw bad(`"${contract}" is not a valid NEAR account id.`);
    if (!/^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/.test(meth)) throw bad(`"${method}" is not a valid method name.`);
    const ca = await viewAccount(c);
    if (!ca || ca.code_hash === '11111111111111111111111111111111') throw bad(`${c} has no contract deployed.`);
    let argObj = args ?? {};
    if (typeof argObj === 'string') { try { argObj = JSON.parse(argObj || '{}'); } catch { throw bad('args must be valid JSON.'); } }
    const dep = nearToYocto(depositNear);
    kind = { FunctionCall: { receiver_id: c, actions: [{ method_name: meth, args: Buffer.from(JSON.stringify(argObj)).toString('base64'), deposit: dep.toString(), gas: String(BigInt(Math.round(Number(gasTgas) * 1e12))) }] } };
    summary = `make the DAO call ${meth}() on ${c}${dep > 0n ? ` with ${yoctoToNear(dep)} NEAR` : ''}`;
    o.checks.push(`${c} exists and has a contract deployed.`);
  } else throw bad(`Unknown proposal type "${type}". Supported: transfer, poll, add_member, remove_member, function_call.`);

  if (!text && t !== 'poll') throw bad('Give the proposal a description (it is public and stored on chain).');
  if (text.length > 2000) throw bad('The description is limited to 2000 characters.');
  checkProposer(o, account, policy, kind, id);
  const bond = BigInt(policy.proposal_bond);
  o.checks.push(`Proposal bond ${yoctoToNear(bond)} NEAR read from the DAO's live policy and attached exactly (the DAO refunds it when the proposal passes).`);
  o.checks.push(`DAO ${id} answered get_policy; proposals stay open for ${Number(BigInt(policy.proposal_period) / 86_400_000_000_000n)} days.`);
  o.preview = { op: 'sputnik_propose', dao: id, proposer: account, kind: kindName(kind), summary, bondNear: yoctoToNear(bond) };
  o.transactions = [tx(id, [fnCall('add_proposal', { proposal: { description: text, kind } }, GAS_PROPOSE, bond)])];
  o.note = 'This only creates a proposal. Nothing is paid or executed until the DAO members vote it through.';
  return o;
}

export async function sputnikVote({ account, dao, id: pid, action }) {
  if (!validAccountId(account)) throw bad('Connect a NEAR wallet first (no account is set).');
  const act = ACTIONS[String(action ?? '').toLowerCase().replace(/^vote/, '')];
  if (!act) throw bad(`Unknown vote action "${action}". Use approve, reject, remove or finalize.`);
  const { id, policy } = await loadDao(dao);
  const n = Number(pid);
  if (!Number.isInteger(n) || n < 0) throw bad('Give the proposal number (for example 12).');
  const p = await tryView(id, 'get_proposal', { id: n });
  if (!p) throw bad(`${id} has no proposal #${n}.`);
  const o = out({});
  o.checks.push(`Proposal #${n} read live: "${String(p.description).slice(0, 80)}" (${kindName(p.kind)}), status ${p.status}, ${tally(p)}.`);
  if (p.status !== 'InProgress') throw bad(`Proposal #${n} is ${p.status}, so it can no longer be voted on or finalized.`);
  const expired = Date.now() > deadlineMs(p, policy);
  if (act === 'Finalize') {
    if (!expired) throw bad(`Proposal #${n} is still open until ${new Date(deadlineMs(p, policy)).toISOString()}; the DAO only finalizes proposals whose voting period ended.`);
  } else {
    if (expired) throw bad(`The voting period of proposal #${n} ended ${new Date(deadlineMs(p, policy)).toISOString()}. It can only be finalized now.`);
    if (p.votes?.[account]) throw bad(`${account} already voted ${p.votes[account]} on proposal #${n}; the DAO accepts one vote per member.`);
  }
  const r = canAct(policy, account, kindLabel(p.kind), act);
  if (!r.ok) throw bad(`${account} may not ${act} ${kindLabel(p.kind)} proposals in ${id} (no role grants ${kindLabel(p.kind)}:${act}).${r.unverifiable ? ' Token-weighted roles cannot be evaluated from the policy alone.' : ''}`);
  o.checks.push(`DAO policy (live get_policy): ${account} holds role ${r.roles.join(', ')} which allows ${kindLabel(p.kind)}:${act}.`);
  if (RISKY.has(kindName(p.kind)) && act === 'VoteApprove') o.confirm.push(`Approving a ${kindName(p.kind)} proposal can change who controls the DAO or run code with its funds. Read the proposal details before you approve.`);
  if (act === 'VoteRemove') o.confirm.push('VoteRemove asks to delete the proposal as spam and forfeits the proposer\'s bond if it passes.');
  o.preview = { op: 'sputnik_vote', dao: id, voter: account, proposal: summarize(p, policy), action: act };
  o.transactions = [tx(id, [fnCall('act_proposal', { id: n, action: act }, GAS_ACT, 0n)])];
  o.note = `Proposal #${n}: ${o.preview.proposal.kind}${o.preview.proposal.detail ? ' ' + o.preview.proposal.detail : ''}.`;
  return o;
}
