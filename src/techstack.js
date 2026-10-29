// Wappalyzer-style tech-stack fingerprint from the crawled HTML + response
// headers. The signature table is DATA (a detection fingerprint DB, like
// Wappalyzer's) — not a behaviour-gating hardcoded list: adding/removing a
// signature never changes control flow, it only widens coverage, and a miss
// degrades open (returns [] for that tech, never errors). Each signature is a
// cheap regex over html / a header value / a cookie name.

export const SIGNATURES = [
  // --- analytics / tag managers ---
  { name: 'Google Analytics', cat: 'analytics', html: /www\.google-analytics\.com|gtag\(|googletagmanager\.com\/gtag/i },
  { name: 'Google Tag Manager', cat: 'tag-manager', html: /googletagmanager\.com\/gtm\.js|dataLayer\s*=/i },
  { name: 'Segment', cat: 'analytics', html: /cdn\.segment\.com\/analytics\.js|analytics\.track\(/i },
  { name: 'HubSpot', cat: 'marketing', html: /js\.hs-scripts\.com|hubspot\.com\/|hs-analytics/i },
  { name: 'Hotjar', cat: 'analytics', html: /static\.hotjar\.com|hjSetting/i },
  { name: 'Mixpanel', cat: 'analytics', html: /cdn\.mxpnl\.com|mixpanel\.init/i },
  { name: 'Amplitude', cat: 'analytics', html: /cdn\.amplitude\.com|amplitude\.getInstance/i },
  // --- CMS / site builders ---
  { name: 'WordPress', cat: 'cms', html: /wp-content\/|wp-includes\/|\/wp-json\//i },
  { name: 'Webflow', cat: 'cms', html: /assets\.website-files\.com|data-wf-page|\.webflow\./i },
  { name: 'Wix', cat: 'cms', html: /static\.wixstatic\.com|X-Wix-/i, header: { 'x-wix-request-id': /.+/i } },
  { name: 'Squarespace', cat: 'cms', html: /squarespace\.com|static1\.squarespace/i },
  { name: 'Shopify', cat: 'ecommerce', html: /cdn\.shopify\.com|Shopify\.theme|myshopify\.com/i, header: { 'x-shopify-stage': /.+/i } },
  { name: 'Framer', cat: 'cms', html: /framerusercontent\.com|data-framer/i },
  { name: 'Ghost', cat: 'cms', html: /content\/themes\/|ghost\.io|data-ghost/i },
  { name: 'HubSpot CMS', cat: 'cms', html: /hs-sites\.com|hubspotusercontent/i },
  // --- JS frameworks ---
  { name: 'React', cat: 'js-framework', html: /data-reactroot|react(?:-dom)?(?:\.production)?\.min\.js|__NEXT_DATA__/i },
  { name: 'Next.js', cat: 'js-framework', html: /\/_next\/static\/|__NEXT_DATA__/i, header: { 'x-powered-by': /Next\.js/i } },
  { name: 'Vue.js', cat: 'js-framework', html: /vue(?:\.runtime)?(?:\.min)?\.js|data-v-[0-9a-f]{8}|__NUXT__/i },
  { name: 'Nuxt', cat: 'js-framework', html: /__NUXT__|\/_nuxt\//i },
  { name: 'Angular', cat: 'js-framework', html: /ng-version=|angular(?:\.min)?\.js/i },
  { name: 'Svelte', cat: 'js-framework', html: /svelte-[0-9a-z]{6}|__sveltekit/i },
  { name: 'Gatsby', cat: 'js-framework', html: /gatsby|___gatsby/i },
  // --- infra / hosting / CDN (header-led) ---
  { name: 'Cloudflare', cat: 'cdn', header: { server: /cloudflare/i, 'cf-ray': /.+/i } },
  { name: 'Vercel', cat: 'hosting', header: { server: /Vercel/i, 'x-vercel-id': /.+/i } },
  { name: 'Netlify', cat: 'hosting', header: { server: /Netlify/i, 'x-nf-request-id': /.+/i } },
  { name: 'AWS CloudFront', cat: 'cdn', header: { via: /cloudfront/i, 'x-amz-cf-id': /.+/i } },
  { name: 'Fastly', cat: 'cdn', header: { 'x-served-by': /cache-/i, 'x-fastly-request-id': /.+/i } },
  { name: 'Nginx', cat: 'web-server', header: { server: /nginx/i } },
  { name: 'Apache', cat: 'web-server', header: { server: /apache/i } },
  { name: 'Google Cloud', cat: 'hosting', header: { server: /Google Frontend|gws/i } },
  // --- marketing / support / commerce widgets ---
  { name: 'Intercom', cat: 'support', html: /widget\.intercom\.io|intercomSettings/i },
  { name: 'Drift', cat: 'support', html: /js\.driftt\.com|drift\.load/i },
  { name: 'Zendesk', cat: 'support', html: /static\.zdassets\.com|zendesk\.com\/embeddable/i },
  { name: 'Stripe', cat: 'payments', html: /js\.stripe\.com|Stripe\(/i },
  { name: 'Marketo', cat: 'marketing', html: /munchkin\.marketo|mktoForms/i },
  { name: 'Salesforce', cat: 'crm', html: /force\.com|salesforce\.com\/|pardot/i },
  { name: 'Typeform', cat: 'forms', html: /embed\.typeform\.com/i },
  { name: 'Calendly', cat: 'scheduling', html: /assets\.calendly\.com/i },
];

/**
 * Fingerprint the crawled company. Scans every page's html + every response's
 * headers. Returns a sorted, deduped list of { name, category } detected.
 */
export function fingerprint({ pages }) {
  const good = (pages || []).filter((p) => p && (p.html || p.headers));
  const hits = new Map();

  for (const p of good) {
    const html = p.html || '';
    const headers = p.headers || {};
    for (const sig of SIGNATURES) {
      if (hits.has(sig.name)) continue;
      let matched = false;
      if (sig.html && sig.html.test(html)) matched = true;
      if (!matched && sig.header) {
        for (const [hk, hv] of Object.entries(sig.header)) {
          const val = headers[hk.toLowerCase()];
          if (val && hv.test(val)) { matched = true; break; }
        }
      }
      if (matched) hits.set(sig.name, sig.cat);
    }
  }
  return [...hits.entries()]
    .map(([name, category]) => ({ name, category }))
    .sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));
}
