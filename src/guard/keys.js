// Restricted agent access with NEAR function-call access keys.
//
// A function-call key is the native NEAR sandbox: it is bound to ONE contract, optionally to a list
// of methods, carries a gas ALLOWANCE (a hard budget), and the protocol itself refuses to let it
// attach a deposit. The agent gets such a key; the user keeps the full-access key in their wallet.
// This module only BUILDS the unsigned create/revoke transactions and CHECKS what a key may do.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { b58encode, validPublicKey } from '../lib/base58.js';
import { parseUnits, yoctoToNear, validAccountId } from '../lib/units.js';
import { addFunctionCallKey, deleteKey, tx } from '../near/actions.js';
import { accessKey, accessKeys, viewAccount, hasContract } from '../near/rpc.js';

const KEY_DIR = path.resolve(process.env.SENTINEL_DATA_DIR ?? 'data', 'agent-keys');

/** Generates the agent's own ed25519 keypair. The private half stays on disk (git-ignored) and is never returned. */
export function generateAgentKey(label = 'agent') {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const pub = Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url');
  const seed = Buffer.from(privateKey.export({ format: 'jwk' }).d, 'base64url');
  const pk = `ed25519:${b58encode(pub)}`;
  fs.mkdirSync(KEY_DIR, { recursive: true });
  const secret = `ed25519:${b58encode(Buffer.concat([seed, pub]))}`;
  fs.writeFileSync(path.join(KEY_DIR, `${label}-${pk.slice(8, 16)}.json`), JSON.stringify({ publicKey: pk, secretKey: secret, createdAt: new Date().toISOString() }), { mode: 0o600 });
  return { publicKey: pk };
}

/** What the protocol lets a key do, as plain data. */
export function describeKey(k) {
  const p = k.access_key.permission;
  if (p === 'FullAccess') return { publicKey: k.public_key, type: 'full_access' };
  const fc = p.FunctionCall;
  return {
    publicKey: k.public_key, type: 'function_call', receiverId: fc.receiver_id, methodNames: fc.method_names,
    allowanceNear: fc.allowance == null ? null : yoctoToNear(fc.allowance, 6),
  };
}

export async function listKeys(account) {
  const keys = (await accessKeys(account)).map(describeKey);
  const full = keys.filter((k) => k.type === 'full_access').length;
  const warnings = [];
  if (!full) warnings.push('This account has NO full-access key: nobody can add keys or move funds beyond what existing keys permit.');
  for (const k of keys.filter((k) => k.type === 'function_call' && (k.allowanceNear == null || !k.methodNames.length))) {
    warnings.push(`Key ${k.publicKey.slice(0, 16)}... is loosely scoped (${k.allowanceNear == null ? 'unlimited allowance' : 'any method'}).`);
  }
  return { keys, fullAccessKeys: full, warnings };
}

/** Builds the unsigned AddKey transaction for the user to sign. Throws a plain-language Error on bad input. */
export async function buildCreateAgentKey({ account, publicKey, contract, methods, allowanceNear }) {
  if (!validAccountId(account)) throw new Error('Connect a NEAR account first.');
  if (!validPublicKey(publicKey)) throw new Error('publicKey must look like ed25519:<base58>.');
  if (!validAccountId(contract)) throw new Error(`"${contract}" is not a valid contract account id.`);
  const names = (methods ?? []).map(String).filter(Boolean);
  const allowance = parseUnits(allowanceNear ?? '0.1', 24);
  if (allowance <= 0n) throw new Error('The allowance must be above zero.');
  const checks = [], warnings = [];
  const [acct, target, existing] = await Promise.all([viewAccount(account), viewAccount(contract), accessKey(account, publicKey)]);
  if (!acct) throw new Error(`Account ${account} does not exist on NEAR mainnet.`);
  checks.push(`Account ${account} exists.`);
  if (!target) throw new Error(`Contract account ${contract} does not exist.`);
  if (!hasContract(target)) throw new Error(`${contract} has no contract deployed, so a key bound to it is useless.`);
  checks.push(`${contract} exists and has a contract deployed.`);
  if (existing) throw new Error('That public key is already an access key on this account. Revoke it first or generate a new one.');
  checks.push('The public key is not yet on the account.');
  if (!names.length) warnings.push('No method list: the key could call EVERY method of this contract.');
  warnings.push('A function-call key can never attach a deposit: the agent cannot send NEAR or tokens with it, only call the listed methods and burn the gas allowance.');
  warnings.push(`When the ${yoctoToNear(allowance)} NEAR allowance is used up the key stops working by itself.`);
  return {
    transactions: [tx(account, [addFunctionCallKey(publicKey, contract, names, allowance)])],
    checks, warnings,
    preview: { op: 'agent_key_create', account, publicKey, contract, methods: names, allowanceNear: yoctoToNear(allowance) },
  };
}

