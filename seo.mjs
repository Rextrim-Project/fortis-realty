// SEO Engine head for the static build. The engine key never reaches this repo or the browser: the build asks the Fortis
// dashboard proxy  GET {FORTIS_API}/api/public/seo?path=/route  (server-side, cached, key in the dashboard's env).
// The returned head_html is published verbatim ONLY if it passes a strict allowlist (title, meta, link, JSON-LD) and its canonical
// is this page's real URL; anything else (no FORTIS_API, non-https API, redirect, timeout, 404/503, invalid fragment) keeps the
// default Fortis head, so a page can never fail to build because of the engine.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const LOCAL = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;
const MAX = 64 * 1024;

/** The dashboard API origin is used only over https (http just for localhost). */
export const apiAllowed = (api) => { try { const u = new URL(api); return u.protocol === 'https:' || LOCAL.test(u.origin); } catch { return false; } };

// Budget: the dashboard proxy may take ~13 s on its own retries, so one 15 s attempt + one retry (only for 5xx / network).
export async function fetchSeoHead(api, route, { timeoutMs = 15000, retries = 1, fetchImpl = fetch } = {}) {
  if (!api || !apiAllowed(api)) return null;
  const url = `${api}/api/public/seo?path=${encodeURIComponent(route)}`;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt) await sleep(1000);
    try {
      const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'error', headers: { accept: 'application/json' } });
      if (res.status >= 500) continue;
      if (res.status !== 200) return null;                 // 404 / 400 / 429: no extra SEO for this page
      const text = await res.text(); if (text.length > MAX) return null;
      const j = JSON.parse(text);
      return typeof j?.head_html === 'string' && j.head_html.trim() ? j : null;
    } catch { /* network / timeout / redirect: retry */ }
  }
  return null;
}

const ATTR = /\s+([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*"([^"]*)")?/g;
const LINK_RELS = new Set(['canonical', 'alternate', 'prev', 'next', 'image_src']);
function attrs(s) { const out = {}; const rest = s.replace(ATTR, (m, k, v) => { out[k.toLowerCase()] = v ?? ''; return ''; }); return rest.trim() ? null : out; }
const safeUrl = (v) => /^https?:\/\//i.test(v);
/**
 * Strict allowlist for the engine fragment: <title>text</title>, <meta name|property content>, <link rel=canonical|alternate|… href=https>,
 * <script type="application/ld+json">JSON</script>. No other element, no event handler, no http-equiv, no javascript:/data: URLs.
 * Returns { ok, canonical } (the canonical href, if any) or { ok: false, reason }.
 */
export function validateHead(head) {
  if (typeof head !== 'string' || head.length > MAX) return { ok: false, reason: 'size' };
  let canonical = null, rest = head;
  rest = rest.replace(/<title>([^<]*)<\/title>/g, () => '');
  rest = rest.replace(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g, (m, json) => { try { JSON.parse(json); return /<\//.test(json) ? m : ''; } catch { return m; } });
  let bad = null;
  rest = rest.replace(/<(meta|link)\b([^<>]*?)\/?>/g, (m, tag, a) => {
    const at = attrs(a); if (!at) { bad = `${tag} attributes`; return m; }
    for (const [k, v] of Object.entries(at)) if (/^on/i.test(k) || /^\s*(javascript|data|vbscript):/i.test(v)) { bad = `${tag} ${k}`; return m; }
    if (tag === 'meta') { const keys = Object.keys(at); if (!keys.every((k) => ['name', 'property', 'content'].includes(k)) || !('content' in at) || !(at.name || at.property)) bad = 'meta shape'; }
    else { if (!LINK_RELS.has((at.rel ?? '').toLowerCase()) || !safeUrl(at.href ?? '') || !Object.keys(at).every((k) => ['rel', 'href', 'hreflang', 'type', 'title'].includes(k))) bad = 'link shape'; else if (at.rel.toLowerCase() === 'canonical') canonical = at.href; }
    return '';
  });
  if (bad) return { ok: false, reason: bad };
  if (rest.trim()) return { ok: false, reason: `unexpected markup: ${rest.trim().slice(0, 40)}` };
  return { ok: true, canonical };
}

const norm = (u) => { try { const x = new URL(u); return x.origin + (x.pathname.replace(/\/+$/, '') || '/'); } catch { return null; } };
/** The canonical must be the page's own public URL (origin + base path + route); otherwise the default head is kept. */
export const canonicalMatches = (canonical, pageUrl) => !canonical || (norm(canonical) !== null && norm(canonical) === norm(pageUrl));

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/**
 * Puts head_html verbatim at the very start of <head> (so the title guard picks up the SEO title) and removes from the template
 * only the tags it really replaces: the title, and each meta / canonical / JSON-LD with the SAME identity (name, property, rel).
 */
export function applySeoHead(html, headHtml) {
  if (!headHtml || !/<head[^>]*>/.test(html)) return html;
  if (/<title>/.test(headHtml)) html = html.replace(/<title>[^<]*<\/title>/g, '');
  for (const [, kind, key] of headHtml.matchAll(/<meta\b[^>]*?\b(name|property)="([^"]+)"/g)) html = html.replace(new RegExp(`<meta\\b[^>]*\\b${kind}="${esc(key)}"[^>]*>`, 'g'), '');
  if (/<link\b[^>]*rel="canonical"/.test(headHtml)) html = html.replace(/<link\b[^>]*rel="canonical"[^>]*>/g, '');
  if (headHtml.includes('application/ld+json')) html = html.replace(/<script type="application\/ld\+json">[\s\S]*?<\/script>/g, '');
  return html.replace(/<head([^>]*)>/, (m) => `${m}<meta name="fr-seo" content="engine">${headHtml}`);
}

/** Runs fn over items with at most `limit` (<= 5) in flight. */
export async function pool(items, limit, fn) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(Math.max(1, Math.min(5, limit)), items.length) }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k]); } }));
  return out;
}
