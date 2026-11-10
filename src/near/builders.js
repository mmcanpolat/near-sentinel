// Builders: each turns an intent into UNSIGNED NEAR transactions plus plain-language checks.
// Nothing here has a private key. The user's wallet signs.

import { fnCall, transfer, tx, GAS, ONE_YOCTO } from './actions.js';
import { rpc, view, tryView, viewAccount, storageReserve } from './rpc.js';
import { intentsTokens, INTENTS, WRAP, resolveFt, isNative, isRegistered, storageMin, ftBalance } from './tokens.js';
import { parseUnits, formatUnits, nearToYocto, yoctoToNear, validAccountId, isImplicit } from '../lib/units.js';

const bad = (m) => Object.assign(new Error(m), { user: true });
const out = (o) => ({ checks: [], warnings: [], trustedRecipients: [], ...o });

function needAccount(a) { if (!validAccountId(a)) throw bad('Connect a NEAR wallet first (no account is set).'); return a; }

function recipientId(to) {
  const r = String(to ?? '').trim().toLowerCase();
  if (/^0x[0-9a-f]{40}$/.test(r)) throw bad(`${to} is an Ethereum-style address, not a NEAR account. For cross-chain use the NEAR Intents swap.`);
  if (!validAccountId(r)) throw bad(`"${to}" is not a valid NEAR account id.`);
  return r;
}

async function balanceOfNear(account) {
  const a = await viewAccount(account);
  if (!a) throw bad(`Account ${account} does not exist on NEAR mainnet.`);
  return BigInt(a.amount) - storageReserve(a);
}

/** Registers `who` with a token when needed; returns the registration transaction or null. */
async function registrationTx(contract, who, o, label) {
  if (await isRegistered(contract, who)) { o.checks.push(`${who} is registered with ${label} (NEP-145).`); return null; }
  const min = await storageMin(contract);
  o.warnings.push(`${who} is not registered with ${label}; a first transaction pays a ${yoctoToNear(min)} NEAR storage deposit to register it.`);
  return tx(contract, [fnCall('storage_deposit', { account_id: who, registration_only: true }, GAS.storage, min)]);
}

// ---------------------------------------------------------------- transfers

export async function sendNear({ account, to, amount }) {
  needAccount(account);
  const rcpt = recipientId(to);
  const amt = nearToYocto(amount);
  if (amt <= 0n) throw bad('Amount must be above zero.');
  const o = out({ preview: { op: 'send_near', from: account, to: rcpt, amount: yoctoToNear(amt), token: 'NEAR' } });
  const bal = await balanceOfNear(account);
  if (bal < amt) throw bad(`You can spend ${yoctoToNear(bal)} NEAR, less than the ${yoctoToNear(amt)} you asked to send.`);
  if (!isImplicit(rcpt) && !(await viewAccount(rcpt))) throw bad(`${rcpt} does not exist on NEAR mainnet. Sending to a typo would lose the funds.`);
  o.transactions = [tx(rcpt, [transfer(amt)])];
  return o;
}

export async function sendToken({ account, token, to, amount }) {
  needAccount(account);
  if (isNative(token)) return sendNear({ account, to, amount });
  const rcpt = recipientId(to);
  const ft = await resolveFt(token);
  const amt = parseUnits(amount, ft.decimals);
  if (amt <= 0n) throw bad('Amount must be above zero.');
  const o = out({ preview: { op: 'send_token', from: account, to: rcpt, amount: formatUnits(amt, ft.decimals), token: ft.symbol, contract: ft.contract }, decimals: { [ft.contract]: ft.decimals }, symbols: { [ft.contract]: ft.symbol } });
  const bal = await ftBalance(ft.contract, account);
  if (bal < amt) throw bad(`You hold ${formatUnits(bal, ft.decimals)} ${ft.symbol}, less than the ${formatUnits(amt, ft.decimals)} you asked to send.`);
  o.checks.push(`Live balance: ${formatUnits(bal, ft.decimals)} ${ft.symbol}.`);
  if (!(await viewAccount(rcpt)) && !isImplicit(rcpt)) throw bad(`${rcpt} does not exist on NEAR mainnet.`);
  const reg = await registrationTx(ft.contract, rcpt, o, ft.symbol);
  o.transactions = [...(reg ? [reg] : []), tx(ft.contract, [fnCall('ft_transfer', { receiver_id: rcpt, amount: amt.toString() }, GAS.ft, ONE_YOCTO)])];
  return o;
}

