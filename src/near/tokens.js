// Token metadata comes from live sources only: the NEAR Intents token list and each token's own ft_metadata.
// There is no hard-coded token table in this repository.

import { tryView, view } from './rpc.js';
import { validAccountId } from '../lib/units.js';

export const INTENTS = process.env.NEAR_INTENTS_URL ?? 'https://1click.chaindefuser.com';
export const WRAP = 'wrap.near';

let cache = { at: 0, list: [] };
export async function intentsTokens() {
  if (Date.now() - cache.at < 60_000 && cache.list.length) return cache.list;
  const r = await fetch(`${INTENTS}/v0/tokens`, { signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`NEAR Intents token list unavailable (${r.status}).`);
  cache = { at: Date.now(), list: await r.json() };
  return cache.list;
}

export async function ftInfo(contract) {
  const m = await tryView(contract, 'ft_metadata');
  if (!m || typeof m.decimals !== 'number') return null;
  return { contract, symbol: m.symbol, decimals: m.decimals, name: m.name };
}

export const isNative = (q) => /^near$/i.test(String(q).trim());

/** "USDC", "usdt.tether-token.near" -> { contract, symbol, decimals }. Native NEAR is handled by callers. */
export async function resolveFt(query) {
  const q = String(query ?? '').trim();
  if (!q) throw new Error('Name a token.');
  if (validAccountId(q.toLowerCase()) && q.includes('.')) {
    const info = await ftInfo(q.toLowerCase());
    if (!info) throw new Error(`${q} does not look like a NEP-141 token (no ft_metadata).`);
    return info;
  }
  const list = await intentsTokens();
  const hits = list.filter((t) => t.blockchain === 'near' && t.symbol.toLowerCase() === q.toLowerCase() && t.contractAddress);
  if (!hits.length) throw new Error(`No NEAR token called "${q}" is listed on NEAR Intents. Give the token contract address instead.`);
  const t = hits[0];
  return { contract: t.contractAddress, symbol: t.symbol, decimals: t.decimals };
}

/** NEP-145: is the account registered with the token contract? And what does registering cost? */
export async function isRegistered(contract, account) {
  const r = await tryView(contract, 'storage_balance_of', { account_id: account });
  return r != null;
}
export async function storageMin(contract) {
  const b = await tryView(contract, 'storage_balance_bounds');
  return BigInt(b?.min ?? '1250000000000000000000'); // 0.00125 NEAR is the common minimum when a contract does not say
}
export const ftBalance = async (contract, account) => BigInt(await view(contract, 'ft_balance_of', { account_id: account }));
