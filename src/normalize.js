// Final record assembly + the HIRING block derived from our OWNED multi-ATS layer.
// Pure: the scrape fn is injected so this is unit-testable offline and the live
// path (enrich.js) wires in the real keyless ATS scrape().
//
// The hiring block is the non-substitutable moat: NO resold-DB enrichment
// competitor (foxlabs/code_crafter/microworlds) derives live hiring signals from a
// maintained multi-ATS layer — they resell static firmographics. We turn each
// company's live open reqs into a hiring intensity signal in the SAME record.

function uniq(arr) {
  return [...new Set((arr || []).filter((x) => x != null && String(x).trim()))];
}

function bucketIntensity(n) {
  if (!n) return 'none';
  if (n <= 5) return 'low';
  if (n <= 25) return 'med';
  return 'high';
}

const REMOTE_RE = /\b(remote|anywhere|distributed|work from home|wfh)\b/i;

/**
 * Derive the hiring{} block for one company domain/slug via the injected ATS
 * scrape() (actors/multi-ats-jobs-scraper/src/scrape.js shape).
 * Returns the block; never throws (degrades to ats_vendor:null on any error).
 */
export async function deriveHiring(entry, scrapeFn, onLog = () => {}) {
  try {
    const { jobs, resolutions } = await scrapeFn({ companies: [entry] }, onLog);
    const res = (resolutions && resolutions[0]) || {};
    const resolved = res.resolved || null;
    if (!resolved) {
      return { ats_vendor: null, careers_url: null, open_reqs_count: 0, departments_hiring: [], locations_hiring: [], remote_share: 0, hiring_intensity: 'none', newest_posting_at: null };
    }
    const rows = jobs || [];
    const departments = uniq(rows.map((j) => j.department));
    const locations = uniq(rows.map((j) => j.location));
    const remoteCount = rows.filter((j) => j.remote === true || REMOTE_RE.test(String(j.location || ''))).length;
    const dates = rows.map((j) => j.posted_at).filter(Boolean).sort();
    const careers_url = rows.find((j) => j.url)?.url
      ? new URL(rows.find((j) => j.url).url).origin + new URL(rows.find((j) => j.url).url).pathname.replace(/\/[^/]*$/, '')
      : null;
    return {
      ats_vendor: resolved.platform,
      ats_token: resolved.token,
      careers_url,
      open_reqs_count: rows.length,
      departments_hiring: departments.slice(0, 25),
      locations_hiring: locations.slice(0, 25),
      remote_share: rows.length ? Math.round((remoteCount / rows.length) * 100) / 100 : 0,
      hiring_intensity: bucketIntensity(rows.length),
      newest_posting_at: dates.length ? dates[dates.length - 1] : null,
    };
  } catch (e) {
    onLog({ level: 'warn', msg: `hiring derive failed for ${entry}: ${e.message || e}` });
    return { ats_vendor: null, careers_url: null, open_reqs_count: 0, departments_hiring: [], locations_hiring: [], remote_share: 0, hiring_intensity: 'none', newest_posting_at: null, error: String(e.message || e) };
  }
}

// Stable dedup key for one company record: canonical domain (lowercased apex).
export function companyKey(record) {
  const d = (record.canonical_domain || record.input_domain || '').toLowerCase().replace(/^www\./, '');
  return d || (record.company_name || '').toLowerCase().trim();
}

/**
 * Assemble the final unified enrichment record from the parts. Shapes exactly the
 * dataset_schema; fields absent in the evidence stay null (never fabricated).
 */
export function buildRecord({ input, extracted, tech, emails, phones, hiring, flags = {} }) {
  const e = extracted || {};
  const rec = {
    input_domain: String(input || '').replace(/^https?:\/\//i, '').replace(/^www\./i, '').split('/')[0] || null,
    canonical_domain: e.canonical_domain || null,
    company_name: e.company_name || null,
    legal_name_guess: e.legal_name_guess || null,
    description: e.description || null,
    industry: e.industry || null,
    founded_year: e.founded_year || null,
    employee_size_hint: e.employee_size_hint || null,
    hq_country: e.hq_country || null,
    logo_url: e.logo_url || null,
    social_links: e.social_links || [],
    tech_stack: flags.include_tech === false ? [] : (tech || []),
    _enriched_at: new Date().toISOString(),
    source_freshness: 'live', // crawled live this run (not a resold cache)
  };
  if (flags.include_contacts !== false) {
    rec.contacts = {
      emails: emails || [],
      phones: phones || [],
    };
  }
  if (flags.include_hiring !== false) {
    rec.hiring = hiring || null;
  }
  // a crawl that reached no usable page is flagged, not silently emitted as empty
  rec.enrichment_status = e.company_name || e.description || (emails && emails.length) ? 'ok' : 'thin';
  return rec;
}
