// Rolling spend ledger. An entry is written ONLY after the chain says the transaction settled
// successfully (a wallet signature is not a success), so limits count real spending, not intentions.

import fs from 'node:fs';
import path from 'node:path';
import { txStatus } from '../near/rpc.js';
import { analyze } from './analyze.js';
import { canon } from './policy.js';

const file = () => path.resolve(process.env.SENTINEL_DATA_DIR ?? 'data', 'ledger.json');

function load() {
  try { return JSON.parse(fs.readFileSync(file(), 'utf8')); } catch { return {}; }
}
function save(db) {
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  fs.writeFileSync(file(), JSON.stringify(db, null, 1));
}

export const entries = (account) => (load()[account] ?? []).map((r) => ({ ...r }));

export function record(account, rows) {
  const db = load();
  db[account] = [...(db[account] ?? []), ...rows].filter((r) => Date.now() - r.ts < 7 * 24 * 3600 * 1000);
  save(db);
}

/** First Failure anywhere in an outcome, or null. */
export function failureOf(outcome) {
  const fail = (s) => (s && typeof s === 'object' && s.Failure ? JSON.stringify(s.Failure).slice(0, 200) : null);
  const top = fail(outcome.status);
  if (top) return top;
  for (const r of outcome.receipts_outcome ?? []) { const f = fail(r.outcome?.status); if (f) return f; }
  return null;
}

/**
 * Called after the wallet returns a hash. We re-read the transaction from the chain, check it is the
 * transaction we built (same signer, receiver and number of actions), and only on success write the
 * spend that the transaction's own actions imply.
 */
export async function settle(account, hash, t) {
  const outcome = await txStatus(hash, account);
  const o = outcome.transaction;
  if (o?.signer_id !== account) return { settled: false, reason: 'Signer does not match the connected account.' };
  if (o.receiver_id !== t.receiverId || o.actions?.length !== t.actions.length) return { settled: false, reason: 'That hash is not the transaction that was built.' };
  const f = failureOf(outcome);
  if (f) return { settled: false, reason: `The transaction failed on chain: ${f}` };
  const rows = [];
  for (const e of analyze([t])) {
    if (e.kind === 'native_out' && e.amount > 0n) rows.push({ ts: Date.now(), token: 'near', amount: e.amount.toString(), to: e.to, hash });
    if (e.kind === 'ft_out' && e.amount > 0n) rows.push({ ts: Date.now(), token: canon(e.token), amount: e.amount.toString(), to: e.to, hash });
  }
  record(account, rows);
  return { settled: true, recorded: rows.length };
}
