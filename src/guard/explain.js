// Plain-language explanation of what a transaction will do, derived from its actions
// (not from what the builder claims), so what the user reads is what the wallet will sign.

import { yoctoToNear, formatUnits } from '../lib/units.js';

const KNOWN = {
  near_deposit: (c, d) => `Wrap ${yoctoToNear(d)} NEAR into wNEAR on ${c}`,
  near_withdraw: (c, d, a) => `Unwrap ${yoctoToNear(BigInt(a.amount ?? 0))} wNEAR back to NEAR`,
  deposit_and_stake: (c, d) => `Stake ${yoctoToNear(d)} NEAR in ${c}`,
  unstake: (c, d, a) => `Start unstaking ${a.amount ? yoctoToNear(BigInt(a.amount)) : 'your'} NEAR from ${c} (funds unlock after about 4 epochs, around 2 days)`,
  unstake_all: (c) => `Start unstaking everything from ${c}`,
  withdraw_all: (c) => `Withdraw all unlocked funds from ${c} to your account`,
  withdraw: (c, d, a) => `Withdraw ${a.amount ? yoctoToNear(BigInt(a.amount)) : 'unlocked'} NEAR from ${c}`,
  liquid_unstake: (c) => `Instantly swap stNEAR for NEAR on ${c} (pays a fee)`,
  storage_deposit: (c, d, a) => `Register ${a.account_id ?? 'an account'} with ${c} (storage deposit ${yoctoToNear(d)} NEAR, mostly refundable)`,
  set: (c) => `Write data to ${c} (NEAR Social)`,
  nft_transfer: (c, d, a) => `Send NFT #${a.token_id} of ${c} to ${a.receiver_id}`,
};

export function explainTx(t, meta = {}) {
  const lines = [];
  for (const a of t.actions) {
    const p = a.params ?? {};
    if (a.type === 'Transfer') lines.push(`Send ${yoctoToNear(p.deposit)} NEAR to ${t.receiverId}`);
    else if (a.type === 'FunctionCall') {
      const args = typeof p.args === 'object' ? p.args : {};
      if (p.methodName === 'ft_transfer') {
        const d = meta.decimals?.[t.receiverId] ?? 0, s = meta.symbols?.[t.receiverId] ?? t.receiverId;
        lines.push(`Send ${formatUnits(args.amount, d)} ${s} to ${args.receiver_id}`);
      } else if (p.methodName === 'ft_transfer_call') {
        const d = meta.decimals?.[t.receiverId] ?? 0, s = meta.symbols?.[t.receiverId] ?? t.receiverId;
        lines.push(`Send ${formatUnits(args.amount, d)} ${s} to ${args.receiver_id} and let it act on them (${args.msg ? 'with instructions' : 'plain deposit'})`);
      } else if (KNOWN[p.methodName]) lines.push(KNOWN[p.methodName](t.receiverId, BigInt(p.deposit ?? 0), args));
      else lines.push(`Call ${p.methodName}() on ${t.receiverId}${BigInt(p.deposit ?? 0) > 1n ? ` attaching ${yoctoToNear(p.deposit)} NEAR` : ''}`);
    } else if (a.type === 'AddKey') {
      const perm = p.accessKey?.permission;
      if (perm === 'FullAccess') lines.push(`Give FULL ACCESS to key ${p.publicKey}`);
      else lines.push(`Add a restricted key (${p.publicKey.slice(0, 16)}...) that can only call ${perm.methodNames?.length ? perm.methodNames.join(', ') : 'any method'} on ${perm.receiverId} and spend at most ${perm.allowance ? yoctoToNear(perm.allowance) : 'unlimited'} NEAR of gas. It cannot move funds.`);
    } else if (a.type === 'DeleteKey') lines.push(`Remove key ${p.publicKey.slice(0, 16)}... from ${t.receiverId}; it stops working immediately`);
    else lines.push(`${a.type} on ${t.receiverId}`);
  }
  return lines;
}
