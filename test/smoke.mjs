#!/usr/bin/env node
// Cloud canary (CI smoke) — a real MCP client handshake + the live paths that are
// RELIABLY keyless from any egress (public ATS JSON + public DNS), used as the
// gating drift signal. The full-site crawl (enrich_company) is run ADVISORY: a
// company CDN may rate-limit a cloud runner IP, so a crawl block is logged but
// NEVER fails the gate — only a true upstream reshape of the gating paths does.
// (Same advisory discipline as the LinkedIn guest-endpoint canary elsewhere.)
// Run: node test/smoke.mjs   (exit 0 = healthy, non-zero = real drift)

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
  try { msg = JSON.parse(t); } catch { return; }
  if (msg.id !== undefined && pending.has(msg.id)) { pending.get(msg.id).resolve(msg); pending.delete(msg.id); }
});
function rpc(method, params, { notify = false } = {}) {
  if (notify) { child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n'); return Promise.resolve(null); }
  const id = nextId++;
  const p = new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error(`timeout on ${method}`)); } }, 60000);
  });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  return p;
}
let gateFail = 0;
function gate(cond, label) { console.log(`  ${cond ? 'OK  ' : 'DRIFT'} ${label}`); if (!cond) gateFail++; }
function advisory(cond, label) { console.log(`  ${cond ? 'OK  ' : 'ADVISORY'} ${label}`); }
function parseToolJSON(res) { try { return JSON.parse(res?.result?.content?.[0]?.text); } catch { return {}; } }

(async () => {
  const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke', version: '0' } });
  gate(init.result?.serverInfo?.name === 'greyridge-company-enrichment-mcp', 'initialize handshake');
  await rpc('notifications/initialized', {}, { notify: true });

  const list = await rpc('tools/list', {});
  gate((list.result?.tools || []).length === 4, 'tools/list -> 4 tools');

  // GATING: list_capabilities (offline schema) must be intact
  const caps = parseToolJSON(await rpc('tools/call', { name: 'list_capabilities', arguments: {} }));
  gate(Array.isArray(caps.ats_platforms) && caps.ats_platforms.length === 8, 'schema: 8 ATS platforms');

  // GATING: DNS MX path (keyless, reliable from any egress)
  const em = parseToolJSON(await rpc('tools/call', { name: 'check_email_domain', arguments: { domain: 'stripe.com' } }));
  gate(em.has_mx === true && em.grade === 'B', `check_email_domain(stripe.com) -> MX grade B (got ${em.grade})`);

  // GATING: live hiring signal via public ATS JSON (the moat; reliable from cloud)
  const hs = parseToolJSON(await rpc('tools/call', { name: 'company_hiring_signal', arguments: { company: 'stripe.com' } }));
  gate(hs.hiring?.ats_vendor === 'greenhouse' && Number(hs.hiring?.open_reqs_count) > 0,
    `company_hiring_signal(stripe.com) -> greenhouse ${hs.hiring?.open_reqs_count} reqs`);

  // ADVISORY: full-site crawl may be CDN-blocked from a cloud IP — never gates.
  try {
    const en = parseToolJSON(await rpc('tools/call', { name: 'enrich_company', arguments: { domains: ['stripe.com'], includeContacts: false } }));
    const rec = (en.records || [])[0] || {};
    advisory(rec.enrichment_status === 'ok' && !!rec.company_name, `enrich_company(stripe.com) -> ${rec.company_name || 'crawl blocked (advisory)'}`);
  } catch (e) {
    advisory(false, `enrich_company crawl unavailable from this egress (advisory): ${e.message || e}`);
  }

  child.stdin.end();
  console.log(gateFail === 0 ? '\nHEALTHY (gating paths OK)' : `\n${gateFail} DRIFT on gating path(s)`);
  process.exit(gateFail === 0 ? 0 : 1);
})().catch((e) => { console.error('smoke harness error:', e); process.exit(1); });
