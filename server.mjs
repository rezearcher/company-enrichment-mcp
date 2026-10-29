#!/usr/bin/env node
// Grey Ridge company-enrichment MCP — a Model Context Protocol server that turns a
// company DOMAIN into a live, normalized enrichment record: firmographics, verified
// business contacts, a tech-stack fingerprint, social links, AND a live hiring
// signal derived from eight applicant-tracking systems — one deduped record per
// company, read live from the company's own public site and public DNS/ATS JSON.
//
// Transport: MCP stdio — newline-delimited JSON-RPC 2.0 on stdin/stdout, per the
// Model Context Protocol spec. Hand-rolled framing, no MCP SDK: the server boots
// instantly under `npx` and drags in a single parse dependency (cheerio) rather
// than the SDK's ~95 transitive packages — the right supply-chain posture for an
// agent tool. See test/roundtrip.mjs for a real client handshake.
//
// Everything is read LIVE from source and keyless: the company's public website,
// public DNS/MX, and public ATS JSON. No resold third-party database, no paid API,
// no account — the honest, maintained alternative to the stale-DB enrichment
// resellers, with a buying-intent hiring signal none of them carry.

import { enrichBatch } from './src/enrich.js';
import { deriveHiring } from './src/normalize.js';
import { scrape } from './src/scrape.js';
import { lookupMx } from './src/verify.js';
import { createInterface } from 'node:readline';

const SERVER_INFO = { name: 'greyridge-company-enrichment-mcp', version: '0.1.0' };
const DEFAULT_PROTOCOL = '2025-06-18';
const SUPPORTED_PROTOCOLS = new Set(['2025-06-18', '2025-03-26', '2024-11-05']);

// ---- tool definitions -----------------------------------------------------

const TOOLS = [
  {
    name: 'enrich_company',
    description:
      'Enrich one or more companies from their DOMAIN into a unified record, read live from the ' +
      "company's own public site + public DNS + public ATS JSON (no resold database, no API key). Each " +
      'record carries: company_name, legal_name_guess, description, industry, founded_year, ' +
      'employee_size_hint, hq_country, logo_url, social_links[], tech_stack[] (fingerprinted), ' +
      'contacts{emails[] with MX deliverability grade, phones[]}, and a live hiring{} block (ATS vendor, ' +
      'open_reqs_count, departments/locations hiring, remote_share, hiring_intensity, newest_posting_at). ' +
      'Records are deduped by canonical domain; thin crawls are flagged (enrichment_status), never ' +
      'fabricated. Input accepts domains ("stripe.com") or bare names ("stripe").',
    inputSchema: {
      type: 'object',
      properties: {
        domains: {
          type: 'array',
          items: { type: 'string' },
          description: 'Company domains or names to enrich (e.g. ["stripe.com","ramp.com"]). At least one required.',
          minItems: 1,
        },
        includeHiring: {
          type: 'boolean',
          description: 'Include the live multi-ATS hiring signal (the buying-intent moat). Default true.',
          default: true,
        },
        includeContacts: {
          type: 'boolean',
          description: 'Include emails (MX-graded) + business phones. Default true.',
          default: true,
        },
        includeTech: {
          type: 'boolean',
          description: 'Include the tech-stack fingerprint. Default true.',
          default: true,
        },
        maxPages: {
          type: 'integer',
          description: 'Max public pages crawled per company (default 4, max 12).',
          default: 4,
        },
        maxCompanies: {
          type: 'integer',
          description: 'Cap the number of companies processed (0 = no cap). Default 0.',
          default: 0,
        },
      },
      required: ['domains'],
      additionalProperties: false,
    },
  },
  {
    name: 'company_hiring_signal',
    description:
      'Return ONLY the live hiring signal for one company — a cheap buying-intent probe that skips the ' +
      'full site crawl. Resolves the company to its applicant-tracking system across 8 ATS platforms ' +
      '(Greenhouse, Lever, Ashby, SmartRecruiters, Workday, Recruitee, Workable, BambooHR) and returns ' +
      '{ats_vendor, ats_token, careers_url, open_reqs_count, departments_hiring[], locations_hiring[], ' +
      'remote_share, hiring_intensity (none/low/med/high), newest_posting_at}. This is the ' +
      'category-unique signal no resold-database enricher carries. Keyless, live from public ATS JSON.',
    inputSchema: {
      type: 'object',
      properties: {
        company: { type: 'string', description: 'Company slug ("bunq") or domain ("bunq.com").' },
      },
      required: ['company'],
      additionalProperties: false,
    },
  },
  {
    name: 'check_email_domain',
    description:
      'Grade the email deliverability posture of a domain from its public DNS, keyless and free (no ' +
      'paid verification API). Returns {domain, resolves, has_mx, mx_hosts[], grade}. Grades: B = valid ' +
      'MX present (mailbox existence not probed), D = resolves but no MX (mail unlikely), F = does not ' +
      'resolve. Use before trusting a role inbox or scoring a lead. Accepts a bare domain or an email ' +
      'address (the domain part is used).',
    inputSchema: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'A domain ("stripe.com") or an email ("jobs@stripe.com").' },
      },
      required: ['domain'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_capabilities',
    description:
      'Describe the enrichment record schema, the 8 ATS platforms behind the hiring signal, the live/' +
      'keyless/free-COGS data policy, and the public-business-data-only legal scope. No network call.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
];

