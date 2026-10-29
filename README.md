# Grey Ridge Company Enrichment MCP

[![smoke](https://github.com/rezearcher/company-enrichment-mcp/actions/workflows/smoke.yml/badge.svg)](https://github.com/rezearcher/company-enrichment-mcp/actions/workflows/smoke.yml)
[![MCP](https://img.shields.io/badge/MCP-stdio-blue)](https://modelcontextprotocol.io)
[![deps](https://img.shields.io/badge/dependencies-1-brightgreen)](package.json)

A **Model Context Protocol** server that turns a company **domain** into a live, normalized
enrichment record — for any MCP client (Claude Desktop, Cursor, Cline, Continue, or your own agent).

Give it `stripe.com` and get back, in one call, firmographics + verified business contacts + a
tech-stack fingerprint + social links **and a live hiring signal** — the buying-intent layer that
static enrichment databases can't carry:

> **company_name · industry · hq_country · tech_stack · contacts (MX-graded) · social_links ·
> hiring{ats_vendor, open_reqs, departments, locations, remote_share, intensity, newest_posting}**

- **Live from source, never a resold database.** Every field is read *this call* from the company's
  own public website, public DNS/MX, and public applicant-tracking JSON. No stale cache, no
  third-party data broker, no paid key to hold.
- **Zero keys, zero account, free COGS.** All upstreams are keyless and public.
- **The hiring signal is the moat.** The `hiring{}` block is derived live from **8 ATS platforms**
  (Greenhouse · Lever · Ashby · SmartRecruiters · Workday · Recruitee · Workable · BambooHR) — a
  real buying-intent signal (who is hiring, how hard, in which departments) that resold-DB enrichers
  do not ship because they sell static firmographics.
- **One parse dependency.** `cheerio` for robust HTML extraction — no MCP SDK, no 90-package
  transitive tree dragged into your agent's trust boundary.
- **Honest, never fabricated.** Thin crawls are flagged (`enrichment_status`), absent fields stay
  `null`, placeholder/noreply addresses are dropped.

## Install

Requires Node.js ≥ 18.

### Claude Desktop

Add to `claude_desktop_config.json` (Settings → Developer → Edit Config):

```json
{
  "mcpServers": {
    "company-enrichment": {
      "command": "npx",
      "args": ["-y", "github:rezearcher/company-enrichment-mcp"]
    }
  }
}
```

### Cursor / Cline / Continue

Point the client at the same command (`npx -y github:rezearcher/company-enrichment-mcp`) as a stdio
server. In Cursor: Settings → MCP → Add new server → type `command`.

### From source

```bash
git clone https://github.com/rezearcher/company-enrichment-mcp
cd company-enrichment-mcp
npm install
node server.mjs          # speaks MCP over stdio
npm test                 # real client handshake + live-data roundtrip
```

## Tools

| Tool | What it does |
|------|--------------|
| `enrich_company` | Full live record(s) for one or more domains: firmographics, MX-graded contacts, tech-stack fingerprint, social links, and the live hiring block. Args: `domains` (string[]), `includeHiring`/`includeContacts`/`includeTech` (default true), `maxPages` (default 4, max 12), `maxCompanies`. Deduped by canonical domain. |
| `company_hiring_signal` | **Cheap buying-intent probe** — just the live hiring block for one company, skipping the site crawl. Resolves the ATS across 8 platforms and returns open reqs, departments/locations hiring, remote share, intensity, newest posting. Args: `company` (slug or domain). |
| `check_email_domain` | Grade a domain's mail deliverability from public DNS (keyless, free). Returns `{resolves, has_mx, mx_hosts, grade}` (B/D/F). Accepts a domain or an email address. |
| `list_capabilities` | The record schema, the 8 ATS platforms, the live/keyless data policy, and the public-business-data-only legal scope. No network call. |

### Example

Ask your assistant: *"Enrich stripe.com and ramp.com, and tell me which is hiring harder."*
The model calls:

```json
{ "name": "enrich_company",
  "arguments": { "domains": ["stripe.com", "ramp.com"] } }
```

and gets back a `records[]` array — each a unified company record whose `hiring.hiring_intensity`
(`none`/`low`/`med`/`high`) and `hiring.open_reqs_count` answer the question directly.

Or, for a fast buying-intent check without the full crawl: *"Is bunq hiring right now?"* →

```json
{ "name": "company_hiring_signal", "arguments": { "company": "bunq.com" } }
```

## The record

```jsonc
{
  "input_domain": "stripe.com",
  "canonical_domain": "stripe.com",
  "company_name": "Stripe",
  "description": "...",
  "industry": "...",
  "hq_country": "US",
  "social_links": ["https://twitter.com/stripe", ...],
  "tech_stack": [ { "name": "Next.js", "category": "..." }, ... ],
  "contacts": { "emails": [ { "email": "...", "mx": true, "deliverability_grade": "B" } ], "phones": [...] },
  "hiring": {
    "ats_vendor": "greenhouse", "open_reqs_count": 725, "hiring_intensity": "high",
    "departments_hiring": [...], "locations_hiring": [...], "remote_share": 0.18,
    "newest_posting_at": "2026-10-29T..."
  },
  "source_freshness": "live",
  "enrichment_status": "ok"
}
```

## Why live-from-source (and not a resold database)

Resold-database enrichers (the common Apify/marketplace pattern) return whatever was in a broker's
last crawl — often months stale — and need a paid data key behind them. This server reads each
company *now*, from sources the buyer would otherwise have to integrate and maintain themselves: a
heterogeneous website layout, a DNS/MX posture, and eight different ATS JSON shapes that drift and
that companies migrate between. That upkeep is the point — a scheduled canary
(`.github/workflows/smoke.yml`) exercises the live path on every push and daily and fails loudly the
moment an upstream reshapes. And because the hiring block is computed live, it reflects today's open
reqs, not a snapshot — the signal a prospector actually wants.

## Legal scope

PUBLIC business data only — published firmographics, published business contact points (role
inboxes, switchboard, public social profiles), and public ATS postings. No login, no
personal/consumer PII, no scraped individual profiles, no third-party database. Respect each
source's terms and rate limits.

## License

MIT © Grey Ridge Signals Group LLC.

## Related tools (same maintained engine)

- **[company-enrichment-cli](https://github.com/rezearcher/company-enrichment-cli)** — the same
  enrichment core as a plain command-line tool (`npx github:rezearcher/company-enrichment-cli stripe.com`).
- **[jobs-mcp-server](https://github.com/rezearcher/jobs-mcp-server)** — the raw 8-ATS job feed as
  an MCP server, when you want the postings themselves rather than a company-level signal.
