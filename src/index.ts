// ============================================================
// MOTaxIntelligence Worker.
//
// Routes:
//   GET  /                 statute query console (HTML) — see src/console.ts
//   GET  /console          same page, explicit path
//   GET  /health           liveness + row counts
//   POST /query            small-to-big retrieval (JSON: {q, entity?, top_k?})
//   POST /admin/ingest     load parents+children, embed children, upsert vectors
//                          (TAX_SERVICE_KEY, constant-time checked)
//   POST /admin/verify     on-demand DB integrity check + source drift check
//                          (TAX_SERVICE_KEY) — see src/db-management.ts
//   GET  /admin/stats      row counts by authority/chapter/source, recent
//                          ingestion_event log (TAX_SERVICE_KEY)
//
// Cron (see wrangler.toml [triggers]): scheduled() runs the same drift +
// integrity checks unattended and logs the result to ingestion_event, so a
// maintenance pass has a record even when nobody calls /admin/verify.
//
// Embedding for BOTH ingest and query happens here via env.AI bge-large — the
// vectors therefore live in the exact space Atlas already queries.
// ============================================================

import { EMBEDDING_MODEL } from './config';
import { CONSOLE_HTML } from './console';
import { retrieve, type RetrieveOpts } from './retrieval';
import { logIngestionEvent, runIntegrityCheck, checkSourceDrift } from './db-management';
import type { Env, EntityFilter } from './types';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/console')) return consolePage();
      if (request.method === 'GET' && url.pathname === '/health') return health(env);
      if (request.method === 'POST' && url.pathname === '/query') return query(request, env);
      if (request.method === 'POST' && url.pathname === '/admin/ingest') return ingest(request, env);
      if (request.method === 'POST' && url.pathname === '/admin/verify') return verify(request, env);
      if (request.method === 'GET' && url.pathname === '/admin/stats') return stats(request, env);
      return json({ error: 'not found' }, 404);
    } catch (e) {
      return json({ error: (e as Error).message }, 500);
    }
  },

  // Fires on the cron schedule in wrangler.toml. Best-effort: a failure here
  // logs itself (never throws unhandled — Cloudflare would just retry/drop
  // it silently) so a broken cron is visible in ingestion_event, not silent.
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runMaintenance(env));
  },
} satisfies ExportedHandler<Env>;

async function runMaintenance(env: Env): Promise<void> {
  try {
    const drift = await checkSourceDrift(env);
    await logIngestionEvent(env, 'drift_check_completed', drift);
    for (const d of drift.drifted) {
      await logIngestionEvent(env, 'source_drift_detected', d);
    }

    const integrity = await runIntegrityCheck(env);
    await logIngestionEvent(env, integrity.violations.length ? 'verify_failed' : 'verify_completed', integrity);
  } catch (e) {
    await logIngestionEvent(env, 'verify_failed', { error: (e as Error).message }).catch(() => {});
  }
}

// ── / and /console ──────────────────────────────────────────
// Served from the Worker itself so the console is same-origin with /query.
// No route here sets CORS headers, so a console hosted anywhere else would
// have its POST /query blocked by the browser — serving it here keeps the
// UI working with zero config and without widening the API's CORS surface.
function consolePage(): Response {
  return new Response(CONSOLE_HTML, {
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=300' },
  });
}

// ── /health ─────────────────────────────────────────────────
async function health(env: Env): Promise<Response> {
  const p = await env.DB.prepare('SELECT COUNT(*) AS n FROM parents').first<{ n: number }>().catch(() => null);
  const c = await env.DB.prepare('SELECT COUNT(*) AS n FROM children').first<{ n: number }>().catch(() => null);
  return json({ ok: true, model: EMBEDDING_MODEL, parents: p?.n ?? null, children: c?.n ?? null });
}

// ── /admin/verify — on-demand version of what the cron runs unattended ──
async function verify(request: Request, env: Env): Promise<Response> {
  if (!authorized(request, env)) return json({ error: 'unauthorized' }, 401);
  const drift = await checkSourceDrift(env);
  const integrity = await runIntegrityCheck(env);
  await logIngestionEvent(env, 'drift_check_completed', drift);
  for (const d of drift.drifted) await logIngestionEvent(env, 'source_drift_detected', d);
  await logIngestionEvent(env, integrity.violations.length ? 'verify_failed' : 'verify_completed', integrity);
  return json({ drift, integrity });
}

