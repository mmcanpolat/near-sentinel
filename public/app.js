// Browser side. Wallet: @hot-labs/near-connect (each wallet runs sandboxed in an iframe), loaded only on click.
// Every card is built and judged on the server; the browser only displays it and asks the wallet to sign.

const $ = (id) => document.getElementById(id);
const h = (tag, props = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) k === 'class' ? (e.className = v) : k.startsWith('on') ? e.addEventListener(k.slice(2), v) : e.setAttribute(k, v);
  for (const k of kids.flat()) if (k != null) e.append(k.nodeType ? k : document.createTextNode(String(k)));
  return e;
};
const api = async (path, opts) => {
  let r;
  try {
    r = await fetch(path, { ...opts, headers: { 'content-type': 'application/json' }, body: opts?.body ? JSON.stringify(opts.body) : undefined, signal: AbortSignal.timeout(90000) });
  } catch (e) {
    throw Object.assign(new Error(e?.name === 'TimeoutError' ? 'This is taking too long; the public NEAR RPC may be busy.' : 'Cannot reach the local Sentinel server. Is it still running (npm start)?'), { retryable: true });
  }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j.error || `Request failed (${r.status})`), { retryable: r.status === 503 || r.status === 429 });
  return j;
};
const DEFAULT_PREVIEW = 'near';

let account = '';           // account used for building/checking
let walletAccount = '';     // set only when a real wallet is connected (the only way to sign)
let connector = null;
const history = [];

const EXAMPLES = [
  'balance', 'validators', 'send 0.1 NEAR to root.near', 'send 50 NEAR to root.near',
  'swap 1 NEAR to USDC', 'quote 1 NEAR to USDC on base', 'stake 1 NEAR with metapool',
  'create agent key for wrap.near methods near_deposit allowance 0.05', 'list keys', 'show policy',
  'dao ref-finance.sputnik-dao.near', 'proposals of ref-finance.sputnik-dao.near',
];

function setAccount(a, wallet) {
  if (!a) { a = DEFAULT_PREVIEW; wallet = false; } // never empty: judges see working cards without a wallet
  $('preview').value = wallet ? '' : a;
  account = a; walletAccount = wallet ? a : '';
  $('acct').textContent = a ? (wallet ? a : `${a} (preview)`) : '';
  $('connect').textContent = wallet ? 'Disconnect' : 'Connect NEAR wallet';
  loadPolicy(); loadLedger(); loadAudit(); $('cs-out').replaceChildren();
}

async function getConnector() {
  if (connector) return connector;
  const { NearConnector } = await import('https://cdn.jsdelivr.net/npm/@hot-labs/near-connect@0.12.0/+esm');
  connector = new NearConnector({ network: 'mainnet' });
  connector.on('wallet:signIn', (e) => setAccount(e.accounts?.[0]?.accountId ?? '', true));
  connector.on('wallet:signOut', () => setAccount('', false));
  return connector;
}

$('connect').onclick = async () => {
  try {
    const c = await getConnector();
    if (walletAccount) { await c.disconnect(); return setAccount('', false); }
    await c.whenManifestLoaded; await c.connect();
  } catch (e) { say('bot', /reject|cancel|closed|denied/i.test(String(e?.message)) ? 'Wallet connection cancelled.' : 'Could not open the NEAR wallet. You can still preview any public account below.'); }
};
$('usePreview').onclick = () => { const v = $('preview').value.trim().toLowerCase(); if (v) setAccount(v, false); };
$('preview').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); $('usePreview').click(); } });

function say(who, text) { const m = h('div', { class: `msg ${who}` }, text); $('log').append(m); $('log').scrollTop = 1e9; return m; }