// ---- tool handlers ---------------------------------------------------------

function clampInt(v, def, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.min(Math.max(Math.floor(n), min), max);
}

async function toolEnrichCompany(args) {
  const domains = Array.isArray(args?.domains)
    ? args.domains.filter((d) => typeof d === 'string' && d.trim())
    : [];
  if (domains.length === 0) throw new Error('`domains` must be a non-empty array of strings');
  const opts = {
    include_hiring: args?.includeHiring !== false,
    include_contacts: args?.includeContacts !== false,
    include_tech: args?.includeTech !== false,
    maxPagesPerCompany: clampInt(args?.maxPages, 4, 1, 12),
    maxCompanies: clampInt(args?.maxCompanies, 0, 0, 1000),
  };
  const { records, stats } = await enrichBatch(domains, opts);
  return {
    query: {
      domains,
      includeHiring: opts.include_hiring,
      includeContacts: opts.include_contacts,
      includeTech: opts.include_tech,
      maxPages: opts.maxPagesPerCompany,
    },
    count: records.length,
    stats,
    records,
  };
}

async function toolCompanyHiringSignal(args) {
  const company = typeof args?.company === 'string' ? args.company.trim() : '';
  if (!company) throw new Error('`company` is required');
  const hiring = await deriveHiring(company, scrape);
  return { input: company, source: 'multi-ats-live', hiring };
}

