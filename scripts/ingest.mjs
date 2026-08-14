#!/usr/bin/env node
// ============================================================
// STAGE 3 — INGEST. Push the built corpus into the Worker, which embeds with
// the SAME Workers AI bge-large model Atlas uses and writes D1 + Vectorize
// server-side. Embedding happens in the Worker (not here) so the vectors are
// bit-for-bit in the same space as elle-corpus-vectors — that is what makes
// this index natively queryable by Atlas.
//
// Env:
//   INGEST_URL   e.g. https://motaxintelligence.<subdomain>.workers.dev  (or wrangler dev URL)
//   SERVICE_KEY  matches the Worker's TAX_SERVICE_KEY secret
//
// Usage: node scripts/ingest.mjs [--batch 50] [--dry-run]
// ============================================================

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(fileURLToPath(import.meta.url), '../..');
const args = Object.fromEntries(process.argv.slice(2).flatMap((a, i, arr) =>
  a.startsWith('--') ? [[a.slice(2), arr[i + 1]?.startsWith('--') || arr[i + 1] === undefined ? true : arr[i + 1]]] : []));

const BASE = process.env.INGEST_URL;
const KEY = process.env.SERVICE_KEY;
const BATCH = Number(args.batch ?? 50);

/**
 * INGEST_URL is a secret, so it is masked in CI logs — which meant a
 * malformed value surfaced only as "TypeError: Failed to parse URL from
 * <masked>/admin/ingest" after four pointless retries, with nothing to say
 * WHAT was wrong with it. This validates the shape up front and reports the
 * defect structurally, never echoing the value itself.
 *
 * Deliberately does NOT auto-prepend a missing scheme: silently repairing a
 * misconfigured secret is exactly the kind of guess this repo refuses
 * everywhere else. Name the fix, let a human make it.
 */
export function resolveIngestBase(raw) {
  const v = String(raw ?? '').trim();
  if (!v) throw new Error('INGEST_URL is empty — set it to the Worker origin, e.g. https://motaxintelligence.<subdomain>.workers.dev');

  let url;
  try {
    url = new URL(v);
  } catch {
    // The overwhelmingly common cause is a bare hostname with no scheme.
    const looksSchemeless = /^[\w.-]+\.[a-z]{2,}(?::\d+)?(?:\/|$)/i.test(v);
    throw new Error(
      looksSchemeless
        ? `INGEST_URL is not an absolute URL — it appears to be missing the "https://" scheme (value is masked; it is ${v.length} characters and starts with a hostname, not a scheme). Set it to https://motaxintelligence.<subdomain>.workers.dev`
        : `INGEST_URL is not a parseable URL (value is masked; ${v.length} characters). Set it to the Worker origin, e.g. https://motaxintelligence.<subdomain>.workers.dev`
    );
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(`INGEST_URL must be an http(s) URL — got protocol "${url.protocol}". Set it to https://motaxintelligence.<subdomain>.workers.dev`);
  }
  if (url.pathname.replace(/\/+$/, '') !== '' ) {
    throw new Error(`INGEST_URL must be the Worker ORIGIN only, with no path — it currently ends in "${url.pathname}". The script appends /admin/ingest itself.`);
  }
  // Trailing slash would produce "…//admin/ingest".
  return url.origin;
}

/** A 4xx will never fix itself on retry; only retry transport/5xx failures. */
export function isRetryable(err) {
  return !/^HTTP 4\d\d/.test(String(err?.message ?? ''));
}

async function main() {
  if (!BASE || !KEY) throw new Error('set INGEST_URL and SERVICE_KEY env vars');
  const base = resolveIngestBase(BASE);
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
    await postWithRetry(`${base}/admin/ingest`, payload);
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
    // A 401 from a mismatched TAX_SERVICE_KEY (the next-most-likely
    // misconfiguration after the URL) is not worth four backoffs either.
    if (attempt >= 4 || !isRetryable(e)) throw e;
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

// Only run when invoked directly (`node scripts/ingest.mjs`), so the helpers
// above can be imported by tests without kicking off a real ingest.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
