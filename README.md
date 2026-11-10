# NEAR Sentinel

**A guarded AI agent for NEAR.** You talk to it in plain words; it turns the request into a NEAR transaction, reads the live chain to check it, judges it against *your* safety policy, explains it in plain language, and hands it to *your* wallet. The agent never holds a full-access key and never signs.

Built for NEAR HACKATHON (November 2026). Tracks: Unstoppable DeFi, Agent Economy, Open Innovation, AI Security & Defense.

Zero npm dependencies. Node 22+ only. One command to run.

## The problem

AI agents that move money have two bad options today: hold a key (one prompt injection empties the wallet) or ask the user to sign blindly (the user cannot tell what a hex blob does). NEAR has unusually good primitives for a third way, function-call access keys and NEAR Intents, but nothing ties them together into a safe agent workflow.

## What it does

1. **Policy engine** (`src/guard/policy.js`, pure and unit-tested): per-token per-transaction and rolling 24h spend limits, contract and method allowlists, recipient allowlist, confirmation thresholds, gas ceiling, and hard rules that no configuration can lift (no full-access keys, no contract deploys, no account deletion, unknown actions refused). Verdict: ALLOW / CONFIRM / DENY. A denied card cannot be signed.
2. **Function-call key sandbox** (`src/guard/keys.js`): the agent gets a key bound to one contract, a method list and a gas allowance, and the NEAR protocol itself forbids that key from attaching a deposit. Create and revoke flows are built as unsigned `AddKey` / `DeleteKey` transactions for you to sign. The agent's keypair is generated locally; the private half is never returned by any API. Revoke refuses to delete your only full-access key. `agent_key_check` asks the live chain whether a given key could call a method.
3. **Live pre-checks + plain-words explanation** (`src/guard/precheck.js`, `explain.js`): every transaction is read against current chain state (account and contract exist, live token balance via `ft_balance_of`, NEP-145 registration, spendable balance after the storage reserve at the live gas price, key exists or not, Ref's `predict_swap_actions` on live pool state). The explanation is derived from the transaction's actions, not from what the builder claims. NEAR has no whole-transaction dry run, so the app says what it checked and never claims "simulated".
4. **Spend ledger that only trusts the chain** (`src/guard/ledger.js`): after the wallet returns a hash, the server re-reads the transaction, checks signer/receiver/action count match the built card, rejects failures in any receipt, and only then counts the spend. A signature is not a success.
5. **NEAR Intents cross-chain** (`src/near/builders.js`): `intents_swap` sells a NEAR-side token and delivers on Ethereum, Base, Arbitrum, Solana, Bitcoin, Robinhood Chain and the other chains NEAR Intents serves (1Click API; the refund address is your NEAR account). `intents_receive` is for the **agent economy**: it creates a payment request, so a payer on another chain pays a one-time deposit address and the agent's NEAR account receives a NEAR token. The one-time deposit address is accepted by the policy only because a trusted builder produced it.
6. **NEAR actions**: send NEAR / NEP-141 tokens, wrap/unwrap, validator staking pools (with fee, uptime and stake share comparison), Meta Pool (stNEAR), LiNEAR, Ref Finance swaps (Ref router, priced by Ref's contract), Burrow lending supply, NEP-171 NFT transfer, NEAR Social posts, balances and NFT reads.
7. **LLM tool layer** (`src/agent/`): OpenAI-compatible tool-calling loop (OpenAI, NEAR AI Cloud, OpenRouter, Ollama, anything speaking `/chat/completions`). Tools are read-only data plus builders that return checked cards. There is **no tool that signs, broadcasts, or edits the policy**; this is asserted in a test. Without a key, an offline command parser calls the same tools and guard pipeline, so everything below is reproducible with no API key.

## Architecture

```
 Browser (public/)                          Node server (src/server.js, no deps)
 +--------------------------+  /api/chat   +---------------------------------------------+
 | chat + cards + policy UI |------------->|  agent/llm.js  (OpenAI-compatible loop)     |
 |                          |              |  agent/offline.js (no-key command parser)   |
 | near-connect wallet      |              |        |                                    |
 | (sandboxed iframe)       |              |        v tool calls (agent/tools.js)        |
 |   signs + sends  <-------|--- card ---- |  near/builders.js   unsigned txs + live reads|
 +-----------+--------------+              |        |                                    |
             | hash                        |        v                                    |
             v  /api/settle                |  guard/pipeline.js                          |
 NEAR mainnet <-- verifies outcome --------|    precheck.js  <--- NEAR JSON-RPC (public) |
                                           |    policy.js    (pure engine, tested)       |
                                           |    explain.js   (plain words)               |
                                           |    keys.js      (function-call key sandbox) |
                                           |    ledger.js    (counts only settled spend) |
                                           +---------------------+-----------------------+
                                                                 |
                                       NEAR Intents 1Click API, Ref router, FastNEAR API
```

Trust boundaries: the LLM sees only tool results; the wallet is the only signer; policy is edited only from the UI (`PUT /api/policy`), never by a tool.

## Track mapping

| Track | Requirement | Where |
|---|---|---|
| AI Security & Defense | Spending limits | `policy.js` limits, daily rolling cap, ledger |
| | Policy engines | `policy.js`, 31 unit tests in `test/policy.test.js` |
| | Function-call keys / sandboxed wallets | `keys.js`, `agent_key_create/revoke/check` |
| | Pre-sign checks, no blind signing | `precheck.js`, `explain.js`, cards |
| Agent Economy | Agent earns and pays across chains | `intents_receive`, `intents_swap` |
| | Agent acts autonomously within limits | function-call key + `agent_key_check` |
| Unstoppable DeFi | Non-custodial DeFi | Ref swap, Burrow, Meta Pool, LiNEAR, pools, Intents; user signs |
| Open Innovation | Novel UX | chat + live-verified cards + policy panel |

TEE attestation (suggested in the AI Security track) is not implemented; see "Not done".

## Setup

Requires Node 22+ (no `npm install` needed) or Docker.

```bash
cp .env.example .env     # optional: add LLM_API_KEY for free-form chat
make run                 # http://localhost:3000
# or
docker compose up --build
```

Tests:

```bash
make test        # 38 offline unit tests (policy engine, key sandbox, units, analysis)
make test-live   # + live read-only checks against public NEAR mainnet RPC and NEAR Intents quotes
```

No wallet? Use "Preview as any public account" under the chat box (for example `near` or `root.near`): all building, live checks and policy verdicts work; only signing needs a wallet.

## Demo script (paste these; works with no LLM key)

Preview as `near` (or connect your own wallet). Each step shows what to look for.

1. `show policy` - the default policy, read-only for the agent.
2. `balance` - live balances, unlisted tokens flagged.
3. `send 0.5 NEAR to root.near` - card is **Within policy**, with live checks (account exists, spendable balance, gas fee).
4. `send 2 NEAR to root.near` - **Needs your confirmation** (above the 1 NEAR threshold); sign button requires a tick.
5. `send 50 NEAR to root.near` - **Blocked** (per-transaction and daily cap). "Cannot be signed".
6. `send 1 NEAR to nonexistentaccount99887.near` - refused: the account does not exist (typo protection).
7. `swap 1 NEAR to USDC` - Ref route, the card cites Ref's on-chain `predict_swap_actions` and a minimum received.
8. `quote 1 NEAR to USDC on base` - NEAR Intents cross-chain quote, no deposit address created.
9. `swap 1 NEAR to USDC on base to 0x00000000000000000000000000000000000dead1` - real 1Click quote; the card is a transaction to a one-time deposit address; the policy accepts that address only because the builder produced it.
10. `request 0.01 ETH on base refund 0x00000000000000000000000000000000000dead1` - agent-economy payment request: a payer on Base pays the deposit address, the agent's NEAR account receives USDC.
11. `create agent key for wrap.near methods near_deposit allowance 0.05` - sandbox key: card says it cannot move funds. Change the policy panel's key cap to `0.01`, rerun: **Blocked**.
12. `create agent key for wrap.near allowance 0.05` - **Blocked**: a key with no method list is refused.
13. `stake 1 NEAR with metapool`, `validators` - staking and validator comparison.
14. Policy panel: set "Recipients" to "only the list below", then rerun step 3: **Blocked** (recipient not allowed).

Wallet flow (needs a real wallet, nothing here was signed during development): connect, run step 3 with a small amount to an account you own, tick, sign; the card reports "Confirmed on chain" only after the server verified the outcome, and the Activity tab shows the counted spend.

## Verified vs not verified

Verified (2026-11-10, against NEAR mainnet via public RPC; nothing was signed or sent):

- 38 offline tests pass; 40 pass with `LIVE=1` (the live ones run the HTTP server and exercise build, pre-check, policy, quotes).
- Live builders produced well-formed transactions for: NEAR and token sends, wrap, validator-pool / Meta Pool staking, Ref swaps (Ref's contract priced the exact route), Burrow supply, NEAR Social posts, Intents quote, Intents live quote with deposit address, and Intents payment request. Pre-checks returned no failures for valid cases and refused nonexistent receivers, 0x addresses and over-balance amounts.
- The web UI loads, previews an account, renders a blocked card with a disabled sign button, and shows the policy; no console errors from the app.
- Policy engine edge cases (rolling window, batches, allowlists, hard rules, decimals, wNEAR counted as NEAR, storage-deposit abuse) are covered by tests.

Not verified:

- **No transaction was signed or broadcast by this project**, so the wallet signing path (`@hot-labs/near-connect` loaded from jsDelivr, `signAndSendTransactions`, `/api/settle`) is written against the library's documented API but not exercised end to end here. The same wallet service pattern was used in the author's earlier app, but that is not evidence for this code.
- Function-call key create/revoke are built and pre-checked, but the resulting `AddKey` / `DeleteKey` were not submitted. `checkKeyAllows` mirrors NEAR's documented runtime rules (one action, same receiver, listed method, zero deposit, allowance) rather than being tested against a live key.
- Burrow supply, Meta Pool and LiNEAR unstake/withdraw, NFT transfer and the Social post `set` call shapes were not executed. Deposit-address payment through NEAR Intents was not completed (that needs real funds), so the swap `status` tool was not run on a settled swap.
- The LLM loop was not run against a live provider in this environment (no key). It follows the standard chat-completions tool protocol. Treat `LLM_BASE_URL` values for providers other than OpenAI as untested.
- `docker compose up` was written but Docker was not running here, so the image was not built. `make run` is the verified path.
- Public NEAR RPC endpoints rate-limit; the client fails over and caches for 4 seconds, but a busy judge machine may still see "RPC unavailable". Set `NEAR_RPC_URL` to your own endpoint.

## Not done / honest limits

- Mainnet only. No testnet switch.
- Prices and slippage come from third parties (Ref router, NEAR Intents); the app shows minimums but cannot guarantee execution.
- No TEE attestation, no Chain Signatures, no autonomous signing loop: the function-call key is created and *checked*, but this repo does not run an agent process that signs with it (by design for this submission: "never sign").
- The server has no login and is meant to run locally; it binds to 127.0.0.1. Anyone who can reach it can edit the policy. Do not expose it.
- Not audited.

## Security notes

- No secrets in the repo. `.env`, `data/` (policy, ledger, generated agent keys) are git-ignored; key files are written with mode 0600.
- Tool outputs are untrusted data in the system prompt; the agent cannot change policy; the agent has no signing tool.
- Policy denies by default for unknown contracts; a huge "storage deposit" is counted as a spend.

## License

MIT, see LICENSE. All code in this repository was written between 1 and 10 November 2026 for this hackathon; it uses public NEAR RPC, the NEAR Intents 1Click API, the Ref router and FastNEAR's public API, and loads `@hot-labs/near-connect` from jsDelivr at runtime.
