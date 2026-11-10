# Demo kit (for the maintainer to post; nothing here is posted automatically)

## 90-second video script

0:00 Title card: "NEAR Sentinel: an AI agent that cannot rob you."
0:08 Show the app with a preview account. Say: "The agent holds no key. It proposes, my policy checks, I sign."
0:15 Type `send 0.5 NEAR to root.near`. Point at the green "Within policy" pill and the "Checked against the chain just now" list.
0:30 Type `send 50 NEAR to root.near`. Red "Blocked", sign button disabled. "Per-transaction and daily caps are enforced before my wallet ever opens."
0:42 Type `send 1 NEAR to nonexistentaccount99887.near`. "Typo protection from live chain state."
0:50 Type `create agent key for wrap.near methods near_deposit allowance 0.05`. "For autonomy the agent gets a NEAR function-call key: one contract, listed methods, a gas budget, and the protocol itself forbids deposits. I can revoke it any time."
1:05 Type `quote 1 NEAR to USDC on base`. "Cross-chain through NEAR Intents: the agent can pay and get paid on other chains."
1:15 Show the Policy panel; change the recipient mode to allowlist. "Only I can edit this. The agent has no tool for it."
1:18 Switch preview to `refchef.near`, type `propose poll Should we fund a hackathon? on ref-finance.sputnik-dao.near`. "Same guard for DAOs: it read the DAO's live roles, bond and permissions before showing the card."
1:25 End card: repo link, "Built at NEAR HACKATHON".

## X post draft

Built NEAR Sentinel at NEAR HACKATHON: an AI agent for @NEARProtocol that can't rob you.

- policy engine: spend limits, allowlists, confirmation thresholds
- function-call key sandbox: the agent never holds a full-access key
- every tx checked against live chain state and explained in plain words
- cross-chain pay/earn with NEAR Intents

Repo + demo below. #NEARHackathon

(attach the video; paste the repo URL)

## Submission form fields (fill in yourself)

- Project name: NEAR Sentinel
- One-liner: A guarded AI agent for NEAR: policy engine, function-call-key sandbox, live pre-checks, NEAR Intents cross-chain.
- Tracks: Unstoppable DeFi, Agent Economy, Open Innovation, AI Security & Defense (+ Social Money: Sputnik DAO)
- Repo URL, demo video / X post URL: yours
- Tech: Node 22 (no dependencies), NEAR JSON-RPC, NEAR Intents 1Click, Ref Finance, near-connect
- Run: `npm start` (or `make run`) then open http://localhost:3000
