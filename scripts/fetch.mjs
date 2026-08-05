#!/usr/bin/env node
// ============================================================
// STAGE 1 — FETCH. Pull raw section HTML to data/raw/ with provenance.
//
// Design notes:
//  • Both statute sources resist headless access: revisor.mo.gov renders its
//    section list via JS/bot-protection, and justia sits behind Cloudflare
//    (403s a plain fetch). Both are fetched with a real browser (Playwright,
//    driving the pre-installed Chromium). justia is the working default;
//    revisor stays available via --source revisor to harden interactively.
//  • Resumable: a section already on disk with a matching non-empty body is
//    skipped unless --force. Re-running after a partial pull just fills gaps.
//  • Raw HTML is archived verbatim so every later parse is auditable and the
//    verbatim/citation guarantee is reproducible.
//  • Slow on purpose (per-source rateLimitMs). "The script taking time" is
//    acceptable; getting rate-limited or IP-blocked is not.
//
// Usage:
//   node scripts/fetch.mjs                       # all chapters, default source (justia)
//   node scripts/fetch.mjs --source revisor      # official source (JS-rendered; harden later)
//   node scripts/fetch.mjs --source supplemental # DOR guidance FAQ pages
//   node scripts/fetch.mjs --source regulations  # 12 CSR 10 (PDF)
//   node scripts/fetch.mjs --chapter 143         # one chapter (statute sources only)
//   node scripts/fetch.mjs --force               # re-fetch even if cached
// ============================================================