function renderCard(c) {
  const v = c.policy.verdict;
  const label = { allow: 'Within policy', confirm: 'Needs your confirmation', deny: 'Blocked' }[v];
  const box = h('div', { class: `card is-${v}` },
    h('h4', {}, c.title.replaceAll('_', ' '), ' ', h('span', { class: `pill v-${v}` }, label)),
    c.explain.flat().length ? h('div', {}, h('div', { class: 'sec' }, 'What will happen'), h('ul', {}, c.explain.flat().map((l) => h('li', {}, l)))) : null,
    c.policy.findings.length ? h('div', {}, h('div', { class: 'sec' }, 'Policy'), h('ul', {}, c.policy.findings.map((f) => h('li', { class: `f-${f.level}` }, f.message)))) : null,
    c.checks.length ? h('div', {}, h('div', { class: 'sec' }, 'Checked against the chain just now'), h('ul', { class: 'checks' }, c.checks.map((l) => h('li', { class: 'chk' }, l)))) : null,
    c.warnings.length ? h('div', {}, h('div', { class: 'sec' }, 'Notes'), h('ul', {}, c.warnings.map((l) => h('li', {}, l)))) : null,
    c.note ? h('div', { class: 'chk' }, c.note) : null,
  );
  if (c.transactions.length) {
    const tick = h('input', { type: 'checkbox', id: `t-${c.id}`, style: 'width:auto' });
    const res = h('div', { class: 'result' });
    const btn = h('button', { class: 'primary' }, walletAccount ? 'Sign in wallet' : 'Connect a wallet to sign');
    btn.disabled = !c.canSign;
    if (!c.canSign) btn.textContent = 'Cannot be signed';
    btn.onclick = async () => {
      if (!walletAccount) return $('connect').click();
      if (c.needsConfirm && !tick.checked) { res.textContent = 'Tick the confirmation first.'; return; }
      btn.disabled = true; res.textContent = 'Waiting for your wallet...';
      try {
        const cn = await getConnector(); const { wallet } = await cn.getConnectedWallet();
        const outcomes = await wallet.signAndSendTransactions({ signerId: walletAccount, transactions: c.transactions });
        const notes = [];
        for (const [i, o] of (outcomes || []).entries()) {
          const hash = o?.transaction?.hash ?? o?.transaction_outcome?.id;
          if (!hash) { notes.push('The wallet returned no hash.'); continue; }
          const s = await api('/api/settle', { method: 'POST', body: { cardId: c.id, txIndex: i, hash, account: walletAccount } });
          notes.push(s.settled ? `Confirmed on chain (${hash.slice(0, 8)}...).` : s.reason);
        }
        res.textContent = notes.join(' '); loadLedger();
      } catch (e) { res.textContent = /reject|cancel|denied/i.test(String(e?.message)) ? 'You cancelled in the wallet. Nothing was sent.' : 'The wallet did not complete the transaction.'; btn.disabled = false; }
    };
    box.append(h('div', { class: 'act' }, c.needsConfirm ? h('label', {}, tick, ' I reviewed the warnings above') : null, btn), res);
  }
  $('log').append(box); $('log').scrollTop = 1e9;
}

$('form').onsubmit = async (ev) => {
  ev.preventDefault();
  const text = $('input').value.trim(); if (!text) return;
  $('input').value = ''; say('user', text); history.push({ role: 'user', content: text });
  $('send').disabled = true; const wait = say('bot', 'Checking against the chain...');
  try {
    const r = await api('/api/chat', { method: 'POST', body: { messages: history, account } });
    wait.textContent = r.reply || 'Done.'; history.push({ role: 'assistant', content: r.reply || '' });
    r.cards.forEach(renderCard); loadAudit();
    if (/RPC unavailable|rate-limit/i.test(r.reply || '')) wait.append(' ', retryButton(text));
    loadAudit();
  } catch (e) { wait.textContent = e.message; wait.classList.add('err'); if (e.retryable) wait.append(' ', retryButton(text)); }
  $('send').disabled = false; $('input').focus();
};
function retryButton(text) {
  return h('button', { type: 'button', class: 'retry', onclick: () => { $('input').value = text; $('form').requestSubmit(); } }, 'Try again');
}

