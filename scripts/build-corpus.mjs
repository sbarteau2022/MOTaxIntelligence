#!/usr/bin/env node
// ============================================================
// STAGE 2 — BUILD. data/raw/*.html → data/parents.jsonl + data/children.jsonl
//
// For each raw section: parse verbatim body → classify entity tags → chunk into
// parent+children with exact offsets → VERIFY the no-drift invariant. A single
// invariant violation, empty body, or untagged section is a hard failure: this
// stage refuses to emit a corpus that isn't flawless. Fix the input (selectors
// / entity-map) and re-run.
// ============================================================

import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSection, parsePdfSection, checksum } from '../pipeline/lib/parse.mjs';
import { classify, suggestTags, entityFlags } from '../pipeline/lib/entity.mjs';
import { chunkParent, verifyChildren } from '../pipeline/lib/chunk.mjs';

const ROOT = path.resolve(fileURLToPath(import.meta.url), '../..');
const RAW = path.join(ROOT, 'data', 'raw');

async function main() {
  const manifest = JSON.parse(await readFile(path.join(ROOT, 'sources', 'manifest.json'), 'utf8'));
  const entityMap = JSON.parse(await readFile(path.join(ROOT, 'sources', 'entity-map.json'), 'utf8'));

  const parents = [];
  const children = [];
  const untagged = [];
  const errors = [];

  for (const [sourceKey, source] of Object.entries(manifest.sources)) {
    const srcDir = path.join(RAW, sourceKey);
    for (const chapter of await listDirs(srcDir)) {
      const chDir = path.join(srcDir, chapter);
      for (const f of (await readdir(chDir)).filter((n) => n.endsWith('.html'))) {
        const section = f.replace(/\.html$/, '');
        const html = await readFile(path.join(chDir, f), 'utf8');
        const meta = await readJson(path.join(chDir, f.replace(/\.html$/, '.meta.json')));

        const parsed = parseSection(html, source);
        if (!parsed) { errors.push(`empty/unparseable body: ${sourceKey}/${chapter}/${section}`); continue; }

        const tagRule = classify({ chapter, section }, entityMap);
        if (!tagRule) {
          untagged.push({ section, chapter, suggested: suggestTags(parsed.body) });
          continue; // do not emit an untagged statute — flawless-by-review
        }

        const id = `mo:${chapter}:${section}`;
        const parent = {
          id,
          citation: `Mo. Rev. Stat. § ${section}`,
          chapter,
          section,
          catchline: parsed.catchline,
          effective_date: parsed.effective,
          statute_year: manifest.statute_year,
          authority: source.authority ?? sourceKey,
          entity_tags: tagRule.tags,
          entity_rule: tagRule.rule,
          source: sourceKey,
          source_url: meta?.url ?? null,
          retrieved_at: meta?.retrieved_at ?? null,
          raw_checksum: meta?.raw_checksum ?? null,
          checksum: checksum(parsed.body),
          char_len: parsed.body.length,
          body: parsed.body,
          ...entityFlags(tagRule.tags),
        };

        const kids = chunkParent(parent, {}).map((c) => ({
          ...c,
          entity_tags: tagRule.tags,
          ...entityFlags(tagRule.tags),
        }));

        const problems = verifyChildren(parent, kids);
        if (problems.length) { errors.push(`INVARIANT ${id}: ${problems.join('; ')}`); continue; }

        parents.push(parent);
        children.push(...kids);
      }
    }
  }

  // ── DOR guidance pages (manifest.supplemental.pages) ─────────────────────
  // Curated at the source: page.entity is the tag set directly (these are a
  // handful of hand-reviewed pages, not a whole chapter), so no classify()
  // call and no UNTAGGED path here — a missing/empty entity[] is a build error.
  for (const page of manifest.supplemental?.pages ?? []) {
    const file = path.join(RAW, 'supplemental', `${page.id}.html`);
    const html = await readFile(file, 'utf8').catch(() => null);
    if (html == null) { errors.push(`missing raw file for supplemental page ${page.id} — run pull:fetch --source supplemental`); continue; }
    const meta = await readJson(file.replace(/\.html$/, '.meta.json'));

    const parsed = parseSection(html, page);
    if (!parsed) { errors.push(`empty/unparseable body: supplemental/${page.id}`); continue; }
    if (!page.entity?.length) { errors.push(`supplemental page ${page.id} has no entity[] tags in the manifest`); continue; }

    const id = `mo:guidance:${page.id}`;
    const parent = {
      id,
      citation: page.label ?? page.id,
      chapter: 'guidance',
      section: page.id,
      catchline: parsed.catchline,
      effective_date: null,
      statute_year: manifest.statute_year,
      authority: 'guidance',
      entity_tags: page.entity,
      entity_rule: 'manifest:supplemental',
      source: 'supplemental',
      source_url: meta?.url ?? page.url,
      retrieved_at: meta?.retrieved_at ?? null,
      raw_checksum: meta?.raw_checksum ?? null,
      checksum: checksum(parsed.body),
      char_len: parsed.body.length,
      body: parsed.body,
      ...entityFlags(page.entity),
    };
    const kids = chunkParent(parent, {}).map((c) => ({ ...c, entity_tags: page.entity, ...entityFlags(page.entity) }));
    const problems = verifyChildren(parent, kids);
    if (problems.length) { errors.push(`INVARIANT ${id}: ${problems.join('; ')}`); continue; }
    parents.push(parent);
    children.push(...kids);
  }

  // ── 12 CSR 10 regulations (manifest.regulations) ─────────────────────────
  // PDF-sourced, parsed via parsePdfSection (pipeline/lib/parse.mjs) instead
  // of parseSection. Routed through the SAME classify()/entity-map.json check
  // as statute chapters — no special-cased default tagging — so a freshly
  // fetched division with no entity-map rule yet is reported UNTAGGED and
  // blocked, exactly like an unreviewed statute section.
  const regs = manifest.regulations;
  if (regs) {
    const regDir = path.join(RAW, 'regulations');
    for (const f of (await readdir(regDir).catch(() => [])).filter((n) => n.endsWith('.pdf'))) {
      const division = f.replace(/^12csr10-/, '').replace(/\.pdf$/, '');
      const buf = await readFile(path.join(regDir, f));
      const meta = await readJson(path.join(regDir, f.replace(/\.pdf$/, '.meta.json')));

      const parsed = await parsePdfSection(buf, regs);
      if (!parsed) { errors.push(`empty/unparseable body: regulations/12csr10-${division}`); continue; }

      const tagRule = classify({ chapter: 'regulations', section: division }, entityMap);
      if (!tagRule) {
        untagged.push({ section: division, chapter: 'regulations', suggested: suggestTags(parsed.body) });
        continue;
      }

      const id = `mo:regulation:12csr10-${division}`;
      const parent = {
        id,
        citation: `12 CSR 10-${division}`,
        chapter: 'regulations',
        section: division,
        catchline: parsed.catchline,
        effective_date: null,
        statute_year: manifest.statute_year,
        authority: regs.authority ?? 'regulation',
        entity_tags: tagRule.tags,
        entity_rule: tagRule.rule,
        source: 'regulations',
        source_url: meta?.url ?? null,
        retrieved_at: meta?.retrieved_at ?? null,
        raw_checksum: meta?.raw_checksum ?? null,
        checksum: checksum(parsed.body),
        char_len: parsed.body.length,
        body: parsed.body,
        ...entityFlags(tagRule.tags),
      };
      const kids = chunkParent(parent, {}).map((c) => ({ ...c, entity_tags: tagRule.tags, ...entityFlags(tagRule.tags) }));
      const problems = verifyChildren(parent, kids);
      if (problems.length) { errors.push(`INVARIANT ${id}: ${problems.join('; ')}`); continue; }
      parents.push(parent);
      children.push(...kids);
    }
  }

  // Report before deciding pass/fail.
  if (untagged.length) {
    console.error(`\n[build] ${untagged.length} UNTAGGED sections (add rules to sources/entity-map.json):`);
    for (const u of untagged.slice(0, 50)) {
      console.error(`  - ${u.chapter}/${u.section}  suggested: ${u.suggested.join(', ') || '(none)'}`);
    }
    if (untagged.length > 50) console.error(`  … and ${untagged.length - 50} more`);
  }
  if (errors.length) {
    console.error(`\n[build] ${errors.length} ERRORS:`);
    for (const e of errors.slice(0, 50)) console.error(`  - ${e}`);
  }
  if (errors.length || untagged.length) {
    console.error('\n[build] FAILED — corpus not written. Resolve the above, then re-run.');
    process.exit(1);
  }

  await writeFile(path.join(ROOT, 'data', 'parents.jsonl'), parents.map((p) => JSON.stringify(p)).join('\n') + '\n');
  await writeFile(path.join(ROOT, 'data', 'children.jsonl'), children.map((c) => JSON.stringify(c)).join('\n') + '\n');
  console.log(`[build] OK — ${parents.length} sections, ${children.length} children. Invariant holds on 100%.`);
}

async function listDirs(dir) {
  try { return (await readdir(dir, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name); }
  catch { return []; }
}
async function readJson(p) { try { return JSON.parse(await readFile(p, 'utf8')); } catch { return null; } }

main().catch((e) => { console.error(e); process.exit(1); });