// ── /admin/stats — database management overview ─────────────────────────
async function stats(request: Request, env: Env): Promise<Response> {
  if (!authorized(request, env)) return json({ error: 'unauthorized' }, 401);
  const byAuthority = await env.DB.prepare(
    `SELECT authority, COUNT(*) AS n FROM parents GROUP BY authority`
  ).all<{ authority: string | null; n: number }>().catch(() => ({ results: [] }));
  const byChapter = await env.DB.prepare(
    `SELECT chapter, COUNT(*) AS n FROM parents GROUP BY chapter ORDER BY chapter`
  ).all<{ chapter: string; n: number }>().catch(() => ({ results: [] }));
  const oldest = await env.DB.prepare(
    `SELECT MIN(retrieved_at) AS oldest, MAX(retrieved_at) AS newest FROM parents`
  ).first<{ oldest: string | null; newest: string | null }>().catch(() => null);
  const recentEvents = await env.DB.prepare(
    `SELECT event_type, detail_json, occurred_at FROM ingestion_event ORDER BY occurred_at DESC LIMIT 20`
  ).all<{ event_type: string; detail_json: string; occurred_at: string }>().catch(() => ({ results: [] }));

  return json({
    by_authority: byAuthority.results ?? [],
    by_chapter: byChapter.results ?? [],
    retrieved_at_range: oldest,
    recent_events: (recentEvents.results ?? []).map((r) => ({
      event_type: r.event_type, occurred_at: r.occurred_at,
      detail: safeParse(r.detail_json),
    })),
  });
}

function safeParse(s: string): unknown {
  try { return JSON.parse(s); } catch { return s; }
}

// ── /query ──────────────────────────────────────────────────
const ENTITY_VALUES: EntityFilter[] = ['llc_single', 'llc_multi', 's_corp', 'general', 'any'];

async function query(request: Request, env: Env): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as { q?: string; entity?: string; top_k?: number };
  const q = (body.q ?? '').trim();
  if (!q) return json({ error: 'q required' }, 400);

  const entity = (ENTITY_VALUES.includes(body.entity as EntityFilter) ? body.entity : 'any') as EntityFilter;
  const opts: RetrieveOpts = { entity, topK: clamp(body.top_k ?? 5, 1, 20) };

  const results = await retrieve(env, q, opts);
  return json({ query: q, entity, count: results.length, results });
}

// ── /admin/ingest ───────────────────────────────────────────
interface IngestParent {
  id: string; citation: string; chapter: string; section: string;
  catchline?: string | null; effective_date?: string | null; statute_year?: string | null;
  authority?: string | null; entity_tags: string[];
  ent_llc_single?: boolean; ent_llc_multi?: boolean; ent_s_corp?: boolean; ent_general?: boolean;
  source?: string | null; source_url: string; retrieved_at: string; checksum: string;
  raw_checksum?: string | null;
  char_len: number; body: string;
}
interface IngestChild {
  id: string; parent_id: string; seq: number; start_char: number; end_char: number;
  text: string; breadcrumb?: string | null;
  ent_llc_single?: boolean; ent_llc_multi?: boolean; ent_s_corp?: boolean; ent_general?: boolean;
}

