// Policy engine: pure, deterministic, no network. Given a policy, the effects of a set of
// transactions and the recent spend ledger, it answers ALLOW / CONFIRM / DENY with reasons.
//
//   DENY     the card cannot be signed (the UI disables it)
//   CONFIRM  the user must tick an explicit confirmation before the wallet opens
//   ALLOW    nothing out of the ordinary; the wallet still asks for the user's signature
//
// The LLM can never change the policy: the policy is edited through the web UI only.

import { parseUnits, formatUnits, yoctoToNear } from '../lib/units.js';
import { analyze, totalGas } from './analyze.js';

const FT_STANDARD = new Set(['ft_transfer', 'ft_transfer_call', 'storage_deposit']);
// A storage_deposit is the token contract's registration fee, not a payment. It is only treated
// as one while it stays small; a large "storage deposit" is counted as a real spend.
const REGISTRATION_MAX = 5n * 10n ** 23n; // 0.5 NEAR
// Wrapping NEAR into wNEAR keeps the value in the user's own account, so it is not a spend. If the wNEAR is
// then sent away, that ft_transfer is judged on its own.
const isConversion = (e) => e.kind === 'native_out' && e.via === 'attached_deposit' && e.to === 'wrap.near' && e.method === 'near_deposit';
const isRegistration = (e) => e.kind === 'native_out' && e.via === 'attached_deposit' && e.method === 'storage_deposit' && e.amount <= REGISTRATION_MAX;
export const NATIVE = 'near';
// wNEAR is NEAR in another wrapper: spending it counts against the NEAR limits.
export const canon = (t) => (t === 'wrap.near' ? NATIVE : t);
const DAY_MS = 24 * 3600 * 1000;

export const DEFAULT_POLICY = Object.freeze({
  // Contracts the agent may call. FT contracts are governed by `limits` / `unlistedToken` instead.
  allowedContracts: [
    'wrap.near', 'v2.ref-finance.near', 'contract.main.burrow.near', 'meta-pool.near',
    'linear-protocol.near', 'social.near',
  ],
  // Optional per-contract method allowlist. A contract without an entry allows every method.
  allowedMethods: {
    'wrap.near': ['near_deposit', 'near_withdraw', 'storage_deposit', 'ft_transfer'],
    'social.near': ['set'],
  },
  blockedContracts: [],
  // 'any' or 'allowlist'. With an allowlist, every outgoing transfer must go to a listed account
  // (or to an allowed contract, or to a deposit address produced by a trusted builder).
  recipients: { mode: 'any', list: [] },
  // Human units. perTx / daily are hard caps; confirmAbove asks the user first.
  limits: {
    [NATIVE]: { perTx: '5', daily: '10', confirmAbove: '1' },
  },
  // What to do with a token that has no limit entry: 'allow' | 'confirm' | 'deny'.
  unlistedToken: 'confirm',
  maxGasTgas: 300,
  agentKeys: { allowAnyMethod: false, maxAllowanceNear: '0.25' },
});

export function mergePolicy(p) {
  const d = structuredClone(DEFAULT_POLICY);
  return { ...d, ...(p ?? {}), recipients: { ...d.recipients, ...(p?.recipients ?? {}) }, agentKeys: { ...d.agentKeys, ...(p?.agentKeys ?? {}) } };
}

/** Validates a policy object coming from the UI. Returns { ok, errors }. */
export function validatePolicy(p) {
  const errors = [];
  const list = (v, name) => { if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) errors.push(`${name} must be a list of strings`); };
  list(p.allowedContracts, 'allowedContracts');
  list(p.blockedContracts, 'blockedContracts');
  list(p.recipients?.list, 'recipients.list');
  if (!['any', 'allowlist'].includes(p.recipients?.mode)) errors.push('recipients.mode must be any or allowlist');
  if (!['allow', 'confirm', 'deny'].includes(p.unlistedToken)) errors.push('unlistedToken must be allow, confirm or deny');
  if (!(Number(p.maxGasTgas) > 0 && Number(p.maxGasTgas) <= 1000)) errors.push('maxGasTgas must be between 1 and 1000');
  for (const [tok, l] of Object.entries(p.limits ?? {})) {
    for (const k of ['perTx', 'daily', 'confirmAbove']) {
      if (l[k] != null && l[k] !== '' && !/^\d+(\.\d+)?$/.test(String(l[k]))) errors.push(`limits.${tok}.${k} is not a number`);
    }
  }
  if (!/^\d+(\.\d+)?$/.test(String(p.agentKeys?.maxAllowanceNear ?? ''))) errors.push('agentKeys.maxAllowanceNear is not a number');
  return { ok: errors.length === 0, errors };
}

