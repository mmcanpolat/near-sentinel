// Agent safety report: an append-only audit trail of EVERY action the agent proposed, with the verdict,
// the rules and live checks behind it, and a plain-language reason. Refused requests (typos, missing
// balance, unknown account) are recorded too. Entries are hash-chained so an exported report shows if
// a line was edited or removed. The settlement outcome is stored beside the entry, outside the hash,
// because it arrives later (a signature is not a success; only the chain settles it).

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const MAX_PER_ACCOUNT = 500;
const file = () => path.resolve(process.env.SENTINEL_DATA_DIR ?? 'data', 'audit.json');
const load = () => { try { return JSON.parse(fs.readFileSync(file(), 'utf8')); } catch { return {}; } };
const save = (db) => { fs.mkdirSync(path.dirname(file()), { recursive: true }); fs.writeFileSync(file(), JSON.stringify(db, null, 1)); };
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const bigintJson = (_, v) => (typeof v === 'bigint' ? v.toString() : v);
const GENESIS = '0'.repeat(64);

/** One sentence a non-technical reader can act on. */
export function plainReason(verdict, findings, fallback = '') {
  const of = (lvl) => findings.filter((f) => f.level === lvl).map((f) => f.message);
  if (verdict === 'deny') return `Blocked: ${of('deny').join(' ')}`.trim();
  if (verdict === 'confirm') return `Needs your explicit confirmation before signing: ${of('confirm').join(' ')}`.trim();
  if (verdict === 'refused') return fallback;
  return 'Allowed: every limit, allowlist and live chain check passed. Your wallet still asks for your signature.';
}

function append(account, body) {
  const db = load();
  const list = db[account] ?? [];
  const prevHash = list.length ? list[list.length - 1].hash : GENESIS;
  const entry = { seq: (list.length ? list[list.length - 1].seq : 0) + 1, ...body, prevHash };
  entry.hash = sha(prevHash + JSON.stringify(entry, bigintJson));
  db[account] = [...list, entry].slice(-MAX_PER_ACCOUNT);
  save(db);
  return entry;
}

export function recordProposal(card, { tool } = {}) {
  const txDigest = sha(JSON.stringify(card.transactions, bigintJson));
  return append(card.account || 'anonymous', {
    kind: 'proposal', id: card.id, ts: card.createdAt, account: card.account, tool: tool ?? null,
    title: card.title, summary: card.explain.flat(),
    verdict: card.policy.verdict, canSign: card.canSign,
    rules: card.policy.findings.map((f) => ({ level: f.level, rule: f.rule, message: f.message })),
    checks: card.checks, warnings: card.warnings,
    reason: plainReason(card.policy.verdict, card.policy.findings),
    txDigest, receivers: [...new Set(card.transactions.map((t) => t.receiverId))],
  });
}

export function recordRefusal(account, tool, args, message) {
  return append(account || 'anonymous', {
    kind: 'refused', id: crypto.randomUUID(), ts: Date.now(), account: account || 'anonymous', tool,
    title: String(tool).replaceAll('_', ' '), summary: [`Requested ${tool} ${JSON.stringify(args ?? {}, bigintJson).slice(0, 240)}`],
    verdict: 'refused', canSign: false, rules: [], checks: [], warnings: [],
    reason: `Refused before any card was built: ${message}`, txDigest: null, receivers: [],
  });
}

/** Attach the chain-confirmed outcome (outside the hash). */
export function recordOutcome(account, cardId, outcome) {
  const db = load();
  const e = (db[account] ?? []).find((x) => x.id === cardId);
  if (!e) return false;
  e.outcome = { ...(e.outcome ?? {}), ...outcome, at: Date.now() };
  save(db);
  return true;
}

export const auditEntries = (account) => load()[account || 'anonymous'] ?? [];

/** Recomputes the hash chain of the immutable fields. */
export function verifyChain(entries) {
  let prev = entries.length ? entries[0].prevHash : GENESIS;
  for (const e of entries) {
    const { hash, outcome, ...rest } = e;
    if (rest.prevHash !== prev || sha(prev + JSON.stringify(rest, bigintJson)) !== hash) return { ok: false, brokenAt: e.seq };
    prev = hash;
  }
  return { ok: true };
}

export function report(account) {
  const entries = auditEntries(account);
  const count = (v) => entries.filter((e) => e.verdict === v).length;
  return {
    report: 'NEAR Sentinel agent safety report', generatedAt: new Date().toISOString(), account,
    note: 'Every action the agent proposed, whether or not it could be signed. The agent holds no key and has no signing tool; "outcome" appears only after the chain confirmed a transaction.',
    totals: { proposed: entries.length, allowed: count('allow'), needConfirmation: count('confirm'), blocked: count('deny'), refused: count('refused'), confirmedOnChain: entries.filter((e) => e.outcome?.settled).length },
    hashChain: verifyChain(entries), entries,
  };
}
