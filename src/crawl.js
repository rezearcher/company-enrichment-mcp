// Bounded, keyless HTTP crawl of a company's OWN public website.
//
// HTTP-first (native fetch with a realistic browser UA) — the common path for the
// vast majority of company marketing sites. A JS-rendered-only site is the
// documented Playwright fallback (see README "JS-required pages"); v0.1 keeps the
// core dependency-light so it runs instantly via plain node and the live test
// needs no browser. We fetch the homepage, then a small, capped set of the
// high-signal internal pages (/about, /contact, /company, careers, team) that the
// site itself links to — never an unbounded whole-site crawl.
//
// Bounded-downside law (convex barbell): every fetch carries a hard request
// timeout AND a response-size ceiling (slow-loris / OOM guard), and the whole
// crawl is capped at maxPagesPerCompany pages. An SSRF guard rejects private /
// loopback / link-local hosts so a caller-supplied "domain" can never pivot the
// runner into the internal network.

import { promises as dns } from 'node:dns';
import net from 'node:net';

const REQUEST_TIMEOUT_MS = Number(process.env.ENRICH_REQUEST_TIMEOUT_MS) || 20000;
const MAX_RESPONSE_BYTES = Number(process.env.ENRICH_MAX_RESPONSE_BYTES) || 5 * 1024 * 1024; // 5 MB/page
const MAX_REDIRECTS = Number(process.env.ENRICH_MAX_REDIRECTS) || 5;
const UA =
  process.env.ENRICH_USER_AGENT ||
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36';

// High-signal internal paths probed after the homepage (order = priority).
const CANDIDATE_PATHS = [
  '/about', '/about-us', '/company', '/contact', '/contact-us',
  '/team', '/careers', '/jobs', '/legal/privacy', '/imprint',
];

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 169 && b === 254) return true; // link-local
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    return false;
  }
  const low = ip.toLowerCase();
  // IPv6 loopback / link-local / unique-local
  return low === '::1' || low.startsWith('fe80') || low.startsWith('fc') || low.startsWith('fd') || low === '::';
}

// Resolve host and reject if it points at a private/loopback address (SSRF guard).
async function assertPublicHost(host) {
  if (!host) throw new Error('empty host');
  if (net.isIP(host) && isPrivateIp(host)) throw new Error(`refusing private host ${host}`);
  if (/^(localhost|.*\.local|.*\.internal)$/i.test(host)) throw new Error(`refusing internal host ${host}`);
  let addrs = [];
  try {
    addrs = await dns.lookup(host, { all: true });
  } catch {
    // DNS failure surfaces later as a fetch error; don't block on resolver flakiness.
    return;
  }
  for (const { address } of addrs) {
    if (isPrivateIp(address)) throw new Error(`refusing host ${host} resolving to private ${address}`);
  }
}

// Boolean form of the SSRF guard for non-fetch sinks (e.g. the SMTP probe in
// verify.js that opens a raw TCP socket to an MX host taken from caller-controlled
// DNS). Returns true only if the host is a name/IP that resolves ENTIRELY to
// public addresses. Any failure / private hop => false (fail closed).
export async function isPublicHost(host) {
  try {
    if (!host) return false;
    if (net.isIP(host) && isPrivateIp(host)) return false;
    if (/^(localhost|.*\.local|.*\.internal)$/i.test(host)) return false;
    if (net.isIP(host)) return true; // public literal IP
    const addrs = await dns.lookup(host, { all: true });
    if (!addrs.length) return false;
    return addrs.every(({ address }) => !isPrivateIp(address));
  } catch {
    return false;
  }
}

function readCapped(res, url) {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    throw new Error(`response too large (${declared} bytes) for ${url}`);
  }
  if (!res.body || typeof res.body.getReader !== 'function') return res.text();
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  return (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.length;
        if (total > MAX_RESPONSE_BYTES) throw new Error(`response exceeded ${MAX_RESPONSE_BYTES} bytes for ${url}`);
        chunks.push(value);
      }
    } finally {
      try { await reader.cancel(); } catch { /* already closed */ }
    }
    return Buffer.concat(chunks).toString('utf8');
  })();
}

// Validate one hop (protocol + SSRF guard) before any fetch leaves the process.
async function assertFetchable(u) {
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error(`refusing non-http(s) ${u.href}`);
  await assertPublicHost(u.hostname);
}

