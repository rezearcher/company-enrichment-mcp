#!/usr/bin/env node
// Real MCP client handshake against ./server.mjs over stdio: initialize ->
// notifications/initialized -> ping -> tools/list -> tools/call (list_capabilities
// offline, then LIVE check_email_domain, company_hiring_signal, enrich_company).
// Asserts spec-conformant JSON-RPC 2.0 framing and live enrichment data.
// Run: node test/roundtrip.mjs   (exit 0 = pass, non-zero = fail)

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const serverPath = join(here, '..', 'server.mjs');

const child = spawn(process.execPath, [serverPath], { stdio: ['pipe', 'pipe', 'inherit'] });
const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });

const pending = new Map();
let nextId = 1;
rl.on('line', (line) => {
  const t = line.trim();
  if (!t) return;
  let msg;
  try { msg = JSON.parse(t); } catch { console.error('NON-JSON line from server:', t); process.exit(1); }
  if (msg.id !== undefined && pending.has(msg.id)) {
    const { resolve } = pending.get(msg.id);
    pending.delete(msg.id);
    resolve(msg);
  }
});

function rpc(method, params, { notify = false } = {}) {
  if (notify) {
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
    return Promise.resolve(null);
  }
  const id = nextId++;
  const p = new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error(`timeout on ${method}`)); } }, 60000);
  });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  return p;
}

let failures = 0;
function assert(cond, label) {
  if (cond) { console.log(`  PASS ${label}`); }
  else { console.log(`  FAIL ${label}`); failures++; }
}

function parseToolJSON(res) {
  const txt = res?.result?.content?.[0]?.text;
  try { return JSON.parse(txt); } catch { return { __raw: txt }; }
}

(async () => {
  // 1. initialize
  const init = await rpc('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'roundtrip-test', version: '0' },
  });
  assert(init.result?.protocolVersion === '2025-06-18', 'initialize echoes supported protocolVersion');
  assert(init.result?.serverInfo?.name === 'greyridge-company-enrichment-mcp', 'initialize returns serverInfo');
  assert(!!init.result?.capabilities?.tools, 'initialize advertises tools capability');

  // 2. initialized notification (no reply expected)
  await rpc('notifications/initialized', {}, { notify: true });

  // 3. ping
  const pong = await rpc('ping', {});
  assert(pong.result && typeof pong.result === 'object', 'ping -> empty result');

  // 4. tools/list
  const list = await rpc('tools/list', {});
  const names = (list.result?.tools || []).map((t) => t.name).sort();
  assert(
    JSON.stringify(names) === JSON.stringify(['check_email_domain', 'company_hiring_signal', 'enrich_company', 'list_capabilities']),
    'tools/list returns 4 tools',
  );
  assert((list.result.tools || []).every((t) => t.inputSchema?.type === 'object'), 'every tool has an object inputSchema');

  // 5. list_capabilities (offline)
  const caps = parseToolJSON(await rpc('tools/call', { name: 'list_capabilities', arguments: {} }));
  assert(Array.isArray(caps.ats_platforms) && caps.ats_platforms.length === 8 && caps.ats_platforms.includes('bamboohr'), 'list_capabilities -> 8 ATS platforms');
  assert(!!caps.data_policy?.live_from_source && !!caps.legal_scope, 'list_capabilities -> data policy + legal scope present');

  // 6. check_email_domain LIVE (DNS MX — reliable keyless from any egress)
  const em = parseToolJSON(await rpc('tools/call', { name: 'check_email_domain', arguments: { domain: 'jobs@stripe.com' } }));
  assert(em.domain === 'stripe.com' && em.resolves === true && em.has_mx === true && em.grade === 'B', `check_email_domain(stripe.com) -> resolves+MX grade B (got ${em.grade})`);
  const nx = parseToolJSON(await rpc('tools/call', { name: 'check_email_domain', arguments: { domain: 'nonexistent-domain-xqz123.invalid' } }));
  assert(nx.grade === 'F', `check_email_domain(invalid) -> grade F (got ${nx.grade})`);

  // 7. company_hiring_signal LIVE (owned multi-ATS layer, keyless JSON — the moat)
  const hs = parseToolJSON(await rpc('tools/call', { name: 'company_hiring_signal', arguments: { company: 'stripe.com' } }));
  assert(hs.hiring?.ats_vendor === 'greenhouse', `company_hiring_signal(stripe.com) -> greenhouse (got ${hs.hiring?.ats_vendor})`);
  assert(Number(hs.hiring?.open_reqs_count) > 0, `company_hiring_signal(stripe.com) -> ${hs.hiring?.open_reqs_count} open reqs`);
  assert(['low', 'med', 'high'].includes(hs.hiring?.hiring_intensity), `company_hiring_signal -> intensity ${hs.hiring?.hiring_intensity}`);

  // 8. enrich_company LIVE (full crawl + firmographics + hiring)
  const en = parseToolJSON(await rpc('tools/call', { name: 'enrich_company', arguments: { domains: ['stripe.com'], includeContacts: false } }));
  assert(en.count === 1, `enrich_company(stripe.com) -> ${en.count} record`);
  const rec = (en.records || [])[0] || {};
  assert(rec.canonical_domain === 'stripe.com' || rec.input_domain === 'stripe.com', 'enrich record carries the domain');
  assert(rec.enrichment_status === 'ok' && !!rec.company_name, `enrich record is ok with company_name (${rec.company_name || '?'})`);
  assert(rec.hiring?.ats_vendor === 'greenhouse' && Number(rec.hiring?.open_reqs_count) > 0, 'enrich record carries the live hiring block (greenhouse)');
  assert(Array.isArray(rec.tech_stack) && rec.tech_stack.length > 0, `enrich record has a tech_stack (${(rec.tech_stack || []).join(',') || '?'})`);
  assert(rec.source_freshness === 'live', 'enrich record source_freshness=live');

  // 9. error path: unknown method -> JSON-RPC -32601
  const bad = await rpc('does/not/exist', {});
  assert(bad.error?.code === -32601, 'unknown method -> -32601');

  // 10. tool error surfaces as isError tool result, not protocol error
  const toolErr = await rpc('tools/call', { name: 'enrich_company', arguments: { domains: [] } });
  assert(toolErr.result?.isError === true, 'empty domains -> isError tool result');

  child.stdin.end();
  console.log(failures === 0 ? `\nALL PASS (${nextId - 1} roundtrips)` : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error('harness error:', e); process.exit(1); });
