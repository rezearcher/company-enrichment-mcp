// Firmographic + contact extraction from a company's own public pages.
// Pure parsing (cheerio + regex over the crawled HTML) — no network. Every field
// degrades to null when absent; nothing is fabricated. Signals are merged across
// the crawled pages with a first-non-empty / richest-wins policy.

import * as cheerio from 'cheerio';

const SOCIAL_HOSTS = {
  'linkedin.com': 'linkedin',
  'twitter.com': 'twitter',
  'x.com': 'twitter',
  'facebook.com': 'facebook',
  'instagram.com': 'instagram',
  'youtube.com': 'youtube',
  'github.com': 'github',
  'tiktok.com': 'tiktok',
  'crunchbase.com': 'crunchbase',
  'medium.com': 'medium',
  'pinterest.com': 'pinterest',
  'discord.com': 'discord',
  'discord.gg': 'discord',
  't.me': 'telegram',
};

// Obvious non-business / noreply addresses we never surface as a usable contact.
const JUNK_EMAIL = /@(?:example|sentry|wixpress|godaddy|sentry\.io|email\.com|domain\.com)/i;
const ROLE_LOCALPARTS = /^(?:info|contact|hello|hi|sales|support|help|press|media|careers|jobs|hr|admin|office|team|partnerships?|bd|enquir(?:y|ies)|general)$/i;

function absUrl(href, base) {
  try { return new URL(href, base).toString(); } catch { return null; }
}

function first(...vals) {
  for (const v of vals) if (v && String(v).trim()) return String(v).trim();
  return null;
}

// --- individual field extractors (operate on a loaded cheerio $) -----------

function metaContent($, names) {
  for (const n of names) {
    const byProp = $(`meta[property="${n}"]`).attr('content');
    if (byProp) return byProp.trim();
    const byName = $(`meta[name="${n}"]`).attr('content');
    if (byName) return byName.trim();
  }
  return null;
}

function jsonLdOrgs($) {
  const orgs = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    const txt = $(el).contents().text();
    if (!txt) return;
    let data;
    try { data = JSON.parse(txt); } catch { return; }
    const items = Array.isArray(data) ? data : (data['@graph'] && Array.isArray(data['@graph']) ? data['@graph'] : [data]);
    for (const it of items) {
      if (!it || typeof it !== 'object') continue;
      const t = it['@type'];
      const types = Array.isArray(t) ? t : [t];
      if (types.some((x) => /Organization|Corporation|LocalBusiness/i.test(String(x || '')))) orgs.push(it);
    }
  });
  return orgs;
}

const EMAIL_RE = /\b[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}\b/gi;
// E.164-ish international / NANP phone capture (kept conservative to avoid IDs).
const PHONE_RE = /(?:(?:\+\d{1,3}[\s.-]?)?(?:\(\d{2,4}\)[\s.-]?)?\d{2,4}[\s.-]?\d{3,4}[\s.-]?\d{3,4})/g;

function extractEmails($, html) {
  const out = new Set();
  $('a[href^="mailto:"]').each((_, el) => {
    const h = ($(el).attr('href') || '').replace(/^mailto:/i, '').split('?')[0].trim().toLowerCase();
    if (h) out.add(h);
  });
  const text = html.replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<script[\s\S]*?<\/script>/gi, ' ');
  const m = text.match(EMAIL_RE) || [];
  for (const e of m) out.add(e.toLowerCase());
  return [...out].filter((e) => !JUNK_EMAIL.test(e) && !/\.(png|jpg|jpeg|gif|svg|webp)$/i.test(e));
}

function toE164(raw, defaultCc = '') {
  const digits = raw.replace(/[^\d+]/g, '');
  if (digits.startsWith('+')) {
    const d = '+' + digits.slice(1).replace(/\D/g, '');
    return d.length >= 9 && d.length <= 16 ? d : null;
  }
  const bare = digits.replace(/\D/g, '');
  if (bare.length === 10 && defaultCc === '1') return `+1${bare}`;
  if (bare.length === 11 && bare.startsWith('1')) return `+${bare}`;
  return null; // ambiguous without a country code — drop rather than guess wrong
}

function extractPhones($, html) {
  const out = new Set();
  $('a[href^="tel:"]').each((_, el) => {
    const h = ($(el).attr('href') || '').replace(/^tel:/i, '').trim();
    const e164 = toE164(h);
    if (e164) out.add(e164);
  });
  // text phones only when clearly international (leading +) to avoid grabbing IDs/dates
  const text = html.replace(/<[^>]+>/g, ' ');
  const m = text.match(/\+\d[\d\s().-]{7,16}\d/g) || [];
  for (const p of m) { const e = toE164(p); if (e) out.add(e); }
  return [...out];
}

function classifyEmail(email) {
  const local = email.split('@')[0];
  const role = ROLE_LOCALPARTS.test(local);
  return { email, type: role ? 'role' : 'personal', local_part: local, domain: email.split('@')[1] };
}

function extractSocial($, base) {
  const out = {};
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href');
    const abs = absUrl(href, base);
    if (!abs) return;
    let host;
    try { host = new URL(abs).hostname.replace(/^www\./, '').toLowerCase(); } catch { return; }
    for (const [h, name] of Object.entries(SOCIAL_HOSTS)) {
      if (host === h || host.endsWith(`.${h}`)) {
        // keep the first/cleanest link per network
        if (!out[name]) out[name] = abs.split('?')[0];
      }
    }
  });
  return Object.entries(out).map(([network, url]) => ({ network, url }));
}

