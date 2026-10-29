// Email deliverability grading — FREE COGS only: a DNS MX lookup (node's built-in
// resolver, no paid API) plus an OPTIONAL best-effort SMTP RCPT probe over a raw
// TCP socket ($0). Many datacenter egress IPs have port 25 blocked, so the SMTP
// step is advisory: when it can't run or is inconclusive the grade falls back to
// the MX signal — we NEVER claim a stronger verdict than the evidence supports.
//
// Grades:
//   A  — domain has MX AND an SMTP server accepted RCPT for the address
//   B  — domain has valid MX (mailbox existence unconfirmed; SMTP blocked/skipped)
//   D  — domain resolves but has NO MX record (mail unlikely to deliver)
//   F  — domain does not resolve
// Bounded: per-lookup DNS timeout + a short SMTP socket timeout; no retries storm.

import { promises as dns } from 'node:dns';
import net from 'node:net';
import { isPublicHost } from './crawl.js';

const SMTP_TIMEOUT_MS = Number(process.env.ENRICH_SMTP_TIMEOUT_MS) || 6000;
const SMTP_FROM = process.env.ENRICH_SMTP_FROM || 'verify@example.com';

// Cache MX lookups within a run (many addresses share a domain).
const mxCache = new Map();

export async function lookupMx(domain) {
  if (mxCache.has(domain)) return mxCache.get(domain);
  let result;
  try {
    const mx = await dns.resolveMx(domain);
    if (mx && mx.length) {
      result = { hasMx: true, resolves: true, hosts: mx.sort((a, b) => a.priority - b.priority).map((m) => m.exchange) };
    } else {
      // No MX — RFC 5321 implicit A-record fallback counts as deliverable-ish.
      const a = await dns.resolve(domain).catch(() => []);
      result = { hasMx: false, resolves: a.length > 0, hosts: a.length ? [domain] : [] };
    }
  } catch (e) {
    if (e && (e.code === 'ENOTFOUND' || e.code === 'ENODATA')) {
      const a = await dns.resolve(domain).catch(() => []);
      result = { hasMx: false, resolves: a.length > 0, hosts: a.length ? [domain] : [] };
    } else {
      result = { hasMx: false, resolves: false, hosts: [], error: e.code || String(e.message || e) };
    }
  }
  mxCache.set(domain, result);
  return result;
}

// Best-effort SMTP RCPT probe. Returns 'accepted' | 'rejected' | 'inconclusive'.
// Speaks just enough SMTP: EHLO, MAIL FROM, RCPT TO, QUIT. Any socket error /
// timeout / greylist (4xx) => inconclusive (never a false negative on the grade).
export function smtpProbe(host, email, { connect = net.connect } = {}) {
  return new Promise((resolve) => {
    let stage = 0; // 0 greet,1 ehlo,2 mailfrom,3 rcpt
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; try { sock.destroy(); } catch {} resolve(v); } };
    let sock;
    try {
      sock = connect({ host, port: 25, timeout: SMTP_TIMEOUT_MS });
    } catch { return resolve('inconclusive'); }
    sock.setEncoding('utf8');
    sock.on('timeout', () => done('inconclusive'));
    sock.on('error', () => done('inconclusive'));
    let buf = '';
    sock.on('data', (chunk) => {
      buf += chunk;
      if (!buf.endsWith('\n')) return;
      const code = Number(buf.trim().slice(0, 3));
      buf = '';
      if (stage === 0) {
        if (code !== 220) return done('inconclusive');
        stage = 1; sock.write(`EHLO example.com\r\n`);
      } else if (stage === 1) {
        if (code >= 400) return done('inconclusive');
        stage = 2; sock.write(`MAIL FROM:<${SMTP_FROM}>\r\n`);
      } else if (stage === 2) {
        if (code >= 400) return done('inconclusive');
        stage = 3; sock.write(`RCPT TO:<${email}>\r\n`);
      } else if (stage === 3) {
        sock.write('QUIT\r\n');
        if (code >= 200 && code < 300) return done('accepted');
        if (code >= 500) return done('rejected');
        return done('inconclusive'); // 4xx greylist/temp
      }
    });
    sock.on('close', () => done('inconclusive'));
  });
}

/**
 * Grade a list of email objects (from extract.js). Adds mx + deliverability grade.
 * SMTP probing only runs when enableSmtp is true (default off — port 25 is usually
 * blocked on datacenter egress, and the MX grade is the honest default signal).
 */
export async function verifyEmails(emails, { enableSmtp = false } = {}) {
  const out = [];
  for (const e of emails) {
    const mx = await lookupMx(e.domain);
    let grade;
    let smtp = 'skipped';
    if (!mx.resolves) grade = 'F';
    else if (!mx.hasMx) grade = 'D';
    else grade = 'B';
    if (enableSmtp && mx.hasMx && mx.hosts[0]) {
      // SSRF guard: the MX host comes from the caller's own DNS, so a crafted
      // domain could publish an MX pointing at an internal/loopback host and turn
      // this raw TCP probe into an internal port-scan / open-relay connect. Only
      // probe hosts that resolve entirely to public addresses; otherwise skip
      // (degrade open — keep the MX-based grade, never connect).
      if (await isPublicHost(mx.hosts[0])) {
        smtp = await smtpProbe(mx.hosts[0], e.email);
        if (smtp === 'accepted') grade = 'A';
        else if (smtp === 'rejected') grade = 'F';
      } else {
        smtp = 'skipped_private_mx';
      }
    }
    out.push({
      ...e,
      mx: mx.hasMx,
      mx_host: mx.hosts[0] || null,
      smtp_check: smtp,
      deliverability_grade: grade,
    });
  }
  return out;
}
