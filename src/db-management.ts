// ============================================================
// Database management — src/db-management.ts
//
// "Database management" for a Worker with no server to SSH into: an audit
// log (ingestion_event) plus two maintenance passes that can run on a
// schedule OR on demand via /admin/verify:
//
//   runIntegrityCheck  — re-checks the load-bearing invariant
//     (parent.body.slice(start,end) === child.text) against what's ACTUALLY
//     in D1 right now. scripts/build-corpus.mjs already guarantees this at
//     build time (pipeline/lib/chunk.mjs's verifyChildren); this is the same
//     check run again against the deployed database, catching a partial
//     ingest or write bug the local build never saw.
//
//   checkSourceDrift   — re-fetches every plain-fetchable source_url (justia
//     mirror + DOR guidance pages — NOT revisor.mo.gov, which is
//     bot-protected and needs the local Playwright pull, and NOT PDF
//     regulations, which need pdf-parse) and compares a fresh SHA-256 of the
//     raw bytes against `parents.raw_checksum` (computed at fetch time, see
//     scripts/fetch.mjs). A mismatch means the source changed since the last
//     local pull — this DETECTS drift, it never auto-reingests: the local
//     build → verify pipeline is still the only path that writes a new body,
//     preserving the "a corpus only ships if it's perfect" discipline
//     (docs/ARCHITECTURE.md).
//
// Both are best-effort and bounded (a Worker has CPU/subrequest limits) —
// see MAX_DRIFT_CHECKS_PER_RUN.
// ============================================================

import type { Env } from './types';

function id(): string {
  return crypto.randomUUID();
}

export async function logIngestionEvent(env: Env, eventType: string, detail: unknown): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO ingestion_event (id, event_type, detail_json, occurred_at) VALUES (?,?,?,?)`
  ).bind(id(), eventType, JSON.stringify(detail).slice(0, 8000), new Date().toISOString()).run();
}

async function sha256Hex(bytes: ArrayBuffer | Uint8Array): Promise<string> {
  const buf = bytes instanceof Uint8Array ? bytes.slice().buffer : bytes;
  const digest = await crypto.subtle.digest('SHA-256', buf as ArrayBuffer);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

export interface IntegrityViolation {
  parent_id: string;
  child_id: string;
  reason: string;
}

export interface IntegrityCheckResult {
  parentsChecked: number;
  childrenChecked: number;
  violations: IntegrityViolation[];
}

// Batched to avoid loading the whole corpus into memory at once. D1's
// per-query row cap and Worker memory are both bounded, so this walks
// parents in pages and pulls only that page's children each time.
const INTEGRITY_PAGE_SIZE = 200;

export async function runIntegrityCheck(env: Env): Promise<IntegrityCheckResult> {
  const violations: IntegrityViolation[] = [];
  let parentsChecked = 0, childrenChecked = 0, offset = 0;

  for (;;) {
    const page = await env.DB.prepare(
      `SELECT id, body FROM parents ORDER BY id LIMIT ? OFFSET ?`
    ).bind(INTEGRITY_PAGE_SIZE, offset).all<{ id: string; body: string }>();
    const parents = page.results ?? [];
    if (!parents.length) break;

    const ids = parents.map((p) => p.id);
    const placeholders = ids.map(() => '?').join(',');
    const kids = await env.DB.prepare(
      `SELECT id, parent_id, start_char, end_char, text FROM children WHERE parent_id IN (${placeholders})`
    ).bind(...ids).all<{ id: string; parent_id: string; start_char: number; end_char: number; text: string }>();

    const bodyByParent = new Map(parents.map((p) => [p.id, p.body]));
    for (const c of kids.results ?? []) {
      childrenChecked++;
      const body = bodyByParent.get(c.parent_id);
      if (body == null) {
        violations.push({ parent_id: c.parent_id, child_id: c.id, reason: 'parent not found' });
        continue;
      }
      const slice = body.slice(c.start_char, c.end_char);
      if (slice !== c.text) {
        violations.push({ parent_id: c.parent_id, child_id: c.id, reason: `slice !== text (offsets ${c.start_char}..${c.end_char})` });
      }
    }
    parentsChecked += parents.length;
    offset += INTEGRITY_PAGE_SIZE;
    if (parents.length < INTEGRITY_PAGE_SIZE) break;
  }

  return { parentsChecked, childrenChecked, violations };
}

export interface DriftResult {
  checked: number;
  drifted: Array<{ parent_id: string; source_url: string; stored_raw_checksum: string; fresh_raw_checksum: string }>;
  fetchErrors: Array<{ parent_id: string; source_url: string; error: string }>;
}

// Sources a Worker can re-fetch with a plain `fetch` to drift-check. Only DOR
// guidance ('supplemental') qualifies: revisor.mo.gov is bot-protected, PDF
// regulations need pdf-parse, and 'justia' — though it's the default statute
// mirror — sits behind Cloudflare and 403s a serverless plain fetch (proven in
// the pull pipeline), so re-fetching it from the Worker only ever yields
// fetchErrors, never a real drift signal. Browser-only sources are instead
// drift-verified at pull time: the local `fetch → build → verify` re-fetches
// and re-hashes them, and that pipeline is the only path that writes a body.
const DRIFT_CHECKABLE_SOURCES = ['supplemental'];
const MAX_DRIFT_CHECKS_PER_RUN = 25;

export async function checkSourceDrift(env: Env): Promise<DriftResult> {
  const placeholders = DRIFT_CHECKABLE_SOURCES.map(() => '?').join(',');
  const rows = await env.DB.prepare(
    `SELECT id, source_url, raw_checksum FROM parents
     WHERE source IN (${placeholders}) AND raw_checksum IS NOT NULL
     ORDER BY retrieved_at ASC LIMIT ?`
  ).bind(...DRIFT_CHECKABLE_SOURCES, MAX_DRIFT_CHECKS_PER_RUN).all<{ id: string; source_url: string; raw_checksum: string }>();

  const drifted: DriftResult['drifted'] = [];
  const fetchErrors: DriftResult['fetchErrors'] = [];
  let checked = 0;

  for (const row of rows.results ?? []) {
    checked++;
    try {
      const resp = await fetch(row.source_url, {
        headers: {
          'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
          'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'accept-language': 'en-US,en;q=0.9',
        },
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const bytes = new Uint8Array(await resp.arrayBuffer());
      const fresh = await sha256Hex(bytes);
      if (fresh !== row.raw_checksum) {
        drifted.push({ parent_id: row.id, source_url: row.source_url, stored_raw_checksum: row.raw_checksum, fresh_raw_checksum: fresh });
      }
    } catch (e) {
      fetchErrors.push({ parent_id: row.id, source_url: row.source_url, error: (e as Error).message });
    }
  }

  return { checked, drifted, fetchErrors };
}