const COUNTRY_HINTS = [
  [/\bunited states|u\.?s\.?a?\b|,\s*(?:CA|NY|TX|WA|MA|IL)\b/i, 'US'],
  [/\bunited kingdom|london|england\b/i, 'GB'],
  [/\bcanada|ontario|toronto\b/i, 'CA'],
  [/\bgermany|deutschland|berlin|münchen\b/i, 'DE'],
  [/\bfrance|paris\b/i, 'FR'],
  [/\bnetherlands|amsterdam\b/i, 'NL'],
  [/\bireland|dublin\b/i, 'IE'],
  [/\baustralia|sydney|melbourne\b/i, 'AU'],
  [/\bindia|bengaluru|bangalore|mumbai\b/i, 'IN'],
  [/\bsingapore\b/i, 'SG'],
];

function guessCountry(text, jsonLd) {
  for (const org of jsonLd) {
    const addr = org.address;
    if (addr && typeof addr === 'object') {
      const cc = addr.addressCountry;
      if (typeof cc === 'string' && cc.trim()) return cc.trim().slice(0, 2).toUpperCase();
      if (cc && cc.name) return String(cc.name).slice(0, 2).toUpperCase();
    }
  }
  const sample = text.slice(0, 20000);
  for (const [re, cc] of COUNTRY_HINTS) if (re.test(sample)) return cc;
  return null;
}

/**
 * Extract firmographics + contacts from a crawled company (crawl.js output).
 * Returns the raw extracted block (normalize.js shapes the final record).
 */
export function extractCompany({ origin, host, pages }) {
  const good = (pages || []).filter((p) => p && p.html && p.status && p.status < 400);
  if (!good.length) return null;

  // Homepage first for title/meta priority; remaining pages enrich.
  const home = good[0];
  const $home = cheerio.load(home.html);
  const orgs = jsonLdOrgs($home);
  const org = orgs[0] || {};

  // Prefer the brand/common name (og:site_name, then <title> brand segment) over
  // the schema.org legal name — the "Inc./LLC" form is surfaced as legal_name_guess.
  const title = first(
    metaContent($home, ['og:site_name']),
    ($home('title').first().text() || '').split(/[|\-–—:·]/)[0],
    org.name,
  );
  const description = first(
    org.description,
    metaContent($home, ['og:description', 'description', 'twitter:description']),
  );
  const logo_url = first(
    typeof org.logo === 'string' ? org.logo : org.logo && org.logo.url,
    metaContent($home, ['og:image']),
    absUrl($home('link[rel="icon"], link[rel="shortcut icon"]').first().attr('href'), home.finalUrl || origin),
  );

  // Aggregate text across pages for regex-based fields.
  let allText = '';
  const emails = new Set();
  const phones = new Set();
  const socialByNet = {};
  let legal_name_guess = null;
  let founded_year = null;
  let employee_size_hint = null;

  for (const p of good) {
    const $ = cheerio.load(p.html);
    const base = p.finalUrl || p.url || origin;
    for (const e of extractEmails($, p.html)) emails.add(e);
    for (const ph of extractPhones($, p.html)) phones.add(ph);
    for (const s of extractSocial($, base)) if (!socialByNet[s.network]) socialByNet[s.network] = s.url;
    const text = p.html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ');
    allText += ' ' + text;

    if (!legal_name_guess) {
      const cp = text.match(/©\s*(?:\d{4}(?:\s*[-–]\s*\d{4})?\s+)?([A-Z][A-Za-z0-9&.,'’\- ]{1,60}?(?:,?\s(?:Inc|LLC|Ltd|GmbH|Limited|Corp|Corporation|Co|B\.?V|S\.?A|Pty|Plc)\.?))/);
      if (cp) legal_name_guess = cp[1].replace(/\s+/g, ' ').trim();
    }
    if (!founded_year) {
      const fy = text.match(/\b(?:founded|established|est\.?|since)\b[^.\d]{0,12}(\b(?:18|19|20)\d{2}\b)/i);
      if (fy) { const y = Number(fy[1]); if (y >= 1800 && y <= new Date().getFullYear()) founded_year = y; }
    }
    if (!employee_size_hint) {
      const es = text.match(/\b([\d,]{2,7}\+?)\s+(?:employees|team members|people|staff)\b/i);
      if (es) employee_size_hint = es[1].replace(/,/g, '') + (es[1].includes('+') ? '' : '');
    }
  }

  const emailObjs = [...emails].map(classifyEmail);
  const country = guessCountry(allText, orgs);
  const industry = first(
    Array.isArray(org.industry) ? org.industry[0] : org.industry,
    metaContent($home, ['industry']),
  );

  return {
    canonical_domain: host,
    origin,
    company_name: title,
    legal_name_guess,
    description: description ? description.slice(0, 600) : null,
    industry: industry || null,
    founded_year,
    employee_size_hint: employee_size_hint || null,
    hq_country: country,
    logo_url: logo_url || null,
    social_links: Object.entries(socialByNet).map(([network, url]) => ({ network, url })),
    emails: emailObjs,
    phones: [...phones],
    pages_crawled: good.length,
  };
}
