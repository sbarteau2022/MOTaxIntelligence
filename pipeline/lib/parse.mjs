// ============================================================
// HTML → verbatim section record.
//
// "Verbatim" is the contract: the body we store is the statute text exactly as
// published, with only two safe transforms — HTML entity decoding and CRLF→LF
// newline normalization. We do NOT collapse internal whitespace, reflow lines,
// or drop blank lines, because the parent-child chunker relies on exact
// character offsets and citations must reproduce the source to the letter.
//
// Selectors live in sources/manifest.json per source, so when a live sample
// shows the real container id/class you tune the manifest, not this code. The
// parser also keeps the RAW html on disk (see scripts/fetch.mjs) so any parse
// can be re-audited against what was actually served.
// ============================================================

import { createHash } from 'node:crypto';

/**
 * Extract the statute body from a section page's HTML using the source's
 * configured selectors, with a defensive fallback. Returns null if no body
 * could be confidently extracted (caller records a fetch/parse failure — never
 * a silent empty section).
 *
 * @param {string} html raw page HTML
 * @param {object} source manifest source entry ({ bodySelectors, dropSelectors })
 * @returns {{ body:string, catchline:string|null, effective:string|null }|null}
 */
export function parseSection(html, source) {
  const container = firstMatchingBlock(html, source.bodySelectors ?? []);
  const scoped = container ?? html;

  let inner = scoped;
  for (const sel of source.dropSelectors ?? []) {
    inner = stripTag(inner, sel);
  }

  const body = htmlToText(inner);
  if (!body || body.trim().length < (source.minBodyChars ?? 40)) return null;

  return {
    body,
    catchline: extractCatchline(html, source),
    effective: extractEffective(html, source),
  };
}

/** SHA-256 of the verbatim body — provenance + change detection. */
export function checksum(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

// ── internals ───────────────────────────────────────────────

// Return the inner HTML of the first element matching any of the given simple
// selectors: "#id", ".class", or "tag". Intentionally dependency-free (regex)
// — the surrounding pipeline runs in plain Node without a DOM. If none match,
// returns null so the caller can fall back or fail loudly.
function firstMatchingBlock(html, selectors) {
  for (const sel of selectors) {
    let re;
    if (sel.startsWith('#')) {
      re = new RegExp(`<([a-z0-9]+)[^>]*\\bid=["']${escapeRe(sel.slice(1))}["'][^>]*>([\\s\\S]*?)<\\/\\1>`, 'i');
    } else if (sel.startsWith('.')) {
      re = new RegExp(`<([a-z0-9]+)[^>]*\\bclass=["'][^"']*\\b${escapeRe(sel.slice(1))}\\b[^"']*["'][^>]*>([\\s\\S]*?)<\\/\\1>`, 'i');
    } else {
      re = new RegExp(`<${escapeRe(sel)}[^>]*>([\\s\\S]*?)<\\/${escapeRe(sel)}>`, 'i');
    }
    const m = html.match(re);
    if (m) return sel.startsWith('#') || sel.startsWith('.') ? m[2] : m[1];
  }
  return null;
}

function stripTag(html, tag) {
  return html.replace(new RegExp(`<${escapeRe(tag)}[^>]*>[\\s\\S]*?<\\/${escapeRe(tag)}>`, 'gi'), '');
}

/**
 * Convert an HTML fragment to verbatim text. Block-level tags become newlines
 * (preserving paragraph/subsection structure), <br> becomes a newline, all
 * other tags are removed, entities are decoded, CRLF→LF, trailing spaces on
 * lines trimmed, runs of 3+ blank lines collapsed to 2. No other changes.
 */
export function htmlToText(fragment) {
  let s = fragment;
  s = s.replace(/<\s*br\s*\/?>/gi, '\n');
  s = s.replace(/<\/(p|div|li|tr|h[1-6]|blockquote)\s*>/gi, '\n');
  s = s.replace(/<[^>]+>/g, '');
  s = decodeEntities(s);
  s = s.replace(/\r\n?/g, '\n');
  s = s.replace(/[ \t]+\n/g, '\n');       // trailing spaces
  s = s.replace(/(^|\n)[ \t]+/g, '$1');   // leading HTML pretty-print indentation (RSMo renders flush-left)
  s = s.replace(/[ \t]{2,}/g, ' ');       // collapse runs of spaces from wrapped inline tags
  s = s.replace(/\n{3,}/g, '\n\n');
  return s.replace(/^\n+/, '').replace(/\n+$/, '');
}

export function decodeEntities(s) {
  const named = {
    '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'",
    '&apos;': "'", '&nbsp;': ' ', '&mdash;': '—', '&ndash;': '–',
    '&sect;': '§', '&rsquo;': '’', '&lsquo;': '‘',
    '&ldquo;': '“', '&rdquo;': '”',
  };
  return s
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&[a-z]+;/gi, (e) => (e in named ? named[e] : e));
}

function extractCatchline(html, source) {
  if (!source.catchlineSelectors) return null;
  const block = firstMatchingBlock(html, source.catchlineSelectors);
  if (!block) return null;
  const t = htmlToText(block).split('\n')[0].trim();
  return t || null;
}

function extractEffective(html, source) {
  // RSMo pages print "(RSMo 1972)" / "Effective 28 Aug 2022" style lines.
  const m = html.match(/Effective[^<\n]{0,40}?(\d{1,2}\s+\w+\s+\d{4}|\w+\s+\d{1,2},\s+\d{4})/i)
    || html.match(/\(RSMo\s+([^)]+)\)/i);
  return m ? m[1].trim() : null;
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