// ---- policy panel
const lines = (s) => s.split('\n').map((x) => x.trim()).filter(Boolean);
async function loadPolicy() {
  let p;
  try { p = await api(`/api/policy?account=${encodeURIComponent(account)}`); } catch (e) { $('saved').textContent = e.message; return; }
  const n = p.limits.near || {};
  $('p-near-pertx').value = n.perTx ?? ''; $('p-near-daily').value = n.daily ?? ''; $('p-near-confirm').value = n.confirmAbove ?? '';
  $('p-unlisted').value = p.unlistedToken; $('p-rmode').value = p.recipients.mode; $('p-rlist').value = p.recipients.list.join('\n');
  $('p-contracts').value = p.allowedContracts.join('\n'); $('p-gas').value = p.maxGasTgas; $('p-keymax').value = p.agentKeys.maxAllowanceNear;
  const extra = { ...p.limits }; delete extra.near; $('p-extra').value = Object.keys(extra).length ? JSON.stringify(extra) : '';
  const cs = p.chainSig; $('p-cs-enabled').checked = cs.enabled; $('p-cs-paths').value = cs.allowedPaths.join('\n'); $('p-cs-max').value = cs.maxPerDay; $('p-cs-confirm').checked = cs.confirmEach;
  window.__policy = p;
}
$('save').onclick = async () => {
  try {
    const p = structuredClone(window.__policy);
    p.limits = { ...(JSON.parse($('p-extra').value || '{}')), near: { perTx: $('p-near-pertx').value, daily: $('p-near-daily').value, confirmAbove: $('p-near-confirm').value } };
    p.unlistedToken = $('p-unlisted').value; p.recipients = { mode: $('p-rmode').value, list: lines($('p-rlist').value) };
    p.allowedContracts = lines($('p-contracts').value); p.maxGasTgas = Number($('p-gas').value); p.agentKeys.maxAllowanceNear = $('p-keymax').value;
    p.chainSig = { ...p.chainSig, enabled: $('p-cs-enabled').checked, allowedPaths: lines($('p-cs-paths').value), maxPerDay: Number($('p-cs-max').value), confirmEach: $('p-cs-confirm').checked };
    await api(`/api/policy?account=${encodeURIComponent(account)}`, { method: 'PUT', body: p });
    $('saved').textContent = 'Saved.'; loadPolicy();
  } catch (e) { $('saved').textContent = e.message; }
  setTimeout(() => ($('saved').textContent = ''), 4000);
};
async function loadLedger() {
  if (!account) return;
  let rows;
  try { rows = await api(`/api/ledger?account=${encodeURIComponent(account)}`); } catch (e) { $('ledger').textContent = e.message; return; }
  $('ledger').replaceChildren(rows.length ? h('ul', {}, rows.map((r) => h('li', {}, r.token === 'chainsig:sign' ? `${new Date(r.ts).toLocaleTimeString()}: signature request for path ${r.to}` : `${new Date(r.ts).toLocaleTimeString()}: ${r.amount} raw units of ${r.token} to ${r.to}`))) : h('span', { class: 'hint' }, 'Nothing confirmed in the last 24h.'));
}
// ---- agent safety report
const VLABEL = { allow: 'Allowed', confirm: 'Confirm', deny: 'Blocked', refused: 'Refused' };
async function loadAudit() {
  if (!account) return;
  $('audit-dl').href = `/api/audit?account=${encodeURIComponent(account)}&download=1`;
  let r;
  try { r = await api(`/api/audit?account=${encodeURIComponent(account)}`); } catch (e) { $('audit').textContent = e.message; return; }
  const t = r.totals;
  $('audit-sum').textContent = `${t.proposed} proposed: ${t.allowed} allowed, ${t.needConfirmation} confirm, ${t.blocked} blocked, ${t.refused} refused; chain ${r.hashChain.ok ? 'intact' : 'BROKEN'}`;
  $('audit').replaceChildren(...(r.entries.length ? r.entries.slice().reverse().slice(0, 50).map((e) => h('details', { class: `audit-row is-${e.verdict}` },
    h('summary', {}, h('span', { class: `pill v-${e.verdict === 'refused' ? 'deny' : e.verdict}` }, VLABEL[e.verdict]), ' ', e.title, ' ', h('small', {}, new Date(e.ts).toLocaleTimeString())),
    h('p', {}, e.reason),
    e.summary.length ? h('ul', {}, e.summary.map((l) => h('li', {}, l))) : null,
    e.rules.length ? h('ul', {}, e.rules.map((f) => h('li', { class: `f-${f.level}` }, `${f.rule}: ${f.message}`))) : null,
    e.checks.length ? h('ul', { class: 'checks' }, e.checks.map((l) => h('li', { class: 'chk' }, l))) : null,
    h('small', { class: 'hint' }, `#${e.seq} tool ${e.tool ?? '-'} | tx ${e.txDigest ? e.txDigest.slice(0, 12) : '-'} | hash ${e.hash.slice(0, 12)}`, e.outcome ? ` | ${e.outcome.settled ? 'confirmed on chain' : 'not settled: ' + e.outcome.reason}` : ''),
  )) : [h('span', { class: 'hint' }, 'Nothing proposed yet.')]));
}
$('audit-refresh').onclick = loadAudit;

