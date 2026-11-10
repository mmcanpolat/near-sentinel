// Read-only NEAR JSON-RPC (public nodes). Nothing here can sign or send.

const DEFAULT_RPC = ['https://free.rpc.fastnear.com', 'https://rpc.mainnet.fastnear.com', 'https://rpc.mainnet.near.org'];
const urls = () => (process.env.NEAR_RPC_URL ? [process.env.NEAR_RPC_URL] : DEFAULT_RPC);

export class NearError extends Error {}

const cache = new Map(); // identical reads within 4s share one answer (keeps us under public rate limits)
const TRANSIENT = /rate limit|too many|timeout|temporar|unavailable|overload/i;

export async function rpc(method, params) {
  const key = method + JSON.stringify(params);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < 4000) return hit.value;
  let last = 'no NEAR RPC answered';
  for (let round = 0; round < 2; round++) {
    for (const url of urls()) {
      try {
        const r = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 'sentinel', method, params }),
          signal: AbortSignal.timeout(15000),
        });
        const text = await r.text();
        if (r.status === 429 || r.status >= 500) { last = `HTTP ${r.status}`; continue; }
        const j = JSON.parse(text);
        if (j.error) {
          const msg = j.error.data && typeof j.error.data === 'string' ? j.error.data : j.error.cause?.name || j.error.message;
          if (TRANSIENT.test(String(msg)) || TRANSIENT.test(String(j.error.message))) { last = String(msg); continue; }
          throw Object.assign(new NearError(msg), { rpcCause: j.error.cause?.name });
        }
        // Some nodes report query failures inside `result` instead of `error`.
        if (j.result && typeof j.result.error === 'string' && method === 'query' && params.request_type !== 'call_function') {
          const m = j.result.error;
          throw Object.assign(new NearError(m), { rpcCause: /access key/i.test(m) ? 'UNKNOWN_ACCESS_KEY' : /account .* does not exist/i.test(m) ? 'UNKNOWN_ACCOUNT' : undefined });
        }
        cache.set(key, { at: Date.now(), value: j.result });
        if (cache.size > 500) cache.delete(cache.keys().next().value);
        return j.result;
      } catch (e) {
        if (e instanceof NearError) throw e; // a real answer from the chain: do not retry elsewhere
        last = e.message;
      }
    }
    await new Promise((res) => setTimeout(res, 600));
  }
  throw new NearError(`NEAR RPC unavailable: ${last}`);
}

/** Account state or null when the account does not exist. */
export async function viewAccount(id) {
  try {
    return await rpc('query', { request_type: 'view_account', finality: 'final', account_id: id });
  } catch (e) {
    if (e.rpcCause === 'UNKNOWN_ACCOUNT' || /does not exist/i.test(e.message)) return null;
    throw e;
  }
}

/** Call a view method. Returns parsed JSON. */
export async function view(contract, method, args = {}) {
  const res = await rpc('query', {
    request_type: 'call_function', finality: 'final', account_id: contract, method_name: method,
    args_base64: Buffer.from(JSON.stringify(args)).toString('base64'),
  });
  if (res.error) throw new NearError(res.error);
  const text = Buffer.from(res.result).toString('utf8');
  return text ? JSON.parse(text) : null;
}

/** Like view() but returns null when the call fails (method missing, contract absent). */
export async function tryView(contract, method, args = {}) {
  try { return await view(contract, method, args); } catch { return null; }
}

export async function gasPrice() {
  const r = await rpc('gas_price', [null]);
  return BigInt(r.gas_price);
}

/** All access keys of an account: [{public_key, access_key:{nonce, permission}}]. */
export async function accessKeys(id) {
  const r = await rpc('query', { request_type: 'view_access_key_list', finality: 'final', account_id: id });
  return r.keys;
}

/** One access key or null. */
export async function accessKey(id, publicKey) {
  try {
    return await rpc('query', { request_type: 'view_access_key', finality: 'final', account_id: id, public_key: publicKey });
  } catch (e) {
    if (e.rpcCause === 'UNKNOWN_ACCESS_KEY' || /does not exist/i.test(e.message)) return null;
    throw e;
  }
}

/** Final execution outcome of a transaction (used to confirm settlement, never to send). */
export async function txStatus(hash, signer) {
  return rpc('tx', { tx_hash: hash, sender_account_id: signer, wait_until: 'FINAL' });
}

/** Account has a contract deployed. */
export const hasContract = (acct) => !!acct && acct.code_hash !== '11111111111111111111111111111111';

/** Bytes cost 10^19 yocto each: the part of the balance that cannot be spent. */
export const storageReserve = (acct) => BigInt(acct.storage_usage) * 10n ** 19n;
