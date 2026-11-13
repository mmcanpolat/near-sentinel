# Demo kit (for the maintainer to post; nothing here is posted automatically)

Everything below runs with `npm start`, no key and no wallet; the page previews the public account `near`. Rehearse once with `npm run selftest` (offline) so you know it is green. Public NEAR RPCs rate-limit: wait a second between commands if a card says "RPC unavailable".

## 90-second video script

- 0:00 Title card: "NEAR Sentinel: an AI agent that cannot rob you."
- 0:07 Show the app (previewing `near`). "The agent holds no key and has no signing tool. It proposes, my policy checks, I sign."
- 0:13 Type `send 0.5 NEAR to root.near`. Point at the green "Within policy" pill and the "Checked against the chain just now" list.
- 0:25 Type `send 50 NEAR to root.near`. Red "Blocked", sign button disabled. "Per-transaction and daily caps are enforced before my wallet ever opens."
- 0:35 Type `send 1 NEAR to nonexistentaccount99887.near`. "Typo protection from live chain state."
- 0:43 Open the Cross-chain tab (or type `derive addresses for ethereum-1`). "The same NEAR account controls an Ethereum and a Bitcoin address through Chain Signatures. No key lives here." Then type `sign payload 0x<64 hex> path ethereum-1`: an unsigned `v1.signer.sign` call, and the policy asks for a tick.
- 0:55 Type `create agent key for wrap.near methods near_deposit allowance 0.05`. "For autonomy the agent gets a NEAR function-call key: one contract, listed methods, a gas budget, and the protocol forbids deposits. I revoke it any time."
- 1:05 Type `quote 1 NEAR to USDC on base`. "Cross-chain through NEAR Intents: the agent can pay and get paid on other chains." (needs network; quote only)
- 1:12 Open the Policy panel, set recipients to the allowlist. "Only I can edit this. The agent has no tool for it."
- 1:16 Switch the preview box to `refchef.near`, type `propose poll Should we fund a hackathon? on ref-finance.sputnik-dao.near`. "Same guard for DAOs: it read the DAO's live roles and bond first."
- 1:22 Open Activity: the agent safety report with every verdict; Download JSON.
- 1:27 End card: repo link, "Built at NEAR HACKATHON". Do not claim a wallet signing demo unless you actually record one.

## X post draft

```
Built NEAR Sentinel at NEAR HACKATHON: an AI agent for @NEARProtocol that can't rob you.

- policy engine: spend limits, allowlists, confirmation thresholds
- function-call keys: the agent never holds a full-access key and cannot sign
- every tx checked against live chain state, explained in plain words
- Chain Signatures + NEAR Intents for cross-chain pay/earn
- hash-chained safety report of everything the agent proposed

Repo + demo below. #NEARHackathon
https://github.com/mmcanpolat/near-sentinel
```

(attach the video; keep the repo URL in the text)

## Submission form fields (fill in yourself)

- Project name: NEAR Sentinel
- Team lead: <your name>
- Email: <your email>
- Team size: 1 (change if wrong)
- Tracks: Unstoppable DeFi, Agent Economy, Open Innovation, AI Security & Defense (Sputnik DAO is an optional Social Money extra, mentioned in the description)
- NEAR wallet (for prizes): <yourname.near>
- Repo link: https://github.com/mmcanpolat/near-sentinel
- Demo post link: <URL of the X post>
- One-liner: A guarded AI agent for NEAR: policy engine, function-call-key sandbox, live pre-checks, Chain Signatures, NEAR Intents.
- Tech: Node 22 (no npm dependencies), NEAR JSON-RPC, NEAR Chain Signatures (v1.signer), NEAR Intents 1Click, Ref Finance, Sputnik DAO v2, near-connect, optional NEAR AI Cloud
- Run: `npm start`, then open http://127.0.0.1:3000 (or `make run`, `docker compose up --build`)

### Description (1104 characters; limit 20-2000)

NEAR Sentinel is a guarded AI agent for NEAR. You describe what you want in plain words; the agent builds an unsigned NEAR transaction, reads live mainnet state to check it (account exists, token balance, storage reserve, gas, Ref pool prices), judges it against a safety policy only the user can edit, explains it in plain language and hands it to the user's own wallet. The agent never holds a full-access key and has no signing tool, which tests assert. For autonomy it uses NEAR function-call keys limited to one contract, listed methods and a gas budget. Chain Signatures give the same NEAR account derived Ethereum and Bitcoin addresses, with sign requests built unsigned and passed through the same policy. NEAR Intents powers cross-chain swaps and payment requests (agent economy), and Sputnik DAO v2 proposals and votes get the same checks. Every proposal is logged in a hash-chained, exportable safety report. Zero npm dependencies, Node 22, runs offline with no API key; NEAR AI Cloud is an optional LLM. Nothing was signed on mainnet during development; wallet signing is untested end to end.