function domainOf(input) {
  const s = String(input || '').trim();
  if (!s) return '';
  const at = s.lastIndexOf('@');
  const raw = at >= 0 ? s.slice(at + 1) : s;
  return raw
    .replace(/^https?:\/\//i, '')
    .replace(/^www\./i, '')
    .split('/')[0]
    .split(':')[0]
    .toLowerCase()
    .trim();
}

async function toolCheckEmailDomain(args) {
  const domain = domainOf(args?.domain);
  if (!domain) throw new Error('`domain` is required (a domain or an email address)');
  const mx = await lookupMx(domain);
  let grade;
  if (!mx.resolves) grade = 'F';
  else if (!mx.hasMx) grade = 'D';
  else grade = 'B';
  return {
    domain,
    resolves: mx.resolves,
    has_mx: mx.hasMx,
    mx_hosts: mx.hosts || [],
    grade,
    note:
      grade === 'B'
        ? 'valid MX present; mailbox existence not probed (SMTP RCPT is off by default — port 25 usually blocked)'
        : grade === 'D'
          ? 'domain resolves but has no MX record; mail unlikely to deliver'
          : 'domain does not resolve',
  };
}

function toolListCapabilities() {
  return {
    server: SERVER_INFO,
    record_schema: {
      firmographics: [
        'company_name', 'legal_name_guess', 'description', 'industry', 'founded_year',
        'employee_size_hint', 'hq_country', 'logo_url',
      ],
      contacts: ['emails[] (with mx + deliverability_grade)', 'phones[]'],
      tech_stack: 'wappalyzer-style signature fingerprint from the live crawl',
      social_links: 'public company social profiles',
      hiring: [
        'ats_vendor', 'ats_token', 'careers_url', 'open_reqs_count', 'departments_hiring[]',
        'locations_hiring[]', 'remote_share', 'hiring_intensity', 'newest_posting_at',
      ],
      meta: ['canonical_domain', 'source_freshness (always "live")', '_enriched_at', 'enrichment_status'],
    },
    ats_platforms: [
      'greenhouse', 'lever', 'ashby', 'smartrecruiters', 'workday', 'recruitee', 'workable', 'bamboohr',
    ],
    data_policy: {
      live_from_source: 'every field is read live this call — never a resold or cached third-party database',
      cogs: 'keyless and free — company public site + public DNS/MX + public ATS JSON',
      hiring_moat: 'the live multi-ATS hiring signal is category-unique: resold-DB enrichers ship static firmographics only',
    },
    legal_scope:
      'PUBLIC business data only — published firmographics + published business contact points (role ' +
      'inboxes, switchboard, public social) + public ATS postings. No login, no personal/consumer PII, ' +
      'no scraped individual profiles, no third-party DB. Placeholder/noreply addresses dropped; absent ' +
      'fields stay null (never fabricated).',
    tools: TOOLS.map((t) => t.name),
  };
}

async function dispatchTool(name, args) {
  switch (name) {
    case 'enrich_company':
      return toolEnrichCompany(args);
    case 'company_hiring_signal':
      return toolCompanyHiringSignal(args);
    case 'check_email_domain':
      return toolCheckEmailDomain(args);
    case 'list_capabilities':
      return toolListCapabilities();
    default:
      throw new Error(`unknown tool: ${name}`);
  }
}

// ---- JSON-RPC / MCP plumbing ----------------------------------------------

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

function result(id, res) {
  send({ jsonrpc: '2.0', id, result: res });
}

function error(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

async function handle(msg) {
  const { id, method, params } = msg;
  const isRequest = Object.prototype.hasOwnProperty.call(msg, 'id') && msg.id !== null && msg.id !== undefined;

  // Notifications (no id) — never reply.
  if (!isRequest) return;

  switch (method) {
    case 'initialize': {
      const requested = params?.protocolVersion;
      const protocolVersion = SUPPORTED_PROTOCOLS.has(requested) ? requested : DEFAULT_PROTOCOL;
      result(id, {
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions:
          'Live company enrichment from a domain. Call list_capabilities for the record schema and data ' +
          'policy, enrich_company for a full record (firmographics + contacts + tech + hiring), ' +
          'company_hiring_signal for a cheap live buying-intent probe, and check_email_domain to grade a ' +
          'domain\'s mail deliverability. All live-from-source, keyless, public-business-data only.',
      });
      return;
    }
    case 'ping':
      result(id, {});
      return;
    case 'tools/list':
      result(id, { tools: TOOLS });
      return;
    case 'tools/call': {
      const name = params?.name;
      const args = params?.arguments || {};
      try {
        const data = await dispatchTool(name, args);
        result(id, { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] });
      } catch (e) {
        // Tool-level failure: an isError tool result (not a protocol error) so the
        // model sees the message and can recover.
        result(id, { content: [{ type: 'text', text: `error: ${e?.message || String(e)}` }], isError: true });
      }
      return;
    }
    default:
      error(id, -32601, `method not found: ${method}`);
  }
}

function main() {
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  let inFlight = 0;
  let closed = false;
  const maybeExit = () => { if (closed && inFlight === 0) process.exit(0); };

  rl.on('line', (line) => {
    const text = line.trim();
    if (!text) return;
    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      error(null, -32700, 'parse error');
      return;
    }
    // Track in-flight work so EOF (a one-shot pipe) never kills a request still
    // awaiting a live fetch. Responses stay ordered by the awaits in handle().
    inFlight += 1;
    handle(msg)
      .catch((e) => {
        if (msg && msg.id !== undefined && msg.id !== null) error(msg.id, -32603, `internal error: ${e?.message || e}`);
      })
      .finally(() => { inFlight -= 1; maybeExit(); });
  });
  rl.on('close', () => { closed = true; maybeExit(); });
}

main();
