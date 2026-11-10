// The agent's tool layer. READ tools return data; BUILD tools return a checked card.
// There is deliberately no tool that signs, sends, or edits the policy.

import * as b from '../near/builders.js';
import { generateAgentKey, listKeys, buildCreateAgentKey, buildRevokeAgentKey, checkKeyAllows } from '../guard/keys.js';
import { makeCard, cardForModel, getPolicy } from '../guard/pipeline.js';
import { entries } from '../guard/ledger.js';
import * as dao from '../near/sputnik.js';
import { accessKey } from '../near/rpc.js';
import { fnCall, tx } from '../near/actions.js';
import { yoctoToNear } from '../lib/units.js';
import { recordRefusal } from '../guard/audit.js';
import { chainSigAddresses, chainSigConfig, buildChainSigRequest } from '../near/chainsig.js';

const S = (description) => ({ type: 'string', description });
const obj = (properties, required = []) => ({ type: 'object', properties, required });

export const TOOLS = [
  // ---- reads
  { name: 'get_balances', description: 'NEAR and token balances of the connected account (priced from NEAR Intents; unlisted tokens flagged as possible spam).', parameters: obj({}), read: true, run: ({ account }) => b.balances(account) },
  { name: 'list_validators', description: 'Largest NEAR validators with stake share, fee and uptime, to choose a staking pool.', parameters: obj({ limit: { type: 'number' } }), read: true, run: ({ args }) => b.listValidators(args.limit ?? 8) },
  { name: 'get_nfts', description: 'NFT contracts the account holds tokens of.', parameters: obj({}), read: true, run: ({ account }) => b.nfts(account) },
  { name: 'intents_chains', description: 'Chains reachable through NEAR Intents (cross-chain swaps and payments).', parameters: obj({}), read: true, run: () => b.intentsChains() },
  { name: 'intents_status', description: 'Status of a NEAR Intents swap by its one-time deposit address.', parameters: obj({ depositAddress: S('deposit address from the swap card') }, ['depositAddress']), read: true, run: ({ args }) => b.intentsStatus(args.depositAddress) },
  { name: 'list_access_keys', description: 'All access keys on the account, classified full-access vs function-call, with warnings about loosely scoped keys.', parameters: obj({}), read: true, run: ({ account }) => listKeys(account) },
  { name: 'get_policy', description: 'The user\'s current safety policy (read-only; only the user can change it in the Policy panel) and spending in the last 24h.', parameters: obj({}), read: true,
    run: ({ account }) => ({ policy: getPolicy(account), spentLast24h: entries(account).filter((r) => Date.now() - r.ts < 864e5) }) },
  { name: 'agent_key_check', description: 'Check, against the live key on chain, whether the NEAR protocol would let a function-call key call a method. Nothing is sent.', read: true,
    parameters: obj({ publicKey: S('ed25519:... key on the account'), contract: S('target contract'), method: S('method name'), depositNear: S('attached NEAR, default 0'), gasTgas: { type: 'number' } }, ['publicKey', 'contract', 'method']),
    run: async ({ account, args }) => {
      const k = await accessKey(account, args.publicKey);
      if (!k) return { allowed: false, reasons: ['That key is not on the account.'] };
      const p = k.permission;
      const key = p === 'FullAccess' ? { type: 'full' } : { type: 'function_call', receiverId: p.FunctionCall.receiver_id, methodNames: p.FunctionCall.method_names, allowanceYocto: p.FunctionCall.allowance };
      if (key.type === 'full') return { allowed: true, reasons: ['This is a FULL-ACCESS key: the protocol would accept anything. Do not give it to an agent.'] };
      const dep = args.depositNear ? BigInt(Math.round(Number(args.depositNear) * 1e6)) * 10n ** 18n : 0n;
      const r = checkKeyAllows(key, [tx(args.contract, [fnCall(args.method, {}, BigInt(Math.round((args.gasTgas ?? 30) * 1e12)), dep)])]);
      return { ...r, key: { ...key, allowanceNear: key.allowanceYocto ? yoctoToNear(key.allowanceYocto) : null } };
    } },
  { name: 'dao_info', description: 'Sputnik DAO v2 overview: treasury balance, roles and who is in them, proposal bond, voting period.', parameters: obj({ dao: S('DAO account, e.g. ref-finance.sputnik-dao.near') }, ['dao']), read: true, run: ({ args }) => dao.sputnikInfo(args) },
  { name: 'dao_proposals', description: 'Newest proposals of a Sputnik DAO with status and vote tally. Optional status filter (InProgress, Approved, Rejected, Expired, Failed).', parameters: obj({ dao: S('DAO account'), status: S('optional status filter'), limit: { type: 'number' } }, ['dao']), read: true, run: ({ args }) => dao.sputnikProposals(args) },
  { name: 'chainsig_config', description: 'Live facts of the NEAR Chain Signatures (MPC) contract: version, signing domains with their curve, and the gas the contract needs. Read-only.', parameters: obj({}), read: true, run: async () => { const c = await chainSigConfig(); delete c.config; return c; } },
  { name: 'chainsig_addresses', description: 'The Ethereum/Base (EVM) and Bitcoin addresses that the connected NEAR account controls through NEAR Chain Signatures for a derivation path (for example ethereum-1). Computed from public keys by the MPC contract and re-verified locally; no key exists on this machine.', parameters: obj({ path: S('derivation path, default ethereum-1'), domainId: { type: 'number' } }), read: true, run: ({ account, args }) => chainSigAddresses({ account, path: args.path ?? 'ethereum-1', domainId: args.domainId }) },
  // ---- builds (return a card)
  { name: 'chainsig_prepare_request', description: 'Prepare (never send) a NEAR Chain Signatures request: ask the MPC network to sign a 32-byte payload hash with the key derived for the account and path, so the user can act on another chain. Goes through the same policy as every other action (allowed paths, daily cap, confirmation). The user approves in their wallet.', parameters: obj({ path: S('derivation path, e.g. ethereum-1'), payloadHex: S('32-byte hash to sign, 64 hex characters'), domainId: { type: 'number' } }, ['path', 'payloadHex']), build: ({ account, args }) => buildChainSigRequest({ account, ...args }) },
  { name: 'send_near', description: 'Prepare a native NEAR transfer.', parameters: obj({ to: S('NEAR account id'), amount: S('NEAR amount, e.g. "1.5"') }, ['to', 'amount']), build: ({ account, args }) => b.sendNear({ account, ...args }) },
  { name: 'send_token', description: 'Prepare a NEP-141 token transfer (registers the receiver when needed).', parameters: obj({ token: S('symbol or contract'), to: S('NEAR account id'), amount: S('human amount') }, ['token', 'to', 'amount']), build: ({ account, args }) => b.sendToken({ account, ...args }) },
  { name: 'wrap_near', description: 'Wrap NEAR into wNEAR, or unwrap.', parameters: obj({ amount: S('NEAR amount'), unwrap: { type: 'boolean' } }, ['amount']), build: ({ account, args }) => b.wrapNear({ account, ...args }) },
  { name: 'stake', description: 'Stake, unstake or withdraw. protocol: pool (a validator staking pool; give pool), metapool (stNEAR) or linear (LiNEAR).', parameters: obj({ protocol: { type: 'string', enum: ['pool', 'metapool', 'linear'] }, pool: S('validator pool account when protocol=pool'), amount: S('NEAR amount; omit to unstake everything'), action: { type: 'string', enum: ['stake', 'unstake', 'withdraw'] } }, ['protocol']), build: ({ account, args }) => b.stake({ account, ...args }) },
  { name: 'ref_swap', description: 'Swap tokens on Ref Finance on NEAR (route found by the Ref router, priced by Ref\'s contract on live pool state).', parameters: obj({ from: S('token to sell (NEAR or symbol/contract)'), to: S('token to buy'), amount: S('amount of `from`'), slippagePct: { type: 'number' } }, ['from', 'to', 'amount']), build: ({ account, args }) => b.refSwap({ account, ...args }) },
  { name: 'burrow_supply', description: 'Supply a token to Burrow lending, optionally as collateral.', parameters: obj({ token: S('symbol/contract or NEAR'), amount: S('human amount'), collateral: { type: 'boolean' } }, ['token', 'amount']), build: ({ account, args }) => b.burrowSupply({ account, ...args }) },
  { name: 'nft_transfer', description: 'Send an NFT (NEP-171) the account owns.', parameters: obj({ contract: S('NFT contract'), tokenId: S('token id'), to: S('receiver') }, ['contract', 'tokenId', 'to']), build: ({ account, args }) => b.nftTransfer({ account, ...args }) },
  { name: 'social_post', description: 'Publish a post on NEAR Social (social.near).', parameters: obj({ text: S('post text, markdown') }, ['text']), build: ({ account, args }) => b.socialPost({ account, ...args }) },
  { name: 'intents_swap', description: 'Cross-chain swap through NEAR Intents: sell a NEAR-side token, receive on NEAR or another chain. quoteOnly=true prices without creating a deposit address.',
    parameters: obj({ from: S('token to sell on NEAR (NEAR, USDC, ...)'), to: S('token symbol to receive'), toChain: S('near, eth, base, arb, sol, btc, ...'), amount: S('amount of `from`'), recipient: S('receiving address on toChain'), quoteOnly: { type: 'boolean' }, slippagePct: { type: 'number' } }, ['from', 'to', 'amount']), build: ({ account, args }) => b.intentsSwap({ account, ...args }) },
  { name: 'intents_receive', description: 'Agent earns across chains: create a payment request. A payer on another chain pays a one-time deposit address and the account receives a NEAR-side token. Nothing to sign.',
    parameters: obj({ fromChain: S('payer\'s chain'), fromToken: S('payer\'s token symbol'), amount: S('amount the payer sends'), toToken: S('NEAR-side token to receive, default USDC'), refundAddress: S('payer\'s address on fromChain, for refunds') }, ['fromChain', 'fromToken', 'amount', 'refundAddress']), build: ({ account, args }) => b.intentsReceive({ account, ...args }) },
  { name: 'dao_propose', description: 'Create a Sputnik DAO proposal (the user signs; attaches the DAO\'s proposal bond). type: transfer (receiver, amount, token), poll (description is the question), add_member / remove_member (member, role), function_call (contract, method, args). Governance changes are not available.',
    parameters: obj({ dao: S('DAO account'), type: { type: 'string', enum: ['transfer', 'poll', 'add_member', 'remove_member', 'function_call'] }, description: S('public proposal text'), receiver: S('transfer receiver'), amount: S('transfer amount, human units'), token: S('NEAR (default) or token symbol/contract'), member: S('account for add/remove member'), role: S('DAO role name'), contract: S('function_call target'), method: S('function_call method'), args: { type: 'object' }, depositNear: S('NEAR the DAO attaches, default 0') }, ['dao', 'type']),
    build: ({ account, args }) => dao.sputnikPropose({ account, ...args }) },
  { name: 'dao_vote', description: 'Vote on a Sputnik DAO proposal, or finalize an expired one. action: approve | reject | remove | finalize. The user signs.',
    parameters: obj({ dao: S('DAO account'), id: { type: 'number', description: 'proposal number' }, action: { type: 'string', enum: ['approve', 'reject', 'remove', 'finalize'] } }, ['dao', 'id', 'action']),
    build: ({ account, args }) => dao.sputnikVote({ account, ...args }) },
  { name: 'agent_key_create', description: 'Give the agent a restricted function-call access key bound to ONE contract, with a method list and a gas allowance. Generates the agent\'s keypair locally if no publicKey is given; the private key never leaves the agent runtime. The user signs the AddKey.',
    parameters: obj({ contract: S('the one contract the key may call'), methods: { type: 'array', items: { type: 'string' } }, allowanceNear: S('gas budget in NEAR, e.g. "0.1"'), publicKey: S('existing agent public key; omit to generate') }, ['contract', 'methods']),
    build: async ({ account, args }) => buildCreateAgentKey({ account, ...args, publicKey: args.publicKey ?? generateAgentKey().publicKey }) },
  { name: 'agent_key_revoke', description: 'Revoke an access key (DeleteKey). Refuses to delete the only full-access key.', parameters: obj({ publicKey: S('key to revoke') }, ['publicKey']), build: ({ account, args }) => buildRevokeAgentKey({ account, ...args }) },
];

export const toolSpecs = () => TOOLS.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));

/** Runs one tool. Returns { toModel, card? }. Errors become plain-language results, never stack traces. */
export async function runTool(name, args, account) {
  const t = TOOLS.find((x) => x.name === name);
  if (!t) return { toModel: { error: `Unknown tool ${name}` } };
  try {
    if (t.read) return { toModel: await t.run({ account, args: args ?? {} }) };
    const built = await t.build({ account, args: args ?? {} });
    const card = await makeCard(account, built, { tool: name });
    return { toModel: cardForModel(card), card };
  } catch (e) {
    const msg = e.user || e.name === 'NearError' || /NEAR Intents|Ref |not a valid|more than \d+ decimal/i.test(e.message) ? e.message : `Could not complete that: ${String(e.message).slice(0, 160)}`;
    if (!t.read) { try { recordRefusal(account, name, args, msg); } catch { /* the audit trail must never break the answer */ } }
    return { toModel: { error: msg }, error: msg };
  }
}
