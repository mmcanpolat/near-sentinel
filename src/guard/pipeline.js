// The one path every transaction takes before a user sees it:
//   builder (live reads) -> live pre-check -> policy engine -> plain-language explanation -> CARD
// The card is data for the UI. The agent has no way to sign it; only the user's wallet can.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { precheck } from './precheck.js';
import { evaluate, mergePolicy, validatePolicy } from './policy.js';
import { explainTx } from './explain.js';
import { analyze } from './analyze.js';
import { entries } from './ledger.js';
import { ftInfo } from '../near/tokens.js';

const policyFile = () => path.resolve(process.env.SENTINEL_DATA_DIR ?? 'data', 'policy.json');
const loadAll = () => { try { return JSON.parse(fs.readFileSync(policyFile(), 'utf8')); } catch { return {}; } };

export const getPolicy = (account) => { const all = loadAll(); return mergePolicy(all[account] ?? all.default); };
export function setPolicy(account, p) {
  const merged = mergePolicy(p);
  const v = validatePolicy(merged);
  if (!v.ok) throw Object.assign(new Error(v.errors.join('; ')), { user: true });
  const all = loadAll();
  all[account || 'default'] = merged;
  fs.mkdirSync(path.dirname(policyFile()), { recursive: true });
  fs.writeFileSync(policyFile(), JSON.stringify(all, null, 1));
  return merged;
}

/** Cards waiting for the user (in memory, newest 200). The ledger only trusts what the chain confirms. */
export const cards = new Map();

export async function makeCard(account, built, { title } = {}) {
  const txs = built.transactions ?? [];
  const policy = getPolicy(account);
  const decimals = { ...(built.decimals ?? {}) }, symbols = { ...(built.symbols ?? {}) };
  for (const e of analyze(txs)) {
    if (e.kind === 'ft_out' && decimals[e.token] == null) {
      const i = await ftInfo(e.token);
      if (i) { decimals[e.token] = i.decimals; symbols[e.token] = i.symbol; }
    }
  }
  let pre = { checks: [], failures: [], fee: '0', deposits: '0' };
  if (txs.length) pre = await precheck(account, txs);
  const verdict = txs.length
    ? evaluate(policy, txs, { signer: account, ledger: entries(account), decimals, symbols, trustedRecipients: new Set(built.trustedRecipients ?? []) })
    : { verdict: 'allow', findings: [], spends: [] };
  const findings = [...verdict.findings, ...pre.failures.map((m) => ({ level: 'deny', rule: 'precheck', message: m }))];
  const level = findings.some((f) => f.level === 'deny') ? 'deny' : verdict.verdict;
  const id = crypto.randomUUID();
  const card = {
    id, title: title ?? built.preview?.op ?? 'transaction', account,
    preview: built.preview, note: built.note,
    transactions: txs,
    explain: txs.map((t) => explainTx(t, { decimals, symbols })),
    checks: [...(built.checks ?? []), ...pre.checks],
    warnings: built.warnings ?? [],
    policy: { verdict: level, findings, spends: verdict.spends },
    canSign: txs.length > 0 && level !== 'deny',
    needsConfirm: level === 'confirm',
    createdAt: Date.now(),
  };
  cards.set(id, card);
  if (cards.size > 200) cards.delete(cards.keys().next().value);
  return card;
}

/** What the LLM is told about a card: enough to explain it, never raw signing material. */
export function cardForModel(c) {
  return {
    cardId: c.id, status: c.canSign ? (c.needsConfirm ? 'needs the user to confirm, then sign in their wallet' : 'ready for the user to sign in their wallet') : (c.transactions.length ? 'BLOCKED by policy or pre-check; it cannot be signed' : 'information only, nothing to sign'),
    whatItDoes: c.explain.flat(), verdict: c.policy.verdict,
    policyFindings: c.policy.findings.map((f) => `${f.level}: ${f.message}`),
    checks: c.checks, warnings: c.warnings, preview: c.preview, note: c.note,
  };
}
