// ============================================================
// SMALL-TO-BIG RETRIEVAL — the no-drift read path.
//
// A query embeds → nearest CHILD windows come back from Vectorize → each child
// resolves to its parent by FOREIGN KEY (parent_id in the vector metadata) →
// we load the VERBATIM parent section from D1 and return that. The child text
// is never returned or cited; it exists only to be matched. Because the parent
// is loaded by id (not by relocating the child's text inside it) there is no
// indexOf, no whitespace matching, no window guessing — a mid-section hit
// always yields the exact, whole, citable section. Zero drift by construction.
// ============================================================

import { EMBEDDING_MODEL } from './config';
import type { Citation, EntityFilter, Env } from './types';

export async function embedQuery(env: Pick<Env, 'AI'>, text: string): Promise<number[]> {
  const r = (await env.AI.run(EMBEDDING_MODEL, { text: [text.slice(0, 2000)] })) as { data?: number[][] };
  if (!r?.data?.[0]) throw new Error('embedQuery: Workers AI returned no embedding');
  return r.data[0];
}

const FILTER_FIELD: Record<Exclude<EntityFilter, 'any'>, string> = {
  llc_single: 'ent_llc_single',
  llc_multi: 'ent_llc_multi',
  s_corp: 'ent_s_corp',
  general: 'ent_general',
};

export interface RetrieveOpts {
  entity?: EntityFilter;   // default 'any'
  topK?: number;           // parents returned (default 5)
  candidateK?: number;     // child vectors pulled before grouping (default 40)
}

export async function retrieve(env: Env, query: string, opts: RetrieveOpts = {}): Promise<Citation[]> {
  const entity = opts.entity ?? 'any';
  const topK = opts.topK ?? 5;
  const candidateK = opts.candidateK ?? 40;

  const vector = await embedQuery(env, query);
  const filter = entity !== 'any' ? { [FILTER_FIELD[entity]]: true } : undefined;

  const res = await env.VECTORIZE.query(vector, {
    topK: candidateK,
    returnMetadata: 'all',
    ...(filter ? { filter } : {}),
  });

  // Group child hits by parent, keeping the best score and every matched span.
  interface Agg { best: number; spans: { start_char: number; end_char: number; score: number }[] }
  const byParent = new Map<string, Agg>();
  for (const m of res.matches) {
    const md = (m.metadata ?? {}) as Record<string, unknown>;
    const parentId = String(md.parent_id ?? '');
    if (!parentId) continue;
    const span = {
      start_char: Number(md.start_char ?? 0),
      end_char: Number(md.end_char ?? 0),
      score: m.score,
    };
    const agg = byParent.get(parentId);
    if (agg) { agg.best = Math.max(agg.best, m.score); agg.spans.push(span); }
    else byParent.set(parentId, { best: m.score, spans: [span] });
  }
  if (byParent.size === 0) return [];

  const rankedIds = [...byParent.entries()]
    .sort((a, b) => b[1].best - a[1].best)
    .slice(0, topK)
    .map(([id]) => id);

  const parents = await loadParents(env.DB, rankedIds);
  const pById = new Map(parents.map((p) => [p.id, p]));

  return rankedIds
    .filter((id) => pById.has(id))
    .map((id) => {
      const p = pById.get(id)!;
      const agg = byParent.get(id)!;
      return {
        citation: p.citation,
        section: p.section,
        chapter: p.chapter,
        catchline: p.catchline,
        effective_date: p.effective_date,
        statute_year: p.statute_year,
        authority: p.authority,
        entity_tags: JSON.parse(p.entity_tags || '[]'),
        source_url: p.source_url,
        retrieved_at: p.retrieved_at,
        checksum: p.checksum,
        score: agg.best,
        body: p.body, // VERBATIM
        matched_spans: agg.spans.sort((a, b) => b.score - a.score),
      } as Citation;
    });
}

interface ParentRow {
  id: string; citation: string; chapter: string; section: string;
  catchline: string | null; effective_date: string | null; statute_year: string | null;
  authority: string | null; entity_tags: string; source_url: string; retrieved_at: string;
  checksum: string; body: string;
}

async function loadParents(db: D1Database, ids: string[]): Promise<ParentRow[]> {
  if (!ids.length) return [];
  const ph = ids.map(() => '?').join(',');
  const { results } = await db
    .prepare(
      `SELECT id, citation, chapter, section, catchline, effective_date, statute_year,
              authority, entity_tags, source_url, retrieved_at, checksum, body
       FROM parents WHERE id IN (${ph})`
    )
    .bind(...ids)
    .all<ParentRow>();
  return results ?? [];
}