export async function wrapNear({ account, amount, unwrap = false }) {
  needAccount(account);
  const amt = nearToYocto(amount);
  const o = out({ preview: { op: unwrap ? 'unwrap_near' : 'wrap_near', account, amount: yoctoToNear(amt) } });
  const txs = [];
  if (unwrap) {
    const bal = await ftBalance(WRAP, account);
    if (bal < amt) throw bad(`You hold ${yoctoToNear(bal)} wNEAR, less than ${yoctoToNear(amt)}.`);
    txs.push(tx(WRAP, [fnCall('near_withdraw', { amount: amt.toString() }, GAS.ft, ONE_YOCTO)]));
  } else {
    const bal = await balanceOfNear(account);
    if (bal < amt + nearToYocto('0.01')) throw bad(`You can spend ${yoctoToNear(bal)} NEAR; wrapping ${yoctoToNear(amt)} would leave nothing for gas.`);
    const reg = await registrationTx(WRAP, account, o, 'wNEAR');
    if (reg) txs.push(reg);
    txs.push(tx(WRAP, [fnCall('near_deposit', {}, GAS.ft, amt)]));
  }
  o.transactions = txs;
  return o;
}

// ---------------------------------------------------------------- staking

const POOLS = {
  metapool: { contract: 'meta-pool.near', label: 'Meta Pool (stNEAR)' },
  linear: { contract: 'linear-protocol.near', label: 'LiNEAR' },
};

export async function listValidators(limit = 8) {
  const r = await rpc('validators', [null]);
  const total = r.current_validators.reduce((s, v) => s + BigInt(v.stake), 0n);
  const top = [...r.current_validators].sort((a, b) => (BigInt(b.stake) > BigInt(a.stake) ? 1 : -1)).slice(0, Math.min(limit, 15));
  const rows = [];
  for (const v of top) {
    const fee = await tryView(v.account_id, 'get_reward_fee_fraction');
    const expected = v.num_expected_blocks + v.num_expected_chunks;
    const produced = v.num_produced_blocks + v.num_produced_chunks;
    rows.push({
      pool: v.account_id, stakeNear: yoctoToNear(v.stake, 0),
      sharePct: Number((BigInt(v.stake) * 10000n) / total) / 100,
      feePct: fee ? (fee.numerator / fee.denominator) * 100 : null,
      uptimePct: expected ? Math.round((produced / expected) * 10000) / 100 : null,
    });
  }
  return rows;
}