async function ingest(request: Request, env: Env): Promise<Response> {
  if (!authorized(request, env)) return json({ error: 'unauthorized' }, 401);
  const { parents = [], children = [] } = (await request.json()) as { parents: IngestParent[]; children: IngestChild[] };

  // 1. Upsert parents + children into D1.
  for (const p of parents) {
    await env.DB.prepare(
      `INSERT INTO parents (id,citation,chapter,section,catchline,effective_date,statute_year,authority,
         entity_tags,ent_llc_single,ent_llc_multi,ent_s_corp,ent_general,source,source_url,retrieved_at,checksum,raw_checksum,char_len,body)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET citation=excluded.citation,catchline=excluded.catchline,
         effective_date=excluded.effective_date,statute_year=excluded.statute_year,authority=excluded.authority,
         entity_tags=excluded.entity_tags,ent_llc_single=excluded.ent_llc_single,ent_llc_multi=excluded.ent_llc_multi,
         ent_s_corp=excluded.ent_s_corp,ent_general=excluded.ent_general,source=excluded.source,
         source_url=excluded.source_url,retrieved_at=excluded.retrieved_at,checksum=excluded.checksum,
         raw_checksum=excluded.raw_checksum,char_len=excluded.char_len,body=excluded.body`
    ).bind(
      p.id, p.citation, p.chapter, p.section, p.catchline ?? null, p.effective_date ?? null, p.statute_year ?? null,
      p.authority ?? null, JSON.stringify(p.entity_tags ?? []),
      b(p.ent_llc_single), b(p.ent_llc_multi), b(p.ent_s_corp), b(p.ent_general),
      p.source ?? null, p.source_url, p.retrieved_at, p.checksum, p.raw_checksum ?? null, p.char_len, p.body
    ).run();
  }
  for (const c of children) {
    await env.DB.prepare(
      `INSERT INTO children (id,parent_id,seq,start_char,end_char,text,breadcrumb,
         ent_llc_single,ent_llc_multi,ent_s_corp,ent_general)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET parent_id=excluded.parent_id,seq=excluded.seq,start_char=excluded.start_char,
         end_char=excluded.end_char,text=excluded.text,breadcrumb=excluded.breadcrumb,
         ent_llc_single=excluded.ent_llc_single,ent_llc_multi=excluded.ent_llc_multi,
         ent_s_corp=excluded.ent_s_corp,ent_general=excluded.ent_general`
    ).bind(
      c.id, c.parent_id, c.seq, c.start_char, c.end_char, c.text, c.breadcrumb ?? null,
      b(c.ent_llc_single), b(c.ent_llc_multi), b(c.ent_s_corp), b(c.ent_general)
    ).run();
  }

  // 2. Embed child windows and upsert to Vectorize. Embed the deterministic
  //    breadcrumb + verbatim text (breadcrumb improves recall, never cited).
  //    Metadata carries the FK + exact offsets + entity flags so the read path
  //    resolves parents without touching child text.
  let vectors = 0;
  const BATCH = 25; // matches Elle's embedBatch cadence
  for (let i = 0; i < children.length; i += BATCH) {
    const batch = children.slice(i, i + BATCH);
    const inputs = batch.map((c) => `${c.breadcrumb ?? ''}\n${c.text}`.slice(0, 2000));
    const r = (await env.AI.run(EMBEDDING_MODEL, { text: inputs })) as { data?: number[][] };
    if (!r?.data || r.data.length !== batch.length) {
      return json({ error: `embedding count mismatch: got ${r?.data?.length ?? 0}, expected ${batch.length}` }, 502);
    }
    await env.VECTORIZE.upsert(
      batch.map((c, j) => ({
        id: c.id,
        values: r.data![j],
        metadata: {
          parent_id: c.parent_id,
          start_char: c.start_char,
          end_char: c.end_char,
          ent_llc_single: b(c.ent_llc_single),
          ent_llc_multi: b(c.ent_llc_multi),
          ent_s_corp: b(c.ent_s_corp),
          ent_general: b(c.ent_general),
        },
      }))
    );
    vectors += batch.length;
  }

  // 3. Keep FTS in sync with the parents just written.
  for (const p of parents) {
    await env.DB.prepare(
      `INSERT INTO parents_fts (rowid, body, citation)
       SELECT rowid, body, citation FROM parents WHERE id = ?`
    ).bind(p.id).run().catch(() => {});
  }

  await logIngestionEvent(env, 'ingest_completed', { parents: parents.length, children: children.length, vectors });
  return json({ ok: true, parents: parents.length, children: children.length, vectors });
}

// ── helpers ─────────────────────────────────────────────────
function authorized(request: Request, env: Env): boolean {
  if (!env.TAX_SERVICE_KEY) return false;
  const presented = request.headers.get('authorization') || '';
  return timingSafeEqual(presented, `Bearer ${env.TAX_SERVICE_KEY}`);
}

function timingSafeEqual(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  const len = Math.max(ea.length, eb.length);
  let diff = ea.length ^ eb.length;
  for (let i = 0; i < len; i++) diff |= (ea[i] ?? 0) ^ (eb[i] ?? 0);
  return diff === 0;
}

function b(v: unknown): number { return v ? 1 : 0; }
function clamp(n: number, lo: number, hi: number): number { return Math.max(lo, Math.min(hi, n)); }
function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), { status, headers: { 'content-type': 'application/json' } });
}
