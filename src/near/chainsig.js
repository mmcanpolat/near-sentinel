// NEAR Chain Signatures (MPC signer contract), READ-ONLY plus an UNSIGNED sign-request builder.
//
// A NEAR account has a derived key on every other chain: the MPC network holds a root key per "domain",
// and for (caller account, path) anyone can compute the child PUBLIC key. The agent therefore knows an
// Ethereum / Bitcoin address of the user's NEAR account without any key existing on this machine.
// Spending from it needs the contract's `sign` method, which costs 1 yocto and so cannot be done with a
// function-call key: the user's wallet must approve the call. Sentinel only BUILDS that call.
//
// Facts used here (checked 2026-11-10 against the live contract v1.signer and near/mpc sources):
//   - view `state` lists domains {id, protocol, purpose}; `sign` only accepts purpose "Sign" domains
//   - view `config` holds the gas figures (sign_call_gas_attachment_requirement_tera_gas, ...)
//   - view `public_key {domain_id}` is the root key; `derived_public_key {path, predecessor, domain_id}`
//   - tweak = SHA3-256("near-mpc-recovery v0.1.0 epsilon derivation:" + predecessor + "," + path)
//     derived = root + tweak * G
//   - call: sign {request:{path, payload_v2:{Ecdsa:"<64 hex>"}, domain_id}}, deposit 1 yocto

import crypto from 'node:crypto';
import { view, tryView } from './rpc.js';
import { fnCall, tx, ONE_YOCTO } from './actions.js';
import { b58decode, b58encode } from '../lib/base58.js';
import { G, N, add, mul, fromBytes64, toBytes64 } from '../lib/secp256k1.js';
import { evmAddress, btcP2wpkh, btcP2pkh } from '../lib/addresses.js';
import { validAccountId } from '../lib/units.js';

export const SIGNER_CONTRACT = 'v1.signer';
const TWEAK_PREFIX = 'near-mpc-recovery v0.1.0 epsilon derivation:';
const bad = (m) => Object.assign(new Error(m), { user: true });

