#!/usr/bin/env node
// ============================================================
// STAGE 1 — FETCH. Pull raw section HTML to data/raw/ with provenance.
//
// Design notes:
//  • revisor.mo.gov is bot-protected → default engine is Playwright (drives the
//    pre-installed Chromium). Justia is a clean mirror → plain fetch.
//  • Resumable: a section already on disk with a matching non-empty body is
//    skipped unless --force. Re-running after a partial pull just fills gaps.
//  • Raw HTML is archived verbatim so every later parse is auditable and the
//    verbatim/citation guarantee is reproducible.
//  • Slow on purpose (per-source rateLimitMs). "The script taking time" is
//    acceptable; getting rate-limited or IP-blocked is not.
//
// Usage:
//   node scripts/fetch.mjs                       # all chapters, primary source (revisor)
//   node scripts/fetch.mjs --source justia       # use the statute mirror
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
  const sourceKey = args.source ?? 'revisor';

  if (sourceKey === 'supplemental') return fetchSupplemental(manifest);
  if (sourceKey === 'regulations') return fetchRegulations(manifest);
  return fetchStatutes(manifest, sourceKey);
}

// ── Statute chapters (revisor / justia) — the original fetch loop ─────────
async function fetchStatutes(manifest, sourceKey) {
  const source = manifest.sources[sourceKey];
  if (!source) throw new Error(`unknown source '${sourceKey}'`);

  const chapters = manifest.chapters.filter((c) => !args.chapter || c.chapter === String(args.chapter));
  const fetchImpl = await makeFetcher(args.engine ?? source.engine);

  let ok = 0, skip = 0, fail = 0;
  for (const ch of chapters) {
    const sections = await resolveSections(source, ch, fetchImpl);
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
        .replace('{title_slug}', ch.title_slug ?? '');
      try {
        const html = await fetchImpl(url);
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
  }
  await fetchImpl.close?.();
  console.log(`[fetch] done. fetched=${ok} skipped=${skip} failed=${fail}`);
  if (fail) process.exitCode = 1;
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
async function resolveSections(source, ch, fetchImpl) {
  if (Array.isArray(ch.sections)) return ch.sections;
  const url = source.chapterIndexUrl.replace('{chapter}', ch.chapter).replace('{title_slug}', ch.title_slug ?? '');
  const html = await fetchImpl(url);
  const re = new RegExp(source.sectionLinkPattern, 'g');
  const found = new Set();
  for (let m; (m = re.exec(html)); ) found.add(m[1].replace('-', '.'));
  const list = [...found].sort((a, b) => ord(a) - ord(b));
  if (!list.length) throw new Error(`no sections discovered for chapter ${ch.chapter} — check sectionLinkPattern/selectors against data/raw`);
  return list;
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
    });
    const fn = async (url) => {
      const page = await ctx.newPage();
      try {
        const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
        if (resp && resp.status() >= 400) throw new Error(`HTTP ${resp.status()}`);
        return await page.content();
      } finally {
        await page.close();
      }
    };
    fn.close = () => browser.close();
    return fn;
  }
  // plain fetch
  const fn = async (url) => {
    const resp = await fetch(url, {
      headers: { 'user-agent': 'Mozilla/5.0 (compatible; MOTaxIntelligence/1.0; +statute ingest)' },
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
function parseArgs(a) {
  const o = {};
  for (let i = 0; i < a.length; i++) {
    if (a[i] === '--force') o.force = true;
    else if (a[i].startsWith('--')) o[a[i].slice(2)] = a[++i];
  }
  return o;
}

main().catch((e) => { console.error(e); process.exit(1); });
