// Action constructors in the wallet-selector / near-connect format.
// A transaction is { receiverId, actions: [...] }; the USER's wallet signs it.

export const GAS = { storage: 30n * 10n ** 12n, ft: 30n * 10n ** 12n, call: 100n * 10n ** 12n, swap: 200n * 10n ** 12n, max: 300n * 10n ** 12n };
export const ONE_YOCTO = 1n;

export const transfer = (deposit) => ({ type: 'Transfer', params: { deposit: String(deposit) } });

export const fnCall = (methodName, args, gas, deposit = 0n) => ({
  type: 'FunctionCall',
  params: { methodName, args, gas: String(gas), deposit: String(deposit) },
});

export const tx = (receiverId, actions) => ({ receiverId, actions });

export const addFunctionCallKey = (publicKey, receiverId, methodNames, allowanceYocto) => ({
  type: 'AddKey',
  params: {
    publicKey,
    accessKey: { permission: { receiverId, methodNames, allowance: allowanceYocto == null ? undefined : String(allowanceYocto) } },
  },
});

export const deleteKey = (publicKey) => ({ type: 'DeleteKey', params: { publicKey } });
