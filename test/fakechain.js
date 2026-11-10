import { clearRpcCache } from '../src/near/rpc.js';
// A small fake NEAR RPC so the guard pipeline can run with no network (tests and `npm run selftest`).
// Chain-signature fixtures are values RECORDED from the live v1.signer contract (v3.18.0) on 2026-11-10;
// the derived keys are NOT computed by the code under test, so they work as independent vectors.

export const SIGNER_ROOT_KEY_0 = 'secp256k1:3tFRbMqmoa6AAALMrEFAYCEoHcqKxeW38YptwowBVBtXK1vo36HDbUWuR6EZmoK4JcH6HDkNMGGqP1ouV7VZUWya';
export const RECORDED_DERIVED = [
  { predecessor: 'near', path: 'ethereum-1', key: 'secp256k1:3gnnM7rMWbovkJyWdZA6g8uPaoKyyr31ua8DZz737JoxSyxaXMPjsvYfu6VHh25Jgc9UpmrnSgKr1sHwjbTcGbQ5', evm: '0xb1907fbb615a7E265e4Eaa54b2E75ef8b5BE0954', btc: 'bc1qs46avy85jdznqew4km9c2t4gjtpd6zsav0hfhu' },
  { predecessor: 'alice.near', path: 'bitcoin-1', key: 'secp256k1:4ypfoibiC57fzbYaq56SyXVnjZ8i6hNCwm8vF9XRuJcaYAyKAacgRWFZEfAEFmPt4ky6MZx3yL2Qsjg5MZZkkQue', evm: '0x51374208230f04C980bC1Be4B5a4001b567fb78E', btc: 'bc1qtute5t9f09lx8td574549crs0p9ukxfaqeq3m9' },
  { predecessor: 'alice.near', path: 'ethereum-1', key: 'secp256k1:DgDjtBvj99cpBDZg5C6gozLEX2qdbYZxdPGaWehvFo8fDCCu5A2k8EnZ1VQYBWkfb35LRHsvSgAkuhFk3raaGTb', evm: '0xa2869D3977DEa9afc9B9c069491ac08F06F9e458', btc: 'bc1q96j504ke29e7ttnh0wkhnhr5qpj8alexu6h0gc' },
];
export const SIGNER_STATE = { Running: {
  domains: { domains: [
    { id: 0, protocol: 'CaitSith', reconstruction_threshold: 11, purpose: 'Sign' }, { id: 1, protocol: 'Frost', reconstruction_threshold: 11, purpose: 'Sign' },
    { id: 2, protocol: 'ConfidentialKeyDerivation', reconstruction_threshold: 11, purpose: 'CKD' }, { id: 3, protocol: 'CaitSith', reconstruction_threshold: 11, purpose: 'ForeignTx' }], next_domain_id: 4 },
  keyset: { epoch_id: 16, domains: [
    { domain_id: 0, key: { Secp256k1: { near_public_key: SIGNER_ROOT_KEY_0 } } }, { domain_id: 1, key: { Ed25519: {} } },
    { domain_id: 2, key: { Bls12381: {} } }, { domain_id: 3, key: { Secp256k1: { near_public_key: SIGNER_ROOT_KEY_0 } } }] } } };
export const SIGNER_CONFIG = { sign_call_gas_attachment_requirement_tera_gas: 15, return_signature_and_clean_state_on_success_call_tera_gas: 7, fail_on_timeout_tera_gas: 2 };

const acct = (amount, code = 'ABC') => ({ amount, locked: '0', code_hash: code, storage_usage: 500, storage_paid_at: 0 });
const NEAR = (n) => (BigInt(Math.round(n * 1e6)) * 10n ** 18n).toString();

/** Installs the fake; returns { restore, calls } where calls lists every RPC method asked (to prove read-only). */
export function installFakeChain({ extraViews = {}, accounts = {}, txOutcomes = {} } = {}) {
  clearRpcCache();
  const real = globalThis.fetch;
  const calls = [];
  const all = {
    'alice.near': acct(NEAR(50)), near: acct(NEAR(1000)), 'root.near': acct(NEAR(10), '11111111111111111111111111111111'),
    'wrap.near': acct(NEAR(100)), 'v1.signer': acct(NEAR(100)), 'mallory.near': acct(NEAR(5), '11111111111111111111111111111111'), ...accounts,
  };
  const views = {
    'v1.signer.state': () => SIGNER_STATE, 'v1.signer.config': () => SIGNER_CONFIG, 'v1.signer.version': () => '3.18.0',
    'v1.signer.public_key': () => SIGNER_ROOT_KEY_0,
    'v1.signer.derived_public_key': (a) => RECORDED_DERIVED.find((r) => r.predecessor === a.predecessor && r.path === a.path)?.key ?? (() => { throw new Error('no recorded vector'); })(),
    ...extraViews,
  };
  globalThis.fetch = async (url, init) => {
    if (!String(url).includes('rpc')) return real(url, init);
    const { method, params } = JSON.parse(init.body);
    calls.push(method);
    const reply = (result) => new Response(JSON.stringify({ jsonrpc: '2.0', id: 'x', result }));
    if (method === 'gas_price') return reply({ gas_price: '100000000' });
    if (method === 'tx') { const o = txOutcomes[params.tx_hash]; return o ? reply(o) : new Response(JSON.stringify({ jsonrpc: '2.0', id: 'x', error: { message: 'x', cause: { name: 'UNKNOWN_TRANSACTION' }, data: 'unknown transaction' } })); }
    if (params.request_type === 'view_account') {
      const a = all[params.account_id];
      return a ? reply(a) : new Response(JSON.stringify({ jsonrpc: '2.0', id: 'x', error: { message: 'x', cause: { name: 'UNKNOWN_ACCOUNT' }, data: `account ${params.account_id} does not exist while viewing` } }));
    }
    if (params.request_type === 'call_function') {
      const f = views[`${params.account_id}.${params.method_name}`];
      if (!f) return reply({ error: 'method not found' });
      try { return reply({ result: [...Buffer.from(JSON.stringify(f(JSON.parse(Buffer.from(params.args_base64, 'base64').toString() || '{}'))))] }); } catch (e) { return reply({ error: e.message }); }
    }
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 'x', error: { message: 'unsupported in fake', cause: { name: 'FAKE' }, data: `fake chain does not serve ${method}` } }));
  };
  return { restore: () => { globalThis.fetch = real; }, calls };
}
