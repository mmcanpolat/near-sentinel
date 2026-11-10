// Turns raw transactions into a flat list of EFFECTS the policy engine can judge.
// The policy engine never trusts the builder's own description: it re-derives what a transaction
// does from the actions themselves (receiver, method, args, deposit, key scope).

const FT_OUT = new Set(['ft_transfer', 'ft_transfer_call']);

const big = (v) => { try { return BigInt(v ?? 0); } catch { return 0n; } };

function keyScope(accessKey) {
  const p = accessKey?.permission;
  if (p === 'FullAccess' || p?.type === 'FullAccess' || p?.FullAccess) return { type: 'full' };
  const fc = p?.FunctionCall ?? p;
  return {
    type: 'function_call',
    receiverId: fc?.receiverId ?? fc?.receiver_id ?? '',
    methodNames: fc?.methodNames ?? fc?.method_names ?? [],
    allowance: fc?.allowance == null ? null : big(fc.allowance),
  };
}

/** @param {{receiverId:string, actions:any[]}[]} txs */
export function analyze(txs) {
  const effects = [];
  for (const t of txs) {
    for (const a of t.actions) {
      const p = a.params ?? {};
      switch (a.type) {
        case 'Transfer':
          effects.push({ kind: 'native_out', to: t.receiverId, amount: big(p.deposit), via: 'transfer' });
          break;
        case 'FunctionCall': {
          const args = typeof p.args === 'object' && p.args ? p.args : {};
          const deposit = big(p.deposit);
          effects.push({ kind: 'call', contract: t.receiverId, method: p.methodName, gas: big(p.gas), deposit, args });
          if (FT_OUT.has(p.methodName)) {
            effects.push({ kind: 'ft_out', token: t.receiverId, to: String(args.receiver_id ?? ''), amount: big(args.amount), viaCall: p.methodName === 'ft_transfer_call', msg: args.msg });
          } else if (deposit > 1n) {
            // Attached deposit leaves the account (storage, wrapping, staking, purchases...).
            effects.push({ kind: 'native_out', to: t.receiverId, amount: deposit, via: 'attached_deposit', method: p.methodName });
          }
          break;
        }
        case 'AddKey':
          effects.push({ kind: 'add_key', publicKey: p.publicKey, scope: keyScope(p.accessKey), onAccount: t.receiverId });
          break;
        case 'DeleteKey':
          effects.push({ kind: 'delete_key', publicKey: p.publicKey, onAccount: t.receiverId });
          break;
        case 'DeployContract': effects.push({ kind: 'deploy', onAccount: t.receiverId }); break;
        case 'DeleteAccount': effects.push({ kind: 'delete_account', onAccount: t.receiverId, beneficiary: p.beneficiaryId }); break;
        case 'Stake': effects.push({ kind: 'native_stake', onAccount: t.receiverId }); break;
        case 'CreateAccount': effects.push({ kind: 'create_account', account: t.receiverId }); break;
        default: effects.push({ kind: 'unknown', type: a.type });
      }
    }
  }
  return effects;
}

/** Total attached gas across all FunctionCall actions. */
export const totalGas = (effects) => effects.reduce((s, e) => (e.kind === 'call' ? s + e.gas : s), 0n);