export async function stake({ account, protocol = 'pool', pool, amount, action = 'stake' }) {
  needAccount(account);
  const o = out({ preview: { op: `${protocol}_${action}`, account } });
  const amt = action === 'stake' || amount ? nearToYocto(amount ?? '0') : 0n;
  if (protocol === 'pool') {
    const p = recipientId(pool);
    const acc = await tryView(p, 'get_account', { account_id: account });
    if (!acc) throw bad(`${p} is not a staking pool (get_account failed).`);
    const vals = (await rpc('validators', [null])).current_validators.map((v) => v.account_id);
    if (!vals.includes(p)) throw bad(`${p} is not in the current validator set; staked funds would earn nothing.`);
    o.checks.push(`${p} is a staking pool in the current validator set.`);
    if (action === 'stake') {
      const bal = await balanceOfNear(account);
      if (bal < amt + nearToYocto('0.05')) throw bad(`You can spend ${yoctoToNear(bal)} NEAR; staking ${yoctoToNear(amt)} leaves too little for gas.`);
      o.transactions = [tx(p, [fnCall('deposit_and_stake', {}, GAS.max, amt)])];
    } else if (action === 'unstake') {
      const staked = BigInt(acc.staked_balance);
      if (!amount) o.transactions = [tx(p, [fnCall('unstake_all', {}, GAS.call, 0n)])];
      else if (amt > staked) throw bad(`Only ${yoctoToNear(staked)} NEAR is staked with ${p}.`);
      else o.transactions = [tx(p, [fnCall('unstake', { amount: amt.toString() }, GAS.call, 0n)])];
      o.warnings.push('Unstaked funds unlock after about 4 epochs (roughly 2 days); then withdraw them.');
    } else {
      if (!acc.can_withdraw) throw bad(`Nothing is withdrawable yet: ${yoctoToNear(BigInt(acc.unstaked_balance))} NEAR is still in the unlock period.`);
      o.transactions = [tx(p, [fnCall('withdraw_all', {}, GAS.call, 0n)])];
    }
    o.preview.pool = p;
    return o;
  }
  const lst = POOLS[protocol];
  if (!lst) throw bad(`Unknown staking protocol "${protocol}". Use pool, metapool or linear.`);
  if (!(await viewAccount(lst.contract))) throw bad(`${lst.contract} not found.`);
  o.checks.push(`${lst.label} contract ${lst.contract} is live.`);
  if (action === 'stake') {
    const bal = await balanceOfNear(account);
    if (bal < amt + nearToYocto('0.05')) throw bad(`You can spend ${yoctoToNear(bal)} NEAR; staking ${yoctoToNear(amt)} leaves too little for gas.`);
    o.transactions = [tx(lst.contract, [fnCall('deposit_and_stake', {}, GAS.max, amt)])];
    o.warnings.push(`You receive the liquid token (${protocol === 'linear' ? 'LiNEAR' : 'stNEAR'}), which keeps earning staking rewards.`);
  } else if (action === 'unstake') {
    if (protocol === 'linear') o.transactions = [tx(lst.contract, [fnCall(amount ? 'unstake' : 'unstake_all', amount ? { amount: amt.toString() } : {}, GAS.max, 0n)])];
    else o.transactions = [tx(lst.contract, [fnCall('unstake', { amount: amt.toString() }, GAS.max, 0n)])];
    o.warnings.push('Delayed unstake: funds unlock after several epochs, then use withdraw.');
  } else {
    o.transactions = [tx(lst.contract, [fnCall('withdraw_all', {}, GAS.max, 0n)])];
  }
  return o;
}

// ---------------------------------------------------------------- Ref swap (smart router + on-chain prediction)