export const validPath = (p) => typeof p === 'string' && /^[A-Za-z0-9._:/#-]{1,64}$/.test(p);

/** "secp256k1:<base58 of x||y>" -> curve point. */
export function parseSecpKey(s) {
  if (typeof s !== 'string' || !s.startsWith('secp256k1:')) throw new Error('not a secp256k1 key');
  return fromBytes64(Buffer.from(b58decode(s.slice(10))));
}
export const formatSecpKey = (point) => `secp256k1:${b58encode(toBytes64(point))}`;

export function tweakFor(predecessor, path) {
  const h = crypto.createHash('sha3-256').update(`${TWEAK_PREFIX}${predecessor},${path}`).digest('hex');
  const t = BigInt('0x' + h);
  if (t >= N) throw new Error('tweak is not a valid scalar');
  return t;
}

/** Child public key = root + tweak*G. Pure; this is the math the contract's derived_public_key view runs. */
export function deriveChildKey(rootKey, predecessor, path) {
  return add(parseSecpKey(rootKey), mul(tweakFor(predecessor, path), G));
}

export function addressesOf(point) {
  return { evm: evmAddress(point), bitcoin: btcP2wpkh(point), bitcoinLegacy: btcP2pkh(point) };
}

/** Gas to attach, from the contract's own config: the call requirement plus the yield callbacks it reserves. */
export function signGasFromConfig(cfg) {
  const t = (k) => {
    const v = Number(cfg?.[k]);
    if (!Number.isFinite(v) || v <= 0) throw bad(`The signer contract config has no ${k}; cannot size the gas.`);
    return v;
  };
  const tgas = t('sign_call_gas_attachment_requirement_tera_gas') + t('return_signature_and_clean_state_on_success_call_tera_gas') + t('fail_on_timeout_tera_gas');
  return BigInt(tgas) * 10n ** 12n;
}

/** Domains from the contract's `state`. Only purpose "Sign" domains with a secp256k1 key serve EVM / Bitcoin. */
export function domainsFromState(state) {
  const running = state?.Running;
  if (!running) return [];
  const keys = new Map((running.keyset?.domains ?? []).map((d) => [d.domain_id, Object.keys(d.key ?? {})[0]]));
  return (running.domains?.domains ?? []).map((d) => ({
    id: d.id, protocol: d.protocol, purpose: d.purpose, curve: keys.get(d.id) ?? 'unknown',
    usable: d.purpose === 'Sign' && keys.get(d.id) === 'Secp256k1',
  }));
}

/** Live contract facts: version, domains, gas. Nothing is hardcoded except the contract's account name. */
export async function chainSigConfig(contract = SIGNER_CONTRACT) {
  const [state, config, version] = await Promise.all([view(contract, 'state'), view(contract, 'config'), tryView(contract, 'version')]);
  const domains = domainsFromState(state);
  if (!domains.length) throw bad(`${contract} is not in the Running state; Chain Signatures are unavailable right now.`);
  return { contract, version, domains, gasTgas: Number(signGasFromConfig(config) / 10n ** 12n), depositYocto: ONE_YOCTO.toString(), config };
}

function pickDomain(cfg, domainId) {
  const id = domainId == null ? cfg.domains.find((d) => d.usable)?.id : Number(domainId);
  const d = cfg.domains.find((x) => x.id === id);
  if (!d) throw bad(`Domain ${domainId} does not exist on ${cfg.contract}. Available: ${cfg.domains.map((x) => `${x.id} (${x.protocol}, ${x.curve}, ${x.purpose})`).join('; ')}.`);
  if (!d.usable) throw bad(`Domain ${d.id} is ${d.protocol}/${d.curve} for ${d.purpose}; only secp256k1 signing domains give EVM and Bitcoin addresses here.`);
  return d;
}

/**
 * Addresses of `account` on other chains. The contract's own derived_public_key view is authoritative;
 * the same key is recomputed locally from the root key, and the answer says whether the two agree.
 */
export async function chainSigAddresses({ account, path = 'ethereum-1', domainId }) {
  if (!validAccountId(account)) throw bad('Connect or preview a NEAR account first.');
  if (!validPath(path)) throw bad('A derivation path is 1-64 characters from A-Z a-z 0-9 . _ : / # - (for example ethereum-1).');
  const cfg = await chainSigConfig();
  const d = pickDomain(cfg, domainId);
  const [onChain, root] = await Promise.all([
    view(cfg.contract, 'derived_public_key', { path, predecessor: account, domain_id: d.id }),
    view(cfg.contract, 'public_key', { domain_id: d.id }),
  ]);
  const point = parseSecpKey(onChain);
  const local = deriveChildKey(root, account, path);
  const match = local.x === point.x && local.y === point.y;
  return {
    account, path, domainId: d.id, contract: cfg.contract, contractVersion: cfg.version,
    derivedPublicKey: onChain, addresses: addressesOf(point),
    localDerivationMatchesContract: match,
    note: match
      ? 'These addresses belong to the MPC-derived key of this NEAR account and path. No private key exists on this machine; only a `sign` call approved by the NEAR account can spend from them. The Bitcoin address is a native segwit (bech32) P2WPKH address.'
      : 'WARNING: the locally recomputed key differs from the contract answer. Do not send funds to these addresses.',
  };
}

const HEX64 = /^[0-9a-f]{64}$/;
/** Unsigned `sign` call for a 32-byte payload hash (the digest of a transaction on the target chain). */
export async function buildChainSigRequest({ account, path, payloadHex, domainId }) {
  if (!validAccountId(account)) throw bad('Connect a NEAR wallet first (no account is set).');
  if (!validPath(path)) throw bad('A derivation path is 1-64 characters from A-Z a-z 0-9 . _ : / # - (for example ethereum-1).');
  const hex = String(payloadHex ?? '').toLowerCase().replace(/^0x/, '');
  if (!HEX64.test(hex)) throw bad('The payload must be a 32-byte hash as 64 hex characters (the digest of the transaction to sign on the other chain).');
  const cfg = await chainSigConfig();
  const d = pickDomain(cfg, domainId);
  const info = await chainSigAddresses({ account, path, domainId: d.id });
  if (!info.localDerivationMatchesContract) throw bad('Refused: the key derived locally differs from the key the contract reports for this account and path, so the signing address cannot be trusted.');
  const gas = signGasFromConfig(cfg.config);
  return {
    preview: { op: 'chain_signature', account, path, domainId: d.id, payload: `0x${hex}`, signingAddress: info.addresses.evm },
    checks: [
      `${cfg.contract} (v${cfg.version ?? '?'}) is Running; domain ${d.id} is ${d.protocol}/${d.curve} for ${d.purpose}.`,
      `Key derived for ${account} + "${path}" matches between the contract view and local math: ${info.localDerivationMatchesContract ? 'yes' : 'NO'}.`,
      `Attached gas ${Number(gas / 10n ** 12n)} Tgas comes from the contract config (call requirement + signature callbacks); deposit is 1 yocto.`,
    ],
    warnings: [
      `If the MPC network signs, the signature can authorise a transfer from ${info.addresses.evm} (EVM) or ${info.addresses.bitcoin} (Bitcoin) for exactly the hash 0x${hex}. Check the other-chain transaction behind this hash before you approve.`,
      'Sentinel only builds this request. The signature comes back to the NEAR transaction and nothing is broadcast to the other chain by this app.',
    ],
    transactions: [tx(cfg.contract, [fnCall('sign', { request: { path, payload_v2: { Ecdsa: hex }, domain_id: d.id } }, gas, ONE_YOCTO)])],
  };
}