import { readFile, mkdir, writeFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// sha256 of the raw bytes exactly as served (before any HTML/PDF extraction).
// Stored in each .meta.json as `raw_checksum` and carried through to D1 so
// the deployed Worker's cron can re-fetch a plain-fetchable source_url later
// and detect drift without re-implementing extraction inside the Worker.
function rawChecksum(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

const ROOT = path.resolve(fileURLToPath(import.meta.url), '../..');
const RAW = path.join(ROOT, 'data', 'raw');

const args = parseArgs(process.argv.slice(2));

async function main() {
  const manifest = JSON.parse(await readFile(path.join(ROOT, 'sources', 'manifest.json'), 'utf8'));
  // Default statute source is justia: revisor.mo.gov renders its section list
  // via JS and is bot-protected, so a headless pull sees no section links.
  // justia (via a real browser, see makeFetcher) yields the full lists.
  const sourceKey = args.source ?? 'justia';

  if (sourceKey === 'supplemental') return fetchSupplemental(manifest);
  if (sourceKey === 'regulations') return fetchRegulations(manifest);
  return fetchStatutes(manifest, sourceKey);
}

// ── Statute chapters (revisor / justia) — the original fetch loop ─────────
async function fetchStatutes(manifest, sourceKey) {
  const source = manifest.sources[sourceKey];
  if (!source) throw new Error(`unknown source '${sourceKey}'`);

  const chapters = manifest.chapters.filter((c) => !args.chapter || c.chapter === String(args.chapter));
  const engine = args.engine ?? source.engine;

  // Give every chapter its own fresh browser session (fresh cookies), used
  // for both its discovery request and its section fetches. Proven in CI
  // across three runs: a chapter-index request only succeeds when it's the
  // FIRST such request in its session — chapter 143 (first in the manifest)
  // always succeeds; whichever chapter's index comes second in the SAME
  // session always fails, even when it's the very next request right after
  // chapter 143's own (successful) index fetch, with none of chapter 143's
  // ~168 section fetches in between. Section-page requests don't trip this —
  // only the chapter-index URL shape seems rate-limited to one-per-session.
  // A completely isolated `--chapter 347` run (fresh browser, its index as
  // the only request) passed end-to-end, confirming a fresh session per
  // chapter sidesteps it; per-request waits and reordering within one shared
  // session (both tried first) did not.
  let chaptersFailed = 0;
  const resolved = [];
  for (const ch of chapters) {
    const fetchImpl = await makeFetcher(engine);
    try {
      const sections = await resolveSections(source, ch, fetchImpl);
      resolved.push({ ch, sections, fetchImpl });
    } catch (e) {
      // Isolate a bad chapter to itself rather than aborting discovery (and
      // therefore fetching) for every chapter listed after it in the
      // manifest. The run still exits non-zero so the gap isn't silent.
      chaptersFailed++;
      process.stdout.write(`  ✗ chapter ${ch.chapter} (${ch.label}) — discovery failed: ${e.message}\n`);
      await fetchImpl.close?.();
    }
  }

  let ok = 0, skip = 0, fail = 0;
  for (const { ch, sections, fetchImpl } of resolved) {
    console.log(`[fetch] chapter ${ch.chapter} (${ch.label}) — ${sections.length} sections`);
    const dir = path.join(RAW, sourceKey, ch.chapter);
    await mkdir(dir, { recursive: true });

      for (const section of sections) {
        const file = path.join(dir, `${section}.html`);
        if (!args.force && existsSync(file) && (await nonEmpty(file))) { skip++; continue; }
        const url = source.sectionUrl
          .replace('{section}', section)
          .replace('{section_slug}', section.replace('.', '-'))
          .replace('{chapter}', ch.chapter)
          .replace('{title_slug}', ch.title_slug ?? '')
          .replace('{justia_title}', ch.justia_title ?? '');
        try {
          const html = await fetchWithRetry(fetchImpl, url);
          const provenance = { section, chapter: ch.chapter, source: sourceKey, url, retrieved_at: new Date().toISOString(), raw_checksum: rawChecksum(html) };
          await writeFile(file, html, 'utf8');
          await writeFile(file.replace(/\.html$/, '.meta.json'), JSON.stringify(provenance, null, 2), 'utf8');
          ok++;
          process.stdout.write(`  ✓ ${section}\n`);
        } catch (e) {
          fail++;
          process.stdout.write(`  ✗ ${section} — ${e.message}\n`);
        }
        await sleep(source.rateLimitMs ?? 2000);
      }
    } catch (e) {
      failedChapters.push(ch.chapter);
      console.error(`[fetch] chapter ${ch.chapter} (${ch.label}) FAILED, moving to next chapter — ${e.message}`);
    }
    await fetchImpl.close?.();
  }
  console.log(`[fetch] done. fetched=${ok} skipped=${skip} failed=${fail} chaptersFailed=${chaptersFailed}`);
  if (fail || chaptersFailed) process.exitCode = 1;
}

// ── DOR guidance pages (manifest.supplemental.pages) — plain fetch, HTML ───
// Each page is a whole standalone document (not a chapter of sections), so
// this loop is flatter than fetchStatutes: one file per manifest entry, keyed
// by its own id, saved under data/raw/supplemental/.
async function fetchSupplemental(manifest) {
  const pages = manifest.supplemental?.pages ?? [];
  if (!pages.length) { console.log('[fetch] no supplemental pages in manifest'); return; }

  const dir = path.join(RAW, 'supplemental');
  await mkdir(dir, { recursive: true });
  const fetchImpl = await makeFetcher('fetch'); // DOR guidance pages aren't bot-protected

  let ok = 0, skip = 0, fail = 0;
  for (const page of pages) {
    const file = path.join(dir, `${page.id}.html`);
    if (!args.force && existsSync(file) && (await nonEmpty(file))) { skip++; continue; }
    try {
      const html = await fetchImpl(page.url);
      const provenance = { id: page.id, source: 'supplemental', url: page.url, retrieved_at: new Date().toISOString(), raw_checksum: rawChecksum(html) };
      await writeFile(file, html, 'utf8');
      await writeFile(file.replace(/\.html$/, '.meta.json'), JSON.stringify(provenance, null, 2), 'utf8');
      ok++;
      process.stdout.write(`  ✓ ${page.id}\n`);
    } catch (e) {
      fail++;
      process.stdout.write(`  ✗ ${page.id} — ${e.message}\n`);
    }
    await sleep(1500);
  }
  console.log(`[fetch] supplemental done. fetched=${ok} skipped=${skip} failed=${fail}`);
  if (fail) process.exitCode = 1;
}

// ── 12 CSR 10 regulations (manifest.regulations) — plain fetch, PDF ────────
// PDF-served, so raw bytes are written verbatim (never decoded as text here —
// pipeline/lib/parse.mjs's parsePdfSection does the extraction at build time,
// keeping the same "archive exactly what was served" discipline as HTML).
async function fetchRegulations(manifest) {
  const regs = manifest.regulations;
  if (!regs) { console.log('[fetch] no regulations block in manifest'); return; }

  const dir = path.join(RAW, 'regulations');
  await mkdir(dir, { recursive: true });

  let ok = 0, skip = 0, fail = 0;
  for (const division of regs.divisions ?? []) {
    const file = path.join(dir, `12csr10-${division}.pdf`);
    if (!args.force && existsSync(file) && (await nonEmptyBinary(file))) { skip++; continue; }
    const url = regs.pdfUrlPattern.replace('{division}', division);
    try {
      const resp = await fetch(url, {
        headers: { 'user-agent': 'Mozilla/5.0 (compatible; MOTaxIntelligence/1.0; +regulation ingest)' },
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const bytes = new Uint8Array(await resp.arrayBuffer());
      const provenance = { division, source: 'regulations', url, retrieved_at: new Date().toISOString(), raw_checksum: rawChecksum(bytes) };
      await writeFile(file, bytes);
      await writeFile(file.replace(/\.pdf$/, '.meta.json'), JSON.stringify(provenance, null, 2), 'utf8');
      ok++;
      process.stdout.write(`  ✓ 12 CSR 10-${division}\n`);
    } catch (e) {
      fail++;
      process.stdout.write(`  ✗ 12 CSR 10-${division} — ${e.message}\n`);
    }
    await sleep(regs.rateLimitMs ?? 2000);
  }
  console.log(`[fetch] regulations done. fetched=${ok} skipped=${skip} failed=${fail}`);
  if (fail) process.exitCode = 1;
}

// Discover section numbers from a chapter index page (or use an explicit list
// if the manifest provides one instead of "discover").
async function resolveSections(source, ch, fetchImpl, sourceKey) {
  if (Array.isArray(ch.sections)) return ch.sections;
  const url = source.chapterIndexUrl
    .replace('{chapter}', ch.chapter)
    .replace('{title_slug}', ch.title_slug ?? '')
    .replace('{justia_title}', ch.justia_title ?? '');
  // Discovery has been seen to return 0 links on an otherwise-working source —
  // a transient Cloudflare challenge on just the index request, distinct from
  // the section pages that immediately followed it succeeding. Retry the
  // index fetch before concluding the selectors are actually wrong, so one
  // flaky request doesn't fail an entire chapter.
  //
  // Index pages also get a much longer post-navigation settle wait than
  // section pages: the 600ms default (tuned for section fetches, where it's
  // paid hundreds of times) is enough once Cloudflare has already cleared a
  // browser for this site, but a URL *prefix* the session hasn't hit yet
  // (chapter 143 always succeeds; 347/351 — later in the manifest, first
  // request to that chapter's path — have consistently failed discovery in
  // CI) can trigger a fresh "checking your browser" challenge that needs a
  // few seconds to auto-clear. Discovery only runs once per chapter, so
  // paying that cost here doesn't touch the section-fetch time budget.
  const discoveryFetch = (u) => fetchImpl(u, { waitMs: 5000 });
  const html = await fetchWithRetry(discoveryFetch, url, { attempts: 4, baseDelayMs: 2000 });

  const extractSections = (h) => {
    const re = new RegExp(source.sectionLinkPattern, 'g');
    const found = new Set();
    for (let m; (m = re.exec(h)); ) found.add(m[1].replace('-', '.'));
    // Keep only sections that actually belong to THIS chapter. Index pages link
    // to cross-referenced sections in other chapters (e.g. §3.090) and
    // boilerplate; without this guard the crawler pulls those junk links
    // instead of the chapter.
    return [...found].filter((s) => s.startsWith(ch.chapter + '.')).sort((a, b) => ord(a) - ord(b));
  };

  let list = extractSections(html);
  let lastHtml = html;

  // Empty result even after a successful fetch: re-request the index page
  // itself once more before giving up — this is the "chapter 347 got 0
  // sections" case seen in CI, where the request 200'd but rendered a
  // challenge/interstitial instead of the real list.
  for (let attempt = 0; attempt < 2 && list.length < 3; attempt++) {
    await sleep(3000 * 2 ** attempt);
    try {
      list = extractSections(await discoveryFetch(url));
    } catch { /* keep retrying */ }
  }

  if (list.length < 3) {
    // Persist exactly what we got back so a failure is diagnosable from the
    // raw-html artifact without live network access — resolveSections used to
    // fetch this page and throw it away, leaving nothing to inspect when
    // discovery failed (the artifact only ever had per-section pages, never
    // the index page itself).
    await saveIndexDebug(sourceKey, ch.chapter, url, lastHtml);
    throw new Error(
      `discovered only ${list.length} section(s) for chapter ${ch.chapter}` +
      `${list.length ? ' [' + list.join(', ') + ']' : ''} — the index page likely rendered its ` +
      `section list via JS, hit a Cloudflare challenge${looksLikeChallenge(lastHtml) ? ' (challenge markers detected in the response)' : ''}, ` +
      `or sectionLinkPattern/selectors are wrong for this source. See the saved _index.html in the ` +
      `raw-html artifact (data/raw/${sourceKey}/${ch.chapter}/_index.html) and fix sources/manifest.json.`
    );
  }
  return list;
}

// Cheap heuristic — not a real challenge parser, just enough to tell a human
// "you got blocked" apart from "the selectors don't match this page".
function looksLikeChallenge(html) {
  const markers = ['cf-chl', 'Just a moment', 'Checking your browser', 'Attention Required', 'cf_captcha', 'challenge-platform'];
  return markers.some((m) => html.includes(m));
}

async function saveIndexDebug(sourceKey, chapter, url, html) {
  try {
    const dir = path.join(RAW, sourceKey, chapter);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, '_index.html'), html, 'utf8');
    await writeFile(
      path.join(dir, '_index.meta.json'),
      JSON.stringify({ chapter, source: sourceKey, url, retrieved_at: new Date().toISOString(), byte_len: html.length }, null, 2),
      'utf8'
    );
  } catch { /* debug artifact is best-effort; never let it mask the real error */ }
}

async function makeFetcher(engine) {
  if (engine === 'playwright') {
    const { chromium } = await import('playwright').catch(() => {
      throw new Error("engine 'playwright' requested but 'playwright' is not installed. `npm i -D playwright` (Chromium is pre-provided in Claude web sessions).");
    });
    const browser = await chromium.launch({
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined,
    });
    const ctx = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
      locale: 'en-US',
      viewport: { width: 1280, height: 900 },
      extraHTTPHeaders: { 'accept-language': 'en-US,en;q=0.9' },
    });
    const fn = async (url, opts = {}) => {
      const page = await ctx.newPage();
      try {
        const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
        // Let JS-rendered lists (revisor.mo.gov) and any Cloudflare interstitial
        // (justia) settle before reading the DOM. A fixed short wait, not
        // networkidle: justia keeps ad/tracker connections open indefinitely,
        // so networkidle was timing out on EVERY page (~15s tax x 168 sections
        // = ~45min for one chapter, threatening the job's 90min budget) for no
        // benefit — a real statute page or a Cloudflare challenge both finish
        // rendering well under a second. Callers paying for a page only once
        // per chapter (chapter-index discovery) can override this with a
        // longer wait via opts.waitMs — see resolveSections.
        await page.waitForTimeout(opts.waitMs ?? 600);
        const status = resp ? resp.status() : 0;
        const html = await page.content();
        // A challenge/error page is tiny; a real statute page is large. Throw
        // only when an error status coincides with a too-small body, so a
        // challenge-then-render still succeeds.
        if (status >= 400 && html.length < 2000) throw new Error(`HTTP ${status}`);
        return html;
      } finally {
        await page.close();
      }
    };
    fn.close = () => browser.close();
    return fn;
  }
  // plain fetch — full browser-like headers (bare UAs get 403'd by Cloudflare
  // fronts like justia / dor.mo.gov).
  const fn = async (url) => {
    const resp = await fetch(url, {
      headers: {
        'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
        'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'accept-language': 'en-US,en;q=0.9',
      },
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return await resp.text();
  };
  return fn;
}

async function nonEmpty(file) {
  try { return (await readFile(file, 'utf8')).length > 200; } catch { return false; }
}
async function nonEmptyBinary(file) {
  try { return (await readFile(file)).length > 200; } catch { return false; }
}
function ord(s) { const [a, b = '0'] = s.split('.'); return Number(a) * 1e6 + Number(b.padEnd(6, '0')); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// Shared retry-with-backoff around a single fetchImpl(url) call — used for
// both chapter-index discovery and individual section pages, since both hit
// the same transient-Cloudflare-challenge failure mode.
async function fetchWithRetry(fetchImpl, url, { attempts = 3, baseDelayMs = 1500 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await fetchImpl(url);
    } catch (e) {
      lastErr = e;
      if (attempt < attempts - 1) await sleep(baseDelayMs * 2 ** attempt);
    }
  }
  throw new Error(`fetch failed after ${attempts} attempts: ${lastErr?.message}`);
}
function parseArgs(a) {
  const o = {};
  for (let i = 0; i < a.length; i++) {
    if (a[i] === '--force') o.force = true;
    else if (a[i].startsWith('--')) o[a[i].slice(2)] = a[++i];
  }
  return o;
}

main().catch((e) => { console.error(e); process.exit(1); });