const REF = 'v2.ref-finance.near';
export async function refSwap({ account, from, to, amount, slippagePct = 1 }) {
  needAccount(account);
  const native = isNative(from);
  const tin = native ? { contract: WRAP, symbol: 'wNEAR', decimals: 24 } : await resolveFt(from);
  const nativeOut = isNative(to);
  const tout = nativeOut ? { contract: WRAP, symbol: 'wNEAR', decimals: 24 } : await resolveFt(to);
  if (tin.contract === tout.contract) throw bad('Pick two different tokens.');
  const amt = parseUnits(amount, tin.decimals);
  const bps = Math.round(Number(slippagePct) * 100);
  if (!(bps > 0 && bps <= 5000)) throw bad('Slippage must be between 0.01% and 50%.');
  const o = out({ preview: { op: 'ref_swap', protocol: 'Ref Finance', account, from: native ? 'NEAR' : tin.symbol, to: nativeOut ? 'NEAR' : tout.symbol, amountIn: formatUnits(amt, tin.decimals) }, decimals: { [tin.contract]: tin.decimals }, symbols: { [tin.contract]: tin.symbol } });
  const bal = native ? await balanceOfNear(account) : await ftBalance(tin.contract, account);
  if (bal < amt) throw bad(`You can spend ${formatUnits(bal, tin.decimals)} ${tin.symbol}, less than ${formatUnits(amt, tin.decimals)}.`);
  const url = `https://smartrouter.ref.finance/findPath?amountIn=${amt}&tokenIn=${tin.contract}&tokenOut=${tout.contract}&pathDeep=3&slippage=${bps / 10000}`;
  const j = await (await fetch(url, { signal: AbortSignal.timeout(20000) })).json();
  const routes = j?.result_data?.routes;
  if (!routes?.length) throw bad('Ref Finance found no route for this pair.');
  // Build the action list and let Ref's own contract price it on live pool state.
  const actions = [];
  for (const r of routes) r.pools.forEach((p, i) => actions.push({ pool_id: Number(p.pool_id), token_in: p.token_in, token_out: p.token_out, ...(i === 0 ? { amount_in: p.amount_in } : {}), min_amount_out: '0' }));
  const pred = await view(REF, 'predict_swap_actions', { token_deposit: { [tin.contract]: amt.toString() }, actions }).catch((e) => { throw bad(`Ref could not price this route on chain (${e.message}). Nothing was built.`); });
  const predicted = BigInt(pred[tout.contract] ?? 0);
  if (predicted === 0n) throw bad("Ref's contract returned no output for this route. Nothing was built.");
  const minOut = (predicted * BigInt(10000 - bps)) / 10000n;
  const last = actions.length - 1;
  actions[last].min_amount_out = minOut.toString();
  o.checks.push(`Ref's contract priced the exact action list on live pool state (predict_swap_actions): ${formatUnits(predicted, tout.decimals)} ${tout.symbol}.`);
  o.warnings.push(`You receive at least ${formatUnits(minOut, tout.decimals)} ${nativeOut ? 'NEAR' : tout.symbol} or the swap reverts and the input is returned.`);
  o.preview.amountOut = formatUnits(predicted, tout.decimals);
  o.preview.minAmountOut = formatUnits(minOut, tout.decimals);
  o.decimals[tout.contract] = tout.decimals; o.symbols[tout.contract] = tout.symbol;
  const txs = [];
  if (!nativeOut) { const reg = await registrationTx(tout.contract, account, o, tout.symbol); if (reg) txs.push(reg); }
  const acts = [];
  if (native) {
    if (!(await isRegistered(WRAP, account))) acts.push(fnCall('storage_deposit', { account_id: account, registration_only: true }, GAS.storage, await storageMin(WRAP)));
    acts.push(fnCall('near_deposit', {}, GAS.ft, amt));
    o.warnings.push('NEAR is wrapped to wNEAR in the same transaction, then swapped.');
  }
  const msg = { actions, ...(nativeOut ? { skip_unwrap_near: false } : {}) };
  acts.push(fnCall('ft_transfer_call', { receiver_id: REF, amount: amt.toString(), msg: JSON.stringify(msg) }, actions.length > 2 ? GAS.max : GAS.swap, ONE_YOCTO));
  txs.push(tx(tin.contract, acts));
  o.transactions = txs;
  return o;
}

// ---------------------------------------------------------------- Burrow