// Fetch one URL under timeout + size bound. Returns {url, finalUrl, status, html,
// headers} or throws. Only text/html (and unknown) content is returned as html.
//
// Redirects are followed MANUALLY (redirect:'manual') so every hop's target is
// re-validated through the SSRF guard. Native redirect:'follow' re-resolves the
// Location host itself and would let a public site 302 the runner to an internal
// address (http://169.254.169.254/ cloud metadata, 127.0.0.1, 10.x) — the initial
// assertPublicHost only sees the first host, not the redirect target. The timeout
// bounds the WHOLE chain, and MAX_REDIRECTS bounds the hop count.
export async function fetchPage(url, { fetchImpl = fetch } = {}) {
  let current = new URL(url);
  await assertFetchable(current);

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), REQUEST_TIMEOUT_MS);
  try {
    for (let hop = 0; ; hop++) {
      const res = await fetchImpl(current.href, {
        signal: ctl.signal,
        redirect: 'manual',
        headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml,*/*;q=0.8' },
      });
      const status = res.status;
      const location = typeof res.headers.get === 'function' ? res.headers.get('location') : null;
      // 3xx with a Location: validate the target host through the SSRF guard, then hop.
      if (status >= 300 && status < 400 && location) {
        if (hop >= MAX_REDIRECTS) throw new Error(`too many redirects (>${MAX_REDIRECTS}) from ${url}`);
        let next;
        try { next = new URL(location, current); } catch { throw new Error(`bad redirect target "${location}" from ${current.href}`); }
        await assertFetchable(next); // re-run SSRF guard on EVERY hop — the fix
        if (typeof res.body?.cancel === 'function') { try { await res.body.cancel(); } catch { /* drained */ } }
        current = next;
        continue;
      }
      const ctype = (res.headers.get('content-type') || '').toLowerCase();
      const headers = {};
      res.headers.forEach((v, k) => { headers[k] = v; });
      const isHtml = !ctype || ctype.includes('html') || ctype.includes('xml') || ctype.includes('text');
      const html = isHtml ? await readCapped(res, current.href) : '';
      return { url, finalUrl: res.url || current.href, status, html, headers, contentType: ctype };
    }
  } catch (e) {
    if (e && e.name === 'AbortError') throw new Error(`timed out after ${REQUEST_TIMEOUT_MS}ms for ${url}`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// Normalize a user entry (domain / URL / bare name) to a base https origin + the
// bare registrable-ish host label. Best-effort: a bare name with no dot is left
// for the caller to treat as name->domain (we don't guess TLDs here).
export function toOrigin(entry) {
  const raw = String(entry || '').trim();
  if (!raw) return null;
  let host = raw.replace(/^https?:\/\//i, '').replace(/^www\./i, '').split('/')[0].split('?')[0];
  if (!host.includes('.')) return null; // bare name — not a domain
  return { origin: `https://${host}`, host };
}

// Discover up to `limit` same-host internal links from a homepage's HTML, biased
// toward the high-signal CANDIDATE_PATHS, then any footer/nav links.
export function discoverLinks(homeHtml, origin, limit) {
  const host = new URL(origin).hostname;
  const found = new Set();
  const hrefRe = /<a\b[^>]*\bhref\s*=\s*["']([^"'#]+)["']/gi;
  let m;
  const all = [];
  while ((m = hrefRe.exec(homeHtml)) && all.length < 400) {
    let href = m[1].trim();
    if (!href || href.startsWith('mailto:') || href.startsWith('tel:') || href.startsWith('javascript:')) continue;
    try {
      const abs = new URL(href, origin);
      if (abs.hostname !== host && abs.hostname !== `www.${host}`) continue;
      const path = abs.pathname.toLowerCase().replace(/\/+$/, '') || '/';
      if (path === '/') continue;
      all.push(abs.origin + abs.pathname);
    } catch { /* skip malformed */ }
  }
  // priority: explicit candidate paths first
  for (const p of CANDIDATE_PATHS) {
    const match = all.find((x) => new URL(x).pathname.toLowerCase().replace(/\/+$/, '') === p);
    if (match && !found.has(match)) found.add(match);
    if (found.size >= limit) break;
  }
  // then fill with any other internal links (first-seen order)
  for (const x of all) {
    if (found.size >= limit) break;
    found.add(x);
  }
  return [...found].slice(0, limit);
}

/**
 * Crawl one company. Returns { origin, host, pages: [{url,status,html,headers}],
 * errors: [] }. Bounded by maxPages (homepage counts as one).
 */
export async function crawlCompany(entry, { maxPages = 4, fetchImpl = fetch } = {}) {
  const resolved = toOrigin(entry);
  if (!resolved) return { origin: null, host: null, pages: [], errors: [`"${entry}" is not a domain`] };
  const { origin, host } = resolved;
  const pages = [];
  const errors = [];

  let home;
  try {
    home = await fetchPage(origin, { fetchImpl });
    pages.push(home);
  } catch (e) {
    // retry once over http:// for sites that don't serve https on the apex
    try {
      home = await fetchPage(origin.replace('https://', 'http://'), { fetchImpl });
      pages.push(home);
    } catch (e2) {
      return { origin, host, pages, errors: [String(e.message || e)] };
    }
  }

  const budget = Math.max(1, Number(maxPages) || 4) - 1;
  if (budget > 0 && home.html) {
    const links = discoverLinks(home.html, home.finalUrl || origin, budget);
    for (const link of links) {
      try {
        pages.push(await fetchPage(link, { fetchImpl }));
      } catch (e) {
        errors.push(`${link}: ${String(e.message || e)}`);
      }
    }
  }
  return { origin, host, pages, errors };
}
