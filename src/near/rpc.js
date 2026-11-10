// Read-only NEAR JSON-RPC (public nodes). Nothing here can sign or send.

const DEFAULT_RPC = ['https://free.rpc.fastnear.com', 'https://rpc.mainnet.fastnear.com', 'https://rpc.mainnet.near.org'];
const urls = () => (process.env.NEAR_RPC_URL ? [process.env.NEAR_RPC_URL] : DEFAULT_RPC);

export class NearError extends Error {
  constructor(message, extra) { super(message); this.name = 'NearError'; if (extra) Object.assign(this, extra); }
}

const cache = new Map(); // identical reads within 4s share one answer (keeps us under public rate limits)
const inflight = new Map(); // the same read asked twice at once shares one request
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
const TRANSIENT = /rate limit|too many|timeout|temporar|unavailable|overload/i;

export function rpc(method, params) {
  const key = method + JSON.stringify(params);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < 4000) return Promise.resolve(hit.value);
  if (!inflight.has(key)) inflight.set(key, rpcOnce(method, params, key).finally(() => inflight.delete(key)));
  return inflight.get(key);
}

async function rpcOnce(method, params, key) {
  let last = 'no NEAR RPC answered', limited = false;
  for (let round = 0; round < 3; round++) {
    for (const url of urls()) {
      try {
        const r = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 'sentinel', method, params }),
          signal: AbortSignal.timeout(15000),
        });
        const text = await r.text();
        if (r.status === 429 || r.status >= 500) { last = `HTTP ${r.status}`; limited ||= r.status === 429; continue; }
        const j = JSON.parse(text);
        if (j.error) {
          const msg = j.error.data && typeof j.error.data === 'string' ? j.error.data : j.error.cause?.name || j.error.message;
          if (TRANSIENT.test(String(msg)) || TRANSIENT.test(String(j.error.message))) { last = String(msg); limited ||= /rate limit|too many/i.test(last); continue; }
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
    await sleep(Number(process.env.SENTINEL_RPC_BACKOFF_MS ?? 500) * 2 ** round); // 0.5s, 1s, 2s
  }
  throw new NearError(`NEAR RPC unavailable: ${limited ? 'the public endpoints are rate-limiting this machine' : last}. Wait a few seconds and retry, or set NEAR_RPC_URL to your own endpoint.`, { retryable: true });
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