const BURROW = 'contract.main.burrow.near';
export async function burrowSupply({ account, token, amount, collateral = false }) {
  needAccount(account);
  const ft = isNative(token) ? { contract: WRAP, symbol: 'wNEAR', decimals: 24 } : await resolveFt(token);
  const amt = parseUnits(amount, ft.decimals);
  const o = out({ preview: { op: 'burrow_supply', protocol: 'Burrow', account, token: ft.symbol, amount: formatUnits(amt, ft.decimals), collateral }, decimals: { [ft.contract]: ft.decimals }, symbols: { [ft.contract]: ft.symbol } });
  const assets = await view(BURROW, 'get_assets_paged', { from_index: 0, limit: 100 });
  const asset = assets.find(([id]) => id === ft.contract)?.[1];
  if (!asset) throw bad(`Burrow does not list ${ft.symbol}.`);
  if (!asset.config.can_deposit) throw bad(`Burrow has deposits for ${ft.symbol} switched off.`);
  if (collateral && !asset.config.can_use_as_collateral) throw bad(`${ft.symbol} cannot be used as collateral on Burrow.`);
  o.checks.push(`Burrow accepts ${ft.symbol} deposits${collateral ? ' and lets it serve as collateral' : ''}.`);
  const native = isNative(token);
  const bal = native ? await balanceOfNear(account) : await ftBalance(ft.contract, account);
  if (bal < amt) throw bad(`You can spend ${formatUnits(bal, ft.decimals)} ${ft.symbol}, less than ${formatUnits(amt, ft.decimals)}.`);
  const txs = [];
  if ((await tryView(BURROW, 'storage_balance_of', { account_id: account })) == null) {
    txs.push(tx(BURROW, [fnCall('storage_deposit', { account_id: account, registration_only: false }, GAS.storage, nearToYocto('0.25'))]));
    o.warnings.push('Your account is not registered on Burrow; a first transaction pays a 0.25 NEAR storage deposit (refundable part).');
  }
  const scale = 10n ** BigInt(24 - ft.decimals + (asset.config.extra_decimals ?? 0));
  const msg = collateral ? JSON.stringify({ Execute: { actions: [{ IncreaseCollateral: { token_id: ft.contract, max_amount: (amt * scale).toString() } }] } }) : '';
  const acts = [];
  if (native) {
    if (!(await isRegistered(WRAP, account))) acts.push(fnCall('storage_deposit', { account_id: account, registration_only: true }, GAS.storage, await storageMin(WRAP)));
    acts.push(fnCall('near_deposit', {}, GAS.ft, amt));
  }
  acts.push(fnCall('ft_transfer_call', { receiver_id: BURROW, amount: amt.toString(), msg }, GAS.max, ONE_YOCTO));
  txs.push(tx(ft.contract, acts));
  o.transactions = txs;
  return o;
}

// ---------------------------------------------------------------- NFTs and NEAR Social

export async function nftTransfer({ account, contract, tokenId, to }) {
  needAccount(account);
  const c = recipientId(contract), rcpt = recipientId(to);
  const tok = await tryView(c, 'nft_token', { token_id: String(tokenId) });
  if (!tok) throw bad(`Token ${tokenId} does not exist on ${c}.`);
  if (tok.owner_id !== account) throw bad(`Token ${tokenId} is owned by ${tok.owner_id}, not by ${account}.`);
  if (!(await viewAccount(rcpt))) throw bad(`${rcpt} does not exist on NEAR mainnet.`);
  return out({ preview: { op: 'nft_transfer', account, contract: c, tokenId: String(tokenId), to: rcpt }, checks: [`${account} owns token ${tokenId} (live nft_token).`, `${rcpt} exists.`], transactions: [tx(c, [fnCall('nft_transfer', { receiver_id: rcpt, token_id: String(tokenId) }, GAS.ft, ONE_YOCTO)])] });
}

export async function socialPost({ account, text }) {
  needAccount(account);
  const t = String(text ?? '').trim();
  if (!t || t.length > 2000) throw bad('Post text must be 1 to 2000 characters.');
  const data = { [account]: { post: { main: JSON.stringify({ type: 'md', text: t }) }, index: { post: JSON.stringify({ key: 'main', value: { type: 'md' } }) } } };
  const st = await tryView('social.near', 'get_account_storage', { account_id: account });
  const free = st ? BigInt(st.available_bytes ?? 0) : 0n;
  const need = BigInt(Buffer.byteLength(JSON.stringify(data)) + 200);
  const o = out({ preview: { op: 'social_post', account, text: t } });
  let deposit = 0n;
  if (free < need) { deposit = nearToYocto('0.01'); o.warnings.push('Your NEAR Social storage is empty, so 0.01 NEAR is attached to pay for storage (it stays yours as storage balance).'); }
  else o.checks.push(`NEAR Social storage already covers this post (${free} bytes available).`);
  o.transactions = [tx('social.near', [fnCall('set', { data }, GAS.call, deposit)])];
  return o;
}