// ---- cross-chain addresses (NEAR Chain Signatures)
$('cs-go').onclick = async () => {
  $('cs-out').textContent = 'Reading the MPC contract...';
  try {
    const r = await api(`/api/chainsig?account=${encodeURIComponent(account)}&path=${encodeURIComponent($('cs-path').value.trim())}`);
    const row = (k, v) => h('div', { class: 'cs-row' }, h('b', {}, k), h('code', {}, v));
    $('cs-out').replaceChildren(row('EVM (Ethereum, Base, ...)', r.addresses.evm), row('Bitcoin (native segwit)', r.addresses.bitcoin), row('Bitcoin (legacy)', r.addresses.bitcoinLegacy), row('Public key', r.derivedPublicKey),
      h('p', { class: r.localDerivationMatchesContract ? 'chk' : 'err' }, `${r.localDerivationMatchesContract ? 'Local math matches the contract view. ' : ''}${r.note} Contract ${r.contract} v${r.contractVersion}, domain ${r.domainId}.`));
  } catch (e) { $('cs-out').textContent = e.message; }
};
document.querySelectorAll('.tabs button').forEach((b) => (b.onclick = () => {
  document.querySelectorAll('.tabs button').forEach((x) => x.classList.toggle('on', x === b));
  if (b.dataset.tab === 'activity') loadAudit();
  for (const t of ['policy', 'chains', 'activity', 'about']) $(`tab-${t}`).hidden = t !== b.dataset.tab;
}));

for (const ex of EXAMPLES) $('chips').append(h('button', { type: 'button', onclick: () => { $('input').value = ex; $('input').focus(); } }, ex));
api('/api/config').then((c) => { $('mode').textContent = c.mode === 'llm' ? `LLM: ${c.model}` : 'offline commands (no LLM key)'; });
say('bot', 'I prepare NEAR transactions, check them against the live chain and your safety policy, and hand them to your wallet. I never hold a key. You are previewing the public account \"near\" (read-only): building, live checks and policy verdicts all work, only signing needs a wallet. Click a chip under this box, or connect your wallet.');
setAccount('', false);

// ---- theme toggle (persisted; falls back to the OS setting)
{
  const root = document.documentElement, btn = $('theme');
  const dark = () => (root.dataset.theme ? root.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches);
  try { const t = localStorage.getItem('sentinel-theme'); if (t === 'light' || t === 'dark') root.dataset.theme = t; } catch {}
  const sync = () => { btn.setAttribute('aria-label', dark() ? 'Switch to light theme' : 'Switch to dark theme'); btn.textContent = dark() ? '\u2600' : '\u263E'; };
  btn.onclick = () => { root.dataset.theme = dark() ? 'light' : 'dark'; try { localStorage.setItem('sentinel-theme', root.dataset.theme); } catch {} sync(); };
  sync();
}
