// Orchestrator: one company domain -> one deduped enriched record.
// Wires crawl.js -> extract.js + techstack.js -> verify.js -> normalize.js
// (hiring block from the owned ATS layer). Fetchers are injected so the whole
// pipeline is unit-testable offline AND runs live keyless with the defaults.

import { crawlCompany } from './crawl.js';
import { extractCompany } from './extract.js';
import { fingerprint } from './techstack.js';
import { verifyEmails } from './verify.js';
import { deriveHiring, buildRecord, companyKey } from './normalize.js';
import { scrape } from './scrape.js';

/**
 * @param {string} input  a company domain (preferred) or URL
 * @param {object} opts
 * @param {number}  [opts.maxPagesPerCompany=4]
 * @param {boolean} [opts.include_hiring=true]
 * @param {boolean} [opts.include_contacts=true]
 * @param {boolean} [opts.include_tech=true]
 * @param {boolean} [opts.enableSmtp=false]  best-effort SMTP RCPT (port 25 often blocked)
 * @param {function} [opts.fetchImpl=fetch]
 * @param {function} [opts.scrapeFn=scrape]  ATS hiring-block scraper
 * @param {function} [onLog]
 */
export async function enrichCompany(input, opts = {}, onLog = () => {}) {
  const {
    maxPagesPerCompany = 4,
    include_hiring = true,
    include_contacts = true,
    include_tech = true,
    enableSmtp = false,
    fetchImpl = fetch,
    scrapeFn = scrape,
  } = opts;

  const flags = { include_hiring, include_contacts, include_tech };

  // 1. crawl the company's own public site (bounded, keyless)
  const crawled = await crawlCompany(input, { maxPages: maxPagesPerCompany, fetchImpl });
  onLog({ level: 'info', msg: `${input}: crawled ${crawled.pages.length} page(s)${crawled.errors.length ? ` (${crawled.errors.length} err)` : ''}` });

  // 2. extract firmographics + contacts
  const extracted = extractCompany(crawled);

  // 3. tech fingerprint (from the crawl's html/headers)
  const tech = include_tech ? fingerprint(crawled) : [];

  // 4. deliverability-grade the emails
  let emails = [];
  let phones = [];
  if (include_contacts && extracted) {
    emails = await verifyEmails(extracted.emails || [], { enableSmtp });
    phones = (extracted.phones || []).map((number) => ({ number, type: 'business' }));
  }

  // 5. hiring block from the owned multi-ATS layer (the moat)
  let hiring = null;
  if (include_hiring) {
    const slug = (extracted && extracted.canonical_domain) || input;
    hiring = await deriveHiring(slug, scrapeFn, onLog);
    if (hiring && hiring.ats_vendor) {
      onLog({ level: 'info', msg: `${input}: hiring ${hiring.ats_vendor} ${hiring.open_reqs_count} reqs (${hiring.hiring_intensity})` });
    }
  }

  const record = buildRecord({ input, extracted, tech, emails, phones, hiring, flags });
  record._crawl_errors = crawled.errors.length ? crawled.errors.slice(0, 5) : undefined;
  return record;
}

/**
 * Enrich a batch, deduped by canonical domain. Bounded by maxCompanies.
 * Returns { records, stats }.
 */
export async function enrichBatch(inputs, opts = {}, onLog = () => {}) {
  const { maxCompanies = 0 } = opts;
  const list = (Array.isArray(inputs) ? inputs : []).map((x) => String(x || '').trim()).filter(Boolean);
  const capped = maxCompanies > 0 ? list.slice(0, maxCompanies) : list;
  const seen = new Set();
  const records = [];
  let ok = 0;
  let thin = 0;
  for (const input of capped) {
    const rec = await enrichCompany(input, opts, onLog);
    const key = companyKey(rec);
    if (key && seen.has(key)) {
      onLog({ level: 'info', msg: `dedup: ${input} collapses into ${key}` });
      continue;
    }
    if (key) seen.add(key);
    if (rec.enrichment_status === 'ok') ok += 1; else thin += 1;
    records.push(rec);
  }
  return {
    records,
    stats: { requested: list.length, processed: capped.length, emitted: records.length, ok, thin },
  };
}
