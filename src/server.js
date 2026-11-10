// Tiny dependency-free HTTP server: static UI + JSON API. Binds to loopback unless HOST says otherwise.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chatWithTools, llmConfigured, llmSettings } from './agent/llm.js';
import { chatOffline } from './agent/offline.js';
import { cards, getPolicy, setPolicy } from './guard/pipeline.js';
import { entries, settle } from './guard/ledger.js';
import { report, auditEntries, recordOutcome } from './guard/audit.js';
import { validAccountId } from './lib/units.js';
import { chainSigAddresses } from './near/chainsig.js';

const PUBLIC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
const json = (res, code, body) => {
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body, (_, v) => (typeof v === 'bigint' ? v.toString() : v)));
};
const readBody = (req) => new Promise((resolve, reject) => {
  let n = 0; const parts = [];
  req.on('data', (c) => { n += c.length; if (n > 100_000) { reject(Object.assign(new Error('Request too large'), { status: 413 })); req.destroy(); } else parts.push(c); });
  req.on('end', () => { try { resolve(parts.length ? JSON.parse(Buffer.concat(parts).toString()) : {}); } catch { reject(Object.assign(new Error('Invalid JSON'), { status: 400 })); } });
});
const acct = (a) => { const x = String(a ?? '').toLowerCase(); return validAccountId(x) ? x : ''; };

export function createServer() {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    try {
      if (url.pathname.startsWith('/api/')) {
        // Cross-site pages must not be able to drive the local API.
        if (req.method !== 'GET' && !(req.headers['content-type'] ?? '').startsWith('application/json')) return json(res, 415, { error: 'JSON only' });
        if (url.pathname === '/api/health') return json(res, 200, { ok: true });
        if (url.pathname === '/api/config') return json(res, 200, { mode: llmConfigured() ? 'llm' : 'offline', model: llmConfigured() ? llmSettings().model : null, provider: llmConfigured() ? llmSettings().label : null, network: 'mainnet' });
        if (url.pathname === '/api/chat' && req.method === 'POST') {
          const { messages = [], account } = await readBody(req);
          const a = acct(account);
          const r = llmConfigured() ? await chatWithTools(messages, a) : await chatOffline(messages, a);
          return json(res, 200, r);
        }
        if (url.pathname === '/api/policy') {
          const a = acct(url.searchParams.get('account'));
          if (req.method === 'GET') return json(res, 200, getPolicy(a));
          if (req.method === 'PUT') { const b = await readBody(req); return json(res, 200, setPolicy(a || 'default', b)); }
        }
        if (url.pathname === '/api/ledger') {
          const a = acct(url.searchParams.get('account'));
          return json(res, 200, entries(a).filter((r) => Date.now() - r.ts < 864e5));
        }
        if (url.pathname === '/api/chainsig') {
          const d = url.searchParams.get('domain');
          return json(res, 200, await chainSigAddresses({ account: acct(url.searchParams.get('account')), path: url.searchParams.get('path') || 'ethereum-1', domainId: d == null || d === '' ? undefined : Number(d) }));
        }
        if (url.pathname === '/api/audit') {
          const a = acct(url.searchParams.get('account'));
          if (url.searchParams.get('download') === '1') {
            res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store', 'content-disposition': `attachment; filename="sentinel-safety-report-${a || 'anonymous'}.json"` });
            return res.end(JSON.stringify(report(a), null, 2));
          }
          return json(res, 200, report(a));
        }
        if (url.pathname === '/api/settle' && req.method === 'POST') {
          const { cardId, txIndex, hash, account } = await readBody(req);
          const card = cards.get(cardId);
          if (!card || card.account !== acct(account)) return json(res, 404, { error: 'Unknown card.' });
          if (!/^[1-9A-HJ-NP-Za-km-z]{43,44}$/.test(String(hash))) return json(res, 400, { error: 'Not a transaction hash.' });
          const result = await settle(card.account, hash, card.transactions[txIndex ?? 0]);
          recordOutcome(card.account, cardId, { settled: result.settled, hash, reason: result.reason ?? null });
          return json(res, 200, result);
        }
        return json(res, 404, { error: 'Not found' });
      }
      const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      const file = path.resolve(PUBLIC, rel);
      if (!file.startsWith(PUBLIC + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); return res.end('Not found'); }
      res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream', 'x-content-type-options': 'nosniff' });
      fs.createReadStream(file).pipe(res);
    } catch (e) {
      if (e.retryable) return json(res, 503, { error: e.message, retryable: true });
      json(res, e.status ?? (e.user ? 400 : 500), { error: e.user || e.status ? e.message : 'Something went wrong. Please try again.' });
      if (!e.user && !e.status) console.error(e);
    }
  });
}

export function startServer() {
  try { process.loadEnvFile('.env'); } catch { /* no .env: offline mode */ }
  const port = Number(process.env.PORT ?? 3000), host = process.env.HOST ?? '127.0.0.1';
  const srv = createServer();
  srv.on('error', (e) => {
    console.error(e.code === 'EADDRINUSE' ? `Port ${port} is already in use. Start on another one:  PORT=3001 npm start` : `Server error: ${e.message}`);
    process.exit(1);
  });
  srv.listen(port, host, () => console.log(`NEAR Sentinel on http://${host}:${port}  (${llmConfigured() ? 'LLM mode' : 'offline command mode, no LLM key needed'})`));
  return srv;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) startServer();
