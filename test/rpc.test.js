// RPC resilience, offline: rate limits are retried, shared, and surface as a clear retryable error.
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SENTINEL_RPC_BACKOFF_MS = '1';
delete process.env.NEAR_RPC_URL;
const { rpc, NearError } = await import('../src/near/rpc.js');
const real = globalThis.fetch;
test.afterEach(() => { globalThis.fetch = real; });

test('a 429 from one endpoint falls over to the next and the answer is returned', async () => {
  let n = 0;
  globalThis.fetch = async () => (++n === 1 ? new Response('slow down', { status: 429 }) : new Response(JSON.stringify({ jsonrpc: '2.0', id: 'x', result: { ok: n } })));
  assert.deepEqual(await rpc('status', ['a']), { ok: 2 });
});

test('identical concurrent reads share one request', async () => {
  let n = 0;
  globalThis.fetch = async () => { n++; await new Promise((r) => setTimeout(r, 20)); return new Response(JSON.stringify({ jsonrpc: '2.0', id: 'x', result: 7 })); };
  const [a, b, c] = await Promise.all([rpc('status', ['shared']), rpc('status', ['shared']), rpc('status', ['shared'])]);
  assert.deepEqual([a, b, c], [7, 7, 7]);
  assert.equal(n, 1);
});

test('persistent rate limiting becomes a plain, retryable NearError', async () => {
  globalThis.fetch = async () => new Response('', { status: 429 });
  await assert.rejects(rpc('status', ['limited']), (e) => e instanceof NearError && e.retryable === true && /rate-limiting/.test(e.message) && /NEAR_RPC_URL/.test(e.message));
});

test('a real chain error is not retried on other endpoints', async () => {
  let n = 0;
  globalThis.fetch = async () => { n++; return new Response(JSON.stringify({ jsonrpc: '2.0', id: 'x', error: { message: 'Server error', cause: { name: 'UNKNOWN_ACCOUNT' }, data: 'account nope.near does not exist' } })); };
  await assert.rejects(rpc('query', { request_type: 'view_account', account_id: 'nope.near' }), /does not exist/);
  assert.equal(n, 1);
});
