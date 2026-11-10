// Live pre-check: every transaction is compared with the CURRENT chain state before it is shown.
// NEAR has no whole-transaction dry run, so this says exactly what was checked and never says "simulated".

import { analyze } from './analyze.js';
import { viewAccount, view, gasPrice, hasContract, storageReserve, accessKey, tryView } from '../near/rpc.js';
import { yoctoToNear, formatUnits, isImplicit } from '../lib/units.js';

/** @returns {{checks:string[], failures:string[], fee:string, deposits:string}} */
export async function precheck(signer, txs) {
  const checks = [], failures = [];
  const acct = await viewAccount(signer);
  if (!acct) return { checks, failures: [`Account ${signer} does not exist on NEAR mainnet.`], fee: '0', deposits: '0' };
  checks.push(`Account ${signer} exists on NEAR mainnet.`);

  const price = await gasPrice();
  let gas = 0n, deposits = 0n;
  const ftNeeds = new Map();
  const seen = new Set();
  for (const t of txs) {
    const key = t.receiverId;
    if (!seen.has(key) && t.receiverId !== signer) {
      seen.add(key);
      const ra = await viewAccount(t.receiverId);
      const needsContract = t.actions.some((a) => a.type === 'FunctionCall');
      if (!ra && !isImplicit(t.receiverId)) failures.push(`${t.receiverId} does not exist on NEAR mainnet.`);
      else if (!ra) checks.push(`${t.receiverId} is a new implicit account (it will be created by the transfer).`);
      else if (needsContract && !hasContract(ra)) failures.push(`${t.receiverId} has no contract deployed; calling it would fail.`);
      else checks.push(`${t.receiverId} exists${hasContract(ra) ? ' and has a contract deployed' : ''}.`);
    }
    for (const a of t.actions) {
      if (a.type === 'Transfer') deposits += BigInt(a.params.deposit);
      if (a.type === 'FunctionCall') { gas += BigInt(a.params.gas); deposits += BigInt(a.params.deposit); }
      if (a.type === 'AddKey' || a.type === 'DeleteKey') {
        const ex = await accessKey(t.receiverId, a.params.publicKey);
        if (a.type === 'AddKey' && ex) failures.push('That key already exists on the account.');
        if (a.type === 'DeleteKey' && !ex) failures.push('That key is not on the account.');
      }
    }
  }
  for (const e of analyze(txs)) if (e.kind === 'ft_out') ftNeeds.set(e.token, (ftNeeds.get(e.token) ?? 0n) + e.amount);

  for (const [token, need] of ftNeeds) {
    const bal = await tryView(token, 'ft_balance_of', { account_id: signer });
    const meta = await tryView(token, 'ft_metadata');
    const dec = meta?.decimals ?? 0, symbol = meta?.symbol ?? token;
    if (bal == null) failures.push(`${token} did not answer ft_balance_of: it may not be a NEP-141 token.`);
    else if (BigInt(bal) < need) failures.push(`Balance is ${formatUnits(bal, dec)} ${symbol}, less than the ${formatUnits(need, dec)} ${symbol} this moves.`);
    else checks.push(`Token balance covers ${formatUnits(need, dec)} ${symbol} (live ft_balance_of: ${formatUnits(bal, dec)}).`);
  }

  const fee = gas * price;
  const spendable = BigInt(acct.amount) - storageReserve(acct);
  if (deposits + fee > spendable) failures.push(`Needs ${yoctoToNear(deposits + fee)} NEAR (deposits ${yoctoToNear(deposits)} + max gas fee ${yoctoToNear(fee)}) but only ${yoctoToNear(spendable < 0n ? 0n : spendable)} NEAR is spendable after the storage reserve.`);
  else checks.push(`Spendable NEAR ${yoctoToNear(spendable)} covers deposits ${yoctoToNear(deposits)} + max gas fee ${yoctoToNear(fee, 6)} (live gas price).`);
  return { checks, failures, fee: fee.toString(), deposits: deposits.toString() };
}
