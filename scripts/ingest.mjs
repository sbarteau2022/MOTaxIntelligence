#!/usr/bin/env node
// ============================================================
// STAGE 3 — INGEST. Push the built corpus into the Worker, which embeds with
// the SAME Workers AI bge-large model Atlas uses and writes D1 + Vectorize
// server-side. Embedding happens in the Worker (not here) so the vectors are
// bit-for-bit in the same space as elle-corpus-vectors — that is what makes
// this index natively queryable by Atlas.
//
// Env:
//   INGEST_URL   e.g. https://mo-tax.<subdomain>.workers.dev  (or wrangler dev URL)
//   SERVICE_KEY  matches the Worker's TAX_SERVICE_KEY secret
//
// Usage: node scripts/ingest.mjs [--batch 50] [--dry-run]
// ============================================================

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(import.meta.url), '../..');
const args = Object.fromEntries(process.argv.slice(2).flatMap((a, i, arr) =>
  a.startsWith('--') ? [[a.slice(2), arr[i + 1]?.startsWith('--') || arr[i + 1] === undefined ? true : arr[i + 1]]] : []));

const BASE = process.env.INGEST_URL;
const KEY = process.env.SERVICE_KEY;
const BATCH = Number(args.batch ?? 50);

async function main() {
  if (!BASE || !KEY) throw new Error('set INGEST_URL and SERVICE_KEY env vars');
  const parents = await readJsonl(path.join(ROOT, 'data', 'parents.jsonl'));
  const children = await readJsonl(path.join(ROOT, 'data', 'children.jsonl'));
  const kidsOf = groupBy(children, (c) => c.parent_id);

  console.log(`[ingest] ${parents.length} parents / ${children.length} children → ${BASE}`);
  if (args['dry-run']) { console.log('[ingest] dry-run, not posting'); return; }

  let done = 0;
  for (let i = 0; i < parents.length; i += BATCH) {
    const slice = parents.slice(i, i + BATCH);
    const payload = {
      parents: slice,
      children: slice.flatMap((p) => kidsOf.get(p.id) ?? []),
    };
    await postWithRetry(`${BASE}/admin/ingest`, payload);
    done += slice.length;
    process.stdout.write(`  ingested ${done}/${parents.length}\r`);
  }
  console.log(`\n[ingest] done — ${done} sections.`);
}

async function postWithRetry(url, body, attempt = 0) {
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
      body: JSON.stringify(body),
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${(await resp.text()).slice(0, 300)}`);
    return await resp.json().catch(() => ({}));
  } catch (e) {
    if (attempt >= 4) throw e;
    const wait = 2 ** attempt * 1000;
    console.warn(`  retry ${attempt + 1} after ${wait}ms — ${e.message}`);
    await new Promise((r) => setTimeout(r, wait));
    return postWithRetry(url, body, attempt + 1);
  }
}

async function readJsonl(p) {
  return (await readFile(p, 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l));
}
function groupBy(arr, key) {
  const m = new Map();
  for (const x of arr) { const k = key(x); if (!m.has(k)) m.set(k, []); m.get(k).push(x); }
  return m;
}

main().catch((e) => { console.error(e); process.exit(1); });
