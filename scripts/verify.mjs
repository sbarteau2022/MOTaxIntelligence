#!/usr/bin/env node
// ============================================================
// VERIFY — the flawlessness gate. Run against the built JSONL BEFORE ingest.
// Exits non-zero on any defect. Checks:
//   1. child.text === parent.body.slice(start,end)   (the no-drift invariant)
//   2. full coverage of every parent by its children (no gaps)
//   3. unique ids (parents and children)
//   4. every parent has provenance: source_url, retrieved_at, checksum
//   5. checksum matches the stored body (nothing mutated post-fetch)
//   6. every parent carries at least one entity tag
// ============================================================

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { verifyChildren } from '../pipeline/lib/chunk.mjs';

const ROOT = path.resolve(fileURLToPath(import.meta.url), '../..');

async function main() {
  const parents = await readJsonl(path.join(ROOT, 'data', 'parents.jsonl'));
  const children = await readJsonl(path.join(ROOT, 'data', 'children.jsonl'));
  const byParent = new Map(parents.map((p) => [p.id, p]));
  const kidsOf = new Map();
  for (const c of children) {
    if (!kidsOf.has(c.parent_id)) kidsOf.set(c.parent_id, []);
    kidsOf.get(c.parent_id).push(c);
  }

  const fail = [];
  const seenP = new Set(), seenC = new Set();

  for (const p of parents) {
    if (seenP.has(p.id)) fail.push(`duplicate parent id ${p.id}`);
    seenP.add(p.id);
    if (!p.source_url) fail.push(`${p.id}: missing source_url`);
    if (!p.retrieved_at) fail.push(`${p.id}: missing retrieved_at`);
    if (!p.checksum) fail.push(`${p.id}: missing checksum`);
    else if (sha256(p.body) !== p.checksum) fail.push(`${p.id}: checksum mismatch — body changed after fetch`);
    if (!Array.isArray(p.entity_tags) || p.entity_tags.length === 0) fail.push(`${p.id}: no entity tags`);

    const kids = kidsOf.get(p.id) ?? [];
    if (!kids.length) fail.push(`${p.id}: no children`);
    for (const c of kids) {
      if (seenC.has(c.id)) fail.push(`duplicate child id ${c.id}`);
      seenC.add(c.id);
    }
    for (const prob of verifyChildren(p, kids)) fail.push(`${p.id}: ${prob}`);
  }

  for (const c of children) {
    if (!byParent.has(c.parent_id)) fail.push(`orphan child ${c.id} → missing parent ${c.parent_id}`);
  }

  if (fail.length) {
    console.error(`[verify] FAILED — ${fail.length} defect(s):`);
    for (const f of fail.slice(0, 100)) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log(`[verify] PASS — ${parents.length} parents, ${children.length} children. No-drift invariant holds on 100%.`);
}

async function readJsonl(p) {
  const raw = await readFile(p, 'utf8');
  return raw.split('\n').filter(Boolean).map((l) => JSON.parse(l));
}
function sha256(s) { return createHash('sha256').update(s, 'utf8').digest('hex'); }

main().catch((e) => { console.error(e); process.exit(1); });