// ---------------------------------------------------------------- NEAR Intents (1Click), cross-chain

function chainKey(c) {
  const k = String(c ?? '').toLowerCase().trim();
  return { ethereum: 'eth', arbitrum: 'arb', solana: 'sol', bitcoin: 'btc', polygon: 'pol', optimism: 'op', avalanche: 'avax', robinhood: 'hood' }[k] ?? k;
}
const EVM = new Set(['eth', 'base', 'arb', 'op', 'pol', 'bsc', 'avax', 'hood', 'gnosis', 'bera', 'aurora']);

export async function intentsChains() {
  const list = await intentsTokens();
  const m = new Map();
  for (const t of list) m.set(t.blockchain, (m.get(t.blockchain) ?? 0) + 1);
  return [...m].map(([chain, tokens]) => ({ chain, tokens }));
}

function pickDest(list, chain, sym) {
  const hits = list.filter((t) => t.blockchain === chain && t.symbol.toLowerCase() === String(sym).toLowerCase());
  if (!hits.length) throw bad(`NEAR Intents lists no "${sym}" on ${chain}. Try the chains tool to see what is supported.`);
  return hits[0];
}

async function quote(req) {
  const h = { 'content-type': 'application/json' };
  if (process.env.NEAR_INTENTS_JWT) h.authorization = `Bearer ${process.env.NEAR_INTENTS_JWT}`;
  const r = await fetch(`${INTENTS}/v0/quote`, { method: 'POST', headers: h, body: JSON.stringify(req), signal: AbortSignal.timeout(30000) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw bad(`NEAR Intents: ${j.message ?? 'the quote was refused'}`);
  return j;
}

/**
 * Sell a NEAR-side token and receive on any chain NEAR Intents serves.
 * `quoteOnly` asks for a dry quote: no deposit address is created and no transaction is built.
 */
export async function intentsSwap({ account, from, to, toChain = 'near', amount, recipient, slippagePct = 1, quoteOnly = false }) {
  needAccount(account);
  const list = await intentsTokens();
  const native = isNative(from);
  const ft = native ? { contract: WRAP, symbol: 'wNEAR', decimals: 24 } : await resolveFt(from);
  const origin = list.find((t) => t.blockchain === 'near' && t.contractAddress === (native ? WRAP : ft.contract));
  if (!origin) throw bad(`NEAR Intents does not list ${ft.contract} as a sell asset.`);
  const chain = chainKey(toChain);
  const dest = pickDest(list, chain, isNative(to) && chain === 'near' ? 'wNEAR' : to);
  // A dry quote needs a well-formed address but moves nothing, so a placeholder is fine for quote-only requests.
  const PLACEHOLDER = { sol: '11111111111111111111111111111111', btc: 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4' };
  const rcpt = recipient?.trim() || (chain === 'near' ? account : quoteOnly ? (EVM.has(chain) ? '0x00000000000000000000000000000000000dead1' : PLACEHOLDER[chain] ?? '') : '');
  if (!rcpt) throw bad(`Give the ${chain} address that should receive the tokens.`);
  if (EVM.has(chain) && !/^0x[0-9a-fA-F]{40}$/.test(rcpt)) throw bad(`"${rcpt}" is not a valid ${chain} address.`);
  if (chain === 'near' && !validAccountId(rcpt)) throw bad(`"${rcpt}" is not a valid NEAR account id.`);
  const amt = parseUnits(amount, ft.decimals);
  const bal = native ? await balanceOfNear(account) : await ftBalance(ft.contract, account);
  if (bal < amt) throw bad(`You can spend ${formatUnits(bal, ft.decimals)} ${ft.symbol}, less than ${formatUnits(amt, ft.decimals)}.`);
  const bps = Math.round(Number(slippagePct) * 100);
  if (!(bps > 0 && bps <= 5000)) throw bad('Slippage must be between 0.01% and 50%.');
  const q = await quote({
    dry: quoteOnly, swapType: 'EXACT_INPUT', slippageTolerance: bps, originAsset: origin.assetId, depositType: 'ORIGIN_CHAIN',
    destinationAsset: dest.assetId, amount: amt.toString(), refundTo: account, refundType: 'ORIGIN_CHAIN', recipient: rcpt,
    recipientType: 'DESTINATION_CHAIN', deadline: new Date(Date.now() + 3600e3).toISOString(),
  });
  const qq = q.quote ?? {};
  if (!qq.amountOut || qq.amountOut === '0') throw bad('NEAR Intents could not price that trade.');
  const o = out({
    preview: {
      op: 'intents_swap', protocol: 'NEAR Intents', account, from: native ? 'NEAR' : ft.symbol, amountIn: formatUnits(amt, ft.decimals),
      to: dest.symbol, toChain: chain, amountOut: formatUnits(qq.amountOut, dest.decimals), minAmountOut: formatUnits(qq.minAmountOut ?? '0', dest.decimals),
      recipient: rcpt, usdIn: qq.amountInUsd, usdOut: qq.amountOutUsd, etaSeconds: qq.timeEstimate,
    },
    decimals: { [ft.contract]: ft.decimals }, symbols: { [ft.contract]: ft.symbol },
  });
  o.checks.push('Live quote from NEAR Intents market makers.');
  if (quoteOnly && !recipient) o.warnings.push('Quote only: the recipient shown is a placeholder.');
  o.warnings.push(`You receive at least ${o.preview.minAmountOut} ${dest.symbol} on ${chain} at ${rcpt}. If the swap cannot complete, the input is refunded to ${account}.`);
  const usdIn = Number(qq.amountInUsd), usdOut = Number(qq.amountOutUsd);
  if (usdIn > 0 && usdOut > 0 && usdOut < usdIn * 0.97) o.warnings.push(`The quote values the output at $${usdOut.toFixed(2)} for $${usdIn.toFixed(2)} in: a price impact above 3%.`);
  if (quoteOnly) { o.transactions = []; o.note = 'Quote only: nothing was created and no deposit address exists yet.'; return o; }
  const dep = qq.depositAddress;
  if (!dep) throw bad('NEAR Intents returned no deposit address.');
  o.preview.depositAddress = dep;
  o.trustedRecipients = [dep];
  const txs = [];
  const acts = [];
  if (native) {
    if (!(await isRegistered(WRAP, account))) acts.push(fnCall('storage_deposit', { account_id: account, registration_only: true }, GAS.storage, await storageMin(WRAP)));
    acts.push(fnCall('near_deposit', {}, GAS.ft, amt));
  }
  if (!(await isRegistered(ft.contract, dep))) acts.push(fnCall('storage_deposit', { account_id: dep, registration_only: true }, GAS.storage, await storageMin(ft.contract)));
  acts.push(fnCall('ft_transfer', { receiver_id: dep, amount: amt.toString() }, GAS.ft, ONE_YOCTO));
  txs.push(tx(ft.contract, acts));
  o.transactions = txs;
  o.note = 'The funds go to a one-time deposit address created by this quote. Track it with the swap status tool.';
  return o;
}

/**
 * Agent earns across chains: build a payment request. A payer on another chain sends `fromToken` to a one-time
 * deposit address and the agent's NEAR account receives `toToken`. No NEAR transaction is needed (nothing to sign).
 */
export async function intentsReceive({ account, fromChain, fromToken, amount, toToken = 'USDC', refundAddress }) {
  needAccount(account);
  const list = await intentsTokens();
  const chain = chainKey(fromChain);
  const origin = pickDest(list, chain, fromToken);
  const dest = pickDest(list, 'near', toToken);
  if (!refundAddress) throw bad(`Give the payer's ${chain} refund address so a failed payment returns there.`);
  if (EVM.has(chain) && !/^0x[0-9a-fA-F]{40}$/.test(refundAddress)) throw bad(`"${refundAddress}" is not a valid ${chain} address.`);
  const amt = parseUnits(amount, origin.decimals);
  const q = await quote({
    dry: false, swapType: 'EXACT_INPUT', slippageTolerance: 100, originAsset: origin.assetId, depositType: 'ORIGIN_CHAIN',
    destinationAsset: dest.assetId, amount: amt.toString(), refundTo: refundAddress, refundType: 'ORIGIN_CHAIN', recipient: account,
    recipientType: 'DESTINATION_CHAIN', deadline: new Date(Date.now() + 3600e3).toISOString(),
  });
  const qq = q.quote ?? {};
  if (!qq.depositAddress) throw bad('NEAR Intents returned no deposit address.');
  const o = out({
    preview: { op: 'intents_receive', protocol: 'NEAR Intents', account, payerChain: chain, payerPays: `${formatUnits(amt, origin.decimals)} ${origin.symbol}`, agentReceives: `${formatUnits(qq.amountOut, dest.decimals)} ${dest.symbol} (at least ${formatUnits(qq.minAmountOut ?? '0', dest.decimals)})`, depositAddress: qq.depositAddress },
    transactions: [],
  });
  o.checks.push('Live quote from NEAR Intents market makers.');
  o.warnings.push(`The payer sends exactly ${o.preview.payerPays} on ${chain} to ${qq.depositAddress} within 1 hour. ${account} receives the NEAR-side token. No transaction on your side is needed.`);
  if (!(await isRegistered(dest.contractAddress, account))) o.warnings.push(`${account} is not registered with ${dest.symbol} on NEAR yet; register it first or the delivery is refunded.`);
  o.note = 'A payment request: the deposit address is only for the payer. Nothing is signed or sent by this app.';
  return o;
}

export async function intentsStatus(depositAddress) {
  const r = await fetch(`${INTENTS}/v0/status?depositAddress=${encodeURIComponent(depositAddress)}`, { headers: process.env.NEAR_INTENTS_JWT ? { authorization: `Bearer ${process.env.NEAR_INTENTS_JWT}` } : {}, signal: AbortSignal.timeout(20000) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw bad(`NEAR Intents: ${j.message ?? 'status unavailable'}`);
  return { status: j.status, updatedAt: j.updatedAt, swapDetails: j.swapDetails ? { amountOutFormatted: j.swapDetails.amountOutFormatted, destinationChainTxHashes: j.swapDetails.destinationChainTxHashes } : undefined };
}

// ---------------------------------------------------------------- reads

export async function balances(account) {
  needAccount(account);
  const a = await viewAccount(account);
  if (!a) return { account, exists: false };
  const r = await fetch(`https://api.fastnear.com/v1/account/${account}/ft`, { signal: AbortSignal.timeout(15000) });
  const j = r.ok ? await r.json() : { tokens: [] };
  const list = await intentsTokens();
  const toks = [];
  for (const t of (j.tokens ?? []).filter((x) => x.balance && x.balance !== '0').slice(0, 40)) {
    const li = list.find((x) => x.blockchain === 'near' && x.contractAddress === t.contract_id);
    if (!li) { toks.push({ contract: t.contract_id, listed: false, raw: t.balance }); continue; }
    const amount = formatUnits(t.balance, li.decimals);
    toks.push({ contract: t.contract_id, symbol: li.symbol, amount, usd: +(Number(amount) * li.price).toFixed(2), listed: true });
  }
  const near = BigInt(a.amount);
  return { account, exists: true, near: yoctoToNear(near), spendableNear: yoctoToNear(near - storageReserve(a)), tokens: toks.sort((x, y) => (y.usd ?? 0) - (x.usd ?? 0)), note: 'Tokens without a NEAR Intents listing are shown unpriced and may be spam.' };
}

export async function nfts(account) {
  needAccount(account);
  const r = await fetch(`https://api.fastnear.com/v1/account/${account}/nft`, { signal: AbortSignal.timeout(15000) });
  const j = r.ok ? await r.json() : { tokens: [] };
  return { account, collections: (j.tokens ?? []).slice(0, 30).map((t) => t.contract_id) };
}
