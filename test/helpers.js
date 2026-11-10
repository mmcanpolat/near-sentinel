import { transfer, fnCall, tx, addFunctionCallKey } from '../src/near/actions.js';
import { mergePolicy } from '../src/guard/policy.js';

export const NEAR = (n) => BigInt(Math.round(n * 1e6)) * 10n ** 18n;
export const sendNear = (to, n) => [tx(to, [transfer(NEAR(n))])];
export const ftSend = (token, to, amount) => [tx(token, [fnCall('ft_transfer', { receiver_id: to, amount: String(amount) }, 30n * 10n ** 12n, 1n)])];
export const policy = (over = {}) => mergePolicy(over);
export const levels = (r) => r.findings.map((f) => `${f.level}:${f.rule}`);
export const KEY = 'ed25519:6E8sCci9badyRkXb3JoRpBj5p8C6Tw41ELDZoiihKEtp';
export { tx, fnCall, transfer, addFunctionCallKey };