/** Builds the unsigned DeleteKey transaction. Refuses to delete the last full-access key. */
export async function buildRevokeAgentKey({ account, publicKey }) {
  if (!validAccountId(account)) throw new Error('Connect a NEAR account first.');
  if (!validPublicKey(publicKey)) throw new Error('publicKey must look like ed25519:<base58>.');
  const { keys } = await listKeys(account);
  const k = keys.find((x) => x.publicKey === publicKey);
  if (!k) throw new Error('That key is not on the account (already revoked?).');
  const fullCount = keys.filter((x) => x.type === 'full_access').length;
  if (k.type === 'full_access' && fullCount <= 1) throw new Error('Refused: that is your only full-access key. Deleting it would lock the account forever.');
  const checks = [`The key exists on ${account} (${k.type === 'full_access' ? 'full access' : `function-call key for ${k.receiverId}`}).`];
  const warnings = [];
  if (k.type === 'full_access') warnings.push('This is a FULL-ACCESS key. Make sure it is not the one you use in your wallet.');
  return { transactions: [tx(account, [deleteKey(publicKey)])], checks, warnings, preview: { op: 'agent_key_revoke', account, publicKey, keyType: k.type } };
}

/**
 * Pure check: would the NEAR protocol accept these transactions if signed with this function-call key?
 * Mirrors the runtime rules: one action, a FunctionCall, same receiver as the key, listed method, zero deposit,
 * and gas fees within the remaining allowance.
 */
export function checkKeyAllows(key, txs, { gasPrice = 100000000n } = {}) {
  const reasons = [];
  if (key.type !== 'function_call') return { allowed: false, reasons: ['Only function-call keys are sandboxed; this key is not one.'] };
  let budget = key.allowanceYocto == null ? null : BigInt(key.allowanceYocto);
  for (const t of txs) {
    if (t.receiverId !== key.receiverId) reasons.push(`Key is bound to ${key.receiverId}; this transaction targets ${t.receiverId}.`);
    if (t.actions.length !== 1) reasons.push('A function-call key can sign only transactions with exactly one action.');
    for (const a of t.actions) {
      if (a.type !== 'FunctionCall') { reasons.push(`A function-call key cannot do ${a.type}.`); continue; }
      if (BigInt(a.params.deposit ?? 0) !== 0n) reasons.push(`A function-call key cannot attach a deposit (${a.params.methodName} attaches ${a.params.deposit} yocto).`);
      if (key.methodNames?.length && !key.methodNames.includes(a.params.methodName)) reasons.push(`Method ${a.params.methodName}() is not in the key's method list (${key.methodNames.join(', ')}).`);
      if (budget != null) {
        const fee = BigInt(a.params.gas) * gasPrice;
        if (fee > budget) reasons.push('The key allowance is too small for this call\'s gas.'); else budget -= fee;
      }
    }
  }
  return { allowed: reasons.length === 0, reasons };
}