const lim = (l, k, dec) => (l?.[k] == null || l[k] === '' ? null : parseUnits(l[k], dec));

/**
 * @param policy   merged policy
 * @param txs      transactions to judge
 * @param ctx      { signer, ledger:[{ts,token,amount}], now, decimals:{token:n}, trustedRecipients:Set, symbols:{token:sym} }
 */
export function evaluate(policy, txs, ctx = {}) {
  const now = ctx.now ?? Date.now();
  const effects = analyze(txs);
  const findings = [];
  const add = (level, rule, message) => findings.push({ level, rule, message });
  const decimals = (tok) => (tok === NATIVE ? 24 : ctx.decimals?.[tok]);
  const sym = (tok) => (tok === NATIVE ? 'NEAR' : ctx.symbols?.[tok] ?? tok);
  const fmt = (tok, raw) => `${formatUnits(raw, decimals(tok) ?? 0)} ${sym(tok)}`;
  const allowedC = new Set(policy.allowedContracts);
  const trusted = ctx.trustedRecipients ?? new Set();

  // ---- 1. Things an agent must never do, regardless of configuration -------------------------
  for (const e of effects) {
    if (e.kind === 'deploy') add('deny', 'hard.deploy', `Deploying a contract on ${e.onAccount} is never allowed for an agent.`);
    if (e.kind === 'delete_account') add('deny', 'hard.delete_account', `Deleting account ${e.onAccount} is never allowed for an agent.`);
    if (e.kind === 'native_stake') add('deny', 'hard.stake_action', 'Validator staking actions are not allowed.');
    if (e.kind === 'unknown') add('deny', 'hard.unknown_action', `Unknown action type "${e.type}" is refused.`);
    if (e.kind === 'add_key' && e.scope.type === 'full') add('deny', 'hard.full_access_key', `Adding a FULL-ACCESS key (${short(e.publicKey)}) is never allowed: a full-access key can empty the account.`);
  }

  // ---- 2. Contract / method allowlists ------------------------------------------------------
  for (const e of effects.filter((x) => x.kind === 'call')) {
    if (policy.blockedContracts.includes(e.contract)) { add('deny', 'contract.blocked', `${e.contract} is on the blocked list.`); continue; }
    const standardFt = FT_STANDARD.has(e.method);
    if (!allowedC.has(e.contract) && !standardFt) {
      add('deny', 'contract.not_allowed', `${e.contract}.${e.method}() is not on the allowed contracts list.`);
      continue;
    }
    const ms = policy.allowedMethods?.[e.contract];
    if (ms && !ms.includes(e.method) && !(standardFt && !allowedC.has(e.contract))) {
      add('deny', 'method.not_allowed', `Method ${e.method}() is not allowed on ${e.contract} (allowed: ${ms.join(', ')}).`);
    }
  }

  // ---- 3. Recipients -------------------------------------------------------------------------
  const outs = [];
  for (const e of effects) {
    if (e.kind === 'native_out') outs.push({ token: NATIVE, to: e.to, amount: e.amount, e });
    if (e.kind === 'ft_out') outs.push({ token: canon(e.token), to: e.to, amount: e.amount, e });
  }
  if (policy.recipients.mode === 'allowlist') {
    const okTo = new Set([...policy.recipients.list, ...allowedC, ...trusted, ctx.signer].filter(Boolean));
    for (const o of outs) {
      // Tokens are paid *by* the token contract, but the recipient is what matters.
      const target = o.e.kind === 'ft_out' ? o.to : o.to;
      if (isRegistration(o.e) || isConversion(o.e)) continue;
      if (!okTo.has(target)) add('deny', 'recipient.not_allowed', `${target} is not on the recipient allowlist.`);
    }
  }

  // ---- 4. Spend limits (per transaction set and rolling 24h) --------------------------------
  const perToken = new Map();
  for (const o of outs) {
    if (o.amount === 0n) continue;
    if (isRegistration(o.e) || isConversion(o.e)) continue; // registration fee / wrapping: not a payment
    perToken.set(o.token, (perToken.get(o.token) ?? 0n) + o.amount);
  }
  const summary = [];
  for (const [tok, amount] of perToken) {
    const dec = decimals(tok);
    const l = policy.limits?.[tok];
    summary.push({ token: tok, symbol: sym(tok), amount: amount.toString(), human: dec == null ? null : formatUnits(amount, dec) });
    if (dec == null) { add('confirm', 'limit.unknown_decimals', `Could not read ${tok} metadata, so its amount cannot be compared with a limit.`); continue; }
    if (!l) {
      const mode = policy.unlistedToken;
      const msg = `${fmt(tok, amount)} leaves the account but ${sym(tok)} has no spend limit.`;
      if (mode === 'deny') add('deny', 'limit.unlisted', `${msg} Unlisted tokens are denied.`);
      else if (mode === 'confirm') add('confirm', 'limit.unlisted', `${msg} Confirm to proceed.`);
      continue;
    }
    const perTx = lim(l, 'perTx', dec), daily = lim(l, 'daily', dec), confirmAbove = lim(l, 'confirmAbove', dec);
    if (perTx != null && amount > perTx) add('deny', 'limit.per_tx', `${fmt(tok, amount)} exceeds the per-transaction cap of ${fmt(tok, perTx)}.`);
    const used = (ctx.ledger ?? []).filter((r) => r.token === tok && now - r.ts < DAY_MS).reduce((s, r) => s + BigInt(r.amount), 0n);
    if (daily != null) {
      if (used + amount > daily) add('deny', 'limit.daily', `${fmt(tok, amount)} plus ${fmt(tok, used)} already spent in the last 24h exceeds the daily cap of ${fmt(tok, daily)}.`);
    }
    if (confirmAbove != null && amount > confirmAbove) add('confirm', 'limit.confirm_above', `${fmt(tok, amount)} is above your confirmation threshold of ${fmt(tok, confirmAbove)}.`);
    summary[summary.length - 1].dailyUsed = formatUnits(used, dec);
    summary[summary.length - 1].dailyCap = l.daily ?? null;
  }

  // ---- 5. Gas ----------------------------------------------------------------------------
  const gas = totalGas(effects);
  const maxGas = BigInt(Math.round(Number(policy.maxGasTgas) * 1e12));
  if (gas > maxGas) add('confirm', 'gas.high', `Attached gas ${Number(gas) / 1e12} Tgas is above your ${policy.maxGasTgas} Tgas limit.`);

  // ---- 6. Access keys ----------------------------------------------------------------------
  for (const e of effects.filter((x) => x.kind === 'add_key' && x.scope.type === 'function_call')) {
    const s = e.scope, ak = policy.agentKeys;
    if (!s.receiverId) add('deny', 'key.no_receiver', 'A function-call key must be bound to one contract.');
    else if (!allowedC.has(s.receiverId)) add('deny', 'key.receiver_not_allowed', `A key bound to ${s.receiverId} is refused: that contract is not on the allowed list.`);
    if (!s.methodNames.length && !ak.allowAnyMethod) add('deny', 'key.any_method', 'A key with no method list could call every method of the contract. List the methods.');
    if (s.allowance == null) add('deny', 'key.unlimited_allowance', 'A key without an allowance limit is refused.');
    else {
      const cap = parseUnits(ak.maxAllowanceNear, 24);
      if (s.allowance > cap) add('deny', 'key.allowance_too_high', `Allowance ${yoctoToNear(s.allowance)} NEAR is above the ${ak.maxAllowanceNear} NEAR cap for agent keys.`);
    }
  }

  const verdict = findings.some((f) => f.level === 'deny') ? 'deny' : findings.some((f) => f.level === 'confirm') ? 'confirm' : 'allow';
  if (verdict === 'allow') add('ok', 'policy.ok', 'Within every limit and allowlist of your policy.');
  return { verdict, findings, effects: effects.length, spends: summary };
}

const short = (k) => (k && k.length > 20 ? `${k.slice(0, 16)}...${k.slice(-4)}` : k);
