// Offline mode (no LLM key): a small deterministic command parser that calls the SAME tools and the SAME
// guard pipeline. It exists so a reviewer can run every demo prompt without any API key.
// It understands the demo phrasings in README / DEMO.md; the LLM understands anything.

import { runTool } from './tools.js';

const CHAINS = 'eth|ethereum|base|arb|arbitrum|sol|solana|btc|bitcoin|op|optimism|pol|polygon|bsc|avax|hood|robinhood';
const ADDR = '(0x[0-9a-fA-F]{40}|[a-z0-9._-]+\\.(?:near|tg)|[0-9a-f]{64})';
const KEY = '(ed25519:[1-9A-HJ-NP-Za-km-z]{43,44})';

const DAO = '([a-z0-9._-]+\\.sputnik-dao\\.near)';
const rules = [
  // NEAR Chain Signatures (matched first: "sign" and "addresses" are generic words)
  [/\bsign\b.*?\b(?:payload|hash)\s+(?:0x)?([0-9a-fA-F]{64})\b(?:.*?\bpath\s+([\w.:/#-]+))?(?:.*?\bdomain\s+(\d+))?/i, (m) => ['chainsig_prepare_request', { payloadHex: m[1], path: m[2] ?? 'ethereum-1', ...(m[3] != null ? { domainId: Number(m[3]) } : {}) }]],
  [/\b(?:chain signatures?|mpc)\b.*\b(?:config|status|domains?)\b|\b(?:config|status|domains?)\b.*\b(?:chain signatures?|mpc)\b/i, () => ['chainsig_config', {}]],
  [/^\s*(?:show|derive|get|list|what(?:'s| is| are)|my)\b.*\b(?:addresses|address)\b(?:.*?\b(?:path|for)\s+((?:ethereum|base|bitcoin|[a-z]+)-[\w.:/#-]+))?\s*$/i, (m) => ['chainsig_addresses', { path: m[1] ?? 'ethereum-1' }]],
  // Sputnik DAO (matched first: proposal text may contain words that other rules key on)
  [new RegExp(`\\bpropose\\b.*?\\bpoll\\b\\s+["“]?(.+?)["”]?\\s+(?:on|in|at)\\s+${DAO}\\s*$`, 'i'), (m) => ['dao_propose', { dao: m[2], type: 'poll', description: m[1] }]],
  [new RegExp(`\\bpropose\\b.*?\\btransfer\\s+([\\d.]+)\\s*(\\w+)\\s+to\\s+([^\\s]+)\\s+(?:on|in|from|at)\\s+${DAO}(?:\\s+(?:for|because|desc(?:ription)?:?)\\s+["“]?(.+?)["”]?)?\\s*$`, 'i'), (m) => ['dao_propose', { dao: m[4], type: 'transfer', amount: m[1], token: m[2], receiver: m[3], description: m[5] ?? `Transfer ${m[1]} ${m[2]} to ${m[3]}` }]],
  [new RegExp(`\\bpropose\\b.*?\\b(add|remove)\\s+([^\\s]+)\\s+(?:to|from)\\s+(?:role\\s+)?(\\w+)\\s+(?:on|in|at)\\s+${DAO}\\s*$`, 'i'), (m) => ['dao_propose', { dao: m[4], type: `${m[1].toLowerCase()}_member`, member: m[2], role: m[3], description: `${m[1][0].toUpperCase()}${m[1].slice(1).toLowerCase()} ${m[2]} ${m[1].toLowerCase() === 'add' ? 'to' : 'from'} ${m[3]}` }]],
  [new RegExp(`\\b(?:vote\\s+)?(approve|reject|remove|finalize)\\b.*?\\bproposal\\s+#?(\\d+)\\s+(?:on|in|of|at)\\s+${DAO}`, 'i'), (m) => ['dao_vote', { dao: m[3], id: Number(m[2]), action: m[1] }]],
  [new RegExp(`\\bproposals?\\b.*?\\b(?:of|on|in|for)\\s+${DAO}(?:\\s+(in progress|approved|rejected|expired|failed))?`, 'i'), (m) => ['dao_proposals', { dao: m[1], status: m[2] }]],
  [new RegExp(`\\b(?:dao|info)\\b.*?${DAO}`, 'i'), (m) => ['dao_info', { dao: m[1] }]],
  [/\b(balance|what do i (have|hold)|holdings|portfolio)\b/i, () => ['get_balances', {}]],
  [/\bvalidators?\b/i, () => ['list_validators', {}]],
  [/\b(chains|supported chains)\b/i, () => ['intents_chains', {}]],
  [/\b(my )?(access )?keys\b.*\b(list|show)\b|\b(list|show)\b.*\bkeys\b/i, () => ['list_access_keys', {}]],
  [/\b(policy|limits)\b.*\b(show|what|current)\b|\b(show|what|current)\b.*\b(policy|limits)\b/i, () => ['get_policy', {}]],
  [new RegExp(`\\b(revoke|remove|delete)\\b.*${KEY}`, 'i'), (m) => ['agent_key_revoke', { publicKey: m[2] }]],
  [new RegExp(`\\bcheck\\b.*${KEY}.*\\b(call|run)\\s+(\\w+)\\s+on\\s+([a-z0-9._-]+)`, 'i'), (m) => ['agent_key_check', { publicKey: m[1], method: m[3], contract: m[4] }]],
  [/\b(?:create|give|add|make)\b.*\bagent\b.*\bkey\b.*?\b(?:for|on|to)\s+([a-z0-9._-]+\.near)\b(.*)$/i, (m) => {
    const allowance = /allowance\s+([\d.]+)/i.exec(m[2])?.[1];
    const methods = /methods?\s+([\w, ]+?)(?=\s+(?:with|and)?\s*allowance|$)/i.exec(m[2])?.[1] ?? '';
    return ['agent_key_create', { contract: m[1], methods: methods.split(/[ ,]+/).filter(Boolean), allowanceNear: allowance ?? '0.1' }];
  }],
  [/\b(?:post|tweet|publish)\b\s+(?:on near social\s*:?\s*)?["“]?(.+?)["”]?\s*$/i, (m) => ['social_post', { text: m[1] }]],
  [/\bunwrap\s+([\d.]+)/i, (m) => ['wrap_near', { amount: m[1], unwrap: true }]],
  [/\bwrap\s+([\d.]+)/i, (m) => ['wrap_near', { amount: m[1] }]],
  [/\bstake\s+([\d.]+)\s*(?:near)?\s*(?:with|in|on|to|using)?\s*(meta ?pool|linear|[a-z0-9._-]+\.poolv1\.near|[a-z0-9._-]+\.pool\.near)/i, (m) => {
    const w = m[2].toLowerCase().replace(' ', '');
    return ['stake', w === 'metapool' ? { protocol: 'metapool', amount: m[1] } : w === 'linear' ? { protocol: 'linear', amount: m[1] } : { protocol: 'pool', pool: w, amount: m[1] }];
  }],
  [new RegExp(`\\b(?:quote|price)\\b.*?([\\d.]+)\\s*(\\w+)\\s+(?:to|for|into)\\s+(\\w+)\\s+on\\s+(${CHAINS})\\b`, 'i'), (m) => ['intents_swap', { from: m[2], to: m[3], toChain: m[4], amount: m[1], quoteOnly: true }]],
  [new RegExp(`\\b(?:swap|bridge|send)\\s+([\\d.]+)\\s*(\\w+)\\s+(?:to|for|into)\\s+(\\w+)\\s+on\\s+(${CHAINS})\\b(?:.*?\\bto\\s+${ADDR})?`, 'i'), (m) => ['intents_swap', { from: m[2], to: m[3], toChain: m[4], amount: m[1], recipient: m[5] }]],
  [/\bswap\s+([\d.]+)\s*(\w+)\s+(?:to|for|into)\s+(\w+)/i, (m) => ['ref_swap', { from: m[2], to: m[3], amount: m[1] }]],
  [new RegExp(`\\b(?:request|invoice|charge)\\b.*?([\\d.]+)\\s*(\\w+)\\s+on\\s+(${CHAINS})\\b.*?refund\\s+(?:to\\s+)?${ADDR}`, 'i'), (m) => ['intents_receive', { amount: m[1], fromToken: m[2], fromChain: m[3], refundAddress: m[4], ...(/\bas\s+(\w+)/i.exec(m[0]) ? { toToken: /\bas\s+(\w+)/i.exec(m[0])[1] } : {}) }]],
  [/\bsupply\s+([\d.]+)\s*(\w+)\s+(?:to|on|in)\s+burrow(\s+as collateral)?/i, (m) => ['burrow_supply', { amount: m[1], token: m[2], collateral: !!m[3] }]],
  [/\bsend\s+([\d.]+)\s*near\s+to\s+([^\s]+)/i, (m) => ['send_near', { amount: m[1], to: m[2] }]],
  [/\bsend\s+([\d.]+)\s*(\w+)\s+to\s+([^\s]+)/i, (m) => ['send_token', { amount: m[1], token: m[2], to: m[3] }]],
];

export const HELP = `I am running without an LLM key, so I only understand these phrasings (add LLM_API_KEY to .env for free-form chat; LLM_PROVIDER=near-ai uses NEAR AI Cloud):
- balance | validators | chains | list keys | show policy
- send 1 NEAR to alice.near | send 5 USDC to alice.near
- wrap 2 NEAR | stake 3 NEAR with metapool | swap 1 NEAR to USDC
- swap 1 NEAR to USDC on base to 0x... | quote 1 NEAR to USDC on eth
- request 0.01 ETH on base refund 0x...   (optionally: ... as wNEAR)
- create agent key for wrap.near methods near_deposit allowance 0.1
- revoke key ed25519:...  |  post hello NEAR
- Chain Signatures: derive addresses (for ethereum-1) | chain signatures config | sign payload 0x<64 hex> path ethereum-1
- Sputnik DAO: dao ref-finance.sputnik-dao.near | proposals of ref-finance.sputnik-dao.near
  propose transfer 1 NEAR to alice.near on x.sputnik-dao.near for Grant | propose poll Ship it? on x.sputnik-dao.near
  propose add bob.near to role council on x.sputnik-dao.near | approve proposal 12 on x.sputnik-dao.near | finalize proposal 12 on x.sputnik-dao.near`;

export async function chatOffline(messages, account) {
  const text = String(messages.at(-1)?.content ?? '').trim();
  for (const [re, fn] of rules) {
    const m = re.exec(text);
    if (!m) continue;
    const [tool, args] = fn(m);
    const res = await runTool(tool, args, account);
    if (res.error) return { reply: res.error, cards: [] };
    if (res.card) {
      const c = res.card;
      const verdict = c.canSign ? (c.needsConfirm ? 'The policy asks you to confirm before signing.' : 'It is within your policy; you still sign in your wallet.') : c.transactions.length ? 'The policy or a pre-check BLOCKS this, so it cannot be signed.' : 'Nothing to sign.';
      return { reply: `${c.explain.flat().join('; ') || c.note || 'Prepared.'} ${verdict}`.trim(), cards: [c] };
    }
    return { reply: '```json\n' + JSON.stringify(res.toModel, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2).slice(0, 3500) + '\n```', cards: [] };
  }
  return { reply: HELP, cards: [] };
}
